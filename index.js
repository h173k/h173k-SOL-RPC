/**
 * h173k Solana RPC Proxy – Cloudflare Worker
 * Obsługuje: HTTP JSON-RPC + WebSocket (wss://)
 *
 * Env vars (Dashboard → Worker → Settings → Variables → Encrypted):
 *   SOLANA_RPC_URL  – prywatny RPC endpoint (Helius, QuickNode, itp.)
 *   RPC_SECRET      – opcjonalny Bearer token (zostaw puste by wyłączyć)
 */

const ALLOWED_ORIGINS = new Set([
  "https://h173k-wallet.pages.dev",
  "https://h173k-burn-chat.pages.dev",
  "http://localhost:3000",
  "https://localhost:3000"
]);

// ── helpers ───────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, solana-client",
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

function isAllowedOrigin(origin) {
  // Brak Origin = zapytanie spoza przeglądarki (walidacja endpointu, curl) – przepuść
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

// ── main ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const isWebSocket = request.headers.get("Upgrade") === "websocket";

    // CORS preflight
    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin))
        return new Response("Forbidden", { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Origin guard
    if (!isAllowedOrigin(origin))
      return new Response("Forbidden: origin not allowed", { status: 403 });

    const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

    // ── WebSocket: po prostu przekaż request do upstream ──────────────────────
    if (isWebSocket) {
      // Zamień http(s) → ws(s) w URL
      const wsUrl = rpcUrl
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://");

      // Cloudflare automatycznie obsłuży WebSocket proxy przez fetch()
      return fetch(new Request(wsUrl, request));
    }

    // ── HTTP: tylko POST ──────────────────────────────────────────────────────
    if (request.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    const cors = corsHeaders(origin);

    // Optional Bearer auth
    const secret = env.RPC_SECRET ?? "";
    if (secret) {
      const auth = request.headers.get("Authorization") ?? "";
      if (auth !== `Bearer ${secret}`)
        return json(rpcErr(null, -32000, "Unauthorized"), 401, cors);
    }

    // Parse + forward
    let body;
    try { body = await request.json(); }
    catch { return json(rpcErr(null, -32700, "Parse error"), 400, cors); }

    let upstream;
    try {
      upstream = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json(rpcErr(null, -32603, `Upstream error: ${e.message}`), 502, cors);
    }

    if (!upstream.ok)
      return json(rpcErr(null, -32603, `Upstream HTTP ${upstream.status}`), 502, cors);

    let upBody;
    try { upBody = await upstream.json(); }
    catch { return json(rpcErr(null, -32603, "Invalid upstream response"), 502, cors); }

    return json(upBody, 200, cors);
  }
};
