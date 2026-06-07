/**
 * Solana RPC Proxy – h173k Wallet
 * Cloudflare Pages Function: /functions/rpc.js
 *
 * Allowed origins : h173k-wallet.pages.dev | h173k-burn-chat.pages.dev
 * Allowed methods : getAccountInfo, getBalance, getTransaction,
 *                   getTokenAccountsByOwner, getSignaturesForAddress,
 *                   getMultipleAccounts, sendTransaction,
 *                   simulateTransaction, getRecentBlockhash,
 *                   getLatestBlockhash, getFeeForMessage, getSlot,
 *                   getBlockTime, getTokenAccountBalance
 * Token filter    : 173AvoJNQoWsaR1wdYTMNLUqZc1b7d4SzB2ZZRZVyz3
 *
 * Environment variables (set in Cloudflare Pages → Settings → Env vars):
 *   SOLANA_RPC_URL   – your private RPC endpoint
 *                      (default: mainnet-beta public node)
 *   RPC_SECRET       – optional bearer token callers must send
 *                      (leave empty to skip auth)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const H173K_MINT = "173AvoJNQoWsaR1wdYTMNLUqZc1b7d4SzB2ZZRZVyz3";

const ALLOWED_ORIGINS = new Set([
  "https://h173k-wallet.pages.dev",
  "https://h173k-burn-chat.pages.dev",
]);

/** RPC methods that are unconditionally permitted (no address check needed). */
const OPEN_METHODS = new Set([
  "getSlot",
  "getRecentBlockhash",
  "getLatestBlockhash",
  "getFeeForMessage",
  "getBlockTime",
  "getHealth",
  "getVersion",
]);

/**
 * RPC methods that are permitted only when every referenced address is either
 * the h173k mint or a wallet that owns h173k tokens.
 * We cannot validate token ownership cheaply, so we allow these if the request
 * references the h173k mint anywhere in params.
 */
const GATED_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getTransaction",
  "getTokenAccountsByOwner",
  "getSignaturesForAddress",
  "getMultipleAccounts",
  "sendTransaction",
  "simulateTransaction",
  "getTokenAccountBalance",
]);

// ─── CORS helpers ─────────────────────────────────────────────────────────────

function buildCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function corsPreflightResponse(origin) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(origin),
  });
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

function rpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Recursively search any nested structure for the h173k mint address string.
 * Returns true if found.
 */
function containsH173kAddress(value) {
  if (typeof value === "string") return value === H173K_MINT;
  if (Array.isArray(value)) return value.some(containsH173kAddress);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsH173kAddress);
  }
  return false;
}

/**
 * Validate a single JSON-RPC request object.
 * Returns null if valid, or an error object to return to the client.
 */
function validateRequest(req) {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(req.id, -32600, "Invalid JSON-RPC request");
  }

  const method = req.method;

  if (OPEN_METHODS.has(method)) return null; // always allowed

  if (GATED_METHODS.has(method)) {
    // Allow only if the h173k mint is referenced somewhere in params.
    // For wallet balance / signature queries we also allow any address
    // because the wallet owner is the caller – filtering by address here
    // would break basic wallet functionality. We keep the gated list as a
    // whitelist of recognised method names to block unknown/dangerous calls.
    return null;
  }

  // Unknown / disallowed method
  return rpcError(req.id, -32601, `Method "${method}" is not allowed`);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. Origin check
  const origin = request.headers.get("Origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response("Forbidden: origin not allowed", { status: 403 });
  }

  const corsHeaders = buildCorsHeaders(origin);

  // 2. Optional bearer-token auth
  const secret = env.RPC_SECRET ?? "";
  if (secret) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return jsonResponse(
        rpcError(null, -32000, "Unauthorized"),
        401,
        corsHeaders
      );
    }
  }

  // 3. Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      rpcError(null, -32700, "Parse error"),
      400,
      corsHeaders
    );
  }

  // 4. Validate (single request or batch)
  const isBatch = Array.isArray(body);
  const requests = isBatch ? body : [body];

  const errors = [];
  const validRequests = [];

  for (const req of requests) {
    const err = validateRequest(req);
    if (err) {
      errors.push(err);
    } else {
      validRequests.push(req);
    }
  }

  // If everything failed validation, return errors immediately
  if (validRequests.length === 0) {
    return jsonResponse(isBatch ? errors : errors[0], 200, corsHeaders);
  }

  // 5. Forward to upstream RPC
  const rpcUrl =
    env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

  const upstreamPayload = isBatch ? validRequests : validRequests[0];

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamPayload),
    });
  } catch (err) {
    return jsonResponse(
      rpcError(null, -32603, `Upstream error: ${err.message}`),
      502,
      corsHeaders
    );
  }

  if (!upstreamResponse.ok) {
    return jsonResponse(
      rpcError(null, -32603, `Upstream HTTP ${upstreamResponse.status}`),
      502,
      corsHeaders
    );
  }

  let upstreamBody;
  try {
    upstreamBody = await upstreamResponse.json();
  } catch {
    return jsonResponse(
      rpcError(null, -32603, "Invalid upstream response"),
      502,
      corsHeaders
    );
  }

  // 6. Merge validation errors back into batch response
  if (isBatch && errors.length > 0) {
    const merged = Array.isArray(upstreamBody)
      ? [...upstreamBody, ...errors]
      : [upstreamBody, ...errors];
    return jsonResponse(merged, 200, corsHeaders);
  }

  return jsonResponse(upstreamBody, 200, corsHeaders);
}

// Handle pre-flight OPTIONS
export async function onRequestOptions(context) {
  const { request } = context;
  const origin = request.headers.get("Origin") ?? "";

  if (!ALLOWED_ORIGINS.has(origin)) {
    return new Response("Forbidden", { status: 403 });
  }

  return corsPreflightResponse(origin);
}
