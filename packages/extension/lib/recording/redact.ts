/**
 * Redaction helpers for the interface (schema) view. Before an endpoint's inferred
 * schema is shown to the user or handed to an agent, representative example scalars
 * are passed through here so credentials / PII never leak. This is deliberately a
 * pure, dependency-free module so it can be reused by schema.ts (per-leaf example
 * redaction) and unit-tested in isolation.
 *
 * Two independent signals mark a value as sensitive:
 *   1. its FIELD NAME looks secret (token, password, authorization, ...), or
 *   2. its VALUE looks secret (a JWT, a long hex/base64 blob, an email, ...).
 * Either one triggers masking. When in doubt we prefer to over-redact — a masked
 * example is a cosmetic loss; a leaked token is a security incident.
 */

/** Field names (case-insensitive substring match) that always mark a value secret. */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'auth',
  'cookie',
  'session',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'privatekey',
  'private_key',
  'credential',
  'signature',
  'csrf',
  'xsrf',
];

/** A JWT: three base64url segments separated by dots. */
const JWT_RE = /^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/;
/** A long hex blob (>=24 chars) — typical of hashes / signatures / api keys. */
const LONG_HEX_RE = /^[0-9a-f]{24,}$/i;
/** A long base64-ish blob (>=32 chars) — opaque tokens. */
const LONG_B64_RE = /^[A-Za-z0-9+/=_-]{32,}$/;
/** An email address. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when a field NAME suggests its value is a credential/secret. */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/** True when a VALUE looks like a credential/PII regardless of its field name. */
export function isSensitiveValue(value: string): boolean {
  if (JWT_RE.test(value)) return true;
  if (LONG_HEX_RE.test(value)) return true;
  if (EMAIL_RE.test(value)) return true;
  // base64-ish blobs are only suspicious when long AND not a plain word/number.
  if (LONG_B64_RE.test(value) && /[+/=_-]|[A-Z].*[a-z0-9]/.test(value)) return true;
  return false;
}

/** A fixed mask so redacted examples are visually obvious and never partial. */
export const REDACTION_MASK = '«redacted»';

/**
 * Produce a display-safe example for a scalar leaf. Masks the value when the key
 * OR the value itself looks sensitive; otherwise returns the value unchanged (it
 * is only ever a single representative sample, not the full dataset).
 *
 * @param key   The field/property name this value sits under ('' at the root).
 * @param value The stringified scalar sample.
 */
export function redactExample(key: string, value: string): string {
  if (isSensitiveKey(key) || isSensitiveValue(value)) return REDACTION_MASK;
  return value;
}
