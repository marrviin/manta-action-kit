/**
 * Action replay engine: execute a saved action's steps against the live site
 * through the sandbox gateway.
 *
 * Per step, the recorded ApiCall (referenced by callId) is re-read from the
 * `calls` store, cloned into a GatewayRequest, rewritten by the step's
 * overrides (template values resolved against runtime params + earlier steps'
 * outputs), and forwarded via runGatewayFetch / runGatewaySse — so every replay
 * gets the same cookie injection, SSRF guard, header stripping and audit log as
 * an agent-issued proxy_fetch. A refused or errored step ABORTS the run; HTTP
 * 4xx/5xx responses are still 'ok' (forwarded) and also abort only when a later
 * step's template depends on outputs this response couldn't provide.
 *
 * Template grammar (see types.ts):
 *   {{paramName}}                       — runtime parameter value
 *   {{steps[N].outputs[outputName]}}    — named output of step N (0-based)
 *
 * Pure engine — persistence and RPC plumbing live in db.ts / mcp/handlers.ts.
 */
import { getCalls } from "@/lib/db";
import {
  runGatewayFetch,
  runGatewaySse,
  GatewayRefusedError,
} from "@/lib/gateway/run";
import { requestGatewayConfirmation } from "@/lib/gateway/confirm";
import type {
  GatewayRequest,
  GatewayResponse,
  GatewaySseRequest,
  GatewaySseResponse,
} from "@/lib/gateway/types";
import type { ApiCall } from "@/lib/recording/types";
import {
  ACTION_MAX_STEPS,
  ACTION_MAX_WAIT_MS,
  ACTION_RESULT_PREVIEW_CAP,
  type Action,
  type ActionOverride,
  type ActionRunResult,
  type ActionStepResult,
  type ActionStep,
} from "./types";

/** Request headers we drop when cloning a recorded call — fetch re-derives them. */
const DROPPED_CLONE_HEADERS = new Set(["content-length", "host", "connection"]);

/** Values available to override templates while a run is in flight. */
interface TemplateContext {
  /** Resolved runtime params (defaults already applied). */
  params: Record<string, string>;
  /** Outputs extracted from finished steps, keyed by 0-based step index. */
  stepOutputs: Record<number, Record<string, string>>;
}

/**
 * Resolve a template string. Every placeholder must resolve — an unknown param
 * name or a reference to a missing/not-yet-produced output throws (the caller
 * treats it as a step failure, aborting the run).
 */
function resolveTemplate(tpl: string, ctx: TemplateContext): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_all, raw: string) => {
    const stepRef = /^steps\[(\d+)\]\.outputs\[(.+)\]$/.exec(raw);
    if (stepRef) {
      const idxStr = stepRef[1];
      const name = stepRef[2];
      if (idxStr === undefined || name === undefined) {
        throw new Error(`Malformed step output reference "${raw}"`);
      }
      const idx = Number(idxStr);
      const value = ctx.stepOutputs[idx]?.[name];
      if (value === undefined) {
        throw new Error(
          `Template references steps[${idx}].outputs[${name}], which produced no value`,
        );
      }
      return value;
    }
    const v = ctx.params[raw];
    if (v !== undefined) return v;
    throw new Error(`Template references unknown parameter "${raw}"`);
  });
}

/** Tokenize a dotted/bracketed path ("data[0].id") into keys and array indices. */
function tokenizePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) out.push(m[1]);
    else out.push(Number(m[2]));
  }
  return out;
}

/** Read a value out of a parsed JSON tree by dotted/bracketed path. */
function getByPath(node: unknown, path: string): unknown {
  let cur: unknown = node;
  for (const seg of tokenizePath(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/** Set a value inside a (mutable) JSON tree by dotted/bracketed path, creating parents. */
function setByPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segs = tokenizePath(path);
  if (!segs.length) {
    throw new Error(
      'Override with toLocation "body" needs a non-empty toPath (JSON path)',
    );
  }
  let cur: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const next = segs[i + 1];
    const container =
      next === undefined ? undefined : typeof next === "number" ? [] : {};
    if (typeof seg === "number") {
      if (!Array.isArray(cur))
        throw new Error(`Path mismatch at [${seg}]: parent is not an array`);
      while (cur.length <= seg) cur.push(undefined);
      if (cur[seg] === undefined || cur[seg] === null)
        cur[seg] = container as never;
      cur = cur[seg] as typeof cur;
    } else {
      if (Array.isArray(cur))
        throw new Error(`Path mismatch at "${seg}": parent is an array`);
      const existing = cur[seg];
      if (existing === undefined || existing === null)
        cur[seg] = container as never;
      cur = cur[seg] as typeof cur;
    }
  }
  const last = segs[segs.length - 1]!;
  if (typeof last === "number") {
    if (!Array.isArray(cur))
      throw new Error(`Path mismatch at [${last}]: parent is not an array`);
    while (cur.length <= last) cur.push(undefined);
    cur[last] = value;
  } else {
    if (Array.isArray(cur))
      throw new Error(`Path mismatch at "${last}": parent is an array`);
    cur[last] = value;
  }
}

/**
 * Coerce a resolved (string) override value into the JSON value a body target
 * expects. Templates are plain string interpolation, so a `{{pageNumber}}`
 * resolving to "1" would otherwise land in the JSON body as `"pageNumber": "1"`
 * — servers that typed the field as int reject that. The RECORDED body is the
 * ground truth for a field's type (it came from a real, accepted request), so:
 *   - existing number  → numeric coercion (non-numeric text fails loudly)
 *   - existing boolean → "true"/"false" (anything else fails loudly)
 *   - existing array/object (incl. a {{steps[N].outputs[X]}} that stringified
 *     one) → re-parsed as JSON
 *   - existing string / brand-new path → kept verbatim, EXCEPT a value that
 *     looks like a JSON container ("[...]" / "{...}") is parsed, so an agent
 *     can inject arrays/objects into new paths by passing JSON text.
 */
function coerceBodyValue(
  root: Record<string, unknown>,
  path: string,
  value: string,
): unknown {
  const existing = getByPath(root, path);
  if (typeof existing === "number") {
    const n = Number(value);
    if (Number.isNaN(n)) {
      throw new Error(
        `Body override at "${path}": recorded field is a number, but the template resolved to non-numeric ${JSON.stringify(value)}`,
      );
    }
    return n;
  }
  if (typeof existing === "boolean") {
    if (value !== "true" && value !== "false") {
      throw new Error(
        `Body override at "${path}": recorded field is a boolean, but the template resolved to ${JSON.stringify(value)} (expected "true"/"false")`,
      );
    }
    return value === "true";
  }
  if (existing !== null && typeof existing === "object") {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(
        `Body override at "${path}": recorded field is a JSON ${Array.isArray(existing) ? "array" : "object"}, but the template resolved to invalid JSON: ${JSON.stringify(value)}`,
      );
    }
  }
  // Existing string, or a path that doesn't exist in the recorded body: keep
  // the raw string unless it is unambiguous JSON container text.
  const trimmed = value.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON after all — fall through and keep the raw string.
    }
  }
  return value;
}

/** Clone a recorded call into a clean GatewayRequest template. */
function requestFromCall(call: ApiCall): GatewayRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.reqHeaders)) {
    if (DROPPED_CLONE_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  // Cookie/authorization aren't dropped here on purpose — runGatewayFetch strips
  // them anyway (defense in depth: a tampered action record can't smuggle creds).
  return {
    method: call.method as GatewayRequest["method"],
    url: call.url,
    headers,
    body: call.reqBody ?? undefined,
  };
}

/** Apply one resolved override to the request clone, in place. */
function applyOverride(
  req: GatewayRequest,
  ov: ActionOverride,
  value: string,
): void {
  switch (ov.toLocation) {
    case "header": {
      if (!ov.toPath)
        throw new Error(
          "Header override needs a non-empty toPath (header name)",
        );
      req.headers = { ...req.headers, [ov.toPath]: value };
      return;
    }
    case "query": {
      if (!ov.toPath)
        throw new Error("Query override needs a non-empty toPath (query key)");
      const url = new URL(req.url);
      url.searchParams.set(ov.toPath, value);
      req.url = url.toString();
      return;
    }
    case "url": {
      if (ov.toPath)
        throw new Error(
          "Url override must have an empty toPath (whole-url rewrite)",
        );
      // Any non-http(s) scheme dies later in the gateway's URL validation.
      req.url = value;
      return;
    }
    case "body": {
      let parsed: unknown;
      if (req.body) {
        try {
          parsed = JSON.parse(req.body);
        } catch {
          throw new Error("Body override: recorded request body is not JSON");
        }
      } else {
        parsed = {};
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error(
          "Body override: recorded request body must be a JSON object",
        );
      }
      const root = parsed as Record<string, unknown>;
      setByPath(root, ov.toPath, coerceBodyValue(root, ov.toPath, value));
      req.body = JSON.stringify(root);
      return;
    }
  }
}

/** Build the step result's preview text from a gateway response. */
function previewOf(res: GatewayResponse | GatewaySseResponse): {
  bodyPreview: string | null;
  truncated: boolean;
} {
  const text =
    "events" in res
      ? (res as GatewaySseResponse).events.map((e) => e.data).join("\n")
      : res.body;
  if (text == null) return { bodyPreview: null, truncated: false };
  if (text.length <= ACTION_RESULT_PREVIEW_CAP)
    return { bodyPreview: text, truncated: false };
  return {
    bodyPreview: text.slice(0, ACTION_RESULT_PREVIEW_CAP),
    truncated: true,
  };
}

/** Extract a step's named outputs from its (sanitized) gateway response. */
function extractOutputs(
  outputs: Record<string, string> | undefined,
  res: GatewayResponse | GatewaySseResponse,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!outputs) return out;
  // Candidate JSON documents to read paths from: the fetch body, or each SSE
  // event's data in order (first event that yields the path wins).
  const docs: unknown[] = [];
  if ("events" in res) {
    for (const ev of (res as GatewaySseResponse).events) {
      try {
        docs.push(JSON.parse(ev.data));
      } catch {
        /* non-JSON event data — skip */
      }
    }
  } else if (res.body) {
    try {
      docs.push(JSON.parse(res.body));
    } catch {
      /* non-JSON body — no outputs */
    }
  }
  for (const [name, path] of Object.entries(outputs)) {
    for (const doc of docs) {
      const value = getByPath(doc, path);
      if (value !== undefined && value !== null) {
        out[name] =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        break;
      }
    }
    // A missing output is NOT fatal by itself — only a later template that
    // references it will fail, with a precise error message.
  }
  return out;
}

/** Deep-ish clone so applying overrides never mutates the cached recorded call. */
function cloneRequest(req: GatewayRequest): GatewayRequest {
  return {
    method: req.method,
    url: req.url,
    headers: { ...req.headers },
    body: req.body,
  };
}

/**
 * Validate + resolve the runtime params for an action. Applies defaults, then
 * enforces required-ness and type coercion. Runtime values may arrive as
 * strings OR bare numbers/booleans (callers like the MCP tool layer may pass
 * JSON scalars) — both are normalized to strings here, then checked against
 * the declared type. Throws before any network activity when the caller's
 * params are unusable.
 */
export function resolveActionParams(
  action: Action,
  runtime: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of action.params) {
    const raw = runtime?.[p.name] ?? p.default;
    const given = typeof raw === "string" ? raw : String(raw);
    if (given === "") {
      if (p.required) throw new Error(`Missing required param "${p.name}"`);
      continue;
    }
    if (p.type === "number" && Number.isNaN(Number(given))) {
      throw new Error(`Param "${p.name}" must be a number, got "${given}"`);
    }
    if (p.type === "boolean" && !["true", "false"].includes(given)) {
      throw new Error(
        `Param "${p.name}" must be "true" or "false", got "${given}"`,
      );
    }
    out[p.name] = given;
  }
  return out;
}

/**
 * Run an action end to end. Throws on pre-flight problems (bad params, missing
 * recorded calls, out-of-range shape) — those are caller errors, not run
 * results. Once running, failures land in the returned ActionRunResult.
 */
export async function runAction(
  action: Action,
  runtimeParams: Record<string, string | number | boolean> | undefined,
): Promise<ActionRunResult> {
  if (!action.steps.length) throw new Error("Action has no steps");
  if (action.steps.length > ACTION_MAX_STEPS) {
    throw new Error(
      `Action has ${action.steps.length} steps (max ${ACTION_MAX_STEPS})`,
    );
  }
  const params = resolveActionParams(action, runtimeParams);

  // Load the source recording's calls once; every step's callId must resolve.
  const calls = await getCalls(action.recordingId);
  const callById = new Map(calls.map((c) => [c.id, c]));
  for (const step of action.steps) {
    if (!callById.has(step.callId)) {
      throw new Error(`Step references unknown callId "${step.callId}"`);
    }
  }

  const startedAt = Date.now();
  const run: ActionRunResult = {
    actionId: action.id,
    actionName: action.name,
    startedAt,
    durationMs: 0,
    endReason: "complete",
    steps: [],
  };
  const ctx: TemplateContext = { params, stepOutputs: {} };

  // One user decision per distinct host per run: each step hands the gateway a
  // confirmHost (instead of letting it pop up per call), so the first step
  // reaching a new host triggers ONE confirmation popup that covers every later
  // step to that host. Denylist/allowlist/SSRF are still enforced per call in
  // prepareCall — this hook is only consulted for hosts needing confirmation.
  const approvedHosts = new Set<string>();
  const confirmHost = async (host: string, req: GatewayRequest) => {
    if (approvedHosts.has(host)) return true;
    const ok = await requestGatewayConfirmation({
      method: req.method,
      url: req.url,
      bodyPreview: req.body ?? null,
      via: "agent",
    });
    if (ok) approvedHosts.add(host);
    return ok;
  };

  for (let i = 0; i < action.steps.length; i++) {
    const step: ActionStep = action.steps[i]!;
    const recorded = callById.get(step.callId)!;
    const stepStarted = Date.now();
    const req = cloneRequest(requestFromCall(recorded));

    let result: ActionStepResult | null = null;
    try {
      // Resolve + apply overrides (order matters: later overrides see earlier
      // ones' effects on the same clone).
      for (const ov of step.overrides ?? []) {
        applyOverride(req, ov, resolveTemplate(ov.value, ctx));
      }

      if (step.waitMs && step.waitMs > 0) {
        const wait = Math.min(step.waitMs, ACTION_MAX_WAIT_MS);
        await new Promise((r) => setTimeout(r, wait));
      }

      const res =
        step.kind === "sse"
          ? await runGatewaySse(req as GatewaySseRequest, { confirmHost })
          : await runGatewayFetch(req, { confirmHost });

      const outputs = extractOutputs(step.outputs, res);
      ctx.stepOutputs[i] = outputs;
      result = {
        index: i + 1,
        callId: step.callId,
        kind: step.kind,
        url: req.url,
        outcome: "ok",
        status: res.status,
        statusText: res.statusText,
        ...previewOf(res),
        eventCount:
          "events" in res ? (res as GatewaySseResponse).eventCount : undefined,
        outputs,
        durationMs: Date.now() - stepStarted,
      };
    } catch (err) {
      // Pre-forward policy refusal vs. transport/processing error.
      const refused = err instanceof GatewayRefusedError;
      result = {
        index: i + 1,
        callId: step.callId,
        kind: step.kind,
        url: req.url,
        outcome: refused ? "refused" : "error",
        status: 0,
        statusText: "",
        bodyPreview: null,
        truncated: false,
        outputs: {},
        errorText: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - stepStarted,
      };
    }

    run.steps.push(result);
    if (result.outcome !== "ok") {
      run.endReason = "aborted";
      run.failedStep = result.index;
      run.failure = result.outcome === "refused" ? "refused" : "error";
      break;
    }
  }

  run.durationMs = Date.now() - startedAt;
  return run;
}
