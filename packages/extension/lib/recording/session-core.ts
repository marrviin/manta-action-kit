/**
 * Recording session state machine — the injectable core (see session.ts for the
 * extension-bound wrapper that wires real storage).
 *
 * MV3 service workers sleep (and are killed) when idle, so NO recording state may
 * live only in module scope:
 *  - the on/off flag lives in storage.session (`recordingState`)
 *  - the in-flight call buffer is mirrored to storage.session (`recordingBuffer`)
 *    on every push; on the first access after a SW restart the in-memory buffer is
 *    restored from it. Otherwise a >30s lull in API traffic mid-recording would
 *    silently drop everything captured so far while `count` kept claiming more.
 *
 * All mutating operations are serialized through one promise chain: concurrent
 * pushes (a burst of XHRs relayed at once) each read-modify-write the buffer, and
 * unsynchronized runs would race the count update. `stop` joining the same chain
 * also guarantees it sees every push that was accepted before it was invoked.
 *
 * Pure over its two storage dependencies (getStateStore / getBufferStore) — no
 * extension API imports — so the queueing, persistence, and restore behavior can
 * be unit-tested with fakes.
 */
import type {
  ApiCall,
  CapturedCall,
  Recording,
  RecordingFilterRule,
  RecordingState,
} from './types';
import { IDLE_RECORDING_STATE } from './types';
import { isBlacklisted } from './filter';
import { inferDependencies } from './infer-deps';

/** Minimal async KV the state machine needs (satisfied by WXT storage items). */
export interface StateStore<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
}

export interface SessionStores {
  state: StateStore<RecordingState>;
  buffer: StateStore<CapturedCall[]>;
  filterRules: StateStore<RecordingFilterRule[]>;
}

export interface SessionDeps extends SessionStores {
  /** Persist one finished recording + its calls (IndexedDB in the wrapper). */
  saveRecording(recording: Recording, calls: ApiCall[]): Promise<void>;
  /** Fresh unique id (uuid in the wrapper). */
  newId(): string;
  /** epoch ms clock. */
  now(): number;
}

export interface StopResult {
  recordingId: string | null;
  state: RecordingState;
}

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

/**
 * Create the session state machine. All returned operations are serialized
 * through one queue; the buffer is restored from `buffer` storage on first use
 * after a (re)construction — which is what happens when the MV3 service worker
 * restarts.
 */
export function createSession(deps: SessionDeps) {
  /** In-memory buffer of calls for the active recording (restored after SW restarts). */
  let buffer: CapturedCall[] | null = null;

  /** Serialized mutation queue (see module doc). */
  let queue: Promise<unknown> = Promise.resolve();

  /** Run `op` exclusively; later callers wait for earlier ones to settle. */
  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op, op);
    // Keep the chain alive regardless of op failures (the error still propagates
    // to THIS caller via `run`).
    queue = run.catch(() => {});
    return run;
  }

  /**
   * Restore the in-memory buffer from storage.session after a service-worker
   * restart. Cheap no-op once restored. A failed read yields an empty buffer
   * (recording continues with what arrives from now on).
   */
  async function ensureBuffer(): Promise<CapturedCall[]> {
    if (buffer) return buffer;
    buffer = await deps.buffer.getValue().catch(() => [] as CapturedCall[]);
    return buffer;
  }

  /** Mirror the buffer to storage.session so a SW kill doesn't lose it. */
  async function persistBuffer(): Promise<void> {
    if (!buffer) return;
    // Fire-and-forget with logging: a quota write failure must not fail the push
    // (the in-memory buffer is still the source of truth while this SW lives);
    // we only lose crash-resilience for calls captured after this point.
    await deps.buffer.setValue(buffer).catch((err: unknown) =>
      console.error('[recording] failed to persist call buffer', err),
    );
  }

  async function getState(): Promise<RecordingState> {
    return deps.state.getValue();
  }

  async function start(input: {
    tabId: number;
    origin: string;
    url: string;
  }): Promise<RecordingState> {
    return enqueue(async () => {
      buffer = [];
      await deps.buffer.setValue([]);
      const state: RecordingState = {
        active: true,
        paused: false,
        tabId: input.tabId,
        origin: input.origin,
        startedAt: deps.now(),
        count: 0,
      };
      await deps.state.setValue(state);
      return state;
    });
  }

  /** Toggle pause. While paused the session stays active but incoming calls are dropped. */
  async function setPaused(paused: boolean): Promise<RecordingState> {
    return enqueue(async () => {
      const state = await deps.state.getValue();
      if (!state.active) return state;
      const next = { ...state, paused };
      await deps.state.setValue(next);
      return next;
    });
  }

  /** Push a captured call if it belongs to the active recording tab and is an API call. */
  async function push(
    call: CapturedCall,
    senderTabId: number | undefined,
  ): Promise<number> {
    return enqueue(async () => {
      const state = await deps.state.getValue();
      if (!state.active || state.paused || state.tabId == null) return state.count;
      if (senderTabId !== state.tabId) return state.count;
      if (!isApiCall(call)) return state.count;

      // Drop calls blacklisted by an enabled filter rule (never persisted).
      const filterRules = await deps.filterRules.getValue();
      if (isBlacklisted(call.url, filterRules)) return state.count;

      const buf = await ensureBuffer();
      buf.push(call);
      await persistBuffer();
      const next = { ...state, count: buf.length };
      await deps.state.setValue(next);
      return next.count;
    });
  }

  /** Stop recording, persist to IndexedDB, and reset state. Returns the recording id. */
  async function stop(): Promise<StopResult> {
    return enqueue(async () => {
      const state = await deps.state.getValue();
      const buf = state.active ? await ensureBuffer() : [];

      if (!state.active || buf.length === 0) {
        buffer = [];
        await deps.buffer.setValue([]);
        await deps.state.setValue(IDLE_RECORDING_STATE);
        return { recordingId: null, state: IDLE_RECORDING_STATE };
      }

      const recordingId = deps.newId();
      const createdAt = deps.now();
      const calls: ApiCall[] = buf.map((c, i) => ({
        ...c,
        id: deps.newId(),
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
      await deps.saveRecording(recording, calls);
      buffer = [];
      await deps.buffer.setValue([]);
      await deps.state.setValue(IDLE_RECORDING_STATE);
      return { recordingId, state: IDLE_RECORDING_STATE };
    });
  }

  return { getState, start, setPaused, push, stop };
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
