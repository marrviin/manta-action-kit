/**
 * WS bridge handshake auth (extension side, WebCrypto).
 *
 * The extension and the local MCP server share a token (settings.mcpAuthToken ↔
 * the MCP process's MANTA_TOKEN env). A socket is trusted only after a
 * challenge-response exchange in which the token itself never crosses the wire:
 *
 *   client → hello   { nonce }                                              (fresh per connection)
 *   server → welcome { proof = HMAC(token, "manta/welcome/" + helloNonce),
 *                      nonce }                                              ← we verify
 *   client → auth    { proof = HMAC(token, "manta/auth/" + serverNonce) }   ← server verifies
 *
 * This closes both spoofing directions on the loopback bridge: a fake "server"
 * (a local process squatting on the port) can't forge the welcome proof, and a
 * fake "extension"/"peer" (any local process — or a web page dialing
 * ws://127.0.0.1 before Chrome's Local Network Access lands) can't answer the
 * auth challenge. See lib/mcp/bridge.ts for the exchange and
 * packages/mcp/src/auth.ts for the node:crypto twin — the domain-separation
 * prefixes below MUST stay in sync with it.
 */

const enc = new TextEncoder();

/** A fresh random nonce for one handshake (URL-safe hex via UUID). */
export function newNonce(): string {
  return crypto.randomUUID();
}

async function hmacHex(token: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Constant-time string comparison for HMAC proofs. `===` short-circuits on the
 * first differing byte, and the threat model includes a web page dialing
 * ws://127.0.0.1 whose JS can time responses — so proof checks must not leak
 * how many leading hex chars an attacker guessed. Length mismatch is still
 * distinguishable (unavoidable without leaking length via padding); the fixed
 * 64-char HMAC-SHA256 output makes that harmless in practice.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify the server's `welcome` proof for OUR hello nonce. Until this passes,
 * the socket is untrusted and nothing else may be sent or accepted on it.
 */
export async function verifyWelcomeProof(
  token: string,
  helloNonce: string,
  proof: string,
): Promise<boolean> {
  const expected = await hmacHex(token, `manta/welcome/${helloNonce}`);
  return timingSafeEqual(expected, proof);
}

/** The `auth` proof answering the server's challenge nonce. */
export async function authProof(
  token: string,
  serverNonce: string,
): Promise<string> {
  return hmacHex(token, `manta/auth/${serverNonce}`);
}
