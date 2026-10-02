import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import {
  planFromJsonSchema,
  questionsFromJsonSchema,
  answersToJson,
  decide,
  SchemaError,
  MAX_PROPERTIES,
  MAX_OPTIONS,
  MAX_SCORE_LEVELS,
  type PlannedField,
  type DecideRunner,
} from './structured';

describe('planFromJsonSchema', () => {
  it('plans an enum string as a choice with options in enum order', () => {
    const fields = planFromJsonSchema({
      type: 'object',
      properties: {
        dept: { type: 'string', enum: ['billing', 'support'], description: 'Department' },
      },
    });
    expect(fields).toHaveLength(1);
    const f = fields[0] as PlannedField;
    expect(f.kind).toBe('choice');
    expect(f.options).toEqual([
      ['billing', 'billing'],
      ['support', 'support'],
    ]);
    expect(f.question.type).toBe('choice');
    expect(f.question.instructions).toBe('Department');
  });

  it('plans a boolean as a noul question', () => {
    const fields = planFromJsonSchema({
      type: 'object',
      properties: { needs_human: { type: 'boolean' } },
    });
    expect(fields[0]!.kind).toBe('noul');
    expect(fields[0]!.question.type).toBe('noul');
  });

  it('plans a boolean enum as noul too', () => {
    const fields = planFromJsonSchema({
      type: 'object',
      properties: { flag: { enum: [true, false] } },
    });
    expect(fields[0]!.kind).toBe('noul');
  });

  it('plans a bounded integer as a score with level labels', () => {
    const fields = planFromJsonSchema({
      type: 'object',
      properties: { urgency: { type: 'integer', minimum: 1, maximum: 3 } },
    });
    const f = fields[0] as PlannedField;
    expect(f.kind).toBe('score');
    expect(f.minimum).toBe(1);
    expect(f.question.criteria).toEqual(['1', '2', '3']);
  });

  it('plans a const as a single-option choice', () => {
    const fields = planFromJsonSchema({
      type: 'object',
      properties: { fixed: { const: 'always' } },
    });
    expect(fields[0]!.kind).toBe('choice');
    expect(fields[0]!.options).toEqual([['always', 'always']]);
  });

  it('unwraps an Optional[...] union (one non-null branch), keeping the outer description', () => {
    const fields = planFromJsonSchema({
      type: 'object',
      properties: {
        dept: {
          description: 'Which team',
          anyOf: [{ type: 'null' }, { type: 'string', enum: ['a', 'b'] }],
        },
      },
    });
    expect(fields[0]!.kind).toBe('choice');
    expect(fields[0]!.question.instructions).toBe('Which team');
  });

  it('rejects unions with more than one non-null branch', () => {
    expect(() =>
      planFromJsonSchema({
        type: 'object',
        properties: { x: { anyOf: [{ type: 'string', enum: ['a'] }, { type: 'integer', minimum: 0, maximum: 1 }] } },
      }),
    ).toThrow(SchemaError);
  });

  it('rejects unsupported shapes, naming the path', () => {
    const base = { type: 'object', properties: {} } as const;
    expect(() => planFromJsonSchema({ ...base, properties: { s: { type: 'string' } } }))
      .toThrow(/properties\.s/);
    expect(() => planFromJsonSchema({ ...base, properties: { a: { type: 'array', items: {} } } }))
      .toThrow(/arrays/);
    expect(() => planFromJsonSchema({ ...base, properties: { o: { type: 'object' } } }))
      .toThrow(/nested objects/);
    expect(() => planFromJsonSchema({ ...base, properties: { r: { $ref: '#/x' } } }))
      .toThrow(/\$ref/);
  });

  it('rejects malformed enum / score definitions', () => {
    const base = { type: 'object', properties: {} } as const;
    expect(() => planFromJsonSchema({ ...base, properties: { e: { enum: [] } } })).toThrow(/empty/);
    expect(() =>
      planFromJsonSchema({ ...base, properties: { e: { enum: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => i) } } }),
    ).toThrow(/MAX_OPTIONS/);
    expect(() => planFromJsonSchema({ ...base, properties: { s: { type: 'string', enum: ['a', 'a'] } } }))
      .toThrow(/duplicate/);
    expect(() => planFromJsonSchema({ ...base, properties: { n: { type: 'integer' } } }))
      .toThrow(/minimum/);
    expect(() =>
      planFromJsonSchema({ ...base, properties: { n: { type: 'integer', minimum: 3, maximum: 1 } } }),
    ).toThrow(/below/);
    expect(() =>
      planFromJsonSchema({
        ...base,
        properties: { n: { type: 'integer', minimum: 0, maximum: MAX_SCORE_LEVELS } },
      }),
    ).toThrow(/MAX_SCORE_LEVELS/);
  });

  it('rejects a malformed top level', () => {
    expect(() => planFromJsonSchema(null)).toThrow(SchemaError);
    expect(() => planFromJsonSchema('x')).toThrow(SchemaError);
    expect(() => planFromJsonSchema([])).toThrow(SchemaError);
    expect(() => planFromJsonSchema({ type: 'string' })).toThrow(/top level/);
    expect(() => planFromJsonSchema({ type: 'object', properties: {} })).toThrow(/non-empty/);
    expect(() => planFromJsonSchema({ type: 'object' })).toThrow(/properties/);
  });

  it('rejects more than MAX_PROPERTIES fields', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PROPERTIES; i++) properties[`f${i}`] = { enum: ['a', 'b'] };
    expect(() => planFromJsonSchema({ type: 'object', properties })).toThrow(/MAX_PROPERTIES/);
  });
});

describe('questionsFromJsonSchema', () => {
  it('maps field name -> question', () => {
    const qs = questionsFromJsonSchema({
      type: 'object',
      properties: {
        dept: { type: 'string', enum: ['a', 'b'] },
        urgent: { type: 'boolean' },
      },
    });
    expect(Object.keys(qs)).toEqual(['dept', 'urgent']);
    expect(qs.dept!.type).toBe('choice');
    expect(qs.urgent!.type).toBe('noul');
  });
});

describe('answersToJson', () => {
  const schema = {
    type: 'object',
    properties: {
      dept: { type: 'string', enum: ['billing', 'support'] },
      urgent: { type: 'boolean' },
      level: { type: 'integer', minimum: 2, maximum: 4 },
    },
  };

  it('projects a choice label back to its enum value', () => {
    const values = answersToJson({ dept: { choice: 'support' } }, schema);
    expect(values.dept).toBe('support');
  });

  it('projects noul by the 0.5 threshold', () => {
    const values = answersToJson({ urgent: { noul: 0.9 } }, schema);
    expect(values.urgent).toBe(true);
    expect(answersToJson({ urgent: { noul: 0.2 } }, schema).urgent).toBe(false);
  });

  it('projects score by the best probability level, plus minimum offset', () => {
    const values = answersToJson(
      { level: { probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } } },
      schema,
    );
    expect(values.level).toBe(4); // idx 2 + minimum 2
  });

  it('projects score by rounding the raw score when no probabilities exist', () => {
    const values = answersToJson({ level: { score: 1.4 } }, schema);
    expect(values.level).toBe(3); // round(1.4)=1, + minimum 2
  });

  it('projects a low-confidence answer to null and skips a missing answer', () => {
    const values = answersToJson(
      { dept: { choice: 'billing', low_confidence: true } },
      schema,
    );
    expect(values.dept).toBeNull();
    expect(values).not.toHaveProperty('urgent');
  });
});

function fakeRunner(answers: Record<string, Record<string, any> | undefined>): {
  runner: DecideRunner;
  predict: MockedFunction<DecideRunner['predict']>;
} {
  const predict = vi.fn<DecideRunner['predict']>().mockResolvedValue({ answers, usage: { u: 1 } });
  return { runner: { predict } as DecideRunner, predict };
}

describe('decide', () => {
  const schema = {
    type: 'object',
    properties: {
      dept: { type: 'string', enum: ['billing', 'support'] },
      urgent: { type: 'boolean' },
    },
  };

  it('projects answers onto schema values', async () => {
    const { runner, predict } = fakeRunner({
      dept: { choice: 'billing' },
      urgent: { noul: 0.8 },
    });
    const values = await decide(runner, 'state', schema);
    expect(values).toEqual({ dept: 'billing', urgent: true });
    // The planned questions were what got sent to the runner.
    const qs = predict.mock.calls[0]![1] as Record<string, { type: string }>;
    expect(qs.dept!.type).toBe('choice');
  });

  it('returns raw answers when explicit questions are given', async () => {
    const { runner } = fakeRunner({ q1: { choice: 'x' } });
    const values = await decide(runner, 'state', undefined, {
      questions: { q1: { type: 'choice', instructions: '?', criteria: { x: null } } },
    });
    expect(values).toEqual({ q1: { choice: 'x' } });
  });

  it('throws unless exactly one of schema / questions is passed', async () => {
    const { runner } = fakeRunner({});
    await expect(decide(runner, 's', schema, { questions: {} })).rejects.toThrow(/exactly one/);
    await expect(decide(runner, 's')).rejects.toThrow(/exactly one/);
  });

  it('accepts a model exposing toJSONSchema()', async () => {
    const { runner } = fakeRunner({ dept: { choice: 'support' } });
    const model = { toJSONSchema: () => schema };
    const values = await decide(runner, 's', model);
    expect(values.dept).toBe('support');
  });

  it('forwards minConfidence (validated) and other options to predict', async () => {
    const { runner, predict } = fakeRunner({ dept: { choice: 'billing' } });
    await decide(runner, 's', schema, { minConfidence: 0.6, model: 'x' });
    const opts = predict.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.minConfidence).toBe(0.6);
    expect(opts.model).toBe('x');
    await expect(decide(runner, 's', schema, { minConfidence: 1.5 })).rejects.toThrow();
  });

  it('returns details with per-field confidence and noul probabilities', async () => {
    const { runner } = fakeRunner({
      dept: { choice: 'billing', confidence: 0.9 },
      urgent: { type: 'noul', noul: 0.25, confidence: 0.5 },
    });
    const details = await decide(runner, 's', schema, { returnDetails: true });
    expect(details.values).toEqual({ dept: 'billing', urgent: false });
    expect(details.confidence).toEqual({ dept: 0.9, urgent: 0.5 });
    expect(details.probabilities.urgent).toEqual({ false: 0.75, true: 0.25 });
    expect(details.usage).toEqual({ u: 1 });
  });
});
