/**
 * h173k Solana RPC Proxy – Cloudflare Worker
 * Full-pass proxy: wszystkie metody Solana RPC są przepuszczane.
 * Ochrona tylko po Origin (CORS guard).
 *
 * Env vars (Dashboard → Worker → Settings → Variables → Encrypted):
 *   SOLANA_RPC_URL  – prywatny RPC endpoint (Helius, QuickNode, itp.)
 *   RPC_SECRET      – opcjonalny Bearer token (zostaw puste by wyłączyć)
 */

const ALLOWED_ORIGINS = new Set([
  "https://h173k-wallet.pages.dev",
  "https://h173k-burn-chat.pages.dev",
]);

const H173K_MINT = "173AvoJNQoWsaR1wdYTMNLUqZc1b7d4SzB2ZZRZVyz3";

// ── helpers ───────────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
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

// ── WebSocket proxy ───────────────────────────────────────────────────────────

async function handleWebSocket(request, env) {
  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  // Zamień http(s) na ws(s)
  const wsUrl = rpcUrl
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");

  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  // Połącz z upstream RPC przez WebSocket
  const [client, server] = Object.values(new WebSocketPair());

  const upstream = new WebSocket(wsUrl);

  upstream.addEventListener("open", () => {
    server.accept();
  });

  // upstream → client
  upstream.addEventListener("message", (event) => {
    try { server.send(event.data); } catch {}
  });

  upstream.addEventListener("close", (event) => {
    try { server.close(event.code, event.reason); } catch {}
  });

  upstream.addEventListener("error", () => {
    try { server.close(1011, "Upstream error"); } catch {}
  });

  // client → upstream
  server.addEventListener("message", (event) => {
    if (upstream.readyState === WebSocket.OPEN) {
      try { upstream.send(event.data); } catch {}
    }
  });

  server.addEventListener("close", (event) => {
    try { upstream.close(event.code, event.reason); } catch {}
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

// ── HTTP RPC proxy ────────────────────────────────────────────────────────────

async function handleHTTP(request, env, origin) {
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

  // Forward everything to upstream RPC
  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

  let upstream;
  try {
    upstream = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "solana-client": request.headers.get("solana-client") ?? "h173k-proxy",
      },
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

// ── main ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const isUpgrade = request.headers.get("Upgrade") === "websocket";

    // CORS preflight
    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin) && origin !== "")
        return new Response("Forbidden", { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Origin guard – blokuj obce domeny (pozwól brak Origin dla testów/walidacji)
    if (origin !== "" && !ALLOWED_ORIGINS.has(origin))
      return new Response("Forbidden: origin not allowed", { status: 403 });

    // WebSocket upgrade
    if (isUpgrade) {
      return handleWebSocket(request, env);
    }

    // Tylko POST dla HTTP RPC
    if (request.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    return handleHTTP(request, env, origin || "*");
  }
};
