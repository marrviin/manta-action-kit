/**
 * Wire protocol between the local MCP server (WebSocket SERVER, this package) and
 * the Chrome extension (WebSocket CLIENT). Mirror of
 * packages/extension/lib/mcp/protocol.ts — keep the two in sync.
 *
 * The extension owns the data (IndexedDB), so the server forwards each agent tool
 * call as an `rpc` frame and awaits the matching `rpc-result` (correlated by id).
 */

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

/** Minimal shapes we need on the server side (structural, kept loose on purpose). */
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

/** A field-level data dependency between two calls (mirror of the extension type). */
export interface FieldDependency {
  id: string;
  fromSeq: number;
  fromPath: string;
  toSeq: number;
  toLocation: 'url' | 'query' | 'body' | 'header';
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

/** The primitive JSON kinds a SchemaNode can describe (mirror of extension type). */
export type SchemaKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

/** A structural description of a JSON value (mirror of the extension type). */
export interface SchemaNode {
  kind: SchemaKind;
  optional?: boolean;
  nullable?: boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  example?: string;
}

/** One request field whose value comes from an upstream endpoint's response (mirror). */
export interface EndpointInput {
  toLocation: 'url' | 'query' | 'body' | 'header';
  toPath: string;
  fromEndpointKey: string;
  fromPath: string;
}

/** One distinct endpoint contract distilled from a recording (mirror of extension type). */
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
  /**
   * Where this endpoint's request fields get their VALUES from (upstream endpoint +
   * response path), derived from the recording's flow. No literal values. Omitted
   * when nothing was inferred.
   */
  inputsFrom?: EndpointInput[];
}

/** Agent-supplied gateway request (no credentials — the extension injects those). */
export interface GatewayRequest {
  method: string;
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

/** A proxy rule (mirror of the extension type). */
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

/** One parsed Server-Sent Event (mirror of extension type). */
export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

/** Result of draining an SSE stream through the gateway (mirror of extension type). */
export interface GatewaySseResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  events: SseEvent[];
  endReason: 'complete' | 'stop-match' | 'idle' | 'max-events' | 'max-bytes' | 'timeout' | 'error';
  eventCount: number;
  errorText?: string;
  /** COUNT of the user's cookies injected (never names/values — see GatewayResponse). */
  injectedCookieCount: number;
}

export interface RpcResults {
  list_recordings: { recordings: Recording[] };
  get_recording: { recording: Recording | null; calls: ApiCall[]; descriptionHint?: string };
  get_call: { call: ApiCall | null };
  get_flow: { flow: RecordingFlow | null };
  get_endpoints: { endpoints: EndpointSummary[] };
  set_recording_description: { recording: Recording | null };
  proxy_fetch: GatewayResponse;
  proxy_sse: GatewaySseResponse;
  proxy_rule: GatewayResponse & { matched: boolean; error?: string };
  list_proxy_rules: { rules: GatewayProxyRule[] };
  add_proxy_rule: { rule: GatewayProxyRule };
  update_proxy_rule: { rule: GatewayProxyRule };
  /** Persist a new proxy port in the extension so its scripts' baseURL stays in sync. */
  set_proxy_port: { proxyPort: number };
}

/**
 * Hello frame sent right after a socket opens to declare who is dialing in:
 *  - `extension`: the Chrome extension (owns the data / cookies).
 *  - `peer`: another MCP server process that lost the port race and now forwards
 *    its agent's tool calls to us (the owner) instead of talking to the extension
 *    directly. See index.ts's single-instance election.
 */
export interface HelloFrame {
  type: 'hello';
  role: 'extension' | 'peer';
  version: string;
}

export interface RpcRequestFrame {
  type: 'rpc';
  id: string;
  method: RpcMethod;
  params: unknown;
}

export type RpcResultFrame =
  | { type: 'rpc-result'; id: string; ok: true; result: unknown }
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

/** Frames a client (extension or peer) may send to the owner. */
export type ClientFrame = HelloFrame | RpcResultFrame | PeerRpcRequestFrame;

/** Frames the owner may send back to a peer. */
export type PeerServerFrame = RpcRequestFrame | PeerRpcResultFrame;

export const DEFAULT_MCP_PORT = 8787;

/** Default port for the local HTTP proxy (script-driven gateway entry). */
export const DEFAULT_PROXY_PORT = 8788;
