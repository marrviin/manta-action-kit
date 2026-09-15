/**
 * Gateway orchestrator: the full lifecycle of one agent-requested call.
 *
 *   validate URL
 *     → inject cookies + fetch (see dnr.ts)
 *     → sanitize (strip auth-ish request headers, Set-Cookie response headers,
 *        truncate large bodies)
 *     → write an audit-log row (cookie values never stored)
 *     → return the sanitized response to the agent.
 *
 * The human-in-the-loop gate lives on the MCP/agent side as the tool's NATIVE
 * permission prompt: each proxy_fetch/proxy_sse tool carries
 * `_meta["anthropic/requiresUserInteraction"]`, so Claude Code forces a native
 * approval prompt before the tool runs — on every call, even in auto/bypass modes.
 * Reaching the forward RPC therefore means the user already approved. There is no
 * separate confirmation prompt here and no whitelist admission check: approving the
 * native prompt IS the authorization. The per-tool kill switch (handlers.ts) is the
 * only extension-side gate.
 *
 * Every terminal outcome (blocked / errored / ok) is logged exactly once.
 *
 * Runs in the background service worker (invoked from the RPC handlers).
 */
import { addGatewayLog } from '@/lib/db';
import { uuid, originOf } from '@/lib/utils';
import { parseHttpUrl, isBlockedHost } from './authorize';
import { forwardWithCookies } from './dnr';
import { createSseParser, type SseEvent } from '@/lib/sse-parse';
import {
  GATEWAY_BODY_CAP,
  SSE_IDLE_MS,
  SSE_MAX_BYTES,
  SSE_MAX_EVENTS,
  SSE_MAX_MS,
  type GatewayDecision,
  type GatewayLog,
  type GatewayRequest,
  type GatewayResponse,
  type GatewaySseRequest,
  type GatewaySseResponse,
} from './types';

/**
 * Which entrypoint invoked the gateway:
 *  - 'agent': the proxy_fetch/proxy_sse MCP tool (gated by a per-call native prompt).
 *  - 'rule': the script-driven proxy, authorized by an enabled proxy rule.
 */
export type GatewayVia = 'agent' | 'rule';

/** Request headers we never forward from the agent — credentials must come from us. */
const STRIPPED_REQUEST_HEADERS = new Set(['cookie', 'authorization']);

/** Response headers we never hand back to the agent (leak the user's session). */
const STRIPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

/** Error thrown when a call is refused; carries the decision for the caller/log. */
export class GatewayRefusedError extends Error {
  constructor(
    message: string,
    readonly decision: GatewayDecision,
  ) {
    super(message);
    this.name = 'GatewayRefusedError';
  }
}

/** Drop auth-ish headers the agent may have sent; return a clean copy. */
function sanitizeRequestHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const clean: Record<string, string> = {};
  if (!headers) return clean;
  for (const [k, v] of Object.entries(headers)) {
    if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    clean[k] = v;
  }
  return clean;
}

/** Copy response headers into a plain object, dropping Set-Cookie and friends. */
function sanitizeResponseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    out[key] = value;
  });
  return out;
}

/** Truncate a string to the body cap; report whether it was cut. */
function capBody(text: string | null): { body: string | null; truncated: boolean } {
  if (text == null) return { body: null, truncated: false };
  if (text.length <= GATEWAY_BODY_CAP) return { body: text, truncated: false };
  return { body: text.slice(0, GATEWAY_BODY_CAP), truncated: true };
}

/** Reason strings for a blocked call, reused by the audit rows. */
const blockBadUrl = (url: string) => `Invalid URL: ${url} (only http/https is supported).`;
const blockPrivateHost = (host: string) =>
  `Refused: ${host} is a loopback/private/link-local address. The gateway injects ` +
  `your cookies, so it never forwards to local or internal hosts (SSRF guard).`;

/**
 * Shared preamble for a forwarding call. Validates the URL (defense in depth —
 * never trust the caller) and returns the in-progress log + finish() so the caller
 * proceeds straight to forwarding. Throws GatewayRefusedError (after logging) when
 * the URL is invalid. There is no whitelist admission check and no confirmation
 * step here: the per-tool kill switch is enforced at the RPC entry (handlers.ts)
 * and the native tool prompt (requiresUserInteraction) already gated the agent path.
 */
async function prepareCall(
  req: GatewayRequest,
  kind: 'fetch' | 'sse',
  via: GatewayVia,
): Promise<{
  log: GatewayLog;
  reqHeaders: Record<string, string>;
  finish: () => Promise<void>;
}> {
  const { log, finish, reqHeaders } = startLog(req, kind);

  const parsed = parseHttpUrl(req.url);
  if (!parsed) {
    log.decision = 'blocked';
    await finish();
    throw new GatewayRefusedError(blockBadUrl(req.url), 'blocked');
  }

  // SSRF guard: never forward cookie-injected requests to loopback/private/
  // link-local hosts (localhost, 10.x, 192.168.x, 169.254.169.254 metadata, …).
  // Enforced for BOTH the agent and rule paths, since both reach here.
  if (isBlockedHost(parsed.host)) {
    log.decision = 'blocked';
    await finish();
    throw new GatewayRefusedError(blockPrivateHost(parsed.host), 'blocked');
  }

  if (via === 'rule') {
    // Script-driven path: authorization is the existence of the enabled proxy rule
    // (checked before we got here). No agent, no native prompt — record it as an
    // auto-allowed rule call.
    log.decision = 'auto';
    log.authSource = 'rule';
    return { log, reqHeaders, finish };
  }

  // Agent path: reaching here means the user approved the native prompt → authorized.
  log.decision = 'allowed';
  log.authSource = 'agent';
  return { log, reqHeaders, finish };
}

/** Build a fresh audit-log row + a finish() that stamps duration and persists once. */
function startLog(
  req: GatewayRequest,
  kind: 'fetch' | 'sse',
): { log: GatewayLog; finish: () => Promise<void>; reqHeaders: Record<string, string> } {
  const at = Date.now();
  const parsed = parseHttpUrl(req.url);
  const reqHeaders = sanitizeRequestHeaders(req.headers);
  const log: GatewayLog = {
    id: uuid(),
    at,
    kind,
    method: req.method,
    url: req.url,
    origin: parsed?.origin ?? originOf(req.url),
    host: parsed?.host ?? '',
    decision: 'blocked',
    authSource: null,
    injectedCookieNames: [],
    cookieDomain: '',
    reqHeaders,
    reqBodyPreview: capBody(req.body ?? null).body,
    status: 0,
    statusText: '',
    resHeadersSafe: {},
    resBodyPreview: null,
    durationMs: 0,
    errored: false,
  };
  const finish = async () => {
    log.durationMs = Date.now() - at;
    await addGatewayLog(log).catch((err) =>
      console.error('[gateway] failed to write audit log', err),
    );
  };
  return { log, finish, reqHeaders };
}

/**
 * Run one gateway call end to end. Resolves with a sanitized response, or throws
 * (GatewayRefusedError for policy refusals, a plain Error for network failures).
 * Always writes exactly one audit-log row.
 */
export async function runGatewayFetch(
  req: GatewayRequest,
  opts: { via?: GatewayVia } = {},
): Promise<GatewayResponse> {
  const { log, reqHeaders, finish } = await prepareCall(req, 'fetch', opts.via ?? 'agent');

  try {
    const { res, injectedCookieNames, cookieDomain } = await forwardWithCookies({
      ...req,
      headers: reqHeaders,
    });
    log.injectedCookieNames = injectedCookieNames;
    log.cookieDomain = cookieDomain;
    log.status = res.status;
    log.statusText = res.statusText;
    log.resHeadersSafe = sanitizeResponseHeaders(res);

    const rawBody = await res.text().catch(() => null);
    const { body, truncated } = capBody(rawBody);
    log.resBodyPreview = body;
    await finish();

    return {
      status: res.status,
      statusText: res.statusText,
      headers: log.resHeadersSafe,
      body,
      truncated,
      injectedCookieCount: injectedCookieNames.length,
    };
  } catch (err) {
    // fetch only rejects on a NETWORK-layer failure (DNS/connection/abort). HTTP
    // 4xx/5xx resolve normally and return via the branch above, so the agent still
    // sees them (with injectedCookieCount). Tag this so the agent can tell a network
    // failure apart from an HTTP error status.
    log.errored = true;
    log.errorText = err instanceof Error ? err.message : String(err);
    await finish();
    throw new Error(`Forward failed (network): ${log.errorText}`);
  }
}

/**
 * Run one SSE (text/event-stream) call: forward with cookies injected, then drain
 * the stream — parsing frames via the shared SSE parser — until one of these ends
 * it: EOF ('complete'), a caller-supplied stop condition ('stop-match'), an idle
 * gap ('idle'), or a hard cap (SSE_MAX_EVENTS / SSE_MAX_BYTES / SSE_MAX_MS). The
 * gateway makes NO assumption about a given API's "done" convention — the agent
 * passes stopOnEventName/stopOnData (learned from a recording) when it knows one.
 *
 * The GET is forced to `accept: text/event-stream` unless the caller set accept.
 */
export async function runGatewaySse(
  req: GatewaySseRequest,
): Promise<GatewaySseResponse> {
  const { log, reqHeaders, finish } = await prepareCall(req, 'sse', 'agent');

  // Default the Accept header for SSE if the agent didn't set one.
  const hasAccept = Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'accept');
  const headers = hasAccept ? reqHeaders : { ...reqHeaders, accept: 'text/event-stream' };

  try {
    const { res, injectedCookieNames, cookieDomain } = await forwardWithCookies({
      ...req,
      headers,
    });
    log.injectedCookieNames = injectedCookieNames;
    log.cookieDomain = cookieDomain;
    log.status = res.status;
    log.statusText = res.statusText;
    log.resHeadersSafe = sanitizeResponseHeaders(res);

    const drained = await drainSse(res, {
      stopOnEventName: req.stopOnEventName,
      stopOnData: req.stopOnData,
    });
    log.sseEventCount = drained.eventCount;
    // Store a compact preview of the joined event data for the audit log.
    log.resBodyPreview = capBody(drained.events.map((e) => e.data).join('\n')).body;
    if (drained.endReason === 'error') {
      log.errored = true;
      log.errorText = drained.errorText;
    }
    await finish();

    return {
      status: res.status,
      statusText: res.statusText,
      headers: log.resHeadersSafe,
      events: drained.events,
      endReason: drained.endReason,
      eventCount: drained.eventCount,
      errorText: drained.errorText,
      injectedCookieCount: injectedCookieNames.length,
    };
  } catch (err) {
    log.errored = true;
    log.errorText = err instanceof Error ? err.message : String(err);
    await finish();
    throw new Error(`SSE forward failed (network): ${log.errorText}`);
  }
}

/**
 * Read an SSE response body to completion (or a cap), parsing frames with the shared
 * SSE parser (createSseParser). The gateway itself knows NOTHING about any API's
 * "done" convention; it stops on:
 *  - EOF → 'complete'
 *  - a caller-supplied stop condition matching (stopOnEventName / stopOnData) →
 *    'stop-match' (the agent learns the real terminator from a recording)
 *  - no bytes for SSE_IDLE_MS → 'idle' (server kept the connection open after the
 *    final event; don't wait for EOF that won't come)
 *  - SSE_MAX_MS / SSE_MAX_EVENTS / SSE_MAX_BYTES → the matching cap reason
 *
 * The idle/overall deadlines are enforced by racing each read() against a timer, so
 * a silent, never-closing stream can't block forever.
 */
async function drainSse(
  res: Response,
  stop: { stopOnEventName?: string; stopOnData?: string } = {},
): Promise<{
  events: SseEvent[];
  eventCount: number;
  endReason: GatewaySseResponse['endReason'];
  errorText?: string;
}> {
  const events: SseEvent[] = [];
  if (!res.body) {
    return { events, eventCount: 0, endReason: 'complete' };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  const deadline = Date.now() + SSE_MAX_MS;
  let bytes = 0;
  let endReason: GatewaySseResponse['endReason'] = 'complete';
  let errorText: string | undefined;

  const stopName = stop.stopOnEventName?.toLowerCase();
  const stopData = stop.stopOnData?.trim().toLowerCase();
  const isStop = (ev: SseEvent): boolean => {
    if (stopName && ev.event?.toLowerCase() === stopName) return true;
    if (stopData && ev.data.trim().toLowerCase() === stopData) return true;
    return false;
  };

  /** Race a read() against idle + overall deadlines. Resolves 'idle'/'timeout' on cap. */
  const readWithTimeout = (): Promise<
    { kind: 'chunk'; value: Uint8Array } | { kind: 'done' } | { kind: 'idle' } | { kind: 'timeout' }
  > => {
    const msToOverall = deadline - Date.now();
    const wait = Math.max(0, Math.min(SSE_IDLE_MS, msToOverall));
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ kind: msToOverall <= SSE_IDLE_MS ? 'timeout' : 'idle' });
      }, wait);
      reader.read().then(
        ({ done, value }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (done) resolve({ kind: 'done' });
          else resolve({ kind: 'chunk', value: value as Uint8Array });
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          errorText = err instanceof Error ? err.message : String(err);
          resolve({ kind: 'done' }); // treat read error as end; errorText set below
        },
      );
    });
  };

  try {
    outer: for (;;) {
      const r = await readWithTimeout();
      if (r.kind === 'idle') {
        endReason = 'idle';
        break;
      }
      if (r.kind === 'timeout') {
        endReason = 'timeout';
        break;
      }
      if (r.kind === 'done') {
        endReason = errorText ? 'error' : 'complete';
        break;
      }
      bytes += r.value?.byteLength ?? 0;
      for (const ev of parser.push(decoder.decode(r.value, { stream: true }))) {
        events.push(ev);
        if (isStop(ev)) {
          endReason = 'stop-match';
          break outer;
        }
        if (events.length >= SSE_MAX_EVENTS) {
          endReason = 'max-events';
          break outer;
        }
      }
      if (bytes >= SSE_MAX_BYTES) {
        endReason = 'max-bytes';
        break;
      }
    }
    // Flush any trailing frame not terminated by a blank line (only on clean EOF).
    if (endReason === 'complete') {
      for (const ev of parser.flush()) events.push(ev);
    }
  } catch (err) {
    endReason = 'error';
    errorText = err instanceof Error ? err.message : String(err);
  } finally {
    reader.cancel().catch(() => {});
  }

  return { events, eventCount: events.length, endReason, errorText };
}
