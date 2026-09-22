/**
 * Wire protocol between the Chrome extension (WebSocket CLIENT) and the local
 * MCP server (WebSocket SERVER, packages/mcp) — the SINGLE SOURCE OF TRUTH for
 * both sides. Previously mirrored by hand in packages/mcp/src/protocol.ts and
 * packages/extension/lib/mcp/protocol.ts; a change here now reaches both
 * packages at compile time instead of relying on a "keep in sync" comment.
 *
 * MV3 service workers cannot listen on a port, so the extension dials OUT to the
 * MCP server. The server forwards agent tool calls as `rpc` frames; the extension
 * executes them against IndexedDB and replies with a matching `rpc-result`
 * (correlated by `id`).
 *
 * Domain types (Recording, ApiCall, Gateway*, Action*, ...) are declared here
 * structurally: the extension's richer internal types (lib/recording/types.ts,
 * lib/gateway/types.ts, lib/action/types.ts) are checked to be assignable to
 * these via the RPC map, so the two views cannot drift silently. The server side
 * imports nothing but this package.
 *
 * Pure types + constants — zero runtime code, no dependency on DOM or node
 * builtins — so both the extension build (bundler resolution) and the MCP
 * server build (NodeNext resolution) can consume it directly from source.
 */

// ---------------------------------------------------------------------------
// Domain types (wire shape)
// ---------------------------------------------------------------------------

/** One parsed Server-Sent Event. */
export interface SseEvent {
  /** The event's `event:` field, if any (defaults to "message" per the SSE spec). */
  event?: string;
  /** The event's `id:` field, if any. */
  id?: string;
  /** The joined `data:` lines for this event. */
  data: string;
}

/** A saved recording's metadata as it crosses the wire. */
export interface Recording {
  id: string;
  name: string;
  origin: string;
  url: string;
  createdAt: number;
  callCount: number;
  /** Agent-authored summary of what this recording captures (set via set_recording_description). */
  description?: string;
  /** epoch ms when `description` was last written by an agent. */
  descriptionUpdatedAt?: number;
}

/** One captured API call — request input + response output + timing. */
export interface ApiCall {
  id: string;
  recordingId: string;
  seq: number;
  source: string;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  status: number;
  statusText: string;
  resHeaders: Record<string, string>;
  resBody: string | null;
  resIsJson: boolean;
  /** True when the response was a stream (text/event-stream) captured as events. */
  streaming?: boolean;
  /** For streaming responses: the parsed SSE events, in order. */
  sseEvents?: SseEvent[];
  startedAt: number;
  durationMs: number;
  errored: boolean;
  errorText?: string;
}

/** Where in a request a dependency's value is injected. */
export type DependencyLocation = 'url' | 'query' | 'body' | 'header';

/** A field-level data dependency between two calls in a recording's flow. */
export interface FieldDependency {
  id: string;
  fromSeq: number;
  fromPath: string;
  toSeq: number;
  toLocation: DependencyLocation;
  toPath: string;
  value: string;
  origin: 'inferred' | 'confirmed' | 'manual';
}

/** A lightweight call summary in a flow (no headers/bodies). */
export interface FlowStep {
  seq: number;
  method: string;
  url: string;
  status: number;
}

/** A recording's flow view: ordered steps + the dependencies linking them. */
export interface RecordingFlow {
  recordingId: string;
  name: string;
  steps: FlowStep[];
  deps: FieldDependency[];
}

/** The primitive JSON kinds a SchemaNode can describe. */
export type SchemaKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

/** A structural description of a JSON value (shape with values dropped). */
export interface SchemaNode {
  kind: SchemaKind;
  optional?: boolean;
  nullable?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  /** A single representative example scalar (redacted). */
  example?: string;
}

/** One request field whose value comes from an upstream endpoint's response. */
export interface EndpointInput {
  toLocation: DependencyLocation;
  toPath: string;
  fromEndpointKey: string;
  fromPath: string;
}

/** One distinct endpoint contract distilled from a recording. */
export interface EndpointSummary {
  key: string;
  method: string;
  pathKey: string;
  sampleUrl: string;
  callCount: number;
  statuses: number[];
  requestSchema: SchemaNode | null;
  responseSchema: SchemaNode | null;
  queryKeys: string[];
  /** Upstream sources for this endpoint's request fields. Omitted when nothing was inferred. */
  inputsFrom?: EndpointInput[];
}

/** HTTP methods the gateway accepts from an agent (mirrors the extension's GatewayMethod). */
export type GatewayMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/** Agent-supplied gateway request (no credentials — the extension injects those). */
export interface GatewayRequest {
  method: GatewayMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Agent-supplied SSE request: a request plus optional, caller-supplied stop marks. */
export interface GatewaySseRequest extends GatewayRequest {
  stopOnEventName?: string;
  stopOnData?: string;
}

/** A script-driven proxy request tunneled from the local HTTP proxy (no agent). */
export interface ProxyRuleRequest {
  method: string;
  /** Full inbound path + query as received by the local proxy, e.g. "/api/order?x=1". */
  rawPath: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A proxy rule for the script-driven gateway entry. */
export interface GatewayProxyRule {
  id: string;
  sandboxPrefix: string;
  targetBase: string;
  enabled: boolean;
  createdBy: 'user' | 'agent';
  createdAt: number;
}

/** Sanitized gateway response (no Set-Cookie; body may be truncated). */
export interface GatewayResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  truncated: boolean;
  /**
   * COUNT of the user's cookies injected into the request (never names/values). If a
   * 401/403 comes back with 0 here, the user isn't logged in to that site — surface
   * that to the user instead of retrying.
   */
  injectedCookieCount: number;
}

/** Result of draining an SSE stream through the gateway. */
export interface GatewaySseResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  events: SseEvent[];
  endReason:
    | 'complete'
    | 'stop-match'
    | 'idle'
    | 'max-events'
    | 'max-bytes'
    | 'timeout'
    | 'error';
  eventCount: number;
  errorText?: string;
  /** COUNT of the user's cookies injected (never names/values — see GatewayResponse). */
  injectedCookieCount: number;
}

/** Where an action override writes its templated value. */
export type OverrideLocation = DependencyLocation;

/** Simple value kinds for an action's runtime parameters. */
export type ActionParamType = 'string' | 'number' | 'boolean';

/** A runtime parameter an action declares. */
export interface ActionParam {
  name: string;
  description?: string;
  type: ActionParamType;
  required: boolean;
  default?: string;
}

/** One templated override applied to a step's recorded request. */
export interface ActionOverride {
  toLocation: OverrideLocation;
  toPath: string;
  /** A template — {{param}} or {{steps[N].outputs[X]}} — never a recorded literal. */
  value: string;
}

/** One replay step: a recorded call referenced by callId, plus its overrides. */
export interface ActionStep {
  callId: string;
  kind: 'fetch' | 'sse';
  overrides?: ActionOverride[];
  waitMs?: number;
  /** Named JSON paths into the step's response, usable by later steps' templates. */
  outputs?: Record<string, string>;
}

/** A saved, replayable action (no credentials inside). */
export interface Action {
  id: string;
  name: string;
  description: string;
  recordingId: string;
  params: ActionParam[];
  steps: ActionStep[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Lightweight projection for list/search results (progressive disclosure);
 * get_action returns the full Action.
 */
export interface ActionSummary {
  id: string;
  name: string;
  description: string;
  recordingId: string;
  params: Array<{
    name: string;
    type: ActionParamType;
    required: boolean;
  }>;
  stepCount: number;
  updatedAt: number;
}

/** Outcome of one executed action step. */
export interface ActionStepResult {
  index: number;
  callId: string;
  kind: 'fetch' | 'sse';
  url: string;
  outcome: 'ok' | 'refused' | 'error';
  status: number;
  statusText: string;
  bodyPreview: string | null;
  truncated: boolean;
  eventCount?: number;
  outputs: Record<string, string>;
  errorText?: string;
  durationMs: number;
}

/** A full action run: every step's result, or the point where it aborted. */
export interface ActionRunResult {
  actionId: string;
  actionName: string;
  startedAt: number;
  durationMs: number;
  endReason: 'complete' | 'aborted';
  failedStep?: number;
  failure?: 'refused' | 'error';
  steps: ActionStepResult[];
}

// ---------------------------------------------------------------------------
// RPC methods + per-method param/result shapes
// ---------------------------------------------------------------------------

/** RPC methods the agent can invoke against the extension. */
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
  | 'set_proxy_port'
  | 'list_actions'
  | 'get_action'
  | 'search_actions'
  | 'create_action'
  | 'update_action'
  | 'delete_action'
  | 'execute_action';

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
   * bodies) plus the inferred field dependencies between them.
   */
  get_flow: {
    params: { id: string };
    result: { flow: RecordingFlow | null };
  };
  /**
   * Return a recording's distinct ENDPOINTS: calls collapsed by method +
   * normalized URL path into interface contracts with redacted schemas.
   */
  get_endpoints: {
    params: { id: string };
    result: { endpoints: EndpointSummary[] };
  };
  /**
   * Agent-facing: set/overwrite a recording's DESCRIPTION (the ONLY way to author
   * it). A dedicated write path so the agent can never touch other fields.
   */
  set_recording_description: {
    params: { id: string; description: string };
    result: { recording: Recording | null };
  };
  /**
   * Forward one API call through the extension with the user's cookies injected.
   * The agent sends NO credentials; a sanitized response comes back.
   */
  proxy_fetch: {
    params: { req: GatewayRequest };
    result: GatewayResponse;
  };
  /**
   * Forward an SSE (text/event-stream) call through the extension with cookies
   * injected, drain the stream (up to caps), and return the collected events.
   */
  proxy_sse: {
    params: { req: GatewaySseRequest };
    result: GatewaySseResponse;
  };
  /**
   * Script-driven proxy: the MCP HTTP proxy tunnels an inbound request here. The
   * extension matches it against the proxy rules by longest sandboxPrefix,
   * rewrites onto the rule's target, forwards with cookies injected, and returns
   * a sanitized response. `matched` is false when no enabled rule covers the path
   * (→ HTTP 404 on the proxy side). Internal (not an agent-facing MCP tool).
   */
  proxy_rule: {
    params: { req: ProxyRuleRequest };
    result: GatewayResponse & { matched: boolean; error?: string };
  };
  /**
   * Agent-facing: list all proxy rules (script-driven gateway entry). Read-only.
   */
  list_proxy_rules: {
    params: void;
    result: { rules: GatewayProxyRule[] };
  };
  /**
   * Agent-facing: create a proxy rule. The agent supplies prefix/target only —
   * it CANNOT set `enabled` (the human's kill switch).
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
   * baseURL stays in sync after the MCP server rebinds its HTTP proxy at runtime.
   */
  set_proxy_port: {
    params: { proxyPort: number };
    result: { proxyPort: number };
  };
  /**
   * Agent-facing: list all saved actions (most recent first), summaries only —
   * get_action fetches the full definition.
   */
  list_actions: {
    params: void;
    result: { actions: ActionSummary[] };
  };
  /** Agent-facing: fetch one action in full (params + steps). */
  get_action: {
    params: { id: string };
    result: { action: Action | null };
  };
  /**
   * Agent-facing: find saved actions by a case-insensitive substring match on
   * name/description (plus recordingId if given).
   */
  search_actions: {
    params: { query: string; recordingId?: string };
    result: { actions: ActionSummary[] };
  };
  /**
   * Agent-facing: create an action from a recording. Validated extension-side:
   * step count, waitMs, and callId existence. The extension mints
   * id/createdAt/updatedAt. NO credentials are stored (overrides are templates).
   */
  create_action: {
    params: {
      name: string;
      description: string;
      recordingId: string;
      params: ActionParam[];
      steps: ActionStep[];
    };
    result: { action: Action };
  };
  /**
   * Agent-facing: patch an action's content (name/description/params/steps).
   * Same validation as create_action. Cannot touch id/recordingId/timestamps.
   */
  update_action: {
    params: {
      id: string;
      patch: {
        name?: string;
        description?: string;
        params?: ActionParam[];
        steps?: ActionStep[];
      };
    };
    result: { action: Action | null };
  };
  /** Agent-facing: delete an action. Idempotent — deleting a missing id is ok. */
  delete_action: {
    params: { id: string };
    result: { deleted: boolean };
  };
  /**
   * Agent-facing: run an action. The agent supplies runtime values for the
   * action's params; the extension re-plays each step through the gateway
   * (cookies injected, SSRF-guarded, no credentials ever cross the wire).
   */
  execute_action: {
    params: {
      id: string;
      /**
       * Runtime param values. Scalars (number/boolean) are accepted and
       * stringified before templating; body overrides then restore the
       * recorded field's JSON type.
       */
      params?: Record<string, string | number | boolean>;
    };
    result: { run: ActionRunResult };
  };
}

/** Flattened result map, for callers that only await results (the MCP tool layer). */
export type RpcResults = {
  [M in keyof RpcMap]: RpcMap[M]['result'];
};

// ---------------------------------------------------------------------------
// Frame types (WebSocket wire format)
// ---------------------------------------------------------------------------

/**
 * Hello frame sent right after a socket opens to declare who is dialing in:
 *  - `extension`: the Chrome extension (owns the data / cookies).
 *  - `peer`: another MCP server process that lost the port race and now forwards
 *    its agent's tool calls to us (the owner) instead of talking to the extension
 *    directly. See index.ts's single-instance election.
 *
 * Carries a fresh nonce the server must answer with a token-derived proof
 * (see auth.ts on both sides) — the socket is untrusted until the
 * challenge-response exchange completes on both sides.
 */
export interface HelloFrame {
  type: 'hello';
  role: 'extension' | 'peer';
  /** Sender version, for the server to log. */
  version: string;
  /** Fresh random nonce; the server proves it knows the token over this. */
  nonce: string;
}

/**
 * Server's reply to a client's hello: proves the server knows the shared token
 * (which never crosses the wire) and challenges the client back.
 */
export interface WelcomeFrame {
  type: 'welcome';
  /** HMAC(token, "manta/welcome/" + hello.nonce) — verified by the client. */
  proof: string;
  /** Server's challenge nonce; the client answers with HMAC(token, "manta/auth/" + nonce). */
  nonce: string;
}

/** A client's answer to the welcome challenge: proves it knows the token. */
export interface AuthFrame {
  type: 'auth';
  proof: string;
}

/**
 * Frame the server sends to invoke a method on the extension. Strongly typed
 * per-method via `M`; the server relay constructs it with `params: unknown`
 * (cast at the send site) and the extension parses inbound frames with the
 * default `M = RpcMethod` union.
 */
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

/**
 * A peer process (a non-owner MCP server) asks the owner to run an RPC against
 * the extension on its behalf. Correlated back by `id` in a `peer-rpc-result`.
 */
export interface PeerRpcRequestFrame {
  type: 'peer-rpc';
  id: string;
  method: RpcMethod;
  params: unknown;
}

/** The owner's reply to a peer's `peer-rpc`, carrying the extension's result. */
export type PeerRpcResultFrame =
  | { type: 'peer-rpc-result'; id: string; ok: true; result: unknown }
  | { type: 'peer-rpc-result'; id: string; ok: false; error: string };

/**
 * Frames a client (the extension OR a peer process) may send to the owner
 * server: the handshake frames, RPC results (extension → server), and a peer's
 * delegated `peer-rpc` request.
 */
export type ClientFrame =
  | HelloFrame
  | RpcResultFrame
  | PeerRpcRequestFrame
  | AuthFrame;

/** Frames the server may send to the extension. */
export type ServerFrame = RpcRequestFrame | WelcomeFrame;

/** Frames a peer process may send to the owner. */
export type PeerClientFrame = HelloFrame | AuthFrame | PeerRpcRequestFrame;

/** Frames the owner may send back to a peer (or any pre-auth client). */
export type PeerServerFrame = RpcRequestFrame | PeerRpcResultFrame | WelcomeFrame;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default WS bridge port; overridable via the settings page / MANTA_WS_PORT env. */
export const DEFAULT_MCP_PORT = 8787;

/** Default port for the local HTTP proxy (script-driven gateway entry). */
export const DEFAULT_PROXY_PORT = 8788;

// ---------------------------------------------------------------------------
// Tool registry — shared by the MCP tab UI (kill switches) and the handlers
// ---------------------------------------------------------------------------

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
   * Display grouping. `read`/`gateway`/`action` are business tools
   * (extension-side, togglable). `ops` are MCP-process-side ops/self-heal
   * tools: shown with a switch for consistency, but the switch is disabled
   * (always on) because the kill switch does not reach them.
   */
  group: 'read' | 'gateway' | 'action' | 'ops';
  sensitive: boolean;
}

/** Ops tools run in the MCP process and cannot be toggled from the extension. */
export function isOpsTool(group: ToolInfo['group']): boolean {
  return group === 'ops';
}

/**
 * The tools exposed to the agent, in display order. Single source of truth for
 * the MCP tab's tool list and the per-tool enable checks (settings.mcpToolEnabled).
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
  { method: 'list_actions', group: 'action', sensitive: false },
  { method: 'get_action', group: 'action', sensitive: false },
  { method: 'search_actions', group: 'action', sensitive: false },
  { method: 'create_action', group: 'action', sensitive: true },
  { method: 'update_action', group: 'action', sensitive: true },
  { method: 'delete_action', group: 'action', sensitive: true },
  { method: 'execute_action', group: 'action', sensitive: true },
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
