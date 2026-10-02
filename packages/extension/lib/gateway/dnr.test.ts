/**
 * dnr.ts tests: the pure helpers (cookie header build, referrer split) plus
 * forwardWithCookies against a stubbed chrome.* + global fetch — verifying the
 * DNR session rule is added with the injected Cookie/Referer, scoped to the
 * exact URL+method, and removed even when the fetch fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCookieHeader,
  splitReferrer,
  forwardWithCookies,
} from '@/lib/gateway/dnr';
import type { GatewayRequest } from '@/lib/gateway/types';

const updateSessionRules = vi.fn(async (_o?: unknown) => {});
const cookiesGetAll = vi.fn(async () => [] as chrome.cookies.Cookie[]);
const globalFetch = vi.fn(async (..._a: unknown[]) => new Response('ok'));

const cookie = (name: string, value: string, domain = 'example.com') =>
  ({ name, value, domain }) as chrome.cookies.Cookie;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', globalFetch);
  vi.stubGlobal('chrome', {
    cookies: { getAll: cookiesGetAll },
    declarativeNetRequest: { updateSessionRules },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildCookieHeader', () => {
  it('joins name=value pairs with "; " and is empty for no cookies', () => {
    expect(buildCookieHeader([cookie('a', '1'), cookie('b', '2=3')])).toBe(
      'a=1; b=2=3',
    );
    expect(buildCookieHeader([])).toBe('');
  });
});

describe('splitReferrer', () => {
  it('lifts a well-formed http(s) referer out of the headers', () => {
    const { headers, referrer } = splitReferrer({
      accept: 'text/html',
      referer: 'https://example.com/page?x=1',
    });
    expect(headers).toEqual({ accept: 'text/html' });
    expect(referrer).toBe('https://example.com/page?x=1');
  });

  it('drops malformed and non-http referers, keeps the rest', () => {
    expect(splitReferrer({ referer: 'not a url' }).referrer).toBeUndefined();
    expect(splitReferrer({ referer: 'ftp://x/' }).referrer).toBeUndefined();
    expect(splitReferrer({}).referrer).toBeUndefined();
    expect(splitReferrer().referrer).toBeUndefined(); // default param
  });
});

describe('forwardWithCookies', () => {
  const req = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: {},
    body: undefined,
    ...over,
  });

  it('injects a scoped Cookie DNR rule and removes it after the fetch', async () => {
    cookiesGetAll.mockResolvedValue([cookie('sid', 's1'), cookie('theme', 'dark')]);
    const { res, injectedCookieNames, cookieDomain } = await forwardWithCookies(req());
    expect(res.status).toBe(200);
    expect(injectedCookieNames).toEqual(['sid', 'theme']);
    expect(cookieDomain).toBe('example.com');

    expect(updateSessionRules).toHaveBeenCalledTimes(2);
    const add = (updateSessionRules.mock.calls[0]![0] as {
      addRules: { id: number; condition: { urlFilter: string; requestMethods: string[] }; action: { requestHeaders: { header: string; operation: string; value?: string }[] } }[];
    }).addRules[0]!;
    expect(add.condition.urlFilter).toBe('|https://api.example.com/x');
    expect(add.condition.requestMethods).toEqual(['get']);
    expect(add.action.requestHeaders).toEqual([
      { header: 'cookie', operation: 'set', value: 'sid=s1; theme=dark' },
    ]);
    const remove = (updateSessionRules.mock.calls[1]![0] as { removeRuleIds: number[] }).removeRuleIds;
    // The removal targets the same rule id the add used.
    const addIds = (updateSessionRules.mock.calls[0]![0] as { addRules: { id: number }[] }).addRules.map((r) => r.id);
    expect((updateSessionRules.mock.calls[1]![0] as { removeRuleIds: number[] }).removeRuleIds).toEqual(addIds);
  });

  it('also injects Referer via the same rule (forbidden header workaround)', async () => {
    await forwardWithCookies(
      req({ headers: { referer: 'https://example.com/from' } }),
    );
    const add = (updateSessionRules.mock.calls[0]![0] as {
      addRules: { action: { requestHeaders: { header: string }[] } }[];
    }).addRules[0]!;
    expect(add.action.requestHeaders.map((h) => h.header)).toEqual(['cookie', 'referer']);
    // And fetch receives it through the allowed referrer option, not headers.
    const [, init] = globalFetch.mock.calls[0] as [string, RequestInit & { referrer?: string }];
    expect(init.referrer).toBe('https://example.com/from');
  });

  it('skips the DNR rule entirely when there is nothing to inject', async () => {
    cookiesGetAll.mockResolvedValue([]);
    await forwardWithCookies(req());
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  it('removes the rule even when the fetch fails', async () => {
    cookiesGetAll.mockResolvedValue([cookie('sid', 's1')]);
    globalFetch.mockRejectedValueOnce(new Error('network down'));
    await expect(forwardWithCookies(req())).rejects.toThrow(/network down/);
    expect(updateSessionRules).toHaveBeenCalledTimes(2); // add + remove
  });
});
