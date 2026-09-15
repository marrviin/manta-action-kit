/**
 * Deterministic, LLM-free JSON schema inference. Given one or more concrete JSON
 * samples of the same logical body (e.g. every recorded response for one
 * endpoint), produce a single SchemaNode describing its shape — types, which
 * fields are optional (missing in some samples) or nullable, array element shape,
 * and one redacted example per scalar.
 *
 * Pure over its inputs (no I/O). Used by aggregate.ts to distil an endpoint's
 * request/response contract from raw recorded bodies. Values themselves are never
 * retained beyond a single redacted example (see redact.ts) so the schema is safe
 * to surface to the user or an agent.
 */
import type { SchemaKind, SchemaNode } from './types';
import { redactExample } from './redact';

/** The JSON kind of a parsed value. */
function kindOf(v: unknown): SchemaKind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'object';
}

/** Safe JSON.parse returning undefined instead of throwing. */
function tryParse(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Infer a schema for a single value, under the property name `key` (used only for
 * example redaction — a value under "token" gets masked). Recurses into objects
 * and arrays. `null` becomes kind 'null' with nullable set; callers merge it.
 */
function inferOne(value: unknown, key: string): SchemaNode {
  const kind = kindOf(value);

  if (kind === 'object') {
    const properties: Record<string, SchemaNode> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      properties[k] = inferOne(v, k);
    }
    return { kind, properties };
  }

  if (kind === 'array') {
    const arr = value as unknown[];
    const items = arr.length ? mergeMany(arr.map((el) => inferOne(el, key))) : undefined;
    return { kind, items };
  }

  if (kind === 'null') {
    return { kind, nullable: true };
  }

  // Primitive: attach a single redacted example.
  return { kind, example: redactExample(key, String(value)) };
}

/**
 * Merge two schemas describing the same logical slot across samples. The first
 * non-null kind wins for `kind`; `nullable` accumulates; object properties union
 * (a property missing on either side becomes optional); array element schemas
 * merge recursively; the first available example is kept.
 */
function mergeTwo(a: SchemaNode, b: SchemaNode): SchemaNode {
  // Null on one side just flags nullability on the other's concrete kind.
  if (a.kind === 'null' && b.kind !== 'null') return { ...b, nullable: true };
  if (b.kind === 'null' && a.kind !== 'null') return { ...a, nullable: true };

  const nullable = a.nullable || b.nullable || undefined;
  // Divergent kinds (e.g. string vs number): keep the first, still record nullable.
  if (a.kind !== b.kind) return { ...a, nullable };

  const merged: SchemaNode = { kind: a.kind, nullable };

  if (a.kind === 'object') {
    const props: Record<string, SchemaNode> = {};
    const ap = a.properties ?? {};
    const bp = b.properties ?? {};
    const keys = new Set([...Object.keys(ap), ...Object.keys(bp)]);
    for (const k of keys) {
      const av = ap[k];
      const bv = bp[k];
      if (av && bv) {
        props[k] = mergeTwo(av, bv);
      } else {
        // Present in only one sample → optional.
        props[k] = { ...(av ?? bv)!, optional: true };
      }
    }
    merged.properties = props;
  } else if (a.kind === 'array') {
    if (a.items && b.items) merged.items = mergeTwo(a.items, b.items);
    else merged.items = a.items ?? b.items;
  } else {
    merged.example = a.example ?? b.example;
  }

  return merged;
}

/** Reduce a list of schemas into one (empty → a permissive object schema). */
function mergeMany(nodes: SchemaNode[]): SchemaNode {
  if (nodes.length === 0) return { kind: 'object', properties: {} };
  return nodes.reduce((acc, n) => mergeTwo(acc, n));
}

/**
 * Infer a unified schema from a set of raw JSON body texts (the recorded bodies
 * of one endpoint). Unparseable / empty bodies are skipped. Returns null when no
 * sample parses (e.g. all bodies were non-JSON), so callers can omit the schema.
 *
 * @param bodies Raw body texts (request or response) for one endpoint.
 */
export function inferSchema(bodies: (string | null)[]): SchemaNode | null {
  const samples: SchemaNode[] = [];
  for (const body of bodies) {
    const parsed = tryParse(body);
    if (parsed === undefined) continue;
    samples.push(inferOne(parsed, ''));
  }
  if (samples.length === 0) return null;
  return mergeMany(samples);
}
