/**
 * Gateway orchestrator tests. db / storage / confirm popup / dnr forwarding are
 * mocked; authorize (SSRF + domain policy) and the SSE parser stay real, so the
 * gate ORDER, the audit-log contract and the drain end-reasons are all verified
 * against the production logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  addGatewayLog: vi.fn(async () => {}),
}));
vi.mock('@/lib/storage', () => ({
  settings: {
    gatewayAllowDomains: { getValue: vi.fn(async () => []) },
    gatewayDenyDomains: { getValue: vi.fn(async () => []) },
    gatewayConfirmRequired: { getValue: vi.fn(async () => true) },
  },
}));
vi.mock('./confirm', () => ({
  requestGatewayConfirmation: vi.fn(),
}));
vi.mock('./dnr', () => ({
  forwardWithCookies: vi.fn(),
}));

import { addGatewayLog } from '@/lib/db';
import { settings } from '@/lib/storage';
import {
  runGatewayFetch,
  runGatewaySse,
  GatewayRefusedError,
  type ConfirmHostFn,
} from '@/lib/gateway/run';
import { requestGatewayConfirmation } from '@/lib/gateway/confirm';
import { forwardWithCookies } from '@/lib/gateway/dnr';
import type { GatewayRequest, GatewaySseRequest } from '@/lib/gateway/types';
import { SSE_IDLE_MS } from '@/lib/gateway/types';

const addLog = vi.mocked(addGatewayLog);
const confirmPopup = vi.mocked(requestGatewayConfirmation);
const forward = vi.mocked(forwardWithCookies);

const allow = vi.mocked(settings.gatewayAllowDomains.getValue);
const deny = vi.mocked(settings.gatewayDenyDomains.getValue);
const confirmRequired = vi.mocked(settings.gatewayConfirmRequired.getValue);

beforeEach(() => {
  vi.clearAllMocks();
  allow.mockResolvedValue([]);
  deny.mockResolvedValue([]);
  confirmRequired.mockResolvedValue(true);
});

const req = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
  method: 'GET',
  url: 'https://api.example.com/v1/x',
  headers: { accept: 'application/json', cookie: 'evil=1', authorization: 'Bearer t' },
  body: undefined,
  ...over,
});

/** Canned forwardWithCookies result. */
function forwardReturns(over: Partial<ResponseInit> = {}, body = 'ok') {
  forward.mockResolvedValue({
    res: new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=1' }, ...over }),
    injectedCookieNames: ['sid'],
    cookieDomain: 'example.com',
  });
}

const lastLog = (): any => addLog.mock.calls.at(-1)![0];

describe('gate ordering', () => {
  it('blocks an invalid URL before any policy or forwarding', async () => {
    await expect(
      runGatewayFetch(req({ url: 'ftp://x/y' })),
    ).rejects.toThrow(/Invalid URL/);
    expect(lastLog()).toMatchObject({ decision: 'blocked', errored: false });
    expect(forward).not.toHaveBeenCalled();
    expect(addLog).toHaveBeenCalledTimes(1);
  });

  it('SSRF guard wins over the allowlist', async () => {
    allow.mockResolvedValue(['localhost']);
    await expect(
      runGatewayFetch(req({ url: 'http://localhost:8080/admin' })),
    ).rejects.toThrow(GatewayRefusedError);
    expect(forward).not.toHaveBeenCalled();
    expect(lastLog()).toMatchObject({ decision: 'blocked', authSource: null });
  });

  it('denylist refusal wins over the allowlist and never confirms', async () => {
    deny.mockResolvedValue(['api.example.com']);
    allow.mockResolvedValue(['api.example.com']);
    await expect(runGatewayFetch(req())).rejects.toThrow(/denylist/);
    expect(confirmPopup).not.toHaveBeenCalled();
    expect(lastLog()).toMatchObject({ decision: 'blocked', authSource: 'denylist' });
  });

  it('allowlist auto-allows without a popup and forwards', async () => {
    allow.mockResolvedValue(['example.com']);
    forwardReturns();
    const res = await runGatewayFetch(req());
    expect(confirmPopup).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(lastLog()).toMatchObject({ decision: 'auto', authSource: 'allowlist' });
  });

  it('confirmation-off auto-allows attributed to the path', async () => {
    confirmRequired.mockResolvedValue(false);
    forwardReturns();
    await runGatewayFetch(req());
    expect(confirmPopup).not.toHaveBeenCalled();
    expect(lastLog()).toMatchObject({ decision: 'auto', authSource: 'agent' });
  });

  it('a declined popup blocks with the audit row and no forward', async () => {
    confirmPopup.mockResolvedValue(false);
    await expect(runGatewayFetch(req())).rejects.toThrow(/user declined/);
    expect(forward).not.toHaveBeenCalled();
    expect(lastLog()).toMatchObject({ decision: 'blocked' });
  });

  it('an approved popup forwards and logs authSource prompt', async () => {
    confirmPopup.mockResolvedValue(true);
    forwardReturns();
    await runGatewayFetch(req());
    expect(confirmPopup).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.example.com/v1/x', via: 'agent' }),
    );
    expect(lastLog()).toMatchObject({ decision: 'allowed', authSource: 'prompt' });
  });

  it('uses the injected confirmHost instead of the popup when provided', async () => {
    const confirmHost = vi.fn<ConfirmHostFn>().mockResolvedValue(true);
    forwardReturns();
    await runGatewayFetch(req(), { confirmHost });
    expect(confirmPopup).not.toHaveBeenCalled();
    expect(confirmHost).toHaveBeenCalledWith('api.example.com', expect.anything());
    expect(lastLog()).toMatchObject({ decision: 'allowed', authSource: 'prompt' });
  });
});

describe('forwarding + sanitize', () => {
  it('strips credential request headers and Set-Cookie from the response', async () => {
    forwardReturns();
    const res = await runGatewayFetch(req());
    const sent = forward.mock.calls[0]![0] as GatewayRequest;
    expect(sent.headers).toEqual({ accept: 'application/json' }); // cookie/authorization gone
    expect(res.headers).toEqual({ 'content-type': 'application/json' }); // set-cookie gone
    expect(res.injectedCookieCount).toBe(1);
  });

  it('caps oversized bodies and flags truncation', async () => {
    forwardReturns({}, 'x'.repeat(100_001));
    const res = await runGatewayFetch(req());
    expect(res.truncated).toBe(true);
    expect(res.body!.length).toBe(100_000);
    expect(lastLog().resBodyPreview!.length).toBe(100_000);
  });

  it('maps a network failure to a plain error and logs errored', async () => {
    forward.mockRejectedValue(new TypeError('fetch failed'));
    await expect(runGatewayFetch(req())).rejects.toThrow(/Forward failed \(network\): fetch failed/);
    expect(lastLog()).toMatchObject({ errored: true, errorText: 'fetch failed' });
  });

  it('logs the cookie names only (never values) plus the domain', async () => {
    forwardReturns();
    await runGatewayFetch(req());
    const log = lastLog();
    expect(log.injectedCookieNames).toEqual(['sid']);
    expect(log.cookieDomain).toBe('example.com');
    expect(JSON.stringify(log)).not.toContain('evil=1');
  });
});

describe('SSE', () => {
  const sseReq = (over: Partial<GatewaySseRequest> = {}): GatewaySseRequest => ({
    method: 'POST',
    url: 'https://api.example.com/chat',
    headers: {},
    body: '{"q":1}',
    ...over,
  });

  function sseForward(chunks: string[], neverClosing = false) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(encoder.encode(ch));
        if (!neverClosing) c.close();
      },
    });
    forward.mockResolvedValue({
      res: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      injectedCookieNames: ['sid'],
      cookieDomain: 'example.com',
    });
  }

  it('drains to EOF with endReason complete and injects the SSE accept header', async () => {
    sseForward(['event: message\ndata: hi\n\n', 'data: bye\n\n']);
    const res = await runGatewaySse(sseReq());
    expect(res.endReason).toBe('complete');
    expect(res.eventCount).toBe(2);
    expect(res.events.map((e) => e.data)).toEqual(['hi', 'bye']);
    const sent = forward.mock.calls[0]![0] as GatewaySseRequest;
    expect(sent.headers!.accept).toBe('text/event-stream');
  });

  it('respects a caller-supplied accept header and stops on stopOnData', async () => {
    sseForward([
      'data: one\n\n',
      'data: [DONE]\n\n',
      'data: after\n\n',
    ]);
    const res = await runGatewaySse(sseReq({ headers: { accept: 'text/event-stream' }, stopOnData: '[DONE]' }));
    expect(res.endReason).toBe('stop-match');
    expect(res.events.map((e) => e.data)).toEqual(['one', '[DONE]']);
  });

  it('stops on stopOnEventName case-insensitively', async () => {
    sseForward(['event: chat_final\ndata: done\n\n']);
    const res = await runGatewaySse(sseReq({ stopOnEventName: 'CHAT_FINAL' }));
    expect(res.endReason).toBe('stop-match');
  });

  it('gives up on a silent never-closing stream with endReason idle', async () => {
    vi.useFakeTimers();
    try {
      sseForward(['data: hi\n\n'], true);
      const p = runGatewaySse(sseReq());
      const assertion = expect(p).resolves.toMatchObject({ endReason: 'idle', eventCount: 1 });
      await vi.advanceTimersByTimeAsync(SSE_IDLE_MS + 10);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a read error via endReason error + the audit row', async () => {
    forward.mockResolvedValue({
      res: new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error('stream blew up'));
          },
        }),
        { status: 200 },
      ),
      injectedCookieNames: [],
      cookieDomain: '',
    });
    const res = await runGatewaySse(sseReq());
    expect(res.endReason).toBe('error');
    expect(lastLog()).toMatchObject({ errored: true, errorText: 'stream blew up' });
  });

  it('SSE still passes the gate: blocked before forwarding', async () => {
    confirmPopup.mockResolvedValue(false);
    await expect(runGatewaySse(sseReq())).rejects.toThrow(/user declined/);
    expect(forward).not.toHaveBeenCalled();
  });
});
