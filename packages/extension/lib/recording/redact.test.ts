import { describe, it, expect } from 'vitest';
import { isSensitiveKey, isSensitiveValue, redactExample, REDACTION_MASK } from './redact';

describe('isSensitiveKey', () => {
  it.each(['password', 'passwd', 'token', 'accessToken', 'apiKey', 'api_key', 'authorization', 'Cookie', 'sessionId', 'csrfToken', 'x-xsrf', 'privateKey', 'credential', 'signature'])(
    'flags %s as sensitive',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  it.each(['name', 'email_verified', 'orderId', 'title', 'count', 'status'])(
    'does not flag %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it('is case-insensitive', () => {
    expect(isSensitiveKey('ACCESS_TOKEN')).toBe(true);
  });
});

describe('isSensitiveValue', () => {
  it('flags a JWT', () => {
    expect(isSensitiveValue('eyJhbGciOi.eyJzdWIiOiJ1.SflKxwRJSMeKKF2QT')).toBe(true);
  });

  it('flags a long hex blob', () => {
    expect(isSensitiveValue('a3f5c9d2e1b4a6f8c0d2e4f6a8b0c2d4')).toBe(true);
  });

  it('flags an email', () => {
    expect(isSensitiveValue('alice@example.com')).toBe(true);
  });

  it('flags a long opaque base64-ish token', () => {
    expect(isSensitiveValue('AbCdEf01+/=GhIjKlMnOpQrStUvWxYz01')).toBe(true);
  });

  it('does not flag ordinary short strings', () => {
    expect(isSensitiveValue('hello')).toBe(false);
    expect(isSensitiveValue('12345')).toBe(false);
    expect(isSensitiveValue('New York')).toBe(false);
  });

  it('does not flag a plain long lowercase word', () => {
    // No digits/symbols/mixed-case → not treated as an opaque token.
    expect(isSensitiveValue('abcdefghijklmnopqrstuvwxyzabcdef')).toBe(false);
  });
});

describe('redactExample', () => {
  it('masks when the key is sensitive even if the value looks benign', () => {
    expect(redactExample('token', 'abc')).toBe(REDACTION_MASK);
  });

  it('masks when the value looks sensitive even under a benign key', () => {
    expect(redactExample('note', 'alice@example.com')).toBe(REDACTION_MASK);
  });

  it('returns the value unchanged when neither key nor value is sensitive', () => {
    expect(redactExample('city', 'Beijing')).toBe('Beijing');
  });
});
