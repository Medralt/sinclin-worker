import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Helpers
 */
function mustEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
/**
 * sinclin-worker (Cloud Run)
 * - Validates Supabase JWT via JWKS
 * - Creates signed URL for Supabase Storage object
 * - Returns { ok: true, signedUrl } when gateway is disabled
 * - Optionally calls Lovable AI Gateway only if explicitly enabled
 */

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Node 18+ on Cloud Run has global fetch

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function jsonError(res, status, message, extra = undefined) {
  return res.status(status).json({
    ok: false,
    error: message,
    ...(extra ? { details: extra } : {}),
  });
}

/**
 * Required ENV (from Cloud Run Secrets)
 */
const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

/**
 * Gateway (optional)
 * Default: disabled
 * Enable only if LOVABLE_AI_GATEWAY_ENABLED=true (or 1/yes/on)
 */
const LOVABLE_AI_GATEWAY_URL = (process.env.LOVABLE_AI_GATEWAY_URL || "").trim();
const LOVABLE_AI_GATEWAY_ENABLED = /^(1|true|yes|on)$/i.test(
  (process.env.LOVABLE_AI_GATEWAY_ENABLED || "").trim()
);
const LOVABLE_AI_GATEWAY_KEY = process.env.LOVABLE_AI_GATEWAY_KEY;

function getValidGatewayBaseUrl() {
  if (!LOVABLE_AI_GATEWAY_URL) return "";
  if (LOVABLE_AI_GATEWAY_URL.includes("example.com")) return "";
  try {
    // valida formato
    new URL(LOVABLE_AI_GATEWAY_URL);
    return LOVABLE_AI_GATEWAY_URL;
  } catch {
    return "";
  }
}

function shouldCallGateway() {
  const base = getValidGatewayBaseUrl();
  return LOVABLE_AI_GATEWAY_ENABLED && !!base;
}

// JWT validation settings
const expectedIssuer = new URL("/auth/v1", SUPABASE_URL).toString().replace(/\/$/, "");
const expectedAudience = process.env.SUPABASE_JWT_AUD || "authenticated";

// JWKS endpoint do Supabase Auth
const jwksUrl = new URL("/auth/v1/.well-known/jwks.json", SUPABASE_URL);
const JWKS = createRemoteJWKSet(jwksUrl);

// Supabase admin (service role) — apenas backend
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function requireSupabaseJWT(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;

  if (!token) {
    const err = new Error("Missing Authorization: Bearer <JWT>");
    err.status = 401;
    throw err;
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: expectedIssuer,
      audience: expectedAudience,
    });
    return payload;
  } catch {
    const err = new Error("Invalid JWT");
    err.status = 401;
    throw err;
  }
}

/**
 * App
 */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.status(200).send("sinclin-worker ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/**
 * POST /transcribe
 */
app.post("/transcribe", async (req, res) => {
  try {
    const jwt = await requireSupabaseJWT(req);
    const userId = jwt?.sub;

    if (!userId) {
      return jsonError(res, 401, "JWT missing sub (user id)");
    }

    const { transcription_request_id, storage_bucket, storage_path, mime_type } =
      req.body || {};

    if (!transcription_request_id || !storage_bucket || !storage_path || !mime_type) {
      return jsonError(res, 400, "Missing required fields", {
        required: ["transcription_request_id", "storage_bucket", "storage_path", "mime_type"],
      });
    }

    // 1) Signed URL do Storage
    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(storage_bucket)
      .createSignedUrl(storage_path, 60 * 60);

    if (signErr || !signed?.signedUrl) {
      console.error("Signed URL error:", signErr);
      return jsonError(res, 500, "Failed to create signed URL");
    }

    // 2) Opcional: marcar status no DB
    try {
      await supabaseAdmin.from("transcription_requests").upsert({
        id: transcription_request_id,
        user_id: userId,
        status: "processing",
        input_json: { storage_bucket, storage_path, mime_type },
        updated_at: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.warn("DB upsert skipped/failed:", dbErr?.message || dbErr);
    }

    // ✅ 3) Se gateway estiver DESLIGADO, retorna agora (objetivo do teste)
    if (!shouldCallGateway()) {
      return res.status(200).json({
        ok: true,
        signedUrl: signed.signedUrl,
      });
    }

    // 4) Gateway ligado explicitamente -> chama
    const gatewayBase = getValidGatewayBaseUrl();
    const gatewayEndpoint = new URL("/transcribe", gatewayBase).toString();

    const headers = { "Content-Type": "application/json" };
    if (LOVABLE_AI_GATEWAY_KEY) {
      headers["Authorization"] = `Bearer ${LOVABLE_AI_GATEWAY_KEY}`;
    }

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
        await supabaseAdmin
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
      await supabaseAdmin
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

/**
 * Start
 */
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("sinclin-worker listening on port", port);
  console.log("SUPABASE_URL:", SUPABASE_URL);
  console.log("JWKS:", jwksUrl.toString());
  console.log("GATEWAY_ENABLED:", LOVABLE_AI_GATEWAY_ENABLED);
  console.log("GATEWAY_URL_VALID:", !!getValidGatewayBaseUrl());
});