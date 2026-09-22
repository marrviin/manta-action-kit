/**
 * Handshake auth cross-check: the extension's WebCrypto implementation must
 * produce EXACTLY what the MCP server's node:crypto twin
 * (packages/mcp/src/auth.ts) computes — the two sides never exchange the token,
 * so a mismatch would only surface as a failed handshake at runtime. These
 * tests use node:crypto as the ground truth for both proof directions and the
 * fixed domain-separation prefixes ("manta/welcome/", "manta/auth/").
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authProof, newNonce, verifyWelcomeProof } from "./auth";

const hmac = (token: string, message: string) =>
  createHmac("sha256", token).update(message).digest("hex");

describe("bridge handshake auth", () => {
  it("newNonce is a fresh non-empty string each call", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("verifyWelcomeProof accepts the proof node:crypto would compute", async () => {
    const ok = await verifyWelcomeProof("tok-1", "nonce-A", hmac("tok-1", "manta/welcome/nonce-A"));
    expect(ok).toBe(true);
  });

  it("verifyWelcomeProof rejects a wrong token / nonce / message", async () => {
    expect(await verifyWelcomeProof("tok-1", "nonce-A", hmac("tok-2", "manta/welcome/nonce-A"))).toBe(false);
    expect(await verifyWelcomeProof("tok-1", "nonce-A", hmac("tok-1", "manta/welcome/nonce-B"))).toBe(false);
    // A proof from the OTHER direction (auth prefix) must not pass as welcome.
    expect(await verifyWelcomeProof("tok-1", "nonce-A", hmac("tok-1", "manta/auth/nonce-A"))).toBe(false);
  });

  it("verifyWelcomeProof rejects malformed proofs (wrong length, empty)", async () => {
    const good = hmac("tok-1", "manta/welcome/nonce-A");
    expect(await verifyWelcomeProof("tok-1", "nonce-A", good.slice(0, 62))).toBe(false);
    expect(await verifyWelcomeProof("tok-1", "nonce-A", "")).toBe(false);
    // A single flipped hex char (same length) must not pass — exercises the
    // constant-time path.
    expect(await verifyWelcomeProof("tok-1", "nonce-A", good.slice(0, 63) + (good[63] === "0" ? "1" : "0"))).toBe(false);
  });

  it("authProof matches the node:crypto ground truth the server verifies", async () => {
    await expect(authProof("tok-1", "nonce-B")).resolves.toBe(hmac("tok-1", "manta/auth/nonce-B"));
  });
});
