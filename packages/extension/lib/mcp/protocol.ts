/**
 * Wire protocol between the extension (WebSocket client) and the local MCP
 * server (WebSocket server in packages/mcp).
 *
 * MV3 service workers cannot listen on a port, so the extension dials OUT to the
 * MCP server. The server forwards agent tool calls as `rpc` frames; the extension
 * executes them against IndexedDB and replies with a matching `rpc-result`
 * (correlated by `id`). This mirror of the protocol lives in both packages —
 * keep packages/mcp/src/protocol.ts in sync when changing it.
 */
import type { ApiCall, EndpointSummary, FieldDependency, Recording } from '@/lib/recording/types';
import type {
  GatewayProxyRule,
  GatewayRequest,
  GatewayResponse,
  GatewaySseRequest,
  GatewaySseResponse,
} from '@/lib/gateway/types';

/** RPC methods the agent can invoke against the extension (this milestone). */
export type RpcMethod =
  | 'list_recordings'
  | 'get_recording'
  | 'get_call'
  | 'get_flow'
  | 'get_endpoints'
  | 'set_recording_description'
  | 'proxy_fetch'
  | 'proxy_sse'
  | 'proxy_rule'
  | 'list_proxy_rules'
  | 'add_proxy_rule'
  | 'update_proxy_rule'
  | 'set_proxy_port';

/** A script-driven proxy request tunneled from the MCP HTTP proxy (no agent). */
export interface ProxyRuleRequest {
  method: string;
  /** Full inbound path + query as received by the local proxy, e.g. "/api/order?x=1". */
  rawPath: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * One step in a recording's flow: a lightweight summary of a call (no headers or
 * bodies) keyed by its seq, so the agent can reason about the call chain cheaply.
 */
export interface FlowStep {
  seq: number;
  method: string;
  url: string;
  status: number;
}

/**
 * A recording's flow view: ordered steps plus the field dependencies linking them
 * (response of one step feeds the request of a later one). Returned by get_flow.
 */
export interface RecordingFlow {
  recordingId: string;
  name: string;
  steps: FlowStep[];
  deps: FieldDependency[];
}

/** Param/result shapes per method — single source of truth for both sides. */
export interface RpcMap {
  list_recordings: {
    params: void;
    result: { recordings: Recording[] };
  };
  get_recording: {
    params: { id: string };
    result: {
      recording: Recording | null;
      calls: ApiCall[];
      /**
       * Present only when the recording exists but has no description yet. A nudge
       * for the agent to analyze the calls/contracts and call
       * set_recording_description so downstream steps understand this recording.
       */
      descriptionHint?: string;
    };
  };
  get_call: {
    params: { callId: string };
    result: { call: ApiCall | null };
  };
  /**
   * Return a recording's FLOW: its calls as ordered, lightweight steps (no full
   * bodies) plus the inferred field dependencies between them. This is the
   * agent-facing "how do these calls chain together" view — cheaper than
   * get_recording and it makes the data-passing explicit (response of step N
   * feeds request of step M) instead of leaving the agent to reverse-infer it.
   */
  get_flow: {
    params: { id: string };
    result: { flow: RecordingFlow | null };
  };
  /**
   * Return a recording's distinct ENDPOINTS: its calls collapsed by method +
   * normalized URL path into interface contracts, with request/response bodies
   * inferred into redacted schemas (no real values). This is the agent-facing
   * "what interfaces exist here" view — deduped and safe, so an agent can learn a
   * site's API surface without wading through repetitive raw calls or credentials.
   */
  get_endpoints: {
    params: { id: string };
    result: { endpoints: EndpointSummary[] };
  };
  /**
   * Agent-facing: set/overwrite a recording's DESCRIPTION — a short natural-language
   * summary of what the recording captures (its business flow / intent), written by
   * the agent after understanding the calls (get_recording) and contracts
   * (get_endpoints). NOT user-editable in the UI; this is the ONLY way to author it.
   * A dedicated write path so the agent can never touch other recording fields.
   */
  set_recording_description: {
    params: { id: string; description: string };
    result: { recording: Recording | null };
  };
  /**
   * Forward one API call through the extension with the user's cookies injected.
   * The agent sends NO credentials. The human-in-the-loop gate is the MCP tool's
   * native permission prompt (requiresUserInteraction) — reaching here means the
   * user approved. The extension re-checks the master switch, injects cookies,
   * records the endpoint as authorized, and returns a sanitized response.
   */
  proxy_fetch: {
    params: { req: GatewayRequest };
    result: GatewayResponse;
  };
  /**
   * Forward an SSE (text/event-stream) call through the extension with cookies
   * injected, drain the stream (up to caps), and return the collected events.
   * Gated by the same native permission prompt as proxy_fetch.
   */
  proxy_sse: {
    params: { req: GatewaySseRequest };
    result: GatewaySseResponse;
  };
  /**
   * Script-driven proxy: the MCP HTTP proxy tunnels an inbound request here. The
   * extension matches it against the proxy rules by longest sandboxPrefix, rewrites
   * onto the rule's target, forwards with cookies injected, and returns a sanitized
   * response. `matched` is false when no enabled rule covers the path (→ HTTP 404 on
   * the proxy side). This RPC is internal (not an agent-facing MCP tool).
   */
  proxy_rule: {
    params: { req: ProxyRuleRequest };
    result: GatewayResponse & { matched: boolean; error?: string };
  };
  /**
   * Agent-facing: list all proxy rules (script-driven gateway entry). Read-only,
   * so the agent can discover which prefixes exist before adding/editing.
   */
  list_proxy_rules: {
    params: void;
    result: { rules: GatewayProxyRule[] };
  };
  /**
   * Agent-facing: create a proxy rule. The agent supplies prefix/target only
   * — it CANNOT set `enabled` (the human's kill switch); the extension
   * decides the initial enabled state.
   */
  add_proxy_rule: {
    params: {
      sandboxPrefix: string;
      targetBase: string;
    };
    result: { rule: GatewayProxyRule };
  };
  /**
   * Agent-facing: patch a proxy rule's CONTENT (prefix/target). The patch
   * structurally cannot carry `enabled` — an agent may never flip the kill
   * switch. Re-validated server-side (unique prefix, http(s) target).
   */
  update_proxy_rule: {
    params: {
      id: string;
      patch: {
        sandboxPrefix?: string;
        targetBase?: string;
      };
    };
    result: { rule: GatewayProxyRule };
  };
  /**
   * Persist a new proxy port in the extension's settings so proxy-rule scripts'
   * baseURL (http://127.0.0.1:<proxyPort><prefix>) stays in sync after the MCP
   * server rebinds its HTTP proxy at runtime (see the `rebind_proxy` tool).
   */
  set_proxy_port: {
    params: { proxyPort: number };
    result: { proxyPort: number };
  };
}

/** Frame the extension sends right after the socket opens. */
export interface HelloFrame {
  type: 'hello';
  role: 'extension';
  /** Extension version, for the server to log. */
  version: string;
}

/** Frame the server sends to invoke a method on the extension. */
export interface RpcRequestFrame<M extends RpcMethod = RpcMethod> {
  type: 'rpc';
  id: string;
  method: M;
  params: RpcMap[M]['params'];
}

/** Frame the extension sends back with the result (or an error). */
export type RpcResultFrame<M extends RpcMethod = RpcMethod> =
  | { type: 'rpc-result'; id: string; ok: true; result: RpcMap[M]['result'] }
  | { type: 'rpc-result'; id: string; ok: false; error: string };

/** Anything the extension may send to the server. */
export type ClientFrame = HelloFrame | RpcResultFrame;

/** Anything the server may send to the extension. */
export type ServerFrame = RpcRequestFrame;

/** Default port; overridable via the settings page / MANTA_WS_PORT env. */
export const DEFAULT_MCP_PORT = 8787;

/**
 * User-facing description of one MCP tool, for the MCP tab's tool list. `group`
 * drives display order/labeling: read-only tools vs. the cookie-injecting gateway
 * tools that carry a security implication. `sensitive` marks the tools whose kill
 * switch actually matters (the ones that act with the user's credentials).
 */
/**
 * A tool name shown in the MCP tab. Business tools map to an `RpcMethod` (executed
 * extension-side, gated by a kill switch). Ops tools (`health` / `rebind_proxy`)
 * run inside the MCP process itself, so they are not `RpcMethod`s and the
 * extension-side kill switch cannot affect them.
 */
export type ToolName = RpcMethod | 'health' | 'rebind_proxy';

export interface ToolInfo {
  method: ToolName;
  /**
   * Display grouping. `read`/`gateway` are business tools (extension-side,
   * togglable). `ops` are MCP-process-side ops/self-heal tools: shown with a
   * switch for consistency, but the switch is disabled (always on) because the
   * kill switch does not reach them.
   */
  group: 'read' | 'gateway' | 'ops';
  sensitive: boolean;
}

/**
 * i18n key builders for a tool's user-facing label/description in the MCP tab.
 * The catalog namespace is `mcpTools` with `<method>Label` / `<method>Desc` keys
 * (see lib/i18n/locales/*). These are what the USER sees and follow the UI
 * language; the tool definitions the AGENT sees live in packages/mcp/src/index.ts
 * and stay English.
 */
export const toolLabelKey = (method: ToolName) => `mcpTools.${method}Label` as const;
export const toolDescKey = (method: ToolName) => `mcpTools.${method}Desc` as const;

/** Ops tools run in the MCP process and cannot be toggled from the extension. */
export function isOpsTool(group: ToolInfo['group']): boolean {
  return group === 'ops';
}

/**
 * The tools exposed to the agent, in display order. Single source of truth for the
 * MCP tab's tool list and the per-tool enable checks (see settings.mcpToolEnabled).
 */
export const TOOL_REGISTRY: ToolInfo[] = [
  { method: 'list_recordings', group: 'read', sensitive: false },
  { method: 'get_recording', group: 'read', sensitive: false },
  { method: 'get_flow', group: 'read', sensitive: false },
  { method: 'get_endpoints', group: 'read', sensitive: false },
  { method: 'get_call', group: 'read', sensitive: false },
  { method: 'set_recording_description', group: 'read', sensitive: false },
  { method: 'proxy_fetch', group: 'gateway', sensitive: true },
  { method: 'proxy_sse', group: 'gateway', sensitive: true },
  { method: 'list_proxy_rules', group: 'gateway', sensitive: false },
  { method: 'add_proxy_rule', group: 'gateway', sensitive: true },
  { method: 'update_proxy_rule', group: 'gateway', sensitive: true },
  { method: 'health', group: 'ops', sensitive: false },
  { method: 'rebind_proxy', group: 'ops', sensitive: false },
];

/** A tool is enabled unless its stored value is explicitly `false` (default on). */
export function isToolEnabled(
  disabledMap: Partial<Record<RpcMethod, boolean>> | undefined,
  method: RpcMethod,
): boolean {
  return disabledMap?.[method] !== false;
}
