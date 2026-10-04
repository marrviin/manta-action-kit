/**
 * RPC handlers: execute an agent-invoked method against the extension's
 * IndexedDB. Runs in the background service worker. Pure data access — no socket
 * concerns here (see bridge.ts for transport).
 */
import {
  getCalls,
  getInspectorCapture,
  getRecording,
  listActions,
  listActionsByRecording,
  listGatewayProxyRules,
  listGifHistory,
  listInspectorCaptures,
  listRecordings,
  saveScreenshotHistory,
  upsertAction,
  deleteAction,
  getAction,
  updateRecordingDescription,
} from "@/lib/db";
import { diffPayloads, formatDiffReport } from "@/lib/inspector/diff";
import { leanInspectorPayload } from "@/lib/inspector/lean";
import { AGENT_CAPTURE_ELEMENTS } from "@/lib/inspector/capture";
import type { AgentCaptureRequest } from "@/lib/inspector/capture";
import { runGatewayFetch, runGatewaySse } from "@/lib/gateway/run";
import { resolveProxyRule } from "@/lib/gateway/proxy-rule";
import {
  addProxyRule,
  updateProxyRuleContent,
} from "@/lib/gateway/manage-rules";
import { settings } from "@/lib/storage";
import type { ApiCall } from "@/lib/recording/types";
import { inferDependencies } from "@/lib/recording/infer-deps";
import {
  aggregateEndpoints,
  attachDependencies,
} from "@/lib/recording/aggregate";
import { attachDynamism } from "@/lib/ai/field-dynamism";
import type { GatewayRequest } from "@/lib/gateway/types";
import { runAction } from "@/lib/action/replay";
import {
  pauseGifRecording,
  resumeGifRecording,
  startGifRecording,
  stopGifRecording,
} from "@/lib/gif-recording/session";
import { requestGifConfirmation } from "@/lib/gif-confirm";
import { GifRecordingError } from "@/lib/gif-recording/types";
import { gifLastResult, gifRecordingState } from "@/lib/storage";
import { isCapturableUrl } from "@/lib/utils";
import {
  ACTION_MAX_STEPS,
  ACTION_MAX_WAIT_MS,
  type Action,
  type ActionParam,
  type ActionStep,
  type ActionSummary,
} from "@/lib/action/types";
import { isToolEnabled, type RpcMap, type RpcMethod } from "./protocol";
import { captureTabScreenshot, shotFilename } from "@/lib/screenshot/capture-flow";
import { ScreenshotError } from "@/lib/screenshot/types";
import { prepareAgentImage } from "@/lib/screenshot/agent-image";
import type { ScreenshotMode } from "@/lib/screenshot/types";

/**
 * Send the programmatic capture request to a tab's content script. The
 * content script persists via its bridge-iframe path and replies with the
 * history id; a thrown error here means there is no listener (chrome:// and
 * other non-injectable pages).
 */
function sendAgentCapture(
  tabId: number,
  req: AgentCaptureRequest,
): Promise<{
  ok: boolean;
  captureId?: string;
  elementCount?: number;
  error?: string;
}> {
  return chrome.tabs.sendMessage(tabId, {
    type: AGENT_CAPTURE_ELEMENTS,
    data: req,
  }) as Promise<{
    ok: boolean;
    captureId?: string;
    elementCount?: number;
    error?: string;
  }>;
}

/**
 * Project an Action into its lightweight summary for list/search results
 * (progressive disclosure: the full definition — steps, overrides, output
 * paths — is only returned by get_action).
 */
function toActionSummary(a: Action): ActionSummary {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    recordingId: a.recordingId,
    params: a.params.map((p) => ({
      name: p.name,
      type: p.type,
      required: p.required,
    })),
    stepCount: a.steps.length,
    updatedAt: a.updatedAt,
  };
}

/** Dispatch one RPC method to its result. Throws on unknown method / bad params. */
export async function handleRpc<M extends RpcMethod>(
  method: M,
  params: RpcMap[M]["params"],
): Promise<RpcMap[M]["result"]> {
  // Single choke point for the per-tool kill switches. A tool is on unless the
  // user explicitly disabled it in the MCP tab (default = all on). `proxy_rule` is
  // NOT an agent-facing tool (it's the internal script-proxy tunnel), so it isn't in
  // the registry and is gated by each proxy rule's own `enabled` flag instead.
  // `set_proxy_port` is likewise internal (server→extension port sync on rebind).
  const INTERNAL_METHODS: RpcMethod[] = ["proxy_rule", "set_proxy_port"];
  if (!INTERNAL_METHODS.includes(method)) {
    const disabledMap = await settings.mcpToolEnabled.getValue();
    if (!isToolEnabled(disabledMap, method)) {
      throw new Error(
        `Tool "${method}" has been disabled by the user in the extension`,
      );
    }
  }

  switch (method) {
    case "list_recordings": {
      const recordings = await listRecordings();
      return { recordings } as RpcMap[M]["result"];
    }

    case "get_recording": {
      const { id } = params as RpcMap["get_recording"]["params"];
      if (!id) throw new Error('get_recording: missing "id"');
      const recording = (await getRecording(id)) ?? null;
      const calls = recording ? await getCalls(id) : [];
      // When the recording exists but has no description, nudge the agent to author
      // one (there is no server-side text generation — the agent supplies the
      // semantics via set_recording_description). Omitted once a description exists.
      const descriptionHint =
        recording && !recording.description
          ? "This recording has no description yet. If it would help downstream steps, use get_flow/get_endpoints to understand the flow, then call set_recording_description with a business-level summary: what task this whole flow accomplishes, what you can do with it, how the steps chain, and caveats for reuse. Do NOT restate per-endpoint field/schema contracts — that already lives in get_endpoints/get_flow."
          : undefined;
      return { recording, calls, descriptionHint } as RpcMap[M]["result"];
    }

    case "set_recording_description": {
      const { id, description } =
        params as RpcMap["set_recording_description"]["params"];
      if (!id) throw new Error('set_recording_description: missing "id"');
      if (typeof description !== "string" || !description.trim()) {
        throw new Error(
          'set_recording_description: "description" must be a non-empty string',
        );
      }
      const existing = await getRecording(id);
      if (!existing)
        throw new Error(
          `set_recording_description: no recording with id "${id}"`,
        );
      // Dedicated write path: only touches description/descriptionUpdatedAt, so the
      // agent can never mutate other recording fields.
      await updateRecordingDescription(id, description);
      const recording = (await getRecording(id)) ?? null;
      return { recording } as RpcMap[M]["result"];
    }

    case "list_element_captures": {
      const captures = (await listInspectorCaptures()).map(
        ({ id, payload }) => ({
          id,
          url: payload.page.url,
          title: payload.page.title,
          capturedAt: payload.capturedAt,
          elementCount: payload.elementCount,
        }),
      );
      return { captures } as RpcMap[M]["result"];
    }

    case "get_element_capture": {
      const { id } = params as RpcMap["get_element_capture"]["params"];
      if (!id) throw new Error('get_element_capture: missing "id"');
      const capture = (await getInspectorCapture(id)) ?? null;
      return { capture } as RpcMap[M]["result"];
    }

    case "diff_element_captures": {
      const { a, b } = params as RpcMap["diff_element_captures"]["params"];
      if (!a || !b) throw new Error('diff_element_captures: missing "a"/"b"');
      const [pa, pb] = await Promise.all([
        getInspectorCapture(a),
        getInspectorCapture(b),
      ]);
      if (!pa) throw new Error(`diff_element_captures: no capture with id "${a}"`);
      if (!pb) throw new Error(`diff_element_captures: no capture with id "${b}"`);
      const diff = diffPayloads(pa, pb);
      // Text report (not JSON): agent-friendly, mirrors the diff view's cards.
      return { report: formatDiffReport(pa, pb, diff), identical: diff.identical } as RpcMap[M]["result"];
    }

    case "capture_screenshot": {
      const { mode } = params as RpcMap["capture_screenshot"]["params"];
      if (mode !== "visible" && mode !== "fullPage") {
        throw new Error(
          'capture_screenshot: "mode" must be "visible" or "fullPage"',
        );
      }
      // Same tab resolution as the manual CAPTURE_SCREENSHOT handler: the
      // agent screenshots what the user is looking at (the active tab).
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new ScreenshotError("unsupported-page", "no active tab");
      // Silent by construction: the manual flow's fx / preview tab /
      // notifications all live in the message handler, not the capture libs.
      const shot = await captureTabScreenshot(tab, mode as ScreenshotMode);
      // The full-resolution original goes to history (the user previews it
      // from the capture tab); the agent receives a compressed copy below.
      // The session-storage preview gate (SCREENSHOT_PREVIEW_MAX_BYTES) does
      // NOT apply here — it guards a storage quota, not the IDB history or
      // the compressed agent copy.
      let historyId: string;
      const filename = shotFilename(tab.url ?? "");
      try {
        historyId = await saveScreenshotHistory(shot.dataUrl, filename);
      } catch (err) {
        throw new ScreenshotError("capture-failed", `history save failed: ${String(err)}`);
      }
      const img = await prepareAgentImage(shot.dataUrl);
      return {
        historyId,
        filename,
        createdAt: Date.now(),
        originalBytes: shot.dataUrl.length,
        ...img,
        fullPageStitched: shot.stitched,
      } as RpcMap[M]["result"];
    }

    case "capture_element": {
      const req = params as RpcMap["capture_element"]["params"];
      const provided = [req?.selector, req?.point, req?.box].filter(
        (v) => v !== undefined && v !== null && v !== "",
      );
      if (provided.length !== 1) {
        throw new Error(
          'capture_element: provide exactly one of "selector", "point", or "box"',
        );
      }
      // Same tab resolution as capture_screenshot: the active tab.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("capture_element: no active tab");
      let reply: Awaited<ReturnType<typeof sendAgentCapture>> | undefined;
      try {
        reply = await sendAgentCapture(tab.id, req);
      } catch {
        throw new Error(
          `capture_element: no content script on this tab (unsupported page?) — ${tab.url ?? ""}`,
        );
      }
      if (!reply?.ok || !reply.captureId) {
        throw new Error(`capture_element failed: ${reply?.error ?? "unknown error"}`);
      }
      // Read the stored record back and strip the preview-only bulk
      // (fullStyles/pseudo/textFull — 20-100MB on big pages) so the response
      // stays token-bounded; get_element_capture(captureId) returns the full
      // fidelity snapshot on demand.
      const stored = await getInspectorCapture(reply.captureId);
      if (!stored) {
        throw new Error(
          "capture_element: capture was persisted but could not be read back",
        );
      }
      const lean = leanInspectorPayload(stored);
      return {
        captureId: reply.captureId,
        page: lean.page,
        capturedAt: lean.capturedAt,
        elementCount: lean.elementCount,
        elements: lean.elements,
      } as RpcMap[M]["result"];
    }

    case "start_gif_recording": {
      const { tabId } = params as RpcMap["start_gif_recording"]["params"];
      const tab =
        tabId != null
          ? await chrome.tabs.get(tabId).catch(() => undefined)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab?.id) throw new GifRecordingError("unsupported-page", "no such tab");
      if (!isCapturableUrl(tab.url)) {
        throw new GifRecordingError("unsupported-page", tab.url ?? "");
      }
      // The confirm window's Allow click IS the user gesture Chrome requires
      // to mint the tabCapture streamId (see lib/gif-confirm.ts). Blocks up
      // to the 120s fail-closed timeout; declined/timed-out → start failed.
      const decision = await requestGifConfirmation({
        tabId: tab.id,
        title: tab.title ?? "",
        url: tab.url ?? "",
      });
      if (!decision.approved || !decision.streamId) {
        throw new GifRecordingError(
          "start-failed",
          decision.error ?? "user declined or confirmation timed out",
        );
      }
      await startGifRecording(decision.streamId, {
        tabId: tab.id,
        url: tab.url,
        silent: true,
      });
      return { ok: true, tabId: tab.id, startedAt: Date.now() } as RpcMap[M]["result"];
    }

    case "stop_gif_recording": {
      const startedAt = Date.now();
      await stopGifRecording();
      // The offscreen DONE report (which carries draftId) lands right after
      // the stop ack; wait briefly so the agent gets the draftId in this
      // reply instead of having to poll. handleGifOffscreenDone writes
      // gifLastResult (storage, not module scope — the SW sleeps during a
      // recording) before clearing the state.
      for (let i = 0; i < 75; i++) {
        const last = await gifLastResult.getValue();
        if (last && last.endedAt >= startedAt) {
          return {
            ok: true,
            ...(last.draftId ? { draftId: last.draftId } : {}),
            ...(last.hitTimeLimit ? { hitTimeLimit: true } : {}),
          } as RpcMap[M]["result"];
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      // Still not settled (rare) — the agent re-polls
      // get_gif_recording_status and reads lastResult.draftId.
      return { ok: true } as RpcMap[M]["result"];
    }

    case "pause_gif_recording": {
      await pauseGifRecording();
      return { ok: true } as RpcMap[M]["result"];
    }

    case "resume_gif_recording": {
      await resumeGifRecording();
      return { ok: true } as RpcMap[M]["result"];
    }

    case "get_gif_recording_status": {
      const recording = await gifRecordingState.getValue();
      const lastResult = (await gifLastResult.getValue()) ?? undefined;
      return { recording, lastResult } as RpcMap[M]["result"];
    }

    case "list_gif_history": {
      // Metadata projection only — the WebM blob stays in IndexedDB.
      const drafts = await listGifHistory();
      return { drafts } as RpcMap[M]["result"];
    }

    case "get_call": {
      const { callId } = params as RpcMap["get_call"]["params"];
      if (!callId) throw new Error('get_call: missing "callId"');
      const call = await findCall(callId);
      return { call } as RpcMap[M]["result"];
    }

    case "get_flow": {
      const { id } = params as RpcMap["get_flow"]["params"];
      if (!id) throw new Error('get_flow: missing "id"');
      const recording = await getRecording(id);
      if (!recording) return { flow: null } as RpcMap[M]["result"];
      const calls = await getCalls(id);
      // Prefer stored deps; fall back to on-the-fly inference for recordings
      // captured before the flow feature (deps === undefined).
      const deps = recording.deps ?? inferDependencies(calls);
      const flow = {
        recordingId: recording.id,
        name: recording.name,
        steps: [...calls]
          .sort((a, b) => a.seq - b.seq)
          .map((c) => ({
            seq: c.seq,
            method: c.method,
            url: c.url,
            status: c.status,
            // laya relevance mark, when the recording has been analyzed:
            // 'irrelevant' calls are background noise the agent can skip.
            ...(c.relevance ? { relevance: c.relevance } : {}),
            // The user interaction that likely triggered this step (nearest
            // within ~2s before it started) — readable intent for the agent.
            ...(c.precedingInteraction
              ? { precedingInteraction: c.precedingInteraction }
              : {}),
          })),
        deps,
      };
      return { flow } as RpcMap[M]["result"];
    }

    case "get_endpoints": {
      const { id } = params as RpcMap["get_endpoints"]["params"];
      if (!id) throw new Error('get_endpoints: missing "id"');
      const recording = await getRecording(id);
      if (!recording) return { endpoints: [] } as RpcMap[M]["result"];
      const calls = await getCalls(id);
      // Attach the flow's field dependencies re-keyed onto endpoints (inputsFrom), so
      // the agent gets shape + value provenance in one read. Same dep source as
      // get_flow: prefer stored deps, fall back to on-the-fly inference for pre-flow
      // recordings (deps === undefined).
      const deps = recording.deps ?? inferDependencies(calls);
      // Lay the field-dynamism marks (which fields would change on replay) onto
      // the request schemas / query params. Absent marks read as unanalyzed.
      const endpoints = attachDynamism(
        attachDependencies(aggregateEndpoints(calls), calls, deps),
        recording.fieldDynamism,
      );
      return { endpoints } as RpcMap[M]["result"];
    }

    case "proxy_fetch": {
      const { req } = params as RpcMap["proxy_fetch"]["params"];
      if (!req?.url) throw new Error('proxy_fetch: missing "url"');
      if (!req?.method) throw new Error('proxy_fetch: missing "method"');
      const res = await runGatewayFetch(req);
      return res as RpcMap[M]["result"];
    }

    case "proxy_sse": {
      const { req } = params as RpcMap["proxy_sse"]["params"];
      if (!req?.url) throw new Error('proxy_sse: missing "url"');
      if (!req?.method) throw new Error('proxy_sse: missing "method"');
      const res = await runGatewaySse(req);
      return res as RpcMap[M]["result"];
    }

    case "proxy_rule": {
      const { req } = params as RpcMap["proxy_rule"]["params"];
      if (!req?.rawPath) throw new Error('proxy_rule: missing "rawPath"');
      if (!req?.method) throw new Error('proxy_rule: missing "method"');
      const rules = await listGatewayProxyRules();
      const resolved = resolveProxyRule(rules, req.method, req.rawPath);
      if (!resolved.ok) {
        // No forward: return an unmatched result the proxy turns into an HTTP status.
        return {
          matched: false,
          error: resolved.error,
          status: resolved.status,
          statusText: "",
          headers: {},
          body: null,
          truncated: false,
        } as RpcMap[M]["result"];
      }
      const res = await runGatewayFetch(
        {
          method: req.method as GatewayRequest["method"],
          url: resolved.url,
          headers: req.headers,
          body: req.body,
        },
        { via: "rule" },
      );
      return { ...res, matched: true } as RpcMap[M]["result"];
    }

    case "list_proxy_rules": {
      const rules = await listGatewayProxyRules();
      return { rules } as RpcMap[M]["result"];
    }

    case "add_proxy_rule": {
      const input = params as RpcMap["add_proxy_rule"]["params"];
      if (!input?.sandboxPrefix)
        throw new Error('add_proxy_rule: missing "sandboxPrefix"');
      if (!input?.targetBase)
        throw new Error('add_proxy_rule: missing "targetBase"');
      // Enabled immediately, because reaching here means the user approved the native
      // confirmation prompt (add_proxy_rule carries requiresUserInteraction, like
      // proxy_fetch) — that approval IS what enables the rule. The agent still can
      // never set/flip `enabled` itself: the input shape omits it.
      const rule = await addProxyRule(input, true, "agent");
      return { rule } as RpcMap[M]["result"];
    }

    case "update_proxy_rule": {
      const { id, patch } = params as RpcMap["update_proxy_rule"]["params"];
      if (!id) throw new Error('update_proxy_rule: missing "id"');
      // updateProxyRuleContent only accepts content fields — there is no way for the
      // agent to reach the `enabled` kill switch through here.
      const rule = await updateProxyRuleContent(id, patch ?? {});
      return { rule } as RpcMap[M]["result"];
    }

    case "set_proxy_port": {
      const { proxyPort } = params as RpcMap["set_proxy_port"]["params"];
      if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        throw new Error(
          'set_proxy_port: "proxyPort" must be an integer 1-65535',
        );
      }
      // Persist so proxy-rule scripts' baseURL (http://127.0.0.1:<proxyPort>) tracks
      // the MCP server's rebound HTTP proxy. Settings watchers pick this up live.
      await settings.proxyPort.setValue(proxyPort);
      return { proxyPort } as RpcMap[M]["result"];
    }

    case "list_actions": {
      const actions = (await listActions()).map(toActionSummary);
      return { actions } as RpcMap[M]["result"];
    }

    case "get_action": {
      const { id } = params as RpcMap["get_action"]["params"];
      if (!id) throw new Error('get_action: missing "id"');
      const action = (await getAction(id)) ?? null;
      return { action } as RpcMap[M]["result"];
    }

    case "search_actions": {
      const { query, recordingId } =
        params as RpcMap["search_actions"]["params"];
      if (typeof query !== "string" || !query.trim()) {
        throw new Error('search_actions: "query" must be a non-empty string');
      }
      const pool = recordingId
        ? await listActionsByRecording(recordingId)
        : await listActions();
      const q = query.toLowerCase();
      const actions = pool
        .filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        )
        .map(toActionSummary);
      return { actions } as RpcMap[M]["result"];
    }

    case "create_action": {
      const input = params as RpcMap["create_action"]["params"];
      if (typeof input?.name !== "string" || !input.name.trim()) {
        throw new Error('create_action: "name" must be a non-empty string');
      }
      if (typeof input.description !== "string" || !input.description.trim()) {
        throw new Error(
          'create_action: "description" must be a non-empty string',
        );
      }
      if (!input?.recordingId)
        throw new Error('create_action: missing "recordingId"');
      const recording = await getRecording(input.recordingId);
      if (!recording) {
        throw new Error(
          `create_action: no recording with id "${input.recordingId}"`,
        );
      }
      const now = Date.now();
      const action: Action = {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        description: input.description.trim(),
        recordingId: input.recordingId,
        params: validateActionParams(input.params),
        steps: await validateActionSteps(input.recordingId, input.steps),
        createdAt: now,
        updatedAt: now,
      };
      await upsertAction(action);
      return { action } as RpcMap[M]["result"];
    }

    case "update_action": {
      const { id, patch } = params as RpcMap["update_action"]["params"];
      if (!id) throw new Error('update_action: missing "id"');
      const existing = await getAction(id);
      if (!existing) return { action: null } as RpcMap[M]["result"];
      // Content fields only — id/recordingId/timestamps are never patchable.
      const next: Action = { ...existing };
      if (patch?.name !== undefined) {
        if (typeof patch.name !== "string" || !patch.name.trim()) {
          throw new Error('update_action: "name" must be a non-empty string');
        }
        next.name = patch.name.trim();
      }
      if (patch?.description !== undefined) {
        if (
          typeof patch.description !== "string" ||
          !patch.description.trim()
        ) {
          throw new Error(
            'update_action: "description" must be a non-empty string',
          );
        }
        next.description = patch.description.trim();
      }
      if (patch?.params !== undefined)
        next.params = validateActionParams(patch.params);
      if (patch?.steps !== undefined) {
        next.steps = await validateActionSteps(
          existing.recordingId,
          patch.steps,
        );
      }
      await upsertAction(next);
      const action = (await getAction(id)) ?? null;
      return { action } as RpcMap[M]["result"];
    }

    case "delete_action": {
      const { id } = params as RpcMap["delete_action"]["params"];
      if (!id) throw new Error('delete_action: missing "id"');
      const existing = await getAction(id);
      if (!existing) return { deleted: false } as RpcMap[M]["result"];
      await deleteAction(id);
      return { deleted: true } as RpcMap[M]["result"];
    }

    case "execute_action": {
      const { id, params: runtimeParams } =
        params as RpcMap["execute_action"]["params"];
      if (!id) throw new Error('execute_action: missing "id"');
      const action = await getAction(id);
      if (!action) throw new Error(`execute_action: no action with id "${id}"`);
      const run = await runAction(action, runtimeParams);
      return { run } as RpcMap[M]["result"];
    }

    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

/**
 * Look up a single call by its id. The `calls` store is keyed by id but the db
 * helpers only expose per-recording reads, so scan recordings until found. Fine
 * for local recording volumes; revisit with a direct get if this grows.
 */
async function findCall(callId: string): Promise<ApiCall | null> {
  const recordings = await listRecordings();
  for (const rec of recordings) {
    const calls = await getCalls(rec.id);
    const hit = calls.find((c) => c.id === callId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Validate an action's param declarations: unique names, whitelisted types. The
 * agent can only declare typed inputs — defaults are strings, values resolve at
 * execute time (see replay.ts's resolveActionParams).
 */
function validateActionParams(input: ActionParam[] | undefined): ActionParam[] {
  const params = input ?? [];
  if (!Array.isArray(params)) throw new Error('"params" must be an array');
  const seen = new Set<string>();
  for (const p of params) {
    if (typeof p?.name !== "string" || !p.name.trim()) {
      throw new Error('action params: every entry needs a non-empty "name"');
    }
    if (seen.has(p.name))
      throw new Error(`action params: duplicate name "${p.name}"`);
    seen.add(p.name);
    if (!["string", "number", "boolean"].includes(p.type)) {
      throw new Error(
        `action params: "${p.name}" has invalid type "${String(p.type)}"`,
      );
    }
  }
  // Rebuild field-by-field so a tampered record can't smuggle extra properties
  // into the stored Action.
  return params.map((p) => ({
    name: p.name,
    description: typeof p.description === "string" ? p.description : undefined,
    type: p.type,
    required: p.required === true,
    default: typeof p.default === "string" ? p.default : undefined,
  }));
}

/**
 * Validate an action's steps against the source recording: bounded counts, sane
 * waits, and every callId must exist inside that recording (so a replay can
 * never re-point at a call from another recording's credential context).
 */
async function validateActionSteps(
  recordingId: string,
  input: ActionStep[] | undefined,
): Promise<ActionStep[]> {
  const steps = input ?? [];
  if (!Array.isArray(steps) || !steps.length) {
    throw new Error('"steps" must be a non-empty array');
  }
  if (steps.length > ACTION_MAX_STEPS) {
    throw new Error(
      `"steps" has ${steps.length} entries (max ${ACTION_MAX_STEPS})`,
    );
  }
  const calls = await getCalls(recordingId);
  const known = new Set(calls.map((c) => c.id));
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (typeof s?.callId !== "string" || !s.callId) {
      throw new Error(`steps[${i}]: missing "callId"`);
    }
    if (!known.has(s.callId)) {
      throw new Error(
        `steps[${i}]: callId "${s.callId}" not found in recording "${recordingId}"`,
      );
    }
    if (s.kind !== "fetch" && s.kind !== "sse") {
      throw new Error(`steps[${i}]: "kind" must be "fetch" or "sse"`);
    }
    if (
      s.waitMs !== undefined &&
      (typeof s.waitMs !== "number" ||
        !Number.isFinite(s.waitMs) ||
        s.waitMs < 0 ||
        s.waitMs > ACTION_MAX_WAIT_MS)
    ) {
      throw new Error(
        `steps[${i}]: "waitMs" must be a number 0-${ACTION_MAX_WAIT_MS}`,
      );
    }
  }
  return steps.map((s) => ({
    callId: s.callId,
    kind: s.kind,
    overrides: Array.isArray(s.overrides) ? s.overrides : undefined,
    waitMs: typeof s.waitMs === "number" ? s.waitMs : undefined,
    outputs: s.outputs && typeof s.outputs === "object" ? s.outputs : undefined,
  }));
}
