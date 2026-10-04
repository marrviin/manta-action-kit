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
  CapturedInteraction,
  Recording,
  RecordingFilterRule,
  RecordingState,
} from './types';
import { IDLE_RECORDING_STATE } from './types';
import { isBlacklisted } from './filter';
import { inferDependencies } from './infer-deps';
import { attachPrecedingInteractions } from './interaction';

/** Minimal async KV the state machine needs (satisfied by WXT storage items). */
export interface StateStore<T> {
  getValue(): Promise<T>;
  setValue(v: T): Promise<void>;
}

export interface SessionStores {
  state: StateStore<RecordingState>;
  buffer: StateStore<CapturedCall[]>;
  filterRules: StateStore<RecordingFilterRule[]>;
  /** User-interaction buffer (same SW-sleep restore semantics as `buffer`). */
  interactions: StateStore<CapturedInteraction[]>;
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

/** Two interactions closer than this with the same kind+text+name are one action (double-clicks, re-fires). */
export const INTERACTION_DEDUPE_MS = 500;
/** Hard cap on interactions kept per recording; the oldest are dropped first. */
export const MAX_INTERACTIONS = 300;

/**
 * Dedupe rule for interactions (pure, exported for tests): an interaction
 * identical in kind/text/name to the PREVIOUSLY ACCEPTED one within
 * `INTERACTION_DEDUPE_MS` is a repeat of the same action and is dropped.
 */
export function shouldKeepInteraction(
  prev: CapturedInteraction | undefined,
  next: CapturedInteraction,
): boolean {
  if (!prev) return true;
  if (next.at - prev.at >= INTERACTION_DEDUPE_MS) return true;
  return (
    next.kind !== prev.kind ||
    (next.text ?? '') !== (prev.text ?? '') ||
    (next.name ?? '') !== (prev.name ?? '')
  );
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

  /** In-memory interaction buffer, same lifecycle as `buffer`. */
  let interactions: CapturedInteraction[] | null = null;

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

  /** Restore the in-memory interaction buffer after a SW restart (same rules as `ensureBuffer`). */
  async function ensureInteractions(): Promise<CapturedInteraction[]> {
    if (interactions) return interactions;
    interactions = await deps.interactions.getValue().catch(() => [] as CapturedInteraction[]);
    return interactions;
  }

  /** Mirror the interaction buffer to storage.session (same degrade philosophy as `persistBuffer`). */
  async function persistInteractions(): Promise<void> {
    if (!interactions) return;
    await deps.interactions.setValue(interactions).catch((err: unknown) =>
      console.error('[recording] failed to persist interaction buffer', err),
    );
  }

  /** Clear both in-memory interaction state and its session mirror. */
  async function resetInteractions(): Promise<void> {
    interactions = [];
    await deps.interactions.setValue([]).catch((err: unknown) =>
      console.error('[recording] failed to clear interaction buffer', err),
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
      await resetInteractions();
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

  /**
   * Push a captured user interaction if it belongs to the active recording tab.
   * Same active/paused/tab filters as `push`; deduped against the previously
   * accepted interaction; capped at MAX_INTERACTIONS (oldest dropped). Does NOT
   * bump RecordingState.count — that counter is calls-only.
   */
  async function pushInteraction(
    interaction: CapturedInteraction,
    senderTabId: number | undefined,
  ): Promise<number> {
    return enqueue(async () => {
      const state = await deps.state.getValue();
      if (!state.active || state.paused || state.tabId == null) return 0;
      if (senderTabId !== state.tabId) return 0;

      const list = await ensureInteractions();
      const prev = list[list.length - 1];
      if (!shouldKeepInteraction(prev, interaction)) return list.length;

      list.push(interaction);
      while (list.length > MAX_INTERACTIONS) list.shift();
      await persistInteractions();
      return list.length;
    });
  }

  /** Stop recording, persist to IndexedDB, and reset state. Returns the recording id. */
  async function stop(): Promise<StopResult> {
    return enqueue(async () => {
      const state = await deps.state.getValue();
      const buf = state.active ? await ensureBuffer() : [];
      const ints = state.active ? await ensureInteractions() : [];

      if (!state.active || buf.length === 0) {
        buffer = [];
        await deps.buffer.setValue([]);
        await resetInteractions();
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

      // Link each call to the interaction that likely triggered it (nearest
      // within the window) so UI/MCP/model consumers never re-derive it.
      attachPrecedingInteractions(calls, ints);

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
        // Keep the raw interaction timeline on the recording (Phase 2 feeds it to
        // laya). Omit when empty so old recordings and interaction-less ones compare equal.
        ...(ints.length > 0 ? { interactions: [...ints] } : {}),
      };

      // Persist BEFORE flipping state to idle: the side panel's recording list
      // refreshes on the active->idle transition (see hooks/use-recordings.ts), so
      // the recording must already be in IndexedDB when that signal fires — otherwise
      // the refresh reads a stale list and the new record appears to be missing.
      await deps.saveRecording(recording, calls);
      buffer = [];
      await deps.buffer.setValue([]);
      await resetInteractions();
      await deps.state.setValue(IDLE_RECORDING_STATE);
      return { recordingId, state: IDLE_RECORDING_STATE };
    });
  }

  return { getState, start, setPaused, push, pushInteraction, stop };
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
