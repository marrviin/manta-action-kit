import { describe, it, expect } from 'vitest';
import { checkQuestion, toInternal, defaultTokenizer } from './agent';

describe('checkQuestion', () => {
  const valid = {
    choice: { type: 'choice', instructions: 'Pick one', criteria: { a: 'A', b: 'B' } },
    score: { type: 'score', instructions: 'Rate it', criteria: ['low', 'high'] },
    noul: { type: 'noul', instructions: 'Is it so?' },
  } as const;

  it('accepts well-formed questions of every type', () => {
    expect(() => checkQuestion('q', valid.choice)).not.toThrow();
    expect(() => checkQuestion('q', valid.score)).not.toThrow();
    expect(() => checkQuestion('q', valid.noul)).not.toThrow();
    // Criteria list form for choice, and criteria omitted for noul.
    expect(() => checkQuestion('q', { type: 'choice', instructions: 'i', criteria: ['x', 'y'] })).not.toThrow();
  });

  it('rejects a non-dict definition, an unknown type and a missing instructions', () => {
    expect(() => checkQuestion('q', null)).toThrow(/must be a dict/);
    expect(() => checkQuestion('q', [1])).toThrow(/must be a dict/);
    expect(() => checkQuestion('q', { type: 'essay', instructions: 'i' })).toThrow(/unknown type/);
    expect(() => checkQuestion('q', { type: 'noul' })).toThrow(/no 'instructions'/);
    expect(() => checkQuestion('q', { type: 'noul', instructions: '' })).not.toThrow();
  });

  it('rejects malformed choice criteria', () => {
    const q = (criteria: unknown) => ({ type: 'choice', instructions: 'i', criteria });
    expect(() => checkQuestion('q', q('x'))).toThrow(/dict of label/);
    expect(() => checkQuestion('q', q({}))).toThrow(/at least one criterion/);
    expect(() => checkQuestion('q', q([{}, 'b']))).toThrow(/choice label 0/);
    expect(() => checkQuestion('q', q([null]))).toThrow(/choice label 0 is null/);
    // 1 and "1" share one answer key.
    expect(() => checkQuestion('q', q([1, '1']))).toThrow(/repeats label 0/);
  });

  it('rejects malformed score criteria', () => {
    const q = (criteria: unknown) => ({ type: 'score', instructions: 'i', criteria });
    expect(() => checkQuestion('q', q('x'))).toThrow(/list of level/);
    expect(() => checkQuestion('q', q([]))).toThrow(/at least one level/);
    expect(() => checkQuestion('q', q(['low', null]))).toThrow(/score level 1 is null/);
  });

  it('rejects malformed noul criteria and labels', () => {
    expect(() => checkQuestion('q', { type: 'noul', instructions: 'i', criteria: 'x' })).toThrow(/noul question takes 'criteria'/);
    expect(() =>
      checkQuestion('q', { type: 'noul', instructions: 'i', criteria: { true: 't', maybe: 'm' } }),
    ).toThrow(/only 'true' and 'false'/);
    expect(() =>
      checkQuestion('q', { type: 'noul', instructions: 'i', labels: { false: 'no' } }),
    ).toThrow(/exactly 'false' and 'true'/);
    expect(() =>
      checkQuestion('q', { type: 'noul', instructions: 'i', labels: { false: 'no', true: 'no' } }),
    ).toThrow(/must be distinct/);
  });

  it("rejects 'labels' on non-noul questions", () => {
    expect(() =>
      checkQuestion('q', { ...valid.choice, labels: { false: 'n', true: 'y' } }),
    ).toThrow(/only supported for noul/);
  });
});

describe('toInternal', () => {
  it('converts a choice criteria LIST into a label -> null dict', () => {
    const q = toInternal({ type: 'choice', instructions: 'i', criteria: ['x', 'y'] });
    expect(q.t).toBe('choice');
    expect(q.crit).toEqual({ x: null, y: null });
  });

  it('lowercases noul criteria keys and passes other types through', () => {
    const noul = toInternal({ type: 'noul', instructions: 'i', criteria: { TRUE: 'yes' } });
    expect(noul.crit).toEqual({ true: 'yes' });
    const score = toInternal({ type: 'score', instructions: 'i', criteria: ['a', 'b'] });
    expect(score.crit).toEqual(['a', 'b']);
  });

  it('serializes non-string instructions and trims noul labels', () => {
    const q = toInternal({ type: 'noul', instructions: { k: 'v' }, labels: { false: ' no ', true: ' yes ' } });
    expect(q.ins).toContain('"k"');
    expect(q.labels).toEqual({ false: 'no', true: 'yes' });
  });
});

describe('defaultTokenizer', () => {
  it('returns a BERT-style tokenizer whose ids are stable', () => {
    const tok = defaultTokenizer();
    expect(tok.clsId).toBe(101);
    expect(tok.sepId).toBe(102);
    expect(tok.maskId).toBe(103);
    expect(tok.maskToken).toBe('[MASK]');
    expect(typeof tok.encode('hello')).toBe('object');
  });
});
