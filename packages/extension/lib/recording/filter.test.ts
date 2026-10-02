import { describe, it, expect } from 'vitest';
import { isBlacklisted, matchesPattern } from './filter';
import type { RecordingFilterRule } from './types';

function rule(partial: Partial<RecordingFilterRule>): RecordingFilterRule {
  return {
    id: partial.pattern ?? 'r',
    pattern: '',
    enabled: true,
    createdAt: 0,
    ...partial,
  };
}

describe('matchesPattern', () => {
  it('matches a literal pattern exactly and case-insensitively', () => {
    expect(matchesPattern('https://a.com/api/x', 'https://a.com/api/x')).toBe(true);
    expect(matchesPattern('https://A.COM/api/x', 'https://a.com/api/x')).toBe(true);
    expect(matchesPattern('https://a.com/api/x/extra', 'https://a.com/api/x')).toBe(false);
  });

  it('treats * as any run of characters (full-string)', () => {
    expect(matchesPattern('https://a.com/v2/track?x=1', '*track*')).toBe(true);
    expect(matchesPattern('https://a.com/v2/track', '*/track')).toBe(true);
    // Full-string: a pattern without leading/trailing * does not do substring matches.
    expect(matchesPattern('https://a.com/v2/track', '/v2')).toBe(false);
  });

  it('escapes regex metacharacters in the pattern', () => {
    expect(matchesPattern('https://a.com/x?q=a.b+c', 'https://a.com/x?q=a.b+c')).toBe(true);
    expect(matchesPattern('https://a.com/x?q=aXb+c', 'https://a.com/x?q=a.b+c')).toBe(false);
  });

  it('empty / whitespace-only patterns never match', () => {
    expect(matchesPattern('https://a.com', '')).toBe(false);
    expect(matchesPattern('https://a.com', '   ')).toBe(false);
  });

  it('a URL is matched literally even when it contains regex-special chars', () => {
    expect(matchesPattern('https://a.com/a(b)', 'https://a.com/a(b)')).toBe(true);
  });
});

describe('isBlacklisted', () => {
  const rules = [
    rule({ pattern: '*telemetry*', enabled: true }),
    rule({ pattern: '*polling*', enabled: false }),
  ];

  it('drops urls matching an enabled rule', () => {
    expect(isBlacklisted('https://a.com/api/telemetry/ping', rules)).toBe(true);
  });

  it('ignores disabled rules', () => {
    expect(isBlacklisted('https://a.com/api/polling/now', rules)).toBe(false);
  });

  it('lets everything else through', () => {
    expect(isBlacklisted('https://a.com/api/orders', rules)).toBe(false);
    expect(isBlacklisted('https://a.com/api/orders', [])).toBe(false);
  });
});
