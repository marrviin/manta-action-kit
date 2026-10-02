import { describe, it, expect } from 'vitest';
import { inferSchema } from './schema';

describe('inferSchema', () => {
  it('infers an object schema with redacted primitive examples', () => {
    const s = inferSchema([JSON.stringify({ id: 1, name: 'x', active: true })]);
    expect(s).toEqual({
      kind: 'object',
      properties: {
        id: { kind: 'number', example: '1' },
        name: { kind: 'string', example: 'x' },
        active: { kind: 'boolean', example: 'true' },
      },
    });
  });

  it('masks sensitive-keyed examples via redactExample', () => {
    const s = inferSchema([JSON.stringify({ token: 'super-secret-value', password: 'hunter2' })]);
    const token = (s as any).properties.token;
    const password = (s as any).properties.password;
    expect(token.example).not.toContain('super-secret-value');
    expect(password.example).not.toContain('hunter2');
  });

  it('marks properties missing from some samples as optional', () => {
    const s = inferSchema([
      JSON.stringify({ a: 1, b: 'x' }),
      JSON.stringify({ a: 2 }),
    ]);
    const props = (s as any).properties;
    expect(props.a.optional).toBeUndefined();
    expect(props.b).toMatchObject({ kind: 'string', optional: true });
  });

  it('flags nullable when a property is null in one sample', () => {
    const s = inferSchema([
      JSON.stringify({ v: 'x' }),
      JSON.stringify({ v: null }),
    ]);
    expect((s as any).properties.v).toMatchObject({ kind: 'string', nullable: true });
  });

  it('merges array element shapes across samples', () => {
    const s = inferSchema([JSON.stringify({ items: [{ id: 1 }, { id: 2, tag: 'a' }] })]);
    const items = (s as any).properties.items;
    expect(items.kind).toBe('array');
    expect(items.items.properties.id).toBeDefined();
    expect(items.items.properties.tag).toMatchObject({ optional: true });
  });

  it('leaves array items undefined for an empty array sample', () => {
    const s = inferSchema([JSON.stringify({ items: [] })]);
    const items = (s as any).properties.items;
    expect(items.kind).toBe('array');
    expect(items.items).toBeUndefined();
  });

  it('skips unparseable and empty bodies, returning null when nothing parses', () => {
    expect(inferSchema(['not json', '{"a":1}', null, ''])).toBeDefined();
    expect(inferSchema(['<html>'])) .toBeNull();
    expect(inferSchema([])).toBeNull();
  });

  it('handles nested objects recursively', () => {
    const s = inferSchema([JSON.stringify({ user: { name: 'a', tags: ['t1', 't2'] } })]);
    const user = (s as any).properties.user;
    expect(user.kind).toBe('object');
    expect(user.properties.name.kind).toBe('string');
    expect(user.properties.tags.items.kind).toBe('string');
  });
});
