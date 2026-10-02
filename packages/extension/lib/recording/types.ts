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
 * laya 判定的一个调用与录制链路的相关性。停止录制后自动分析（lib/ai/relevance-run.ts），
 * 结果直接落在 ApiCall 上；旧记录无此字段视为未分析。
 */
export interface CallRelevance {
  /** 相关 / 疑似无关 / 不确定（模型置信度不足）。deps 锚点调用恒为 relevant。 */
  verdict: 'relevant' | 'irrelevant' | 'uncertain';
  /** 模型 answer_confidence (0..1)；deps 锚点强制 relevant 时为 1。 */
  confidence: number;
  /** role choice 的结果（如 "telemetry"），给出"为什么无关"的可读理由。 */
  role?: string;
  /** epoch ms，本轮分析时间。 */
  analyzedAt: number;
}

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
  /** laya 自动相关性分析结果；无此字段 = 未分析。 */
  relevance?: CallRelevance;
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
 * laya 对一条推断依赖边真实性的判定。只有 origin === 'inferred' 的边会被打标
 * （confirmed/manual 边是 ground truth，模型无权推翻）；无此字段 = 未分析。
 */
export interface DepCheck {
  /** likely=真实数据依赖 / unlikely=疑似巧合（时间戳、nonce 等撞车值） / uncertain。 */
  verdict: 'likely' | 'unlikely' | 'uncertain';
  /** 模型 answer_confidence (0..1)。 */
  confidence: number;
  /** epoch ms，本轮分析时间。 */
  analyzedAt: number;
}

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
  /** Seq of the call that PRODUCED the value (its response). */
  fromSeq: number;
  /** JSON path into the producing call's response body, e.g. "data.orderId". */
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
  /** laya 真实性判定（lib/ai/dep-confidence.ts）；仅 inferred 边会有。 */
  depCheck?: DepCheck;
}

/** The primitive JSON kinds a SchemaNode can describe (arrays/objects nest). */
export type SchemaKind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

/**
 * laya 对一个请求字段的动态性判定：同一路径的值在回放（新会话、明天）时是否会变。
 * `source: 'stats'` 是多观测的确定性事实（同一 endpoint 多次调用值全不同/全相同），
 * `'model'` 是单观测时 laya 的语义判断——下游采信 stats 优先于 model。
 */
export interface FieldDynamism {
  /** varies=每次运行会变（该参数化） / stable=可写死 / uncertain。 */
  verdict: 'varies' | 'stable' | 'uncertain';
  /** 'stats' = 确定性统计判定（模型未参与）；'model' = laya 判定。 */
  source: 'stats' | 'model';
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
   * laya 的字段动态性判定（lib/ai/field-dynamism.ts），只挂请求侧叶子；无此字段 = 未分析。
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
   * laya 对各 query 参数的动态性判定（key = 参数名），见 FieldDynamism。无此字段 = 未分析。
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
  /** The upstream endpoint that produces the value (`${method} ${pathKey}`). */
  fromEndpointKey: string;
  /** JSON path into that upstream endpoint's response body, e.g. "data[].id". */
  fromPath: string;
  /** laya 真实性判定（透传自源依赖边，仅 inferred 边会有）。 */
  depCheck?: DepCheck;
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
   * laya 的请求字段动态性判定（lib/ai/field-dynamism.ts），按 endpoint key → 叶子
   * 路径（"body.<json path>" / "query.<key>"）两级索引。EndpointSummary/schema 是
   * 读取时从 calls 现算的，所以判定结果存这里（不落 per-call），读取时经
   * attachDynamism 挂回。叶子无标记 = 未分析（stats 判定不了的且模型没跑/失败）。
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
  /** epoch ms when the laya relevance analysis last ran (absent = never analyzed). */
  relevanceAnalyzedAt?: number;
  /**
   * Lifecycle of the laya relevance analysis, so the detail view can show a
   * live status (incl. on reopen — persisted, not just broadcast). Absent =
   * never ran. `relevanceStatusAt` is the epoch ms of the last transition; a
   * stale `analyzing` (SW died mid-run) is detected by its age.
   */
  relevanceStatus?: 'analyzing' | 'done' | 'failed';
  relevanceStatusAt?: number;
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
