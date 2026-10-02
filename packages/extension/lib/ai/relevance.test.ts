/**
 * Pure-logic tests for the recording-relevance analysis (no extension APIs).
 */
import { describe, expect, it } from 'vitest';
import type { ApiCall, FieldDependency } from '@/lib/recording/types';
import {
  IRRELEVANT_AT,
  MAX_CHAIN_CHARS,
  MAX_CHAIN_LINES,
  RELEVANT_AT,
  buildRelevanceStates,
  callSummary,
  chainSummary,
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
});
