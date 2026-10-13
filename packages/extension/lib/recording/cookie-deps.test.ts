/**
 * Cookie-source dependency detection tests. Pure pass over ApiCall[] plus an
 * injected cookie lookup — no extension APIs involved.
 */
import { describe, it, expect } from 'vitest';
import { inferCookieDependencies, cookieValueMatches, type CookieLookup } from './cookie-deps';
import type { ApiCall } from './types';

function call(partial: Partial<ApiCall> & Pick<ApiCall, 'seq' | 'url'>): ApiCall {
  return {
    id: `c${partial.seq}`,
    recordingId: 'r1',
    source: 'fetch',
    method: 'GET',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    statusText: 'OK',
    resHeaders: {},
    resBody: null,
    resIsJson: false,
    startedAt: 0,
    durationMs: 0,
    errored: false,
    ...partial,
  } as ApiCall;
}

const lookup =
  (...byUrl: Array<Record<string, string>>): CookieLookup =>
  async (url) => {
    const idx = Number(new URL(url).pathname.slice(1)) || 0;
    const map = byUrl[idx] ?? byUrl[0] ?? {};
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  };

describe('cookieValueMatches', () => {
  it('matches exact equality', () => {
    expect(cookieValueMatches('token-abc123', 'token-abc123')).toBe(true);
  });

  it('matches the cookie contained in the field (Bearer-style wrappers)', () => {
    expect(cookieValueMatches('Bearer token-abc123', 'token-abc123')).toBe(true);
    expect(cookieValueMatches('token=token-abc123; other', 'token-abc123')).toBe(true);
  });

  it('does NOT match the reverse containment (cookie swallowing the field)', () => {
    // A long base64 cookie happens to contain a short field value — noise.
    expect(cookieValueMatches('header', 'xxheaderxx-base64-padding')).toBe(false);
  });

  it('enforces the noise floor on the cookie value', () => {
    expect(cookieValueMatches('Bearer ab', 'ab')).toBe(false);
  });
});

describe('inferCookieDependencies', () => {
  it('links a csrf header fed by a same-named cookie (double-submit)', async () => {
    const calls = [
      call({
        seq: 0,
        url: 'https://api.x.com/0',
        reqHeaders: { 'X-XSRF-TOKEN': 'xsrf-value-1234' },
      }),
    ];
    const deps = await inferCookieDependencies(
      calls,
      lookup({ 'XSRF-TOKEN': 'xsrf-value-1234' }),
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({
      fromSeq: -1,
      fromPath: 'cookie:XSRF-TOKEN',
      toSeq: 0,
      toLocation: 'header',
      toPath: 'X-XSRF-TOKEN',
      origin: 'inferred',
    });
  });

  it('detects body leaves fed by a cookie too', async () => {
    const calls = [
      call({
        seq: 0,
        url: 'https://api.x.com/0',
        method: 'POST',
        reqBody: JSON.stringify({ _csrf: 'csrf-token-9999', keep: 1 }),
      }),
    ];
    const deps = await inferCookieDependencies(
      calls,
      lookup({ csrf: 'csrf-token-9999' }),
    );
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ toLocation: 'body', toPath: '_csrf', fromPath: 'cookie:csrf' });
  });

  it('never links the Cookie header itself (the gateway re-injects cookies)', async () => {
    const calls = [
      call({
        seq: 0,
        url: 'https://api.x.com/0',
        reqHeaders: { Cookie: 'session=sess-value-999; XSRF=xsrf-value-123' },
      }),
    ];
    const deps = await inferCookieDependencies(
      calls,
      lookup({ session: 'sess-value-999' }),
    );
    expect(deps).toHaveLength(0);
  });

  it('first matching cookie name wins per field; edges dedupe', async () => {
    const calls = [
      call({
        seq: 0,
        url: 'https://api.x.com/0',
        reqHeaders: { 'X-Token': 'shared-value-123' },
      }),
      call({
        seq: 1,
        url: 'https://api.x.com/1',
        reqHeaders: { 'X-Token': 'shared-value-123' },
      }),
    ];
    const deps = await inferCookieDependencies(
      calls,
      lookup({ a: 'shared-value-123', b: 'shared-value-123' }),
    );
    // Two calls → two edges (dedupe is per toSeq), each picking the first cookie.
    expect(deps).toHaveLength(2);
    expect(deps.every((d) => d.fromPath === 'cookie:a')).toBe(true);
  });

  it('skips values below the noise floor', async () => {
    const calls = [
      call({ seq: 0, url: 'https://api.x.com/0', reqHeaders: { 'X-Flag': 'on' } }),
    ];
    const deps = await inferCookieDependencies(calls, lookup({ flag: 'on' }));
    expect(deps).toHaveLength(0);
  });

  it('a failing cookie lookup skips the call without throwing', async () => {
    const calls = [call({ seq: 0, url: 'https://api.x.com/0' })];
    const deps = await inferCookieDependencies(calls, async () => {
      throw new Error('chrome.cookies exploded');
    });
    expect(deps).toHaveLength(0);
  });

  it('caps the number of edges at MAX_COOKIE_DEPS', async () => {
    const calls = Array.from({ length: 60 }, (_, i) =>
      call({
        seq: i,
        url: `https://api.x.com/${i}`,
        reqHeaders: { 'X-XSRF-TOKEN': 'xsrf-value-1234' },
      }),
    );
    const deps = await inferCookieDependencies(
      calls,
      lookup({ 'XSRF-TOKEN': 'xsrf-value-1234' }),
    );
    expect(deps.length).toBeLessThanOrEqual(50);
  });
});
