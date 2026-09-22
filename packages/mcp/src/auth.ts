/**
 * WS bridge handshake auth (server side, node:crypto). Twin of
 * packages/extension/lib/mcp/auth.ts — the domain-separation prefixes and the
 * HMAC-SHA256-over-hex scheme MUST stay in sync with it.
 *
 * A socket is trusted only after:
 *   client → hello   { nonce }                                            (fresh per connection)
 *   server → welcome { proof = HMAC(token, "manta/welcome/" + helloNonce),
 *                      nonce }                                            ← client verifies
 *   client → auth    { proof = HMAC(token, "manta/auth/" + serverNonce) } ← we verify
 *
 * The token itself never crosses the wire, so a port-squatting process can't
 * impersonate the server to the extension and a local process (or a web page
 * dialing ws://127.0.0.1) can't impersonate a client to us.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** A fresh random challenge nonce for one handshake. */
export function newNonce(): string {
  return randomUUID();
}

function hmacHex(token: string, message: string): string {
  return createHmac("sha256", token).update(message).digest("hex");
}

/** The `welcome` proof answering a client's hello nonce. */
export function welcomeProof(token: string, helloNonce: string): string {
  return hmacHex(token, `manta/welcome/${helloNonce}`);
}

/** The `auth` proof answering the server's challenge nonce (client side). */
export function authProof(token: string, serverNonce: string): string {
  return hmacHex(token, `manta/auth/${serverNonce}`);
}

/**
 * Constant-time check of a client's `auth` answer to our challenge nonce.
 * Returns false for malformed (non-hex / wrong-length) proofs too.
 */
export function verifyAuthProof(
  token: string,
  serverNonce: string,
  proof: string,
): boolean {
  const expected = Buffer.from(hmacHex(token, `manta/auth/${serverNonce}`), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(proof, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Constant-time check of a server's `welcome` proof — used by the PEER client,
 * which must not trust an owner socket until it proved it knows the token.
 */
export function verifyWelcomeProof(
  token: string,
  helloNonce: string,
  proof: string,
): boolean {
  const expected = Buffer.from(
    hmacHex(token, `manta/welcome/${helloNonce}`),
    "hex",
  );
  let actual: Buffer;
  try {
    actual = Buffer.from(proof, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
