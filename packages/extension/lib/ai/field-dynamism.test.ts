/**
 * Pure-logic tests for the field-dynamism pass (no extension APIs).
 */
import { describe, expect, it } from 'vitest';
import type { ApiCall, EndpointSummary } from '@/lib/recording/types';
import {
  STABLE_AT,
  VARIES_AT,
  attachDynamism,
  buildDynamismBatch,
  classifyByStats,
  collectCandidates,
  computeDynamism,
  dynamismVerdictFromAnswers,
  mergeDynamismResults,
} from './field-dynamism';

let seqCounter = 0;
function makeCall(overrides: Partial<ApiCall> = {}): ApiCall {
  seqCounter += 1;
  const seq = overrides.seq ?? seqCounter;
  return {
    id: `call-${seq}`,
    recordingId: 'rec-1',
    seq,
    source: 'fetch',
    method: 'POST',
    url: `https://example.com/api/checkout`,
    reqHeaders: {},
    reqBody: null,
    status: 200,
    statusText: 'OK',
    resHeaders: {},
    resBody: null,
    resIsJson: false,
    startedAt: seq * 1000,
    durationMs: 10,
    errored: false,
    ...overrides,
  };
}

describe('collectCandidates', () => {
  it('collects body leaves and query params keyed by endpoint', () => {
    const calls = [
      makeCall({ reqBody: '{"traceId":"s1","amount":5}' }),
      makeCall({ reqBody: '{"traceId":"s2","amount":7}' }),
    ];
    const cands = collectCandidates(calls);
    const byPath = Object.fromEntries(cands.map((c) => [c.leafPath, c]));
    expect(byPath['body.traceId'].samples).toEqual(['s1', 's2']);
    expect(byPath['body.amount'].samples).toEqual(['5', '7']);
    expect(byPath['body.traceId'].endpointKey).toBe('POST /api/checkout');
  });

  it('groups by normalized endpoint key across volatile path ids', () => {
    const calls = [
      makeCall({ seq: 1, url: 'https://example.com/api/orders/101', method: 'GET', reqBody: '{"page":"1"}' }),
      makeCall({ seq: 2, url: 'https://example.com/api/orders/202', method: 'GET', reqBody: '{"page":"2"}' }),
    ];
    const cands = collectCandidates(calls);
    expect(cands.every((c) => c.endpointKey === 'GET /api/orders/:id')).toBe(true);
  });

  it('skips leaves under sensitive paths and with secret-looking values', () => {
    const calls = [
      makeCall({
        reqBody:
          '{"user":{"password":"hunter2"},"note":"ok","auth":"eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.xYz123456789","sessionId":"abc"}',
      }),
    ];
    const paths = collectCandidates(calls).map((c) => c.leafPath);
    expect(paths).toEqual(['body.note']);
  });

  it('ignores non-JSON bodies and unparseable urls', () => {
    const calls = [makeCall({ reqBody: 'a=1&b=2', url: 'garbage' })];
    expect(collectCandidates(calls)).toEqual([]);
  });
});

describe('classifyByStats', () => {
  const t0 = Date.now();
  const base = { endpointKey: 'POST /api/x', leafPath: 'body.a', sampleCall: makeCall() };

  it('returns null for a single observation (the model queue)', () => {
    expect(classifyByStats({ ...base, samples: ['v1'] }, t0)).toBeNull();
  });

  it('marks all-distinct samples as varies', () => {
    const m = classifyByStats({ ...base, samples: ['v1', 'v2', 'v3'] }, t0)!;
    expect(m).toMatchObject({ verdict: 'varies', source: 'stats' });
  });

  it('marks all-identical samples as stable', () => {
    const m = classifyByStats({ ...base, samples: ['v1', 'v1'] }, t0)!;
    expect(m.verdict).toBe('stable');
  });

  it('marks identical timestamps as varies (two close calls collide)', () => {
    const m = classifyByStats(
      { ...base, samples: ['2024-05-01T10:00:00Z', '2024-05-01T10:00:00Z'] },
      t0,
    )!;
    expect(m.verdict).toBe('varies');
  });

  it('marks partially distinct samples as varies', () => {
    const m = classifyByStats({ ...base, samples: ['v1', 'v1', 'v2'] }, t0)!;
    expect(m.verdict).toBe('varies');
  });
});

describe('computeDynamism / buildDynamismBatch', () => {
  it('routes single-observation leaves to the model queue and multi-observation to stats', () => {
    const calls = [
      makeCall({ seq: 1, reqBody: '{"once":"a1","repeat":"r1"}' }),
      makeCall({ seq: 2, reqBody: '{"repeat":"r2"}' }),
    ];
    const { statsMarks, queue } = computeDynamism(calls);
    expect(queue.map((c) => c.leafPath)).toEqual(['body.once']);
    expect(Object.keys(statsMarks['POST /api/checkout'])).toEqual(['body.repeat']);
  });

  it('builds one state per queued leaf with the per-leaf signal first', () => {
    const { states, leaves, questions } = buildDynamismBatch([
      { endpointKey: 'POST /api/x', leafPath: 'body.sessionId', samples: ['abc123'], sampleCall: makeCall({ reqBody: '{"sessionId":"abc123"}' }) },
    ]);
    expect(leaves).toHaveLength(1);
    expect(Object.keys(states[0])).toEqual(['field', 'endpoint', 'samples', 'context']);
    expect(states[0].field).toBe('body.sessionId');
    expect(states[0].context).toContain('"sessionId":"abc123"');
    expect(questions).toHaveProperty('stable_across_runs');
  });

  it('renders query leaves with a query context', () => {
    const { states } = buildDynamismBatch([
      { endpointKey: 'GET /api/x', leafPath: 'query.page', samples: ['3'], sampleCall: makeCall({ method: 'GET', url: 'https://example.com/api/x?page=3' }) },
    ]);
    expect(states[0].context).toBe('query-param: page=3');
  });
});

describe('dynamismVerdictFromAnswers / mergeDynamismResults', () => {
  it('maps the noul head onto the three verdicts', () => {
    expect(dynamismVerdictFromAnswers({ stable_across_runs: { noul: STABLE_AT } }).verdict).toBe('stable');
    expect(dynamismVerdictFromAnswers({ stable_across_runs: { noul: VARIES_AT } }).verdict).toBe('varies');
    expect(
      dynamismVerdictFromAnswers({ stable_across_runs: { noul: (STABLE_AT + VARIES_AT) / 2 } }).verdict,
    ).toBe('uncertain');
    expect(dynamismVerdictFromAnswers({}).confidence).toBe(0.5);
  });

  it('merges results keyed endpoint → leaf with source "model"', () => {
    const leaves = [
      { endpointKey: 'POST /api/x', leafPath: 'body.sessionId', samples: ['a'], sampleCall: makeCall() },
      { endpointKey: 'POST /api/x', leafPath: 'query.page', samples: ['1'], sampleCall: makeCall() },
    ];
    const marks = mergeDynamismResults(leaves, [
      { stable_across_runs: { noul: 0.1, answer_confidence: 0.7 } },
      null,
    ]);
    expect(marks['POST /api/x']['body.sessionId']).toMatchObject({
      verdict: 'varies',
      source: 'model',
      confidence: 0.7,
    });
    expect(marks['POST /api/x']['query.page'].verdict).toBe('uncertain');
  });
});

describe('attachDynamism', () => {
  const dyn = { verdict: 'varies' as const, source: 'stats' as const, confidence: 0.9, analyzedAt: 1 };
  const ep: EndpointSummary = {
    key: 'POST /api/checkout',
    method: 'POST',
    pathKey: '/api/checkout',
    sampleUrl: 'https://example.com/api/checkout',
    callCount: 2,
    statuses: [200],
    requestSchema: {
      kind: 'object',
      properties: {
        sessionId: { kind: 'string' },
        nested: { kind: 'object', properties: { token: { kind: 'string' } } },
      },
    },
    responseSchema: null,
    queryKeys: ['page'],
  };

  it('attaches marks to body leaves and query params', () => {
    const [out] = attachDynamism([ep], {
      'POST /api/checkout': {
        'body.sessionId': dyn,
        'body.nested.token': dyn,
        'query.page': dyn,
      },
    });
    expect(out.requestSchema!.properties!.sessionId.dynamism).toBe(dyn);
    expect(out.requestSchema!.properties!.nested.properties!.token.dynamism).toBe(dyn);
    expect(out.queryDynamism!.page).toBe(dyn);
  });

  it('walks array indices onto schema items', () => {
    const epArr: EndpointSummary = {
      ...ep,
      requestSchema: { kind: 'array', items: { kind: 'object', properties: { sku: { kind: 'string' } } } },
    };
    const [out] = attachDynamism([epArr], {
      'POST /api/checkout': { 'body.[0].sku': dyn },
    });
    expect(out.requestSchema!.items!.properties!.sku.dynamism).toBe(dyn);
  });

  it('does not mutate the shared schema when another endpoint gets marks', () => {
    const other: EndpointSummary = { ...ep, key: 'GET /other' };
    const out = attachDynamism([ep, other], {
      'GET /other': { 'body.sessionId': dyn },
    });
    // `other` gets a cloned tree with the mark…
    expect(out[1].requestSchema!.properties!.sessionId.dynamism).toBe(dyn);
    // …while `ep`'s shared schema node stays untouched.
    expect(out[0].requestSchema!.properties!.sessionId.dynamism).toBeUndefined();
    expect(ep.requestSchema!.properties!.sessionId.dynamism).toBeUndefined();
  });

  it('returns the input unchanged when the recording has no marks', () => {
    expect(attachDynamism([ep], undefined)[0]).toBe(ep);
  });
});
