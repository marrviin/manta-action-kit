/**
 * Pure-logic tests for the recording-relevance analysis (no extension APIs).
 */
import { describe, expect, it } from 'vitest';
import type { ApiCall, CapturedInteraction, FieldDependency } from '@/lib/recording/types';
import {
  IRRELEVANT_AT,
  MAX_CHAIN_CHARS,
  MAX_CHAIN_LINES,
  MAX_INTENT_CHARS,
  MAX_INTENT_LINES,
  RELEVANT_AT,
  buildRelevanceStates,
  callSummary,
  chainSummary,
  demoteWriteIrrelevant,
  intentSummary,
  mergeVerdicts,
  pathOf,
  verdictFromAnswers,
} from './relevance';

let seqCounter = 0;
function makeCall(overrides: Partial<ApiCall> = {}): ApiCall {
  seqCounter += 1;
  return {
    id: `call-${seqCounter}`,
    recordingId: 'rec-1',
    seq: seqCounter,
    source: 'fetch',
    method: 'GET',
    url: `https://example.com/api/item/${seqCounter}`,
    reqHeaders: {},
    reqBody: null,
    status: 200,
    statusText: 'OK',
    resHeaders: {},
    resBody: '{"ok":true}',
    resIsJson: true,
    startedAt: seqCounter * 1000,
    durationMs: 10,
    errored: false,
    ...overrides,
  };
}

describe('pathOf', () => {
  it('strips the origin and keeps the path', () => {
    expect(pathOf('https://api.example.com/v1/users?limit=5')).toBe(
      '/v1/users?limit=5',
    );
  });

  it('truncates a long query string', () => {
    const p = pathOf(`https://a.com/x?q=${'a'.repeat(300)}`);
    expect(p.length).toBeLessThanOrEqual('/x?'.length + 120 + 1);
    expect(p.startsWith('/x?')).toBe(true);
  });

  it('falls back to a clipped raw string for unparseable urls', () => {
    expect(pathOf('not a url')).toBe('not a url');
  });
});

describe('chainSummary', () => {
  it('renders one line per distinct endpoint, keeping the host', () => {
    const calls = [makeCall({ seq: 0 }), makeCall({ seq: 1, method: 'POST' })];
    const chain = chainSummary(calls);
    expect(chain).toBe('GET example.com/api/item/1\nPOST example.com/api/item/2');
  });

  it('dedupes repeated method+path pairs with a repeat count', () => {
    const url = 'https://report.example.com/collect';
    const calls = [
      makeCall({ seq: 0, url }),
      makeCall({ seq: 1, method: 'POST', url: 'https://a.com/business' }),
      makeCall({ seq: 2, url }),
    ];
    const chain = chainSummary(calls);
    expect(chain).toBe(
      'GET report.example.com/collect (x2)\nPOST a.com/business',
    );
  });

  it('caps the line count with a truncation marker', () => {
    const calls = Array.from({ length: MAX_CHAIN_LINES + 10 }, (_, i) =>
      makeCall({ seq: i }),
    );
    const chain = chainSummary(calls);
    expect(chain.split('\n')).toHaveLength(MAX_CHAIN_LINES + 1);
    expect(chain).toContain(`+10 more endpoints`);
  });

  it('caps the total character budget', () => {
    const calls = Array.from({ length: 30 }, (_, i) =>
      makeCall({ seq: i, url: `https://a.com/${'x'.repeat(300)}` }),
    );
    expect(chainSummary(calls).length).toBeLessThanOrEqual(
      MAX_CHAIN_CHARS + 2,
    );
  });
});

describe('callSummary', () => {
  it('includes clipped request and response bodies', () => {
    const call = makeCall({
      reqBody: '{"a":"' + 'b'.repeat(2000) + '"}',
      resBody: '{"c":"' + 'd'.repeat(2000) + '"}',
    });
    const text = callSummary(call);
    expect(text).toContain(`request-body: `);
    expect(text.length).toBeLessThan(call.reqBody!.length + call.resBody!.length);
    expect(text).toContain('…');
  });

  it('states the response size even when the body is opaque', () => {
    const text = callSummary(makeCall({ resBody: '{"code":0}' }));
    expect(text).toContain('response: HTTP 200, 10 chars');
  });

  it('summarizes SSE streams by event names', () => {
    const call = makeCall({
      streaming: true,
      resBody: null,
      sseEvents: [
        { event: 'thinking', data: 'x' },
        { event: 'message', data: 'y' },
      ],
    });
    expect(callSummary(call)).toContain('SSE stream [thinking, message]');
  });

  it('notes errored calls', () => {
    expect(callSummary(makeCall({ errored: true, errorText: 'boom' }))).toContain(
      'error: boom',
    );
  });

  it('states the preceding user action as a causal hint', () => {
    const text = callSummary(
      makeCall({ precedingInteraction: { kind: 'click', text: '登录', deltaMs: 33 } }),
    );
    expect(text).toContain('user-action: click "登录" 33ms before');
    // Absent interaction → no line at all (silence is the signal).
    expect(callSummary(makeCall())).not.toContain('user-action');
  });
});

describe('intentSummary', () => {
  it('renders kinds with optional text and value', () => {
    const intent = intentSummary([
      { kind: 'click', at: 1, text: '登录', page: { path: '/' } },
      { kind: 'change', at: 2, value: '«redacted»', page: { path: '/' } },
    ]);
    expect(intent).toBe('click "登录"\nchange ="«redacted»"');
  });

  it('returns empty for missing/empty interactions', () => {
    expect(intentSummary(undefined)).toBe('');
    expect(intentSummary([])).toBe('');
  });

  it('keeps the most recent lines and caps the character budget', () => {
    const many = Array.from({ length: MAX_INTENT_LINES + 5 }, (_, i) => ({
      kind: 'click' as const,
      at: i,
      text: `btn-${i}`,
      page: { path: '/' },
    }));
    const intent = intentSummary(many);
    expect(intent).not.toContain('btn-4'); // dropped head
    expect(intent).toContain(`btn-${MAX_INTENT_LINES + 4}`); // kept tail

    const huge = Array.from({ length: MAX_INTENT_LINES }, () => ({
      kind: 'click' as const,
      at: 1,
      text: 'x'.repeat(200),
      page: { path: '/' },
    }));
    expect(intentSummary(huge).length).toBeLessThanOrEqual(MAX_INTENT_CHARS + 1);
  });
});

describe('buildRelevanceStates', () => {
  it('aligns states with call ids and shares the chain', () => {
    const calls = [makeCall({ seq: 1 }), makeCall({ seq: 2 })];
    const { states, callIds, questions } = buildRelevanceStates(calls);
    expect(states).toHaveLength(2);
    expect(callIds).toEqual(calls.map((c) => c.id));
    expect(states[0].chain).toBe(states[1].chain);
    // Truncation cuts the state's TAIL — the per-call `request` must serialize
    // before the shared `chain`, or every state collapses into the same text.
    expect(Object.keys(states[0])).toEqual(['request', 'chain']);
    expect(states[0].request).toContain('#1 GET');
    expect(states[1].request).toContain('#2 GET');
    expect(questions).toHaveProperty('is_noise');
    expect(questions).toHaveProperty('role');
  });

  it('omits the intent key when the recording has no interactions', () => {
    const { states } = buildRelevanceStates([makeCall()]);
    expect(Object.keys(states[0])).toEqual(['request', 'chain']);
  });

  it('embeds the shared intent context after the chain', () => {
    const calls = [makeCall(), makeCall()];
    const interactions: CapturedInteraction[] = [
      { kind: 'click', at: 1, text: '登录', page: { path: '/' } },
    ];
    const { states } = buildRelevanceStates(calls, interactions);
    expect(Object.keys(states[0])).toEqual(['request', 'chain', 'intent']);
    expect(states[0].intent).toBe(states[1].intent);
    expect(states[0].intent).toContain('click "登录"');
  });
});

describe('verdictFromAnswers', () => {
  it('marks high noise probability irrelevant', () => {
    const { relevance } = verdictFromAnswers({
      is_noise: { noul: 0.9, answer_confidence: 0.9 },
      role: { choice: 'telemetry' },
    });
    expect(relevance.verdict).toBe('irrelevant');
    expect(relevance.role).toBe('telemetry');
  });

  it('marks low noise probability relevant', () => {
    const { relevance } = verdictFromAnswers({
      is_noise: { noul: 0.1, answer_confidence: 0.85 },
    });
    expect(relevance.verdict).toBe('relevant');
    expect(relevance.confidence).toBe(0.85);
  });

  it('stays uncertain in the middle band', () => {
    const mid = (RELEVANT_AT + IRRELEVANT_AT) / 2;
    const { relevance } = verdictFromAnswers({
      is_noise: { noul: mid, answer_confidence: 0.51 },
    });
    expect(relevance.verdict).toBe('uncertain');
  });

  it('tolerates malformed answers', () => {
    const { relevance } = verdictFromAnswers({
      is_noise: { noul: Number.NaN },
      role: { choice: 42 as unknown as string },
    });
    expect(relevance.verdict).toBe('uncertain');
    expect(relevance.confidence).toBe(0.5);
    expect(relevance.role).toBeUndefined();
  });

  it('lowers the irrelevant bar when the role head votes noise', () => {
    const { relevance } = verdictFromAnswers({
      is_noise: { noul: 0.55, answer_confidence: 0.6 },
      role: { choice: 'telemetry' },
    });
    // 0.55 is below the base 0.7 bar but above the noise-role 0.5 bar.
    expect(relevance.verdict).toBe('irrelevant');
  });

  it('treats the preflight_static role as a noise vote too', () => {
    const { relevance } = verdictFromAnswers({
      is_noise: { noul: 0.55, answer_confidence: 0.6 },
      role: { choice: 'preflight_static' },
    });
    expect(relevance.verdict).toBe('irrelevant');
  });

  it('raises the irrelevant bar when the role head votes business data', () => {
    const { relevance } = verdictFromAnswers({
      is_noise: { noul: 0.75, answer_confidence: 0.75 },
      role: { choice: 'business_data' },
    });
    // 0.75 clears the base 0.7 bar but not the protected-role 0.8 bar.
    expect(relevance.verdict).toBe('uncertain');
  });
});

describe('mergeVerdicts', () => {
  it('passes model verdicts through by index', () => {
    const calls = [makeCall(), makeCall(), makeCall()];
    const results = [
      { is_noise: { noul: 0.9, answer_confidence: 0.8 } },
      null,
      { is_noise: { noul: 0.2, answer_confidence: 0.7 } },
    ];
    const merged = mergeVerdicts(calls, undefined, results);
    expect(merged.map((m) => m.relevance.verdict)).toEqual([
      'irrelevant',
      'uncertain',
      'relevant',
    ]);
    expect(merged[0].callId).toBe(calls[0].id);
  });

  it('forces both endpoints of every dependency to relevant', () => {
    const calls = [
      makeCall({ seq: 1 }),
      makeCall({ seq: 2 }),
      makeCall({ seq: 3 }),
    ];
    const deps: FieldDependency[] = [
      {
        id: 'dep-1',
        fromSeq: 1,
        fromPath: 'data.id',
        toSeq: 3,
        toLocation: 'body',
        toPath: 'orderId',
        value: '42',
        origin: 'inferred',
      },
    ];
    const results = calls.map(() => ({
      is_noise: { noul: 0.95, answer_confidence: 0.99 },
    }));
    const merged = mergeVerdicts(calls, deps, results);
    expect(merged[0].relevance.verdict).toBe('relevant');
    expect(merged[0].relevance.confidence).toBe(1);
    expect(merged[2].relevance.verdict).toBe('relevant');
    // The un-anchored middle call keeps the model verdict.
    expect(merged[1].relevance.verdict).toBe('irrelevant');
  });

  it('stamps the same analyzedAt on every entry', () => {
    const merged = mergeVerdicts([makeCall()], undefined, [null]);
    expect(merged[0].relevance.analyzedAt).toBeGreaterThan(0);
  });

  it('anchors only evidence-backed edges: manual or depCheck-likely', () => {
    const mk = (over: Partial<FieldDependency>): FieldDependency => ({
      id: `d${seqCounter++}`,
      fromSeq: 1,
      fromPath: 'v',
      toSeq: 2,
      toLocation: 'body',
      toPath: 'v',
      value: 'val123',
      origin: 'inferred',
      ...over,
    });
    const calls = [makeCall({ seq: 1 }), makeCall({ seq: 2 })];
    const results = calls.map(() => ({
      is_noise: { noul: 0.9, answer_confidence: 0.9 },
    }));
    const verdictOf = (deps: FieldDependency[]) =>
      mergeVerdicts(calls, deps, results).map((m) => m.relevance.verdict);

    // Unproven inferred edges never force 'relevant' — the model verdict stands.
    expect(verdictOf([mk({ depCheck: { verdict: 'unlikely', confidence: 0.7, analyzedAt: 1 } })]))
      .toEqual(['irrelevant', 'irrelevant']);
    expect(verdictOf([mk({ depCheck: { verdict: 'uncertain', confidence: 0.6, analyzedAt: 1 } })]))
      .toEqual(['irrelevant', 'irrelevant']);
    // Evidence-backed edges anchor.
    expect(verdictOf([mk({ depCheck: { verdict: 'likely', confidence: 0.8, analyzedAt: 1 } })]))
      .toEqual(['relevant', 'relevant']);
    expect(verdictOf([mk({ origin: 'manual' })])).toEqual(['relevant', 'relevant']);
    expect(verdictOf([mk({ origin: 'confirmed' })])).toEqual(['relevant', 'relevant']);
    // No depCheck (dep-confidence pass degraded/absent) falls back to anchoring.
    expect(verdictOf([mk({})])).toEqual(['relevant', 'relevant']);
    // One unproven edge cannot outweigh one trusted edge on the same call.
    expect(
      verdictOf([
        mk({ id: 'a', toSeq: 2, depCheck: { verdict: 'uncertain', confidence: 0.6, analyzedAt: 1 } }),
        mk({ id: 'b', toSeq: 2, depCheck: { verdict: 'likely', confidence: 0.8, analyzedAt: 1 } }),
      ]),
    ).toEqual(['relevant', 'relevant']);
  });
});

describe('demoteWriteIrrelevant', () => {
  it('demotes an irrelevant verdict on a mutating call without a noise-role vote', () => {
    // Reads (GET/HEAD/OPTIONS) keep the model verdict.
    expect(demoteWriteIrrelevant('GET', 'other', 'irrelevant')).toBe('irrelevant');
    expect(demoteWriteIrrelevant('HEAD', undefined, 'irrelevant')).toBe('irrelevant');
    expect(demoteWriteIrrelevant('OPTIONS', 'other', 'irrelevant')).toBe('irrelevant');
    // A POST with an explicit noise vote is a reporting call — keep it.
    expect(demoteWriteIrrelevant('POST', 'telemetry', 'irrelevant')).toBe('irrelevant');
    expect(demoteWriteIrrelevant('POST', 'preflight_static', 'irrelevant')).toBe('irrelevant');
    // A POST the role head did NOT vote noise on: worst case is 'uncertain'.
    expect(demoteWriteIrrelevant('POST', 'other', 'irrelevant')).toBe('uncertain');
    expect(demoteWriteIrrelevant('PUT', undefined, 'irrelevant')).toBe('uncertain');
    expect(demoteWriteIrrelevant('DELETE', 'business_data', 'irrelevant')).toBe('uncertain');
    // Only the 'irrelevant' verdict is guarded.
    expect(demoteWriteIrrelevant('POST', 'other', 'uncertain')).toBe('uncertain');
    expect(demoteWriteIrrelevant('POST', 'other', 'relevant')).toBe('relevant');
  });

  it('keeps a write irrelevant when its role head voted noise in mergeVerdicts', () => {
    // Telemetry POST: role head voted noise → demotion must NOT fire.
    const noiseCalls = [
      makeCall({ seq: 1, method: 'POST', url: 'https://mon.example.com/collect' }),
    ];
    const noise = mergeVerdicts(
      noiseCalls,
      undefined,
      [{ is_noise: { noul: 0.9, answer_confidence: 0.8 }, role: { choice: 'telemetry' } }],
    );
    expect(noise[0].relevance.verdict).toBe('irrelevant');

    // Business write POST: role head voted 'other' → demoted to uncertain.
    const writeCalls = [makeCall({ seq: 1, method: 'POST', url: 'https://api.example.com/create' })];
    const write = mergeVerdicts(
      writeCalls,
      undefined,
      [{ is_noise: { noul: 0.71, answer_confidence: 0.7 }, role: { choice: 'other' } }],
    );
    expect(write[0].relevance.verdict).toBe('uncertain');
  });
});
