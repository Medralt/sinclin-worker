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
const LOVABLE_AI_GATEWAY_URL = mustEnv("LOVABLE_AI_GATEWAY_URL");

// Optional
const LOVABLE_AI_GATEWAY_KEY = process.env.LOVABLE_AI_GATEWAY_KEY;

// JWT validation settings
// Issuer padrão do Supabase: `${SUPABASE_URL}/auth/v1`
const expectedIssuer = new URL("/auth/v1", SUPABASE_URL).toString().replace(/\/$/, "");
// Audience típica do Supabase: "authenticated"
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
    return payload; // payload.sub é o uid
  } catch (e) {
    const err = new Error("Invalid JWT");
    err.status = 401;
    throw err;
  }
}

/**
 * App
 */
const app = express();

// IMPORTANTE: nada de payload enorme (sem base64)
// Mantém a API segura contra requests gigantes.
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.status(200).send("sinclin-worker ok"));

app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/**
 * POST /transcribe
 *
 * Headers:
 *  Authorization: Bearer <JWT Supabase>
 *
 * Body:
 * {
 *   "transcription_request_id": "...",
 *   "storage_bucket": "audio",
 *   "storage_path": "users/uid/file.webm",
 *   "mime_type": "audio/webm"
 * }
 */
app.post("/transcribe", async (req, res) => {
  try {
    const jwt = await requireSupabaseJWT(req);
    const userId = jwt?.sub;

    if (!userId) {
      return jsonError(res, 401, "JWT missing sub (user id)");
    }

    const {
      transcription_request_id,
      storage_bucket,
      storage_path,
      mime_type,
    } = req.body || {};

    if (
      !transcription_request_id ||
      !storage_bucket ||
      !storage_path ||
      !mime_type
    ) {
      return jsonError(res, 400, "Missing required fields", {
        required: ["transcription_request_id", "storage_bucket", "storage_path", "mime_type"],
      });
    }

    // 1) Signed URL do Storage (download do áudio, sem base64)
    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(storage_bucket)
      .createSignedUrl(storage_path, 60 * 60); // 1 hora

    if (signErr || !signed?.signedUrl) {
      console.error("Signed URL error:", signErr);
      return jsonError(res, 500, "Failed to create signed URL");
    }

    // 2) Opcional: marcar status no DB (se a tabela existir)
    // Recomendação de tabela: transcription_requests
    // Campos sugeridos: id (text/uuid), user_id, status, input_json, result_json, error_json, updated_at
    try {
      await supabaseAdmin
        .from("transcription_requests")
        .upsert({
          id: transcription_request_id,
          user_id: userId,
          status: "processing",
          input_json: {
            storage_bucket,
            storage_path,
            mime_type,
          },
          updated_at: new Date().toISOString(),
        });
    } catch (dbErr) {
      // Não bloqueia se tabela não existir ainda
      console.warn("DB upsert skipped/failed:", dbErr?.message || dbErr);
    }

    // 3) Chamar Lovable AI Gateway
    const gatewayEndpoint = new URL("/transcribe", LOVABLE_AI_GATEWAY_URL).toString();

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

    // 4) Persistir resultado (se tabela existir)
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
});
