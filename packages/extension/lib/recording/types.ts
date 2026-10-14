/**
 * Shared domain types for the API recording feature.
 * Single source of truth used by the injected hook, background, and UI.
 */
import type { SseEvent } from '@/lib/sse-parse';

export type { SseEvent };

/** A serialized header map (case-insensitive keys flattened to a plain object). */
export type HeaderMap = Record<string, string>;

/** How the API call was made. */
export type CallSource = 'fetch' | 'xhr' | 'eventsource';

/**
 * One captured API call — request input + response output + timing.
 * This is the payload emitted by the injected hook and stored in IndexedDB.
 */
export interface ApiCall {
  /** Stable id (uuid) assigned when captured. */
  id: string;
  /** FK to the owning recording. Empty while buffered in-flight. */
  recordingId: string;
  /** 0-based position within the recording's call chain. */
  seq: number;
  source: CallSource;
  method: string;
  url: string;
  reqHeaders: HeaderMap;
  /** Request body as text (JSON stringified / form text). null if none. */
  reqBody: string | null;
  status: number;
  statusText: string;
  resHeaders: HeaderMap;
  /** Response body as text. null if unreadable, or when streaming (see sseEvents). */
  resBody: string | null;
  /** Whether the response body looked like JSON (content-type or parse check). */
  resIsJson: boolean;
  /** True when the response was a stream (text/event-stream) captured as events. */
  streaming?: boolean;
  /** For streaming responses: the parsed SSE events, in order. */
  sseEvents?: SseEvent[];
  /** epoch ms when the request started. */
  startedAt: number;
  /** Total round-trip time in ms. */
  durationMs: number;
  /** True if the request threw (network error) rather than returning a response. */
  errored: boolean;
  /** Error message when errored. */
  errorText?: string;
  /**
   * 触发本调用的用户交互（停止录制时由 attachPrecedingInteractions 回填，取调用开始前
   * 5s 窗口内最近的一次，每次交互最多标记 5 个调用）；无此字段 = 调用前没有可感知的用户交互。仅是意图提示，
   * 不是因果证明——模型侧只当证据用，不做「无交互即无关」的硬规则。
   */
  precedingInteraction?: PrecedingInteraction;
}

/** 用户交互的种类。 */
export type InteractionKind = 'click' | 'submit' | 'change';

/**
 * 一次采集到的用户交互描述符（injected hook 在页面里构建，经 content 中继、background
 * 落 buffer，停止录制时整体存到 Recording.interactions）。只采「可读意图」（文本 +
 * 少量容器语义文本）与「参数语义」（change 的 name/value）；不采坐标/轨迹/id/cssPath。
 * 所有文本截断 + 脱敏（lib/recording/redact.ts），密码类控件的值永不采集。
 */
export interface CapturedInteraction {
  kind: InteractionKind;
  /** epoch ms，与 ApiCall.startedAt 对齐算 deltaMs。 */
  at: number;
  /** 元素自身可读文本 / aria-label，≤64 字符，脱敏。无文本的图标按钮可为空。 */
  text?: string;
  /** 向上最多 3 层祖先的语义文本（标题/aria-label/自身直接文本），每层 ≤32 字符，脱敏。 */
  containers?: string[];
  /** 事件时刻的页面路由快照（SPA 路由变化时每次点击各取一份）。 */
  page: { path: string; title?: string };
  /** 仅 change：表单控件的 name 属性——将来 Action 蒸馏的参数语义来源。 */
  name?: string;
  /** 仅 change：用户最终输入值，≤64 字符，脱敏；password 类控件永不采。 */
  value?: string;
}

/**
 * 挂在 ApiCall 上的瘦身交互描述：调用开始前 2s 窗口内最近一次用户交互。
 * UI 时间线与 MCP get_flow 直接读它，无需回查 Recording.interactions 原始时间线。
 */
export interface PrecedingInteraction {
  kind: InteractionKind;
  /** 该交互的可读文本（未截断副本来自已脱敏的 CapturedInteraction.text）。 */
  text?: string;
  /** 调用开始时刻距交互时刻的毫秒数（≥0）。 */
  deltaMs: number;
}

/**
 * The payload the injected hook emits per call. Same shape as ApiCall minus the
 * fields assigned later by the background (id/recordingId/seq).
 */
export type CapturedCall = Omit<ApiCall, 'id' | 'recordingId' | 'seq'>;

/**
 * Where in a request a dependency's value is injected. Mirrors the parts of an
 * ApiCall an inferred dependency can target.
 */
export type DependencyLocation = 'url' | 'query' | 'body' | 'header';

/**
 * One field-level data dependency between two calls in a recording's flow:
 * the value produced at `fromSeq` (JSON path `fromPath` in its response) reappears
 * as an input at `toSeq` (in `toLocation`, at `toPath`). Captured so an agent can
 * understand how calls chain together — the response of one feeds the request of
 * the next — instead of having to reverse-infer it from raw bodies.
 */
export interface FieldDependency {
  /** Stable id (uuid), so the UI can confirm/edit/remove a single dependency. */
  id: string;
  /**
   * Seq of the call that PRODUCED the value (its response). -1 for
   * cookie-sourced edges: the value comes from a browser cookie, not from any
   * recorded call — see `fromPath`'s `cookie:<NAME>` form.
   */
  fromSeq: number;
  /**
   * JSON path into the producing call's response body, e.g. "data.orderId".
   * Cookie-sourced edges instead carry `cookie:<NAME>` — the source cookie's
   * name, which is also the exact `{{cookie:NAME}}` template syntax the action
   * replay engine resolves to the live cookie value at execute time.
   */
  fromPath: string;
  /** Seq of the call that CONSUMES the value (its request). */
  toSeq: number;
  /** Which part of the consuming request the value appears in. */
  toLocation: DependencyLocation;
  /**
   * Where inside `toLocation` the value sits: a JSON path for body, a query key
   * for query, a header name for header, empty for a raw url match.
   */
  toPath: string;
  /** The literal value that linked the two calls (for display / verification). */
  value: string;
  /**
   * Confidence source. 'inferred' = produced by auto-detection (a candidate the
   * user may confirm/remove); 'confirmed' = user-approved; 'manual' = user-added.
   */
  origin: 'inferred' | 'confirmed' | 'manual';
}

/** The primitive JSON kinds a SchemaNode can describe (arrays/objects nest). */
export type SchemaKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

/**
 * 对一个请求字段的动态性判定：同一路径的值在回放（新会话、明天）时是否会变。
 * 判定是纯统计的（同一 endpoint 多次调用值全不同/全相同）；单观测叶子不打标。
 */
export interface FieldDynamism {
  /** varies=每次运行会变（该参数化） / stable=可写死 / uncertain。 */
  verdict: 'varies' | 'stable' | 'uncertain';
  /** 判定来源，恒为 'stats'（确定性统计判定）。 */
  source: 'stats';
  /** 置信度 (0..1)。 */
  confidence: number;
  /** epoch ms，本轮分析时间。 */
  analyzedAt: number;
}

/**
 * A structural description of a JSON value, inferred from one or more concrete
 * samples (see schema.ts). This is the "shape" of a request/response body with
 * the actual values dropped — what an agent needs to understand an endpoint's
 * contract without seeing (possibly sensitive) real data.
 */
export interface SchemaNode {
  /** The value kind. For mixed samples, the first-seen non-null kind wins. */
  kind: SchemaKind;
  /**
   * True when this field was absent in at least one sample (so an agent knows it
   * is not guaranteed). Always false at the root.
   */
  optional?: boolean;
  /** True when at least one sample had this field as null. */
  nullable?: boolean;
  /** For kind 'object': child field schemas keyed by property name. */
  properties?: Record<string, SchemaNode>;
  /** For kind 'array': the unified element schema (undefined for empty arrays). */
  items?: SchemaNode;
  /**
   * A single representative example scalar (redacted), purely illustrative. Only
   * set for primitive kinds; omitted for object/array.
   */
  example?: string;
  /**
   * 请求字段的动态性判定（lib/ai/field-dynamism.ts），只挂请求侧叶子；无此字段 = 证据不足未判定。
   */
  dynamism?: FieldDynamism;
}

/**
 * One distinct endpoint distilled from a recording's calls: all calls sharing the
 * same method + normalized URL path are aggregated into a single contract, with
 * request/response bodies collapsed into inferred, redacted schemas. This is the
 * "interface view" — what the endpoint looks like, independent of how many times
 * it was called or the concrete data that flowed through it.
 */
export interface EndpointSummary {
  /** Stable key: `${method} ${pathKey}` (see aggregate.ts). */
  key: string;
  method: string;
  /** URL path with volatile segments normalized (e.g. numeric ids -> ":id"). */
  pathKey: string;
  /** A representative full URL (the first call's), for display/reference. */
  sampleUrl: string;
  /** How many recorded calls collapsed into this endpoint. */
  callCount: number;
  /** Distinct response status codes observed, ascending. */
  statuses: number[];
  /** Inferred, redacted schema of the request body (null when no bodies seen). */
  requestSchema: SchemaNode | null;
  /** Inferred, redacted schema of the response body (null when no JSON bodies). */
  responseSchema: SchemaNode | null;
  /** Query parameter names observed across calls (deduped, sorted). */
  queryKeys: string[];
  /**
   * Where this endpoint's request fields get their VALUES from — the recording's
   * flow dependencies (see FieldDependency) re-keyed onto endpoints, so an agent can
   * read this one contract and know both the shape AND how to fill each linked field
   * (e.g. body.orderId comes from `GET /orders`'s response `.data[].id`). Omitted /
   * empty when no upstream source was inferred. Carries NO literal value (kept
   * redacted like the schemas) — just the source location.
   */
  inputsFrom?: EndpointInput[];
  /**
   * 各 query 参数的动态性判定（key = 参数名），见 FieldDynamism。无此字段 = 证据不足未判定。
   */
  queryDynamism?: Record<string, FieldDynamism>;
}

/**
 * One request field whose value is supplied by an upstream endpoint's response,
 * derived by re-keying a recording's FieldDependency from call-seq onto endpoint
 * keys. No literal value (redacted, like the schemas) — only where to read it from.
 */
export interface EndpointInput {
  /** Which part of THIS endpoint's request the value goes into. */
  toLocation: DependencyLocation;
  /** Field path / query key / header name inside `toLocation` (empty for raw url). */
  toPath: string;
  /**
   * The upstream endpoint that produces the value (`${method} ${pathKey}`).
   * Omitted for cookie-sourced inputs — see fromCookie.
   */
  fromEndpointKey?: string;
  /** JSON path into that upstream source's response body (empty for cookies). */
  fromPath: string;
  /**
   * Cookie-sourced input: the request field is fed by this browser cookie
   * (CSRF double-submit et al). Replay with a `{{cookie:<fromCookie>}}`
   * override on the matching request header.
   */
  fromCookie?: string;
}

/** A saved recording's metadata (list view). Calls live in a separate store. */
export interface Recording {
  id: string;
  /** User-editable display name. */
  name: string;
  /** Origin of the page that was recorded, e.g. https://example.com */
  origin: string;
  /** Full URL of the page when recording started. */
  url: string;
  createdAt: number;
  /** Number of API calls captured. */
  callCount: number;
  /**
   * Field-level data dependencies between calls (the recording's "flow"). Optional
   * for backward compatibility: recordings saved before this feature have none.
   * Auto-inferred on save; the user may confirm/edit them in the detail view.
   */
  deps?: FieldDependency[];
  /**
   * 请求字段动态性判定（lib/ai/field-dynamism.ts），按 endpoint key → 叶子
   * 路径（"body.<json path>" / "query.<key>"）两级索引。EndpointSummary/schema 是
   * 读取时从 calls 现算的，所以判定结果存这里（不落 per-call），读取时经
   * attachDynamism 挂回。叶子无标记 = 证据不足（单观测）未判定。
   */
  fieldDynamism?: Record<string, Record<string, FieldDynamism>>;
  /**
   * Agent-authored natural-language description of what this recording captures
   * (the business flow / intent behind the calls). NOT user-editable in the UI —
   * only an agent writes it via MCP (set_recording_description), so downstream
   * steps can grasp the recording's purpose without replaying every call. Optional
   * for backward compatibility: recordings saved before this feature have none.
   */
  description?: string;
  /** epoch ms when `description` was last written by an agent (for staleness hints). */
  descriptionUpdatedAt?: number;
  /**
   * 录制期间采集到的用户交互时间线（click/submit/change 描述符，时间升序，上限 300 条
   * 超出丢最旧）。仅落库 + UI 展示 + MCP 透出，作为调用链路的用户意图信号。
   * Optional：此功能之前保存的录制没有该字段。
   */
  interactions?: CapturedInteraction[];
}

/**
 * Live recording state, persisted in storage.session so it survives the MV3
 * service worker sleeping and is readable by popup/content.
 */
export interface RecordingState {
  active: boolean;
  /** Whether capture is temporarily paused (session stays active, calls dropped). */
  paused: boolean;
  /** Tab being recorded, if active. */
  tabId: number | null;
  /** Page origin being recorded. */
  origin: string | null;
  startedAt: number | null;
  /** Running count of calls captured so far. */
  count: number;
}

export const IDLE_RECORDING_STATE: RecordingState = {
  active: false,
  paused: false,
  tabId: null,
  origin: null,
  startedAt: null,
  count: 0,
};

/** The custom DOM event name the injected hook dispatches for each captured call. */
export const API_CALL_EVENT = 'manta-action-kit:api-call';

/** The custom DOM event name the injected hook dispatches for each captured user interaction. */
export const USER_INTERACTION_EVENT = 'manta-action-kit:user-interaction';

/**
 * A recording filter rule. Currently only a blacklist: while recording, any
 * captured call whose URL matches an enabled rule's wildcard pattern is dropped
 * (never persisted). Stored as structured config (see lib/storage.ts) so the
 * background session state machine can read it and the side panel can edit it.
 */
export interface RecordingFilterRule {
  /** Stable id (uuid). */
  id: string;
  /** Wildcard URL pattern; `*` matches any run of characters. Matched full & case-insensitively. */
  pattern: string;
  /** When false, the rule is inert (ignored during recording). */
  enabled: boolean;
  createdAt: number;
}
