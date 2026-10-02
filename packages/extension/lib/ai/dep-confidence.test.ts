/**
 * Pure-logic tests for the dep-confidence pass (no extension APIs).
 */
import { describe, expect, it } from 'vitest';
import type { ApiCall, FieldDependency } from '@/lib/recording/types';
import {
  LIKELY_AT,
  MAX_CONTEXT_CHARS,
  UNLIKELY_AT,
  buildDepStates,
  clipAround,
  depVerdictFromAnswers,
  mergeDepChecks,
  valueShape,
} from './dep-confidence';

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
    url: `https://example.com/api/step/${seq}`,
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

function makeDep(overrides: Partial<FieldDependency> = {}): FieldDependency {
  return {
    id: 'dep-1',
    fromSeq: 1,
    fromPath: 'data.orderId',
    toSeq: 2,
    toLocation: 'body',
    toPath: 'orderId',
    value: 'ord_9f2a1b',
    origin: 'inferred',
    ...overrides,
  };
}

describe('valueShape', () => {
  it('recognizes the common value shapes', () => {
    expect(valueShape('2024-05-01T10:00:00Z')).toBe('timestamp');
    expect(valueShape('1714557600123')).toBe('epoch-ms');
    expect(valueShape('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid');
    expect(valueShape('eyJhbGci.eyJzdWIi.SflKxwRJ')).toBe('jwt-like');
    expect(valueShape('a@b.com')).toBe('email');
    expect(valueShape('1714557600')).toBe('numeric');
    expect(valueShape('9f2a1b3c4d5e')).toBe('hex');
    expect(valueShape('aWQ9MTIzJmFjdGlvbj1saXN0')).toBe('base64-like');
    expect(valueShape('ord_9f2a1b')).toBe('text');
  });
});

describe('clipAround', () => {
  it('extracts the subtree at the path', () => {
    const body = JSON.stringify({ data: { items: [{ id: 'a1' }, { id: 'b2' }] }, ts: 1 });
    expect(clipAround(body, 'data.items[1].id')).toBe('"b2"');
    expect(clipAround(body, 'data.items[0]')).toBe('{"id":"a1"}');
  });

  it('falls back to the whole clipped text for non-JSON bodies', () => {
    const text = 'x'.repeat(MAX_CONTEXT_CHARS + 50);
    const out = clipAround(text, 'whatever');
    expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back when the path does not resolve', () => {
    const body = '{"a":1}';
    expect(clipAround(body, 'no.such.path')).toBe(body);
  });

  it('renders "(none)" for a missing body', () => {
    expect(clipAround(null, 'a')).toBe('(none)');
  });
});

describe('buildDepStates', () => {
  const producer = makeCall({
    seq: 1,
    method: 'POST',
    url: 'https://example.com/api/orders',
    resBody: '{"data":{"orderId":"ord_9f2a1b"}}',
    resIsJson: true,
  });
  const consumer = makeCall({
    seq: 2,
    method: 'POST',
    url: 'https://example.com/api/pay',
    reqBody: '{"orderId":"ord_9f2a1b","amount":5}',
  });

  it('builds one state per inferred edge with per-edge signal first', () => {
    const deps = [makeDep()];
    const { states, edges, questions } = buildDepStates([producer, consumer], deps);
    expect(states).toHaveLength(1);
    expect(edges[0].id).toBe('dep-1');
    expect(Object.keys(states[0])).toEqual(['link', 'value', 'from', 'to']);
    expect(states[0].link).toContain('#1 data.orderId');
    expect(states[0].link).toContain('#2 body.orderId');
    // The value is annotated with its length and shape, not shown raw-only.
    expect(states[0].value).toContain('10 chars, text');
    expect(states[0].from).toContain('#1 POST https://example.com/api/orders');
    expect(states[0].to).toContain('"orderId":"ord_9f2a1b"');
    expect(questions).toHaveProperty('is_real_dependency');
  });

  it('skips confirmed and manual edges', () => {
    const deps = [
      makeDep({ id: 'a', origin: 'confirmed' }),
      makeDep({ id: 'b', origin: 'manual' }),
      makeDep({ id: 'c' }),
    ];
    const { states, edges } = buildDepStates([producer, consumer], deps);
    expect(states).toHaveLength(1);
    expect(edges[0].id).toBe('c');
  });

  it('skips edges whose endpoint calls no longer exist', () => {
    const { states, edges } = buildDepStates([consumer], [makeDep({ fromSeq: 99 })]);
    expect(states).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('renders query and header consumption locations', () => {
    const q = makeDep({
      id: 'q',
      toLocation: 'query',
      toPath: 'orderId',
      value: 'ord_9f2a1b',
    });
    const h = makeDep({
      id: 'h',
      toLocation: 'header',
      toPath: 'X-Request-Id',
      value: 'ord_9f2a1b',
    });
    const consumer2 = {
      ...consumer,
      url: 'https://example.com/api/pay?orderId=ord_9f2a1b',
      reqHeaders: { 'X-Request-Id': 'ord_9f2a1b' },
    };
    const { states } = buildDepStates([producer, consumer2], [q, h]);
    expect(states[0].to).toContain('request-query: orderId=ord_9f2a1b');
    expect(states[1].to).toContain('request-header: X-Request-Id: ord_9f2a1b');
  });
});

describe('depVerdictFromAnswers', () => {
  it('marks high p as likely', () => {
    expect(depVerdictFromAnswers({ is_real_dependency: { noul: 0.9, answer_confidence: 0.8 } })).toEqual({
      verdict: 'likely',
      confidence: 0.8,
    });
  });

  it('marks low p as unlikely', () => {
    expect(depVerdictFromAnswers({ is_real_dependency: { noul: UNLIKELY_AT - 0.01 } }).verdict).toBe(
      'unlikely',
    );
  });

  it('stays uncertain in the middle band', () => {
    const mid = (LIKELY_AT + UNLIKELY_AT) / 2;
    expect(depVerdictFromAnswers({ is_real_dependency: { noul: mid } }).verdict).toBe('uncertain');
  });

  it('degrades to uncertain on malformed answers', () => {
    const v = depVerdictFromAnswers({ is_real_dependency: { noul: Number.NaN } });
    expect(v.verdict).toBe('uncertain');
    expect(v.confidence).toBe(0.5);
  });
});

describe('mergeDepChecks', () => {
  it('aligns results to edges by index and stamps analyzedAt', () => {
    const edges = [makeDep({ id: 'a' }), makeDep({ id: 'b' })];
    const merged = mergeDepChecks(edges, [
      { is_real_dependency: { noul: 0.95, answer_confidence: 0.9 } },
      null,
    ]);
    expect(merged[0].depId).toBe('a');
    expect(merged[0].depCheck.verdict).toBe('likely');
    expect(merged[1].depId).toBe('b');
    expect(merged[1].depCheck.verdict).toBe('uncertain');
    expect(merged[0].depCheck.analyzedAt).toBe(merged[1].depCheck.analyzedAt);
  });
});
