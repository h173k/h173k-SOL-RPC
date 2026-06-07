/**
 * h173k Solana RPC Proxy – Cloudflare Worker
 *
 * Allowed origins : h173k-wallet.pages.dev | h173k-burn-chat.pages.dev
 * Env vars (ustaw w Cloudflare Dashboard → Worker → Settings → Variables):
 *   SOLANA_RPC_URL  – prywatny RPC endpoint (Helius, QuickNode, itp.)
 *   RPC_SECRET      – opcjonalny Bearer token (zostaw puste by wyłączyć)
 */

const H173K_MINT = "173AvoJNQoWsaR1wdYTMNLUqZc1b7d4SzB2ZZRZVyz3";

const ALLOWED_ORIGINS = new Set([
  "https://h173k-wallet.pages.dev",
  "https://h173k-burn-chat.pages.dev",
]);

const OPEN_METHODS = new Set([
  "getSlot", "getRecentBlockhash", "getLatestBlockhash",
  "getFeeForMessage", "getBlockTime", "getHealth", "getVersion",
]);

const GATED_METHODS = new Set([
  "getAccountInfo", "getBalance", "getTransaction",
  "getTokenAccountsByOwner", "getSignaturesForAddress",
  "getMultipleAccounts", "sendTransaction",
  "simulateTransaction", "getTokenAccountBalance",
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function rpcErr(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function validateMethod(req) {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return rpcErr(req.id, -32600, "Invalid JSON-RPC request");
  if (OPEN_METHODS.has(req.method)) return null;
  if (GATED_METHODS.has(req.method)) return null;
  return rpcErr(req.id, -32601, `Method "${req.method}" is not allowed`);
}

// ── main ─────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin))
        return new Response("Forbidden", { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only POST
    if (request.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    // Origin guard
    if (!ALLOWED_ORIGINS.has(origin))
      return new Response("Forbidden: origin not allowed", { status: 403 });

    const cors = corsHeaders(origin);

    // Optional Bearer auth
    const secret = env.RPC_SECRET ?? "";
    if (secret) {
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${secret}`)
        return json(rpcErr(null, -32000, "Unauthorized"), 401, cors);
    }

    // Parse body
    let body;
    try { body = await request.json(); }
    catch { return json(rpcErr(null, -32700, "Parse error"), 400, cors); }

    // Validate
    const isBatch = Array.isArray(body);
    const reqs = isBatch ? body : [body];
    const errors = [], valid = [];
    for (const r of reqs) {
      const e = validateMethod(r);
      e ? errors.push(e) : valid.push(r);
    }
    if (valid.length === 0)
      return json(isBatch ? errors : errors[0], 200, cors);

    // Forward to RPC
    const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
    let upstream;
    try {
      upstream = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isBatch ? valid : valid[0]),
      });
    } catch (e) {
      return json(rpcErr(null, -32603, `Upstream error: ${e.message}`), 502, cors);
    }

    if (!upstream.ok)
      return json(rpcErr(null, -32603, `Upstream HTTP ${upstream.status}`), 502, cors);

    let upBody;
    try { upBody = await upstream.json(); }
    catch { return json(rpcErr(null, -32603, "Invalid upstream response"), 502, cors); }

    if (isBatch && errors.length > 0) {
      const merged = Array.isArray(upBody) ? [...upBody, ...errors] : [upBody, ...errors];
      return json(merged, 200, cors);
    }

    return json(upBody, 200, cors);
  }
};
