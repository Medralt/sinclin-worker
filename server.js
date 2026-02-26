/**
 * sinclin-worker (Cloud Run)
 * - Does NOT crash on startup if ENV/Secrets are missing
 * - Validates Supabase JWT via JWKS
 * - Creates signed URL for Supabase Storage object
 * - Returns { ok: true, signedUrl } when gateway is disabled
 * - Optionally calls Lovable AI Gateway only if explicitly enabled
 */

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

// -------- helpers --------
function jsonError(res, status, message, extra = undefined) {
  return res.status(status).json({
    ok: false,
    error: message,
    ...(extra ? { details: extra } : {}),
  });
}

function isTruthyFlag(v) {
  return /^(1|true|yes|on)$/i.test((v || "").trim());
}

function getValidUrlOrEmpty(s) {
  const v = (s || "").trim();
  if (!v) return "";
  if (v.includes("example.com")) return "";
  try {
    new URL(v);
    return v;
  } catch {
    return "";
  }
}

// -------- lazy runtime config (prevents startup crash) --------
let cached = {
  supabaseUrl: null,
  serviceRoleKey: null,
  expectedIssuer: null,
  expectedAudience: null,
  jwksUrl: null,
  JWKS: null,
  supabaseAdmin: null,
};

function loadRuntimeConfig() {
  const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
  const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: false,
      missing: [
        !SUPABASE_URL ? "SUPABASE_URL" : null,
        !SUPABASE_SERVICE_ROLE_KEY ? "SUPABASE_SERVICE_ROLE_KEY" : null,
      ].filter(Boolean),
    };
  }

  // If unchanged, reuse cached clients/urls
  if (
    cached.supabaseUrl === SUPABASE_URL &&
    cached.serviceRoleKey === SUPABASE_SERVICE_ROLE_KEY &&
    cached.JWKS &&
    cached.supabaseAdmin
  ) {
    return { ok: true, ...cached };
  }

  const expectedIssuer = new URL("/auth/v1", SUPABASE_URL).toString().replace(/\/$/, "");
  const expectedAudience = process.env.SUPABASE_JWT_AUD || "authenticated";
  const jwksUrl = new URL("/auth/v1/.well-known/jwks.json", SUPABASE_URL);
  const JWKS = createRemoteJWKSet(jwksUrl);

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  cached = {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
    expectedIssuer,
    expectedAudience,
    jwksUrl,
    JWKS,
    supabaseAdmin,
  };

  return { ok: true, ...cached };
}

async function requireSupabaseJWT(req, cfg) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;

  if (!token) {
    const err = new Error("Missing Authorization: Bearer <JWT>");
    err.status = 401;
    throw err;
  }

  try {
    const { payload } = await jwtVerify(token, cfg.JWKS, {
      issuer: cfg.expectedIssuer,
      audience: cfg.expectedAudience,
    });
    return payload;
  } catch {
    const err = new Error("Invalid JWT");
    err.status = 401;
    throw err;
  }
}

// -------- app --------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.status(200).send("sinclin-worker ok"));

app.get("/health", (req, res) => {
  const cfg = loadRuntimeConfig();
  if (!cfg.ok) {
    return res.status(500).json({ ok: false, missing_env: cfg.missing });
  }
  return res.status(200).json({ ok: true });
});

app.post("/transcribe", async (req, res) => {
  try {
    const cfg = loadRuntimeConfig();
    if (!cfg.ok) {
      return jsonError(res, 500, "Missing required env", { missing_env: cfg.missing });
    }

    const jwt = await requireSupabaseJWT(req, cfg);
    const userId = jwt?.sub;

    if (!userId) {
      return jsonError(res, 401, "JWT missing sub (user id)");
    }

    const { transcription_request_id, storage_bucket, storage_path, mime_type } = req.body || {};

    if (!transcription_request_id || !storage_bucket || !storage_path || !mime_type) {
      return jsonError(res, 400, "Missing required fields", {
        required: ["transcription_request_id", "storage_bucket", "storage_path", "mime_type"],
      });
    }

    // 1) Signed URL do Storage
    const { data: signed, error: signErr } = await cfg.supabaseAdmin.storage
      .from(storage_bucket)
      .createSignedUrl(storage_path, 60 * 60);

    if (signErr || !signed?.signedUrl) {
      console.error("Signed URL error:", signErr);
      return jsonError(res, 500, "Failed to create signed URL");
    }

    // 2) Opcional: marcar status no DB
    try {
      await cfg.supabaseAdmin.from("transcription_requests").upsert({
        id: transcription_request_id,
        user_id: userId,
        status: "processing",
        input_json: { storage_bucket, storage_path, mime_type },
        updated_at: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.warn("DB upsert skipped/failed:", dbErr?.message || dbErr);
    }

    // 3) Gateway (optional)
    const gatewayEnabled = isTruthyFlag(process.env.LOVABLE_AI_GATEWAY_ENABLED);
    const gatewayBase = getValidUrlOrEmpty(process.env.LOVABLE_AI_GATEWAY_URL);
    const gatewayKey = process.env.LOVABLE_AI_GATEWAY_KEY;

    // ✅ Default: do NOT call gateway
    if (!gatewayEnabled || !gatewayBase) {
      return res.status(200).json({ ok: true, signedUrl: signed.signedUrl });
    }

    // 4) Gateway explicitly enabled -> call
    const gatewayEndpoint = new URL("/transcribe", gatewayBase).toString();

    const headers = { "Content-Type": "application/json" };
    if (gatewayKey) headers["Authorization"] = `Bearer ${gatewayKey}`;

    const gatewayResp = await fetch(gatewayEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        transcription_request_id,
        user_id: userId,
        audio_url: signed.signedUrl,
        mime_type,
      }),
    });

    const rawText = await gatewayResp.text();
    let gatewayJson;
    try {
      gatewayJson = JSON.parse(rawText);
    } catch {
      gatewayJson = { raw: rawText };
    }

    if (!gatewayResp.ok) {
      console.error("Gateway error:", gatewayResp.status, gatewayJson);

      try {
        await cfg.supabaseAdmin
          .from("transcription_requests")
          .update({
            status: "failed",
            error_json: { http_status: gatewayResp.status, response: gatewayJson },
            updated_at: new Date().toISOString(),
          })
          .eq("id", transcription_request_id);
      } catch {}

      return jsonError(res, 502, "Gateway failed", {
        http_status: gatewayResp.status,
        response: gatewayJson,
      });
    }

    // 5) Persistir resultado (se tabela existir)
    try {
      await cfg.supabaseAdmin
        .from("transcription_requests")
        .update({
          status: "done",
          result_json: gatewayJson,
          updated_at: new Date().toISOString(),
        })
        .eq("id", transcription_request_id);
    } catch {}

    return res.status(200).json({
      ok: true,
      transcription_request_id,
      result: gatewayJson,
      signedUrl: signed.signedUrl,
    });
  } catch (e) {
    const status = e?.status || 500;
    console.error("Internal error:", e);
    return jsonError(res, status, e?.message || "Internal error");
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("sinclin-worker listening on port", port);
});