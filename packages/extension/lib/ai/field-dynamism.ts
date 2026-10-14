/**
 * Field-dynamism analysis for a recording: for each request field, decide
 * whether its value would change if the same request were replayed tomorrow in
 * a fresh session ('varies' — a param candidate) or hold identical ('stable' —
 * safe to hardcode).
 *
 * The signal is purely statistical: the same endpoint called N times with
 * all-distinct values is 'varies', all-identical is 'stable'. Fields observed
 * exactly once stay unmarked — there is not enough evidence, and downstream
 * reads an absent mark as "let the agent decide".
 *
 * Marks are keyed `${method} ${normalizedPath}` → leaf path ("body.<json path>"
 * / "query.<key>") and stored on the Recording (EndpointSummary/schema are
 * recomputed from calls on every read, so they cannot store them). This module
 * is unit-testable in isolation (field-dynamism.test.ts).
 */
import type {
  ApiCall,
  EndpointSummary,
  FieldDynamism,
  Recording,
  SchemaNode,
} from '@/lib/recording/types';
import { endpointKeyOf } from '@/lib/recording/aggregate';
import { isSensitiveKey, isSensitiveValue } from '@/lib/recording/redact';

/** Observed samples kept per leaf — enough for stats, small for storage. */
export const MAX_SAMPLES_PER_LEAF = 4;

// --- candidate collection --------------------------------------------------------

/** One request leaf observed in the recording, with its values across the endpoint's calls. */
export interface LeafCandidate {
  /** `${METHOD} ${normalizedPath}` — matches EndpointSummary.key / fieldDynamism keys. */
  endpointKey: string;
  /** "body.<json path>" or "query.<key>" — the mark's key inside the endpoint. */
  leafPath: string;
  /** Raw observed values, in capture order (capped). */
  samples: string[];
  /** The call that supplied samples[0] — the context fragment source. */
  sampleCall: ApiCall;
}

/** JSON path of a leaf relative to the request BODY ("items[0].id"), with its value. */
interface BodyLeaf {
  path: string;
  value: string;
}

function flattenLeaves(node: unknown, prefix: string, out: BodyLeaf[]): void {
  if (typeof node === 'number' && Number.isFinite(node)) {
    out.push({ path: prefix, value: String(node) });
    return;
  }
  if (typeof node === 'string') {
    out.push({ path: prefix, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => flattenLeaves(item, `${prefix}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      flattenLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

/**
 * Whether a body leaf sits under a secret-looking path ("data.password.x") —
 * tokens/credentials are excluded from dynamism analysis: their visibility is
 * redact.ts's business, and a mark would imply they are safe to template.
 */
function underSensitivePath(path: string): boolean {
  return path.split(/[.[\]]/).some((seg) => seg && isSensitiveKey(seg));
}

function addSample(
  groups: Map<string, LeafCandidate>,
  call: ApiCall,
  leafPath: string,
  value: string,
): void {
  if (!value || isSensitiveValue(value)) return;
  const gKey = `${endpointKeyOf(call)}\u0000${leafPath}`;
  const existing = groups.get(gKey);
  if (existing) {
    // Cap stored samples — stats only need "how many, how distinct".
    if (existing.samples.length < MAX_SAMPLES_PER_LEAF) existing.samples.push(value);
    return;
  }
  groups.set(gKey, {
    endpointKey: endpointKeyOf(call),
    leafPath,
    samples: [value],
    sampleCall: call,
  });
}

/**
 * Collect every request leaf candidate across the recording's calls: JSON body
 * leaves (excluding sensitive paths/values) and query parameters. Request
 * headers are excluded by design (auth is injected by the gateway, never a
 * param) and URL path segments are out of scope.
 */
export function collectCandidates(calls: ApiCall[]): LeafCandidate[] {
  const ordered = [...calls].sort((a, b) => a.seq - b.seq);
  const groups = new Map<string, LeafCandidate>();

  for (const call of ordered) {
    if (call.reqBody) {
      try {
        const leaves: BodyLeaf[] = [];
        flattenLeaves(JSON.parse(call.reqBody), '', leaves);
        for (const leaf of leaves) {
          if (!leaf.path) continue; // scalar root body — nothing to template
          if (underSensitivePath(leaf.path)) continue;
          addSample(groups, call, `body.${leaf.path}`, leaf.value);
        }
      } catch {
        // Non-JSON body (form text etc.) — out of scope.
      }
    }
    try {
      for (const [k, v] of new URL(call.url).searchParams) {
        addSample(groups, call, `query.${k}`, v);
      }
    } catch {
      // Unparseable URL — no query leaves.
    }
  }

  return [...groups.values()];
}

// --- deterministic classification --------------------------------------------------

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const EPOCH_MS_RE = /^\d{13}$/;

/** Whether the value reads as a time value (timestamps stay volatile even when identical). */
function timestampLike(value: string): boolean {
  return ISO_TS_RE.test(value) || EPOCH_MS_RE.test(value);
}

function mark(
  verdict: FieldDynamism['verdict'],
  confidence: number,
  analyzedAt: number,
): FieldDynamism {
  return { verdict, source: 'stats', confidence, analyzedAt };
}

/**
 * Classify a candidate by statistics alone; null when there is only one
 * observation (not enough evidence to claim either way).
 */
export function classifyByStats(
  cand: LeafCandidate,
  analyzedAt: number,
): FieldDynamism | null {
  if (cand.samples.length < 2) return null;
  const distinct = new Set(cand.samples).size;
  if (distinct === cand.samples.length) return mark('varies', 0.9, analyzedAt);
  if (distinct === 1) {
    // Identical values across calls: stable — unless the value is a timestamp,
    // where two close-together calls can legitimately collide.
    return cand.samples.every(timestampLike)
      ? mark('varies', 0.8, analyzedAt)
      : mark('stable', 0.9, analyzedAt);
  }
  // Partially distinct (e.g. a capped sample window) — volatile.
  return mark('varies', 0.7, analyzedAt);
}

// --- full-computation entry point ----------------------------------------------------

/**
 * Run the whole pass: collect candidates and classify them by statistics.
 * Pure over `calls`; single-observation leaves stay unmarked.
 */
export function computeDynamism(
  calls: ApiCall[],
): Record<string, Record<string, FieldDynamism>> {
  const analyzedAt = Date.now();
  const marks: Record<string, Record<string, FieldDynamism>> = {};
  for (const cand of collectCandidates(calls)) {
    const m = classifyByStats(cand, analyzedAt);
    if (!m) continue;
    (marks[cand.endpointKey] ??= {})[cand.leafPath] = m;
  }
  return marks;
}

// --- attach (MCP / schema view) ------------------------------------------------------

/** Split a body-relative JSON path ("items[0].id") into schema-walk tokens. */
function bodyPathTokens(jsonPath: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const seg of jsonPath.split('.')) {
    const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) continue;
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

/**
 * A copy of `node` with `dynamism` set on the descendant at `tokens` — a
 * structural clone along the walked path only, so siblings (and the original
 * tree, which callers may share) stay untouched. Null when the path does not
 * resolve against this schema.
 */
function withDynamism(
  node: SchemaNode,
  tokens: (string | number)[],
  dyn: FieldDynamism,
): SchemaNode | null {
  if (tokens.length === 0) return { ...node, dynamism: dyn };
  const [tok, ...rest] = tokens;
  if (typeof tok === 'number') {
    if (!node.items) return null;
    const items = withDynamism(node.items, rest, dyn);
    return items ? { ...node, items } : null;
  }
  const child = node.properties?.[tok];
  if (!child) return null;
  const newChild = withDynamism(child, rest, dyn);
  return newChild ? { ...node, properties: { ...node.properties, [tok]: newChild } } : null;
}

/**
 * Attach the recording's stored dynamism marks onto endpoint contracts: body
 * leaves onto their SchemaNode (`dynamism`), query params onto
 * `queryDynamism`. Purely functional — schema trees are cloned along the
 * walked path, never mutated, because callers may share derived structures.
 * Endpoints without marks are returned untouched.
 */
export function attachDynamism(
  endpoints: EndpointSummary[],
  fieldDynamism: Recording['fieldDynamism'] | undefined,
): EndpointSummary[] {
  if (!fieldDynamism) return endpoints;
  return endpoints.map((ep) => {
    const marks = fieldDynamism[ep.key];
    if (!marks) return ep;

    let requestSchema = ep.requestSchema;
    const queryDynamism: Record<string, FieldDynamism> = {};
    for (const [leafPath, dyn] of Object.entries(marks)) {
      if (leafPath.startsWith('query.')) {
        queryDynamism[leafPath.slice(6)] = dyn;
        continue;
      }
      if (leafPath.startsWith('body.') && requestSchema) {
        const next = withDynamism(requestSchema, bodyPathTokens(leafPath.slice(5)), dyn);
        if (next) requestSchema = next;
      }
    }

    return {
      ...ep,
      requestSchema,
      ...(Object.keys(queryDynamism).length > 0 ? { queryDynamism } : {}),
    };
  });
}
