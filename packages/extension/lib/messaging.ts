/**
 * Typed messaging helpers between extension contexts (popup / side panel /
 * content script <-> background).
 *
 * Keep the ProtocolMap as the single source of truth for message shapes. Extend it
 * as your business logic grows.
 */
import type { CapturedCall, RecordingState } from "./recording/types";
import type { GatewayLog, GatewayProxyRule } from "./gateway/types";
import type { ScreenshotMode } from "./screenshot/types";
export interface ProtocolMap {
  PING: {
    request: void;
    response: { type: "PONG"; at: number };
  };

  /** Popup -> background: begin recording the given (or active) tab. */
  START_RECORDING: {
    request: { tabId: number; origin: string; url: string };
    response: RecordingState;
  };

  /** Popup -> background: stop recording and persist. Returns saved recording id. */
  STOP_RECORDING: {
    request: void;
    response: { recordingId: string | null; state: RecordingState };
  };

  /** UI -> background: pause/resume capture without ending the session. */
  SET_PAUSED: {
    request: { paused: boolean };
    response: RecordingState;
  };

  /** Any context -> background: read current recording state. */
  GET_RECORDING_STATE: {
    request: void;
    response: RecordingState;
  };

  /** Content script -> background: a captured API call from the page. */
  API_CALL_CAPTURED: {
    request: CapturedCall;
    response: { ok: boolean; count: number };
  };

  /**
   * Background -> UI (fire-and-forget broadcast): the laya relevance analysis
   * for a recording finished writing marks into IndexedDB. The detail view
   * listens for this and re-reads its calls.
   */
  RECORDING_RELEVANCE_UPDATED: {
    request: { recordingId: string };
    response: { ok: boolean };
  };

  /**
   * Background -> UI (broadcast): the relevance analysis entered a new
   * lifecycle phase (analyzing / done / failed). Lets an open detail view show
   * a live status instead of a silent run. The same state is persisted on the
   * Recording (relevanceStatus) for views opened later.
   */
  RECORDING_RELEVANCE_STATUS: {
    request: { recordingId: string; status: 'analyzing' | 'done' | 'failed' };
    response: { ok: boolean };
  };

  /**
   * UI -> background: (re-)run the laya relevance analysis for one recording —
   * the auto pass at STOP_RECORDING only covers that moment, so the detail view
   * offers a manual retry (recordings saved before the feature, failed loads,
   * OOM). Fire-and-forget on the background side; completion arrives via
   * RECORDING_RELEVANCE_UPDATED.
   */
  RUN_RECORDING_RELEVANCE: {
    request: { recordingId: string };
    response: { started: boolean };
  };

  /** Side panel -> background: read the gateway audit log (newest first). */
  LIST_GATEWAY_LOGS: {
    request: void;
    response: { logs: GatewayLog[] };
  };

  /** Side panel -> background: clear the whole gateway audit log. */
  CLEAR_GATEWAY_LOGS: {
    request: void;
    response: { ok: boolean };
  };

  /** Side panel -> background: list proxy rules (script-driven gateway entry). */
  LIST_GATEWAY_PROXY_RULES: {
    request: void;
    response: { rules: GatewayProxyRule[] };
  };

  /**
   * Side panel -> background: add a proxy rule. The background validates the prefix
   * (leading "/", unique) and target (http(s) absolute URL). Returns `{ __error }`
   * on invalid input.
   */
  ADD_GATEWAY_PROXY_RULE: {
    request: {
      sandboxPrefix: string;
      targetBase: string;
    };
    response: { rule: GatewayProxyRule };
  };

  /** Side panel -> background: patch a proxy rule (e.g. toggle enabled). */
  UPDATE_GATEWAY_PROXY_RULE: {
    request: {
      id: string;
      patch: Partial<Omit<GatewayProxyRule, "id" | "createdAt">>;
    };
    response: { rule: GatewayProxyRule };
  };

  /** Side panel -> background: delete a proxy rule. */
  DELETE_GATEWAY_PROXY_RULE: {
    request: { id: string };
    response: { ok: boolean };
  };

  /**
   * Confirm window -> background: the user's allow/deny decision for a pending
   * sandbox-call confirmation. `ok:false` means the id was unknown (expired).
   */
  GATEWAY_CONFIRM_DECISION: {
    request: { id: string; approved: boolean };
    response: { ok: boolean };
  };

  /**
   * Confirm window -> background: keepalive heartbeat while the user decides.
   * Each message resets the MV3 service-worker idle timer so the pending
   * confirmation promise isn't dropped. `ok:false` = request no longer pending.
   */
  GATEWAY_CONFIRM_PING: {
    request: { id: string };
    response: { ok: boolean };
  };

  /**
   * Side panel -> background: pop the confirmation window with a fake request
   * for debugging the confirm UI. Forwards nothing; resolves with the decision.
   */
  GATEWAY_CONFIRM_TEST: {
    request: void;
    response: { approved: boolean };
  };

  /**
   * Confirm window -> background: resize the popup so it hugs its content
   * (fired by a ResizeObserver when the page's layout changes, e.g. the info
   * card expands). `height` is the desired OUTER window height.
   */
  GATEWAY_CONFIRM_RESIZE: {
    request: { id: string; height: number };
    response: { ok: boolean };
  };

  /**
   * Popup -> background: capture the active tab as a PNG (visible viewport or
   * full page) and open a preview tab — copy/download happen there, with the
   * image in front of the user; nothing is saved automatically.
   */
  CAPTURE_SCREENSHOT: {
    request: { mode: ScreenshotMode };
    response: { ok: boolean };
  };

  /**
   * Inspector bridge (extension-origin iframe) -> background: the capture
   * payload is ALREADY in IndexedDB as its own history record (uuid id in
   * `captureId`) — the bridge page wrote it directly, bypassing
   * runtime.sendMessage entirely (full snapshots with per-node computed styles
   * can exceed its ~64MB structured-clone cap; the postMessage hop to the
   * bridge has no such limit). The background opens the element preview tab
   * at that id; comparisons are launched from there via the history dropdown.
   * `preview: false` (agent-driven captures) skips the preview tab — the RPC
   * result already carries the data.
   */
  INSPECTOR_CAPTURE_PREVIEW_READY: {
    request: { captureId: string; preview?: boolean };
    response: { ok: boolean };
  };

  /**
   * Background (agent RPC `capture_element`) -> content script: programmatic
   * element capture — no overlay, no mouse events, no clipboard. Exactly one
   * of selector / point / box (see lib/inspector/capture.ts's
   * captureElementsProgrammatic). The content script persists via the same
   * token-mint + bridge-iframe path as a manual capture (content scripts only
   * see the PAGE's IndexedDB) and returns the resulting history id; `preview:
   * false` keeps the whole flow silent.
   */
  AGENT_CAPTURE_ELEMENTS: {
    request: {
      selector?: string;
      point?: { x: number; y: number };
      box?: { x: number; y: number; w: number; h: number };
      all?: boolean;
      maxElements?: number;
    };
    response: {
      ok: boolean;
      captureId?: string;
      elementCount?: number;
      page?: { url: string; title: string };
      capturedAt?: string;
      error?: string;
    };
  };

  /**
   * Content script -> background: mint a one-shot token authorizing the NEXT
   * inspector-bridge capture handoff. The bridge iframe is embeddable by ANY
   * web page (web_accessible_resource), so "e.source === parent" alone doesn't
   * prove a real capture flow — a malicious page could embed it and feed it a
   * fake payload. A token minted via runtime.sendMessage (unreachable for page
   * scripts) and verified before the IDB write closes that hole.
   */
  INSPECTOR_BRIDGE_MINT_TOKEN: {
    request: void;
    response: { token: string };
  };

  /**
   * Inspector bridge -> background: consume the token handed over with the
   * capture. `ok:false` = unknown/expired/already-used token; the bridge MUST
   * NOT write the payload to IndexedDB in that case. `metadata` is echoed back
   * in the READY message chain (the bridge has no better way to tell the
   * background which tab the capture came from).
   */
  INSPECTOR_BRIDGE_USE_TOKEN: {
    request: { token: string; tabId?: number };
    response: { ok: boolean };
  };

  /**
   * Popup -> background: start recording the active tab as a GIF. The popup
   * obtains the tabCapture stream ID here (it needs the user gesture), the
   * background hands it to the offscreen document which owns the recorder.
   * `tabId`/`url` come from the agent-confirm flow (which already resolved the
   * target tab before asking); `silent` marks agent-driven recordings (no
   * preview tab, no success notification).
   */
  START_GIF_RECORDING: {
    request: { streamId: string; tabId?: number; url?: string; silent?: boolean };
    response: { ok: boolean };
  };

  /**
   * GIF confirm window -> background: the user's Allow/Deny decision on the
   * agent-requested recording. The Allow click is the user gesture that minted
   * `streamId` (chrome.tabCapture.getMediaStreamId inside the extension page) —
   * the background forwards it to startGifRecording. `error` carries the mint
   * failure when approved but getMediaStreamId threw.
   */
  GIF_CONFIRM_DECISION: {
    request: { id: string; approved: boolean; streamId?: string; error?: string };
    response: { ok: boolean };
  };

  /**
   * GIF confirm window -> background: keepalive while the user decides. Each
   * inbound message resets the MV3 service worker's idle timer so the pending
   * confirmation promise survives (same mechanism as GATEWAY_CONFIRM_PING);
   * `ok:false` tells the window its request is gone (expired).
   */
  GIF_CONFIRM_PING: {
    request: { id: string };
    response: { ok: boolean };
  };

  /**
   * Popup -> background: stop the in-flight GIF recording. Resolves once the
   * offscreen recorder has stopped (ack) — the recording is then saved for the
   * preview tab, which reports via GIF_OFFSCREEN_DONE.
   */
  STOP_GIF_RECORDING: {
    request: void;
    response: { ok: boolean };
  };

  /** Background -> offscreen document: begin capturing the tab with this stream ID. */
  GIF_OFFSCREEN_START: {
    request: { streamId: string; url: string };
    response: { ok: boolean };
  };

  /** Background -> offscreen document: stop the recorder; transcode async afterwards. */
  GIF_OFFSCREEN_STOP: {
    request: void;
    response: { ok: boolean };
  };

  /**
   * Popup -> background: pause the in-flight GIF recording. Frames stop being
   * written; the final WebM's timeline excludes the paused span.
   */
  PAUSE_GIF_RECORDING: {
    request: void;
    response: { ok: boolean };
  };

  /** Popup -> background: resume a paused GIF recording. */
  RESUME_GIF_RECORDING: {
    request: void;
    response: { ok: boolean };
  };

  /** Background -> offscreen document: pause the recorder (recorder.pause()). */
  GIF_OFFSCREEN_PAUSE: {
    request: void;
    response: { ok: boolean };
  };

  /** Background -> offscreen document: resume the recorder (recorder.resume()). */
  GIF_OFFSCREEN_RESUME: {
    request: void;
    response: { ok: boolean };
  };

  /**
   * Offscreen document -> background: the recorder finished and the WebM draft
   * is saved for the preview tab (`ok:true`), or the pipeline failed
   * (`ok:false`). Background cleans up: opens the preview tab (success), fires
   * the failure notification (error), closes the offscreen document.
   * `hitTimeLimit` marks an auto-stop at the max recording duration so the
   * background can tell the user why the recording ended on its own.
   */
  GIF_OFFSCREEN_DONE: {
    request: {
      ok: boolean;
      savedForPreview?: boolean;
      /** Id of the persisted history record, forwarded to the preview tab URL. */
      draftId?: string;
      hitTimeLimit?: boolean;
    };
    response: { ok: boolean };
  };

  /**
   * Any UI context -> background: make sure the offscreen document hosting the
   * laya model runtime exists (one per extension). Idempotent — a second call
   * while the document lives is a no-op. Resolves once the document is there;
   * the model itself is loaded lazily on the first LAYA_PREDICT.
   */
  LAYA_ENSURE_RUNTIME: {
    request: void;
    response: { ok: boolean };
  };

  /**
   * Any UI context -> background: forward a laya prediction to the offscreen
   * runtime. The background only relays (it cannot run ONNX itself — the MV3
   * service worker has no WebGPU and a 30s idle lifetime); the offscreen
   * document owns the loaded Agent and answers here. `__error` on failure
   * (model not loaded / runtime missing / predict threw).
   */
  LAYA_PREDICT: {
    request: {
      /** Free-form state: a string, or an object the runtime serializes. */
      state: unknown;
      /** Typed questions keyed by answer id, laya-ts `QuestionDef` shape. */
      questions: Record<string, unknown>;
    };
    response: {
      ok: boolean;
      /** Milliseconds the offscreen runtime spent in agent.predict. */
      elapsedMs?: number;
      /** laya-ts SystemOneResult.answers, if ok. */
      answers?: Record<string, unknown>;
      usage?: { input_tokens: number; output_tokens: number };
    };
  };
  /**
   * Background -> offscreen (relayed like LAYA_PREDICT): classify a batch of
   * states in shared forward passes (Agent.predictBatch). `results[i]` aligns
   * with `states[i]`. Used by the recording-relevance analysis.
   */
  LAYA_PREDICT_BATCH: {
    request: {
      /** One state per item to classify (same shape rules as LAYA_PREDICT.state). */
      states: unknown[];
      /** Typed questions keyed by answer id, shared by every state. */
      questions: Record<string, unknown>;
    };
    response: {
      ok: boolean;
      /** Per-state answers, if ok; aligned with `states` by index. */
      results?: Array<Record<string, unknown>>;
      /** Milliseconds the offscreen runtime spent in agent.predictBatch. */
      elapsedMs?: number;
    };
  };
  /**
   * Offscreen -> background: sent every 15s while a LAYA_PREDICT is in flight.
   * Model load + first predict run for minutes — beyond the MV3 service
   * worker's ~30s idle kill — so each receipt resets the SW idle timer and
   * keeps the relay's pending sendResponse alive. Same trick as the gateway
   * confirm page's GATEWAY_CONFIRM_PING.
   */
  LAYA_KEEPALIVE: {
    request: Record<string, never>;
    response: { ok: true };
  };
  /**
   * Any UI context -> background: query whether the offscreen runtime already
   * holds a loaded agent. Lets the settings card restore its `ready` state on
   * mount (the card's own state dies with the panel; the offscreen agent does
   * not). When the offscreen document is gone entirely, the background answers
   * `ready: false` without creating one — status must not spawn the runtime.
   */
  LAYA_GET_STATUS: {
    request: Record<string, never>;
    response: { ready: boolean; loading: boolean };
  };
}

export type MessageType = keyof ProtocolMap;

/** Discriminated union of all messages — enables `switch (msg.type)` narrowing. */
export type Message = {
  [T in MessageType]: { type: T; data: ProtocolMap[T]["request"] };
}[MessageType];

/** Send a typed message to the background service worker. */
export async function sendMessage<T extends MessageType>(
  type: T,
  data: ProtocolMap[T]["request"],
): Promise<ProtocolMap[T]["response"]> {
  return browser.runtime.sendMessage({ type, data });
}
