/**
 * Shared domain types for the "action" feature: reusable, replayable API
 * sequences distilled from a recording by an agent.
 *
 * An action stores NO request material of its own — every step references a
 * recorded ApiCall by id (in the `calls` store). At execute time the recorded
 * request is re-read, overridden, and replayed through the sandbox gateway
 * (lib/gateway/run.ts), so credentials never live on the action record and the
 * same SSRF / header-stripping / audit machinery guards every replay.
 *
 * Authorship model: only agents create actions via MCP (create_action), the
 * side panel lists / renames / deletes them, and execution goes through the
 * execute_action tool, which is gated by the native permission prompt
 * (requiresUserInteraction) — the user confirms every run.
 */
import type { DependencyLocation } from "@/lib/recording/types";

/** Simple value kinds for an action's runtime parameters. */
export type ActionParamType = "string" | "number" | "boolean";

/**
 * One parameter the caller must (or may) supply when executing the action.
 * Params are referenced from override templates as `{{name}}` placeholders.
 */
export interface ActionParam {
  /** Parameter name used in templates, e.g. "orderId". */
  name: string;
  /** What the parameter is for, shown to agents and users. */
  description?: string;
  type: ActionParamType;
  required: boolean;
  /** Default used when the caller omits the param (implies optional in practice). */
  default?: string;
}

/** Which part of a step's (cloned recorded) request an override rewrites. */
export type OverrideLocation = DependencyLocation;

/**
 * One template-driven rewrite applied to a step's request before replay.
 * `value` may contain `{{param}}` placeholders (action params) and
 * `{{steps[N].outputs[X]}}`-style references — see lib/action/replay.ts for the
 * resolution grammar. Kept as a plain literal string so the stored action holds
 * no captured secret material (the gateway re-strips auth-ish headers anyway).
 */
export interface ActionOverride {
  /** Where in the request the value is injected. */
  toLocation: OverrideLocation;
  /**
   * Where inside `toLocation`: a JSON path for body, a query key for query, a
   * header name for header, empty for a raw url rewrite.
   */
  toPath: string;
  /** Template value with optional placeholders. */
  value: string;
}

/**
 * One replayable step: a recorded call plus the overrides to apply. Steps run
 * strictly in array order; later steps may consume earlier steps' outputs.
 */
export interface ActionStep {
  /** FK to the source ApiCall (calls store) — the request template. */
  callId: string;
  /** Whether to replay via the plain fetch or the SSE-drain gateway path. */
  kind: "fetch" | "sse";
  /** Rewrites applied to the recorded request before replay. */
  overrides?: ActionOverride[];
  /** Fixed wait before this step fires, in ms (capped by replay.ts). */
  waitMs?: number;
  /** Named JSON paths into this step's response, exposed to later templates. */
  outputs?: Record<string, string>;
}

/**
 * A saved action. Stored in the `actions` IndexedDB store (v10), keyed by id,
 * indexed by recordingId so a deleted recording's actions can be surfaced/
 * pruned. The UI shows name/description/steps; agents search by text.
 */
export interface Action {
  /** Stable id (uuid). */
  id: string;
  /** Short, searchable name, e.g. "track order shipment". */
  name: string;
  /** Agent-authored description: what this does, when to use it, caveats. */
  description: string;
  /** FK to the recording the steps were distilled from (traceability). */
  recordingId: string;
  /** Runtime parameters (validated before replay). */
  params: ActionParam[];
  /** The replayable call sequence. */
  steps: ActionStep[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Lightweight projection of an Action for list/search results — progressive
 * disclosure: discovery calls return this summary only, and the agent fetches
 * the full definition (steps, overrides, output paths) via get_action before
 * executing. Keeps token cost of browsing independent of action complexity.
 */
export interface ActionSummary {
  id: string;
  name: string;
  description: string;
  recordingId: string;
  /** Param name/type/required only (defaults and docs live in the full record). */
  params: Array<Pick<ActionParam, "name" | "type" | "required">>;
  /** How many steps the action runs (the steps themselves are in get_action). */
  stepCount: number;
  updatedAt: number;
}

/** Hard cap on a step's fixed wait, so a stored action can't stall a run. */
export const ACTION_MAX_WAIT_MS = 10_000;
/** Max steps in one action (guards runaway agent-authored sequences). */
export const ACTION_MAX_STEPS = 20;
/** Max chars of a response body preview kept per step in the run result. */
export const ACTION_RESULT_PREVIEW_CAP = 2_000;

/** One step's outcome inside an executed run. */
export interface ActionStepResult {
  /** 1-based step position. */
  index: number;
  callId: string;
  kind: "fetch" | "sse";
  /** Resolved request URL after overrides. */
  url: string;
  /** 'ok' — forwarded (even on 4xx/5xx); 'refused' — blocked before forwarding; 'error' — transport error. */
  outcome: "ok" | "refused" | "error";
  /** HTTP status (0 when no response was produced). */
  status: number;
  statusText: string;
  /** Truncated response preview (body text, or joined SSE event data). */
  bodyPreview: string | null;
  truncated: boolean;
  /** For SSE steps: collected event count. */
  eventCount?: number;
  /** Named outputs extracted from this step's response. */
  outputs: Record<string, string>;
  /** Set when outcome is 'refused' or 'error'. */
  errorText?: string;
  durationMs: number;
}

/** Result of one execute_action run. */
export interface ActionRunResult {
  actionId: string;
  actionName: string;
  /** epoch ms when the run started. */
  startedAt: number;
  /** Wall-clock duration of the whole run. */
  durationMs: number;
  /** 'complete' — every step forwarded; 'aborted' — a step failed and the run stopped there. */
  endReason: "complete" | "aborted";
  /** The failed step's 1-based index when endReason is 'aborted'. */
  failedStep?: number;
  /** Why the run aborted (mirrors the failing step's outcome). */
  failure?: "refused" | "error";
  steps: ActionStepResult[];
}
