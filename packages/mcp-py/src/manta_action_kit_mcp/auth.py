"""WS bridge handshake auth (server + client side, stdlib hmac).

Twin of packages/mcp/src/auth.ts (node:crypto) and
packages/extension/lib/mcp/auth.ts (WebCrypto) — the domain-separation
prefixes and the HMAC-SHA256-over-hex scheme MUST stay in sync with them.

A socket is trusted only after:

  client → hello   { nonce }                                              (fresh per connection)
  server → welcome { proof = HMAC(token, "manta/welcome/" + helloNonce),
                     nonce }                                              ← client verifies
  client → auth    { proof = HMAC(token, "manta/auth/" + serverNonce) }  ← server verifies

The token itself never crosses the wire, so a port-squatting process can't
impersonate the server to the extension and a local process (or a web page
dialing ws://127.0.0.1) can't impersonate a client to us.
"""

import hmac
import hashlib
import uuid


def new_nonce() -> str:
    """A fresh random challenge nonce for one handshake (UUID, like the twins)."""
    return str(uuid.uuid4())


def hmac_hex(token: str, message: str) -> str:
    """HMAC-SHA256 over the message, keyed by the token, as lowercase hex."""
    return hmac.new(token.encode(), message.encode(), hashlib.sha256).hexdigest()


def welcome_proof(token: str, hello_nonce: str) -> str:
    """The `welcome` proof answering a client's hello nonce (server side)."""
    return hmac_hex(token, f"manta/welcome/{hello_nonce}")


def auth_proof(token: str, server_nonce: str) -> str:
    """The `auth` proof answering the server's challenge nonce (client side)."""
    return hmac_hex(token, f"manta/auth/{server_nonce}")


def _verify(expected_hex: str, proof: str) -> bool:
    """Constant-time check of a hex proof; malformed (non-hex) proofs fail too.

    Node's Buffer.from(proof, "hex") silently drops invalid characters, so a
    garbage proof just ends up with the wrong length and fails there — the
    ValueError → False path here matches that outcome.
    """
    try:
        actual = bytes.fromhex(proof)
    except ValueError:
        return False
    expected = bytes.fromhex(expected_hex)
    return hmac.compare_digest(actual, expected)


def verify_auth_proof(token: str, server_nonce: str, proof: str) -> bool:
    """Constant-time check of a client's `auth` answer to our challenge nonce."""
    return _verify(hmac_hex(token, f"manta/auth/{server_nonce}"), proof)


def verify_welcome_proof(token: str, hello_nonce: str, proof: str) -> bool:
    """Constant-time check of a server's `welcome` proof (peer/client side)."""
    return _verify(hmac_hex(token, f"manta/welcome/{hello_nonce}"), proof)
