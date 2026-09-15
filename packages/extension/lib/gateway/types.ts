/**
 * Shared domain types for the API gateway / sandbox feature.
 * Single source of truth used by the background orchestrator, MCP handlers, and UI.
 *
 * The gateway lets an agent invoke an API *through* the extension: the agent sends
 * only method/url/headers/body (never credentials), and the extension injects the
 * user's browser cookies at forward time (see lib/gateway/dnr.ts). Authorization is
 * the MCP tool's native permission prompt (requiresUserInteraction) on the agent
 * path, or an enabled proxy rule on the script path. Every call is written to an
 * audit log. Cookie *values* are never stored or returned to the agent.
 */

/** HTTP methods the gateway accepts from an agent. */
export type GatewayMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** What the agent asks the gateway to send (no credentials — those are injected). */
export interface GatewayRequest {
  method: GatewayMethod;
  url: string;
  /** Optional request headers. Auth-ish headers (cookie/authorization) are stripped. */
  headers?: Record<string, string>;
  /** Optional request body as text. */
  body?: string;
}

/** Sanitized response returned to the agent (no Set-Cookie, body may be truncated). */
export interface GatewayResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  /** True if the body was truncated to the size cap. */
  truncated: boolean;
  /**
   * How many of the user's cookies were injected into this request (COUNT only —
   * never the names or values, so nothing sensitive reaches the agent). Lets the
   * agent disambiguate an auth failure: a 401/403 with injectedCookieCount === 0
   * means the user isn't logged in to that site (tell them to log in, don't retry),
   * whereas > 0 means cookies were sent and the endpoint likely needs something else.
   */
  injectedCookieCount: number;
}

/** One parsed Server-Sent Event from a streamed response (shared with recording). */
export type { SseEvent } from '@/lib/sse-parse';
import type { SseEvent } from '@/lib/sse-parse';

/**
 * Parameters for an SSE (text/event-stream) gateway call. Same shape as a normal
 * request plus optional, caller-supplied stop conditions — the gateway itself makes
 * NO assumptions about a given API's "done" convention. The agent learns the real
 * terminator from a recording (get_recording) and passes it here.
 */
export interface GatewaySseRequest extends GatewayRequest {
  /** Stop once an event with this `event:` name arrives (case-insensitive). */
  stopOnEventName?: string;
  /** Stop once an event's data equals this string, trimmed (case-insensitive). */
  stopOnData?: string;
}

/**
 * Result of consuming an SSE stream through the gateway. MCP tool calls are
 * request/response, so the extension drains the stream (up to the caps below) and
 * returns the collected events in one shot — not a live per-token feed.
 */
export interface GatewaySseResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Events collected from the stream, in order. */
  events: SseEvent[];
  /**
   * Why the stream stopped being read.
   *  - complete: server closed the stream (EOF)
   *  - stop-match: a caller-supplied stopOnEventName/stopOnData condition matched
   *  - idle: no bytes arrived for SSE_IDLE_MS — server left the connection open
   *  - max-events / max-bytes / timeout: a hard cap was hit
   *  - error: the read threw
   */
  endReason: 'complete' | 'stop-match' | 'idle' | 'max-events' | 'max-bytes' | 'timeout' | 'error';
  /** Total events observed (== events.length unless capped). */
  eventCount: number;
  /** Set when endReason is 'error'. */
  errorText?: string;
  /** How many of the user's cookies were injected (count only — see GatewayResponse). */
  injectedCookieCount: number;
}

/** Caps for draining an SSE stream, so a long-lived stream can't hang the RPC. */
export const SSE_MAX_EVENTS = 2000;
export const SSE_MAX_BYTES = 1_000_000;
/** Overall wall-clock cap for reading a stream (< the MCP bridge call timeout). */
export const SSE_MAX_MS = 115_000;
/**
 * Idle cap: if no bytes arrive for this long, stop and return what we have. Many
 * SSE endpoints keep the connection open after the final event instead of closing
 * it, so waiting for EOF would hang until the overall cap. A short idle window lets
 * us return promptly once the stream goes quiet.
 */
export const SSE_IDLE_MS = 8_000;

/**
 * How a call was authorized (or null when it was blocked before forwarding).
 *  - 'agent': the proxy_fetch/proxy_sse MCP tool (gated by the native prompt).
 *  - 'rule': the script-driven proxy, authorized by an enabled proxy rule.
 */
export type GatewayAuthSource = 'agent' | 'rule' | null;

/** Outcome of a gateway call, recorded in the audit log. */
export type GatewayDecision =
  | 'auto' // script-driven proxy: authorized by an enabled proxy rule
  | 'allowed' // agent path: the native permission prompt was approved
  | 'blocked'; // invalid URL — never forwarded

/**
 * One audit-log row per gateway call. Sensitive material is redacted: cookie
 * values are never stored (only names), and auth request/response headers are dropped.
 */
export interface GatewayLog {
  /** Stable id (uuid). */
  id: string;
  /** epoch ms when the call was received. */
  at: number;
  /** Whether this call was a plain fetch or an SSE stream drain. */
  kind: 'fetch' | 'sse';
  method: string;
  url: string;
  origin: string;
  host: string;
  decision: GatewayDecision;
  authSource: GatewayAuthSource;
  /** Names of the cookies injected (values never stored). */
  injectedCookieNames: string[];
  /** Domain the injected cookies belonged to. */
  cookieDomain: string;
  /** Agent-provided headers, after stripping auth-ish ones. */
  reqHeaders: Record<string, string>;
  /** Truncated preview of the request body. */
  reqBodyPreview: string | null;
  status: number;
  statusText: string;
  /** Response headers, after stripping Set-Cookie and friends. */
  resHeadersSafe: Record<string, string>;
  /** Truncated preview of the response body (fetch) or joined event data (sse). */
  resBodyPreview: string | null;
  /** For SSE calls: how many events were collected. */
  sseEventCount?: number;
  durationMs: number;
  errored: boolean;
  errorText?: string;
}

/**
 * A proxy rule: the SECOND gateway entrypoint, for scripts (e.g. a skill's Python)
 * that call APIs directly instead of via the agent-driven proxy_fetch tool.
 *
 * A script points its baseURL at the local proxy the MCP server exposes
 * (http://127.0.0.1:<proxyPort><sandboxPrefix>); the request is tunneled to the
 * extension, matched against these rules by longest `sandboxPrefix`, rewritten onto
 * `targetBase`, then forwarded through the same cookie-injecting core as proxy_fetch.
 *
 * There is no per-call native prompt on this path (no agent), so AUTHORIZATION IS
 * the existence of an ENABLED rule: a disabled rule (or no match) is refused, never
 * forwarded. Each rule has its own `enabled` switch — the sole kill switch here.
 */
export interface GatewayProxyRule {
  /** Stable id (uuid). */
  id: string;
  /** Local path prefix on the proxy, normalized to a leading "/" and no trailing "/" (e.g. "/api"). */
  sandboxPrefix: string;
  /** Real target base: an http(s) origin, optionally with a base path (e.g. "https://api.com/v1"). */
  targetBase: string;
  /** When false, the rule is inert — matching requests are refused. */
  enabled: boolean;
  /** Who authored the rule: the human in the side panel, or the agent via MCP. */
  createdBy: 'user' | 'agent';
  createdAt: number;
}

/** Max bytes of request/response body kept in the audit log and returned to the agent. */
export const GATEWAY_BODY_CAP = 100_000;
