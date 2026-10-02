import { describe, it, expect } from 'vitest';
import {
  normaliseName,
  englishFromCode,
  matchTypedDecisionsWorkflow,
  digestsFromEnv,
  DEFAULT_MODELS,
} from './router';

describe('normaliseName', () => {
  it('resolves aliases case-insensitively, trimmed', () => {
    expect(normaliseName('En')).toBe('english');
    expect(normaliseName('  LAYA ')).toBe('english');
    expect(normaliseName('multi')).toBe('multilingual');
    expect(normaliseName('typed_decisions')).toBe('typed-decisions');
    expect(normaliseName('laya-typed-decisions')).toBe('typed-decisions');
  });

  it('accepts canonical names and rejects unknown ones', () => {
    for (const name of Object.keys(DEFAULT_MODELS)) {
      expect(normaliseName(name)).toBe(name);
    }
    expect(() => normaliseName('gpt-4')).toThrow(/unknown model/);
  });
});

describe('englishFromCode', () => {
  it('maps english subtags to true', () => {
    expect(englishFromCode('en')).toBe(true);
    expect(englishFromCode('en-US')).toBe(true);
    expect(englishFromCode('en_US.UTF-8')).toBe(true);
    expect(englishFromCode('eng')).toBe(true);
    expect(englishFromCode('English')).toBe(true);
  });

  it('maps non-english codes to false', () => {
    expect(englishFromCode('zh')).toBe(false);
    expect(englishFromCode('fr-FR')).toBe(false);
    expect(englishFromCode('de_DE.UTF-8')).toBe(false);
  });

  it('abstains (null) on blank, language-agnostic and undetermined codes', () => {
    expect(englishFromCode('')).toBeNull();
    expect(englishFromCode('   ')).toBeNull();
    expect(englishFromCode(null)).toBeNull();
    expect(englishFromCode(undefined)).toBeNull();
    for (const code of ['C', 'POSIX', 'C.UTF-8', 'und', 'zxx', 'mul']) {
      expect(englishFromCode(code)).toBeNull();
    }
  });
});

describe('matchTypedDecisionsWorkflow', () => {
  it('matches a workflow when the question id set is exactly its signature', () => {
    expect(
      matchTypedDecisionsWorkflow({
        action: {}, needs_review: {}, outcome: {}, risk: {}, urgency: {},
      }),
    ).toBe('agent_trace_observability');
    expect(
      matchTypedDecisionsWorkflow({
        category: {}, churn_risk: {}, needs_human: {}, urgency: {}, action: {},
      }),
    ).toBe('customer_service');
  });

  it('returns null on supersets, subsets and null/undefined input', () => {
    expect(matchTypedDecisionsWorkflow({ action: {}, needs_review: {} })).toBeNull();
    expect(
      matchTypedDecisionsWorkflow({
        action: {}, needs_review: {}, outcome: {}, risk: {}, urgency: {}, extra: {},
      }),
    ).toBeNull();
    expect(matchTypedDecisionsWorkflow(null)).toBeNull();
    expect(matchTypedDecisionsWorkflow(undefined)).toBeNull();
  });
});

describe('digestsFromEnv', () => {
  const MODELS = { english: {}, multilingual: {} };

  function withEnv(digests: string | undefined, fn: () => void) {
    const old = process.env['LAYA_SHA256_DIGESTS'];
    if (digests === undefined) delete process.env['LAYA_SHA256_DIGESTS'];
    else process.env['LAYA_SHA256_DIGESTS'] = digests;
    try {
      fn();
    } finally {
      if (old === undefined) delete process.env['LAYA_SHA256_DIGESTS'];
      else process.env['LAYA_SHA256_DIGESTS'] = old;
    }
  }

  it('returns {} when the env var is absent, blank or unparseable', () => {
    withEnv(undefined, () => expect(digestsFromEnv(MODELS)).toEqual({}));
    withEnv('  ', () => expect(digestsFromEnv(MODELS)).toEqual({}));
    withEnv('not json', () => expect(digestsFromEnv(MODELS)).toEqual({}));
  });

  it('returns {} for a FLAT {artifact: digest} map (providers apply it)', () => {
    withEnv(JSON.stringify({ 'model.safetensors': 'abc' }), () => {
      expect(digestsFromEnv(MODELS)).toEqual({});
    });
  });

  it('expands a per-model map, normalising names and backfilling missing models', () => {
    withEnv(JSON.stringify({ en: { 'model.safetensors': 'd1' } }), () => {
      const out = digestsFromEnv(MODELS);
      expect(out.english).toEqual({ 'model.safetensors': 'd1' });
      expect(out.multilingual).toEqual({});
    });
  });

  it('rejects a map mixing flat and per-model values', () => {
    withEnv(JSON.stringify({ en: { a: 'd' }, flat: 'x' }), () => {
      expect(() => digestsFromEnv(MODELS)).toThrow(/mixes the two/);
    });
  });

  it('rejects values that are neither string nor object', () => {
    withEnv(JSON.stringify({ en: 42 }), () => {
      expect(() => digestsFromEnv(MODELS)).toThrow();
    });
  });
});
