/**
 * Pure logic for the field-dynamism pass with the laya model: for each request
 * field of a recording, decide whether its value would change if the same
 * request were replayed tomorrow in a fresh session ('varies' — a param
 * candidate) or hold identical ('stable' — safe to hardcode).
 *
 * The strongest signal is deterministic: the same endpoint called N times with
 * all-distinct values is 'varies', all-identical is 'stable'. The model only
 * covers the statistics' blind spot — fields observed exactly once — where
 * semantics (name, value shape) are the only evidence. A failing model thus
 * degrades to "single-observation leaves unmarked" without losing the stats
 * half.
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
import { clipAround, parentPath, valueShape } from './dep-confidence';
import { dynamismQuestions } from './presets';

/** Char cap on the value shown to the model (a shape annotation follows). */
export const MAX_VALUE_CHARS = 40;
/** Char cap on the JSON context fragment around a leaf. */
export const MAX_CONTEXT_CHARS = 200;
/** Observed samples kept per leaf — enough for stats, small for storage. */
export const MAX_SAMPLES_PER_LEAF = 4;

/** The subset of the laya answer shape this module reads (answers cross the message relay untyped). */
export interface DynamismAnswers {
  stable_across_runs?: { noul?: number; answer_confidence?: number };
}

/** p(stable) at/above which a leaf is 'stable'. */
export const STABLE_AT = 0.7;
/** p(stable) at/below which a leaf is 'varies'. */
export const VARIES_AT = 0.3;

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
  return path.split(/[.\[\]]/).some((seg) => seg && isSensitiveKey(seg));
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
 * param) and URL path segments are out of scope for v1.
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
        // Non-JSON body (form text etc.) — out of scope for v1.
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

function mark(
  verdict: FieldDynamism['verdict'],
  source: FieldDynamism['source'],
  confidence: number,
  analyzedAt: number,
): FieldDynamism {
  return { verdict, source, confidence, analyzedAt };
}

/** Whether every sample reads as a time value (timestamps stay volatile even when identical). */
function allTimestampLike(samples: string[]): boolean {
  const s = valueShape(samples[0]);
  return (s === 'timestamp' || s === 'epoch-ms') && samples.every((v) => valueShape(v) === s);
}

/**
 * Classify a candidate by statistics alone; null when there is only one
 * observation (that case is the model's job).
 */
export function classifyByStats(
  cand: LeafCandidate,
  analyzedAt: number,
): FieldDynamism | null {
  if (cand.samples.length < 2) return null;
  const distinct = new Set(cand.samples).size;
  if (distinct === cand.samples.length) return mark('varies', 'stats', 0.9, analyzedAt);
  if (distinct === 1) {
    // Identical values across calls: stable — unless the value is a timestamp,
    // where two close-together calls can legitimately collide.
    return allTimestampLike(cand.samples)
      ? mark('varies', 'stats', 0.8, analyzedAt)
      : mark('stable', 'stats', 0.9, analyzedAt);
  }
  // Partially distinct (e.g. a capped sample window) — volatile.
  return mark('varies', 'stats', 0.7, analyzedAt);
}

// --- state building ----------------------------------------------------------------

/** The value plus its shape, as the model reads it. */
function sampleText(value: string): string {
  const v = value.length <= MAX_VALUE_CHARS ? value : `${value.slice(0, MAX_VALUE_CHARS)}…`;
  return `'${v}' (${value.length} chars, ${valueShape(value)})`;
}

/**
 * Build the batch predict inputs for the model queue: one state per candidate
 * the statistics could not classify (a single observation). `leaves[i]` is the
 * candidate `states[i]` describes. Questions come from dynamismQuestions().
 */
export function buildDynamismBatch(cands: LeafCandidate[]): {
  states: Array<Record<string, string>>;
  leaves: LeafCandidate[];
  questions: Record<string, unknown>;
} {
  const queue = cands.filter((c) => c.samples.length < 2);
  const states = queue.map((c) => {
    const isQuery = c.leafPath.startsWith('query.');
    const name = isQuery ? c.leafPath.slice(6) : c.leafPath.slice(5);
    const context = isQuery
      ? `query-param: ${name}=${c.samples[0]}`
      : clipAround(c.sampleCall.reqBody, parentPath(name), MAX_CONTEXT_CHARS);
    return {
      field: c.leafPath,
      endpoint: c.endpointKey,
      samples: sampleText(c.samples[0]),
      context,
    };
  });
  return { states, leaves: queue, questions: dynamismQuestions() };
}

// --- verdicts ----------------------------------------------------------------------

function confidenceOf(ans: DynamismAnswers['stable_across_runs']): number {
  const c = ans?.answer_confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : 0.5;
}

/**
 * Fold one state's answers into a verdict. The noul head is p(stable); the band
 * between the bars stays 'uncertain' — a unsure leaf is simply absent of a
 * strong claim, which downstream reads as "let the agent decide".
 */
export function dynamismVerdictFromAnswers(
  answers: DynamismAnswers,
): { verdict: FieldDynamism['verdict']; confidence: number } {
  const p = answers.stable_across_runs?.noul;
  const confidence = confidenceOf(answers.stable_across_runs);
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    return { verdict: 'uncertain', confidence };
  }
  if (p >= STABLE_AT) return { verdict: 'stable', confidence };
  if (p <= VARIES_AT) return { verdict: 'varies', confidence };
  return { verdict: 'uncertain', confidence };
}

// --- full-computation entry points ---------------------------------------------------

export interface DynamismComputation {
  /** Stats marks, keyed endpointKey → leafPath → mark. Persistable without the model. */
  statsMarks: Record<string, Record<string, FieldDynamism>>;
  /** Candidates reserved for the model (single observation), in batch order. */
  queue: LeafCandidate[];
}

/**
 * Run the whole deterministic half: collect candidates, classify what the
 * statistics can, and queue the rest for the model. Pure over `calls`.
 */
export function computeDynamism(calls: ApiCall[]): DynamismComputation {
  const analyzedAt = Date.now();
  const cands = collectCandidates(calls);
  const statsMarks: Record<string, Record<string, FieldDynamism>> = {};
  for (const cand of cands) {
    const m = classifyByStats(cand, analyzedAt);
    if (!m) continue;
    (statsMarks[cand.endpointKey] ??= {})[cand.leafPath] = m;
  }
  return { statsMarks, queue: cands.filter((c) => c.samples.length < 2) };
}

/**
 * Fold batch predict results onto the queue returned by buildDynamismBatch
 * (same order), keyed like statsMarks. A null result degrades to 'uncertain'.
 */
export function mergeDynamismResults(
  leaves: LeafCandidate[],
  results: Array<DynamismAnswers | null>,
): Record<string, Record<string, FieldDynamism>> {
  const analyzedAt = Date.now();
  const marks: Record<string, Record<string, FieldDynamism>> = {};
  leaves.forEach((cand, i) => {
    const v = results[i]
      ? dynamismVerdictFromAnswers(results[i]!)
      : { verdict: 'uncertain' as const, confidence: 0.5 };
    (marks[cand.endpointKey] ??= {})[cand.leafPath] = { ...v, source: 'model', analyzedAt };
  });
  return marks;
}

// --- attach (MCP / schema view) ------------------------------------------------------

/** Split a body-relative JSON path ("items[0].id") into schema-walk tokens. */
function bodyPathTokens(jsonPath: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const seg of jsonPath.split('.')) {
    const m = seg.match(/^([^\[\]]*)((?:\[\d+\])*)$/);
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
