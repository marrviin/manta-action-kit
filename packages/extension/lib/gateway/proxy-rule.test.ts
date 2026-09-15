import { describe, it, expect } from 'vitest';
import { normalizePrefix, validateProxyRuleInput, resolveProxyRule } from './proxy-rule';
import type { GatewayProxyRule } from './types';

/** Build a proxy rule with sensible defaults; override what a test cares about. */
function rule(
  partial: Partial<GatewayProxyRule> & Pick<GatewayProxyRule, 'sandboxPrefix' | 'targetBase'>,
): GatewayProxyRule {
  return {
    id: partial.id ?? `id-${partial.sandboxPrefix}`,
    enabled: partial.enabled ?? true,
    createdBy: partial.createdBy ?? 'user',
    createdAt: partial.createdAt ?? 0,
    sandboxPrefix: partial.sandboxPrefix,
    targetBase: partial.targetBase,
  };
}

describe('normalizePrefix', () => {
  it('adds a leading slash when missing', () => {
    expect(normalizePrefix('api')).toBe('/api');
  });

  it('strips a trailing slash', () => {
    expect(normalizePrefix('/api/')).toBe('/api');
  });

  it('collapses multiple trailing slashes', () => {
    expect(normalizePrefix('/api///')).toBe('/api');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePrefix('  /api  ')).toBe('/api');
  });

  it('leaves a lone root slash intact', () => {
    expect(normalizePrefix('/')).toBe('/');
  });
});

describe('validateProxyRuleInput', () => {
  it('accepts a well-formed prefix + https target', () => {
    expect(
      validateProxyRuleInput({ sandboxPrefix: '/api', targetBase: 'https://api.com/v1' }, []),
    ).toBeNull();
  });

  it('rejects an empty / root-only prefix', () => {
    expect(
      validateProxyRuleInput({ sandboxPrefix: '/', targetBase: 'https://api.com' }, []),
    ).not.toBeNull();
    expect(
      validateProxyRuleInput({ sandboxPrefix: '', targetBase: 'https://api.com' }, []),
    ).not.toBeNull();
  });

  it('rejects a prefix containing whitespace', () => {
    expect(
      validateProxyRuleInput({ sandboxPrefix: '/j d', targetBase: 'https://api.com' }, []),
    ).not.toBeNull();
  });

  it('rejects a non-URL target', () => {
    expect(
      validateProxyRuleInput({ sandboxPrefix: '/api', targetBase: 'not a url' }, []),
    ).not.toBeNull();
  });

  it('rejects a non-http(s) target scheme', () => {
    expect(
      validateProxyRuleInput({ sandboxPrefix: '/api', targetBase: 'ftp://api.com' }, []),
    ).not.toBeNull();
    expect(
      validateProxyRuleInput({ sandboxPrefix: '/api', targetBase: 'file:///etc/passwd' }, []),
    ).not.toBeNull();
  });

  it('rejects a prefix that collides with an existing rule', () => {
    const existing = [rule({ sandboxPrefix: '/api', targetBase: 'https://api.com' })];
    expect(
      validateProxyRuleInput({ sandboxPrefix: '/api/', targetBase: 'https://other.com' }, existing),
    ).not.toBeNull();
  });

  it('ignores the rule being edited when checking collisions', () => {
    const existing = [rule({ id: 'r1', sandboxPrefix: '/api', targetBase: 'https://api.com' })];
    expect(
      validateProxyRuleInput(
        { sandboxPrefix: '/api', targetBase: 'https://api.com/v2' },
        existing,
        'r1',
      ),
    ).toBeNull();
  });
});

describe('resolveProxyRule', () => {
  const rules = [
    rule({ sandboxPrefix: '/api', targetBase: 'https://api.com/v1' }),
    rule({ sandboxPrefix: '/api/orders', targetBase: 'https://orders.com' }),
  ];

  it('rewrites a matching request onto the target base', () => {
    const res = resolveProxyRule(rules, 'GET', '/api/user?id=1');
    expect(res).toEqual({ ok: true, url: 'https://api.com/v1/user?id=1', rule: rules[0] });
  });

  it('prefers the longest matching prefix', () => {
    const res = resolveProxyRule(rules, 'GET', '/api/orders/42');
    expect(res.ok && res.url).toBe('https://orders.com/42');
  });

  it('matches an exact prefix with no leftover path', () => {
    const res = resolveProxyRule(rules, 'GET', '/api');
    expect(res.ok && res.url).toBe('https://api.com/v1');
  });

  it('does not treat a prefix as matching a longer sibling segment', () => {
    // "/apix" must NOT match the "/api" rule.
    const res = resolveProxyRule(rules, 'GET', '/apix/thing');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(404);
  });

  it('404s when no rule matches', () => {
    const res = resolveProxyRule(rules, 'GET', '/unknown/path');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(404);
  });

  it('ignores disabled rules', () => {
    const disabled = [
      rule({ sandboxPrefix: '/api', targetBase: 'https://api.com', enabled: false }),
    ];
    const res = resolveProxyRule(disabled, 'GET', '/api/x');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(404);
  });

  it('502s on an invalid target base', () => {
    const bad = [rule({ sandboxPrefix: '/api', targetBase: 'not-a-url' })];
    const res = resolveProxyRule(bad, 'GET', '/api/x');
    expect(res.ok).toBe(false);
    expect(!res.ok && res.status).toBe(502);
  });

  // Security: a crafted rawPath must never re-point the forward at another origin,
  // which would leak the target's cookies to an attacker-chosen host.
  it('rejects a protocol-relative escape (//evil.com)', () => {
    const res = resolveProxyRule(rules, 'GET', '/api//evil.com/steal');
    // Either it stays on-origin (path segment) or is rejected as an escape — never
    // resolves to evil.com.
    if (res.ok) {
      expect(new URL(res.url).origin).toBe('https://api.com');
    } else {
      expect(res.status).toBe(502);
    }
  });

  it('keeps the query string intact', () => {
    const res = resolveProxyRule(rules, 'GET', '/api/search?q=hello&page=2');
    expect(res.ok && res.url).toBe('https://api.com/v1/search?q=hello&page=2');
  });
});
