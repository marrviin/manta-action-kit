/**
 * Recording session state machine (runs in the background service worker).
 *
 * MV3 service workers sleep, so the on/off flag lives in storage.session (see
 * lib/storage.ts) and the in-flight call buffer is kept in memory but flushed
 * defensively. When recording stops, the buffer is persisted to IndexedDB as one
 * Recording plus its ApiCalls.
 */
import { recordingFilterRules, recordingState } from '@/lib/storage';
import { saveRecording } from '@/lib/db';
import { uuid } from '@/lib/utils';
import { isBlacklisted } from './filter';
import { inferDependencies } from './infer-deps';
import {
  IDLE_RECORDING_STATE,
  type ApiCall,
  type CapturedCall,
  type Recording,
  type RecordingState,
} from './types';

/** In-memory buffer of calls for the active recording (background lifetime). */
let buffer: CapturedCall[] = [];

/**
 * Should this captured call be kept? We record only real API calls:
 * successful-ish XHR/fetch that return JSON (or errored requests, which are
 * interesting). Static assets (js/css/img/fonts) and non-JSON GETs are dropped.
 */
export function isApiCall(call: CapturedCall): boolean {
  if (call.errored) return true;
  if (call.streaming) return true; // SSE streams are API calls (won't look like JSON)
  if (call.resIsJson) return true;
  // Also keep obvious API verbs even if body wasn't detected as JSON.
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(call.method)) return true;
  // Drop static assets by extension.
  if (/\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)(\?|$)/i.test(call.url)) {
    return false;
  }
  return false;
}

export async function getState(): Promise<RecordingState> {
  return recordingState.getValue();
}

export async function start(input: {
  tabId: number;
  origin: string;
  url: string;
}): Promise<RecordingState> {
  buffer = [];
  const state: RecordingState = {
    active: true,
    paused: false,
    tabId: input.tabId,
    origin: input.origin,
    startedAt: Date.now(),
    count: 0,
  };
  await recordingState.setValue(state);
  return state;
}

/** Toggle pause. While paused the session stays active but incoming calls are dropped. */
export async function setPaused(paused: boolean): Promise<RecordingState> {
  const state = await recordingState.getValue();
  if (!state.active) return state;
  const next = { ...state, paused };
  await recordingState.setValue(next);
  return next;
}

/** Push a captured call if it belongs to the active recording tab and is an API call. */
export async function push(call: CapturedCall, senderTabId: number | undefined): Promise<number> {
  const state = await recordingState.getValue();
  if (!state.active || state.paused || state.tabId == null) return state.count;
  if (senderTabId !== state.tabId) return state.count;
  if (!isApiCall(call)) return state.count;

  // Drop calls blacklisted by an enabled filter rule (never persisted).
  const filterRules = await recordingFilterRules.getValue();
  if (isBlacklisted(call.url, filterRules)) return state.count;

  buffer.push(call);
  const next = { ...state, count: buffer.length };
  await recordingState.setValue(next);
  return next.count;
}

/** Stop recording, persist to IndexedDB, and reset state. Returns the recording id. */
export async function stop(): Promise<{ recordingId: string | null; state: RecordingState }> {
  const state = await recordingState.getValue();

  if (!state.active || buffer.length === 0) {
    buffer = [];
    await recordingState.setValue(IDLE_RECORDING_STATE);
    return { recordingId: null, state: IDLE_RECORDING_STATE };
  }

  const recordingId = uuid();
  const createdAt = Date.now();
  const calls: ApiCall[] = buffer.map((c, i) => ({
    ...c,
    id: uuid(),
    recordingId,
    seq: i,
  }));

  const recording: Recording = {
    id: recordingId,
    name: defaultName(state.origin, createdAt),
    origin: state.origin ?? '',
    url: '',
    createdAt,
    callCount: calls.length,
    // Auto-infer the flow (field dependencies between calls) at save time so an
    // agent reading this recording gets the call chain, not just isolated calls.
    // Pure/deterministic (no LLM); the user can refine these in the detail view.
    deps: inferDependencies(calls),
  };

  // Persist BEFORE flipping state to idle: the side panel's recording list
  // refreshes on the active->idle transition (see hooks/use-recordings.ts), so
  // the recording must already be in IndexedDB when that signal fires — otherwise
  // the refresh reads a stale list and the new record appears to be missing.
  await saveRecording(recording, calls);
  buffer = [];
  await recordingState.setValue(IDLE_RECORDING_STATE);
  return { recordingId, state: IDLE_RECORDING_STATE };
}

function defaultName(origin: string | null, at: number): string {
  const host = (() => {
    try {
      return origin ? new URL(origin).host : 'recording';
    } catch {
      return 'recording';
    }
  })();
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${host} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
