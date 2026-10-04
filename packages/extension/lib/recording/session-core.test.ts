/**
 * Tests for the recording session state machine (session-core.ts).
 * Uses in-memory fake stores — no extension APIs, no DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSession,
  isApiCall,
  MAX_INTERACTIONS,
  shouldKeepInteraction,
  type SessionDeps,
  type StateStore,
} from './session-core';
import {
  IDLE_RECORDING_STATE,
  type CapturedCall,
  type CapturedInteraction,
  type RecordingState,
} from './types';

/** In-memory StateStore fake. */
function store<T>(initial: T): StateStore<T> & { data: T } {
  const s = {
    data: initial,
    async getValue() {
      return s.data;
    },
    async setValue(v: T) {
      s.data = v;
    },
  };
  return s;
}

function makeDeps(): SessionDeps & {
  state: ReturnType<typeof store<RecordingState>>;
  buffer: ReturnType<typeof store<CapturedCall[]>>;
  rules: ReturnType<typeof store<RecordingFilterRuleList>>;
  interactionStore: ReturnType<typeof store<CapturedInteraction[]>>;
  saved: Array<{ recording: unknown; calls: unknown[] }>;
} {
  const saved: Array<{ recording: unknown; calls: unknown[] }> = [];
  const state = store<RecordingState>({ ...IDLE_RECORDING_STATE });
  const buffer = store<CapturedCall[]>([]);
  const rules = store<RecordingFilterRuleList>([]);
  const interactionStore = store<CapturedInteraction[]>([]);
  let idCounter = 0;
  return {
    state,
    buffer,
    rules,
    interactionStore,
    saved,
    filterRules: rules,
    interactions: interactionStore,
    saveRecording: vi.fn(async (recording, calls) => {
      saved.push({ recording, calls });
    }),
    newId: () => `id-${++idCounter}`,
    now: () => 1_700_000_000_000,
  };
}

type RecordingFilterRuleList = SessionDeps['filterRules'] extends StateStore<infer T>
  ? T
  : never;

/** Build a minimal CapturedCall; override any field. */
function call(overrides: Partial<CapturedCall> = {}): CapturedCall {
  return {
    source: 'fetch',
    method: 'GET',
    url: 'https://api.example.com/v1/things',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    statusText: 'OK',
    resHeaders: {},
    resBody: '{"ok":true}',
    resIsJson: true,
    startedAt: 0,
    durationMs: 10,
    errored: false,
    ...overrides,
  };
}

/** Build a minimal CapturedInteraction; override any field. */
function interaction(overrides: Partial<CapturedInteraction> = {}): CapturedInteraction {
  return {
    kind: 'click',
    at: 0,
    text: 'load',
    page: { path: '/' },
    ...overrides,
  };
}

describe('isApiCall', () => {
  it('keeps JSON responses', () => {
    expect(isApiCall(call())).toBe(true);
  });

  it('keeps errored requests even when the body is not JSON', () => {
    expect(isApiCall(call({ errored: true, resIsJson: false, method: 'GET' }))).toBe(
      true,
    );
  });

  it('keeps streaming (SSE) responses', () => {
    expect(
      isApiCall(call({ streaming: true, resIsJson: false, method: 'GET' })),
    ).toBe(true);
  });

  it('keeps mutating verbs even without a JSON body', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isApiCall(call({ method, resIsJson: false, resBody: '' }))).toBe(true);
    }
  });

  it('drops non-JSON GETs', () => {
    expect(isApiCall(call({ resIsJson: false, resBody: '<html>…</html>' }))).toBe(
      false,
    );
  });

  it('drops static assets by extension', () => {
    expect(
      isApiCall(call({ resIsJson: false, method: 'GET', url: 'https://x.com/app.js' })),
    ).toBe(false);
    expect(
      isApiCall(
        call({ resIsJson: false, method: 'GET', url: 'https://x.com/a/font.woff2' }),
      ),
    ).toBe(false);
  });

  it('drops static assets even with a query string', () => {
    expect(
      isApiCall(call({ resIsJson: false, url: 'https://x.com/app.js?v=123' })),
    ).toBe(false);
  });
});

describe('createSession', () => {
  it('start activates recording with a clean buffer and zero count', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    const state = await s.start({ tabId: 7, origin: 'https://x.com', url: '' });
    expect(state.active).toBe(true);
    expect(state.tabId).toBe(7);
    expect(state.count).toBe(0);
    expect(deps.buffer.data).toEqual([]);
    expect(deps.state.data).toEqual(state);
  });

  it('accepts a call from the recorded tab and increments count', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 7, origin: 'https://x.com', url: '' });
    const count = await s.push(call(), 7);
    expect(count).toBe(1);
    expect(deps.buffer.data).toHaveLength(1);
    expect(deps.state.data.count).toBe(1);
  });

  it('rejects calls from other tabs, while inactive, and while paused', async () => {
    const deps = makeDeps();
    const s = createSession(deps);

    // Inactive: nothing accepted.
    expect(await s.push(call(), 7)).toBe(0);

    await s.start({ tabId: 7, origin: 'https://x.com', url: '' });

    // Wrong tab.
    expect(await s.push(call(), 8)).toBe(0);
    expect(deps.buffer.data).toHaveLength(0);

    // Paused.
    await s.setPaused(true);
    expect(await s.push(call(), 7)).toBe(0);
    expect(deps.buffer.data).toHaveLength(0);

    // Resume works.
    await s.setPaused(false);
    expect(await s.push(call(), 7)).toBe(1);
  });

  it('serializes concurrent pushes without losing updates', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 1, origin: 'https://x.com', url: '' });

    // Fire 20 pushes at once — each is a read-modify-write of the buffer and
    // count; without the queue some would race and the final count would drift.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.push(call({ url: `https://api.example.com/v1/${i}` }), 1),
      ),
    );

    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(deps.buffer.data).toHaveLength(20);
    expect(deps.state.data.count).toBe(20);
  });

  it('restores the buffer from storage after a simulated SW restart', async () => {
    const deps = makeDeps();
    const s1 = createSession(deps);
    await s1.start({ tabId: 3, origin: 'https://x.com', url: '' });
    await s1.push(call({ url: 'https://api.example.com/before' }), 3);
    expect(deps.buffer.data).toHaveLength(1); // mirrored to storage on push

    // New SW: a fresh session instance with the same stores. The in-memory
    // buffer is gone; the first push/stop must restore what was persisted.
    const s2 = createSession(deps);
    const count = await s2.push(call({ url: 'https://api.example.com/after' }), 3);
    expect(count).toBe(2);
    await s2.stop();

    const { recording, calls } = deps.saved[0]!;
    expect(calls).toHaveLength(2);
    expect((calls as CapturedCall[]).map((c) => c.url)).toEqual([
      'https://api.example.com/before',
      'https://api.example.com/after',
    ]);
    expect((recording as { callCount: number }).callCount).toBe(2);
  });

  it('stop persists the recording with ids/seq/deps and resets state', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 5, origin: 'https://app.example.com', url: '' });
    await s.push(call(), 5);
    await s.push(
      call({ url: 'https://api.example.com/orders/42', method: 'POST' }),
      5,
    );

    const { recordingId, state } = await s.stop();
    expect(recordingId).not.toBeNull();
    expect(state).toEqual(IDLE_RECORDING_STATE);

    expect(deps.saved).toHaveLength(1);
    const { recording, calls } = deps.saved[0]!;
    const rec = recording as {
      id: string;
      name: string;
      origin: string;
      callCount: number;
      deps: unknown[];
    };
    expect(rec.id).toBe(recordingId);
    expect(rec.origin).toBe('https://app.example.com');
    expect(rec.callCount).toBe(2);
    expect(rec.name).toContain('app.example.com');
    const apiCalls = calls as Array<{ id: string; recordingId: string; seq: number }>;
    expect(apiCalls.map((c) => c.seq)).toEqual([0, 1]);
    expect(apiCalls.every((c) => c.recordingId === recordingId)).toBe(true);
    expect(apiCalls.every((c) => c.id.length > 0)).toBe(true);

    // Buffer cleared and state idle after stop.
    expect(deps.buffer.data).toEqual([]);
  });

  it('stop with nothing captured resets state without saving', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 5, origin: 'https://x.com', url: '' });
    const { recordingId, state } = await s.stop();
    expect(recordingId).toBeNull();
    expect(state).toEqual(IDLE_RECORDING_STATE);
    expect(deps.saved).toHaveLength(0);
    expect(deps.buffer.data).toEqual([]);
  });

  it('stop persists before flipping state to idle (use-recordings refresh ordering)', async () => {
    const deps = makeDeps();
    const events: string[] = [];
    deps.saveRecording = async () => {
      events.push('save');
    };
    // Wrap the state store's setValue to observe the idle transition.
    const rawSet = deps.state.setValue.bind(deps.state);
    deps.state.setValue = async (v: RecordingState) => {
      if (!v.active) events.push('idle');
      await rawSet(v);
    };
    const s = createSession(deps);
    await s.start({ tabId: 5, origin: 'https://x.com', url: '' });
    await s.push(call(), 5);
    await s.stop();
    expect(events.indexOf('save')).toBeLessThan(events.indexOf('idle'));
  });

  it('drops calls matching an enabled blacklist rule but keeps non-matching ones', async () => {
    const deps = makeDeps();
    deps.rules.data = [
      { id: 'r1', pattern: '*telemetry*', enabled: true, createdAt: 0 },
      { id: 'r2', pattern: '*disabled-rule*', enabled: false, createdAt: 0 },
    ];
    const s = createSession(deps);
    await s.start({ tabId: 1, origin: 'https://x.com', url: '' });

    expect(await s.push(call({ url: 'https://x.com/api/telemetry/report' }), 1)).toBe(
      0,
    );
    // Disabled rule must not filter.
    expect(
      await s.push(call({ url: 'https://x.com/api/disabled-rule/x' }), 1),
    ).toBe(1);
    expect(await s.push(call({ url: 'https://x.com/api/keep' }), 1)).toBe(2);
  });
});

describe('shouldKeepInteraction', () => {
  it('keeps the first interaction', () => {
    expect(shouldKeepInteraction(undefined, interaction({ at: 100 }))).toBe(true);
  });

  it('drops an identical interaction within the dedupe window', () => {
    const prev = interaction({ kind: 'click', text: 'load', at: 100 });
    expect(shouldKeepInteraction(prev, interaction({ kind: 'click', text: 'load', at: 400 }))).toBe(
      false,
    );
  });

  it('keeps an identical interaction past the dedupe window', () => {
    const prev = interaction({ kind: 'click', text: 'load', at: 100 });
    expect(shouldKeepInteraction(prev, interaction({ kind: 'click', text: 'load', at: 700 }))).toBe(
      true,
    );
  });

  it('keeps interactions differing in kind, text, or name', () => {
    const prev = interaction({ kind: 'click', text: 'load', at: 100 });
    expect(
      shouldKeepInteraction(prev, interaction({ kind: 'submit', text: 'load', at: 200 })),
    ).toBe(true);
    expect(
      shouldKeepInteraction(prev, interaction({ kind: 'click', text: 'other', at: 200 })),
    ).toBe(true);
    expect(
      shouldKeepInteraction(
        interaction({ kind: 'change', text: undefined, name: 'q', at: 100 }),
        interaction({ kind: 'change', text: undefined, name: 'email', at: 200 }),
      ),
    ).toBe(true);
  });
});

describe('pushInteraction', () => {
  it('rejects interactions while inactive, from other tabs, or while paused', async () => {
    const deps = makeDeps();
    const s = createSession(deps);

    expect(await s.pushInteraction(interaction(), 7)).toBe(0);

    await s.start({ tabId: 7, origin: 'https://x.com', url: '' });
    expect(await s.pushInteraction(interaction(), 8)).toBe(0);

    await s.setPaused(true);
    expect(await s.pushInteraction(interaction(), 7)).toBe(0);

    await s.setPaused(false);
    expect(await s.pushInteraction(interaction(), 7)).toBe(1);
    expect(deps.interactionStore.data).toHaveLength(1);
    expect(deps.state.data.count).toBe(0); // count is calls-only
  });

  it('dedupes identical rapid-fire interactions', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 1, origin: 'https://x.com', url: '' });

    expect(await s.pushInteraction(interaction({ at: 1000 }), 1)).toBe(1);
    expect(await s.pushInteraction(interaction({ at: 1200 }), 1)).toBe(1); // deduped
    expect(await s.pushInteraction(interaction({ at: 1300, text: 'other' }), 1)).toBe(2);
    expect(deps.interactionStore.data.map((i) => i.text)).toEqual(['load', 'other']);
  });

  it('caps the buffer at MAX_INTERACTIONS, dropping the oldest', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 1, origin: 'https://x.com', url: '' });

    for (let i = 0; i < MAX_INTERACTIONS + 5; i++) {
      await s.pushInteraction(interaction({ text: `btn-${i}`, at: i * 1000 }), 1);
    }
    expect(deps.interactionStore.data).toHaveLength(MAX_INTERACTIONS);
    expect(deps.interactionStore.data[0]!.text).toBe('btn-5'); // oldest 5 dropped
  });
});

describe('interactions at stop', () => {
  it('persists the interaction timeline and attaches preceding interactions', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 5, origin: 'https://x.com', url: '' });

    await s.pushInteraction(interaction({ kind: 'click', text: 'load', at: 10_000 }), 5);
    await s.push(call({ startedAt: 10_400 }), 5); // 400ms after the click -> attached
    await s.push(call({ startedAt: 15_000 }), 5); // 5s later -> nothing attached
    await s.pushInteraction(
      interaction({ kind: 'change', text: undefined, name: 'q', value: 'hello', at: 16_000 }),
      5,
    );

    const { recordingId } = await s.stop();
    const { recording, calls } = deps.saved[0]!;
    expect((recording as { interactions?: CapturedInteraction[] }).interactions).toHaveLength(2);

    const apiCalls = calls as Array<{
      startedAt: number;
      precedingInteraction?: { kind: string; text?: string; deltaMs: number };
    }>;
    expect(apiCalls[0]!.precedingInteraction).toEqual({
      kind: 'click',
      text: 'load',
      deltaMs: 400,
    });
    expect(apiCalls[1]!.precedingInteraction).toBeUndefined();
    expect(recordingId).not.toBeNull();
  });

  it('omits the interactions field when none were captured', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 5, origin: 'https://x.com', url: '' });
    await s.push(call(), 5);
    await s.stop();
    const { recording } = deps.saved[0]!;
    expect('interactions' in (recording as object)).toBe(false);
  });

  it('clears the interaction store on stop, both in the normal and the empty-buffer path', async () => {
    const deps = makeDeps();
    const s = createSession(deps);
    await s.start({ tabId: 5, origin: 'https://x.com', url: '' });
    await s.pushInteraction(interaction(), 5);
    await s.push(call(), 5);
    await s.stop();
    expect(deps.interactionStore.data).toEqual([]);

    // Empty-buffer path: interactions exist but no calls -> early return still clears.
    const deps2 = makeDeps();
    const s2 = createSession(deps2);
    await s2.start({ tabId: 5, origin: 'https://x.com', url: '' });
    await s2.pushInteraction(interaction(), 5);
    const { recordingId } = await s2.stop();
    expect(recordingId).toBeNull();
    expect(deps2.interactionStore.data).toEqual([]);
  });

  it('restores the interaction buffer after a simulated SW restart', async () => {
    const deps = makeDeps();
    const s1 = createSession(deps);
    await s1.start({ tabId: 3, origin: 'https://x.com', url: '' });
    await s1.pushInteraction(interaction({ text: 'before', at: 1000 }), 3);
    expect(deps.interactionStore.data).toHaveLength(1);

    // Fresh session over the same stores (SW restart): restore must append.
    const s2 = createSession(deps);
    const count = await s2.pushInteraction(interaction({ text: 'after', at: 5000 }), 3);
    expect(count).toBe(2);
    expect(deps.interactionStore.data.map((i) => i.text)).toEqual(['before', 'after']);
  });
});
