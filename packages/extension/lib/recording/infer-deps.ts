/**
 * Deterministic, LLM-free inference of field-level data dependencies between the
 * calls in a recording (its "flow"). The core idea: a value that first appears in
 * one call's RESPONSE and later reappears in a subsequent call's REQUEST is very
 * likely a data dependency (id, token, cursor, ...). We index produced values by
 * their JSON path, then scan each later request for reuse.
 *
 * This is intentionally a pure function over ApiCall[] — no I/O, no globals — so
 * it can run on save, be re-run on demand, and be unit-tested trivially.
 */
import type { ApiCall, FieldDependency, DependencyLocation } from './types';
import { uuid } from '@/lib/utils';

/** A leaf value discovered in a JSON tree, with its dotted/bracketed path. */
interface Leaf {
  path: string;
  value: string;
}

/**
 * Values shorter than this are too ambiguous to treat as a dependency (e.g. "1",
 * "true", small enums collide across unrelated calls and create noise).
 */
const MIN_VALUE_LEN = 6;

/** Only string/number leaves make sense as linkable identifiers. */
function isLinkable(v: unknown): v is string | number {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string';
}

/** Safe JSON.parse that returns undefined instead of throwing. */
function tryParse(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Flatten a JSON value into leaf (path,value) pairs. Arrays use bracket indices,
 * objects use dotted keys — matching the FieldDependency path convention.
 */
function flatten(node: unknown, prefix: string, out: Leaf[]): void {
  if (isLinkable(node)) {
    out.push({ path: prefix, value: String(node) });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

/** All linkable leaves in a call's response body (empty for non-JSON responses). */
function responseLeaves(call: ApiCall): Leaf[] {
  if (!call.resIsJson) return [];
  const parsed = tryParse(call.resBody);
  if (parsed === undefined) return [];
  const out: Leaf[] = [];
  flatten(parsed, '', out);
  return out.filter((l) => l.value.length >= MIN_VALUE_LEN);
}

/**
 * Find where `value` is consumed inside a request. Checks, in priority order:
 * body JSON path, query param, header, then raw url. Returns the first hit, or
 * null if the value does not appear in the request at all.
 */
function findInRequest(
  call: ApiCall,
  value: string,
): { location: DependencyLocation; path: string } | null {
  // Body (prefer structured JSON path over a raw substring match).
  const body = tryParse(call.reqBody);
  if (body !== undefined) {
    const leaves: Leaf[] = [];
    flatten(body, '', leaves);
    const hit = leaves.find((l) => l.value === value);
    if (hit) return { location: 'body', path: hit.path };
  }

  // URL: split query params from the path so we can name the query key.
  let url: URL | null = null;
  try {
    url = new URL(call.url);
  } catch {
    url = null;
  }
  if (url) {
    for (const [key, val] of url.searchParams.entries()) {
      if (val === value) return { location: 'query', path: key };
    }
  }

  // Headers (e.g. an auth token echoed from a login response).
  for (const [name, val] of Object.entries(call.reqHeaders)) {
    if (val === value || (val.length >= MIN_VALUE_LEN && val.includes(value))) {
      return { location: 'header', path: name };
    }
  }

  // Fallback: raw substring anywhere in the url (path segment ids, etc.).
  if (call.url.includes(value)) return { location: 'url', path: '' };

  return null;
}

/**
 * Infer field dependencies across a recording's calls.
 *
 * For each call (ordered by seq), we look at every value produced by an EARLIER
 * call's response and check whether it reappears in this call's request. The
 * earliest producer wins (closest-to-source attribution), and each
 * (toSeq, toLocation, toPath) is linked at most once to avoid duplicate edges.
 *
 * @param calls The recording's calls. Assumed to be in capture order; sorted by
 *   seq defensively so callers need not pre-sort.
 * @returns Inferred dependencies (origin 'inferred'), for the user to confirm.
 */
export function inferDependencies(calls: ApiCall[]): FieldDependency[] {
  const ordered = [...calls].sort((a, b) => a.seq - b.seq);
  const deps: FieldDependency[] = [];

  // Cumulative index of produced values: value -> earliest {seq, path}.
  const produced = new Map<string, { seq: number; path: string }>();

  for (const call of ordered) {
    // Consume first: match this request against everything produced so far.
    const consumedTargets = new Set<string>();
    for (const [value, src] of produced.entries()) {
      const hit = findInRequest(call, value);
      if (!hit) continue;
      const targetKey = `${hit.location}:${hit.path}`;
      if (consumedTargets.has(targetKey)) continue;
      consumedTargets.add(targetKey);
      deps.push({
        id: uuid(),
        fromSeq: src.seq,
        fromPath: src.path,
        toSeq: call.seq,
        toLocation: hit.location,
        toPath: hit.path,
        value,
        origin: 'inferred',
      });
    }

    // Then register this call's produced values for later calls (keep earliest).
    for (const leaf of responseLeaves(call)) {
      if (!produced.has(leaf.value)) {
        produced.set(leaf.value, { seq: call.seq, path: leaf.path });
      }
    }
  }

  return deps;
}
