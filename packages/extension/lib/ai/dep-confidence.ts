/**
 * Pure logic for scoring the recording's inferred field dependencies with the
 * laya model: is each candidate edge a real data dependency, or a coincidental
 * value match (a timestamp, a random nonce, a generic constant)? infer-deps.ts
 * builds candidates deterministically; this module renders each edge as a state
 * for batch classification and folds the answers back into per-edge verdicts.
 *
 * The model only ever sees `origin === 'inferred'` edges — confirmed/manual
 * edges are ground truth by definition and are never re-judged. Background
 * orchestration lives in relevance-run.ts (same laya session as the relevance
 * pass); this module is unit-testable in isolation (dep-confidence.test.ts).
 */
import type { ApiCall, DepCheck, FieldDependency } from '@/lib/recording/types';
import { depConfidenceQuestions } from './presets';

/** Char cap on the literal value shown to the model (a shape annotation follows). */
export const MAX_VALUE_CHARS = 40;
/** Char cap on the JSON fragment extracted around a field path. */
export const MAX_CONTEXT_CHARS = 300;

/** The subset of the laya answer shape this module reads (answers cross the message relay untyped). */
export interface DepAnswers {
  is_real_dependency?: { noul?: number; answer_confidence?: number };
}

/** p(real dependency) at/above which an edge is 'likely'. */
export const LIKELY_AT = 0.7;
/** p(real dependency) at/below which an edge is 'unlikely' (coincidental). */
export const UNLIKELY_AT = 0.3;

/** Truncate `text` to `max` chars with an ellipsis marker. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// --- value shape -----------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]+$/i;
const DIGITS_RE = /^\d+$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const EPOCH_MS_RE = /^\d{13}$/;
const JWT_RE = /^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE64ISH_RE = /^[A-Za-z0-9+/=_-]{20,}$/;

/**
 * A compact shape label, so the model can read the value's format at a glance
 * instead of spending its token budget identifying it.
 */
export function valueShape(value: string): string {
  if (ISO_TS_RE.test(value)) return 'timestamp';
  if (EPOCH_MS_RE.test(value)) return 'epoch-ms';
  if (UUID_RE.test(value)) return 'uuid';
  if (JWT_RE.test(value)) return 'jwt-like';
  if (EMAIL_RE.test(value)) return 'email';
  if (DIGITS_RE.test(value)) return 'numeric';
  if (HEX_RE.test(value) && value.length >= 8) return 'hex';
  if (BASE64ISH_RE.test(value)) return 'base64-like';
  return 'text';
}

// --- JSON path walking -----------------------------------------------------------

/** Split a dotted/bracketed path ("data.items[0].id") into key tokens. */
function pathTokens(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const seg of path.split('.')) {
    const m = seg.match(/^([^\[\]]*)((?:\[\d+\])*)$/);
    if (!m) continue;
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

/** Resolve a JSON path into a subtree, or undefined when it does not resolve. */
function walkPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let node: unknown = root;
  for (const tok of pathTokens(path)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[tok as string];
  }
  return node;
}

/**
 * Extract the JSON fragment around `path` in `text` — the subtree at the path,
 * stringified and clipped. Falls back to clipping the whole text when the body
 * is not JSON or the path does not resolve (e.g. a raw-url match). Requests and
 * responses can be kilobytes while the model's window is 512 tokens, so a whole
 * body never fits — the local fragment is what carries the signal.
 */
export function clipAround(
  text: string | null,
  path: string,
  max: number = MAX_CONTEXT_CHARS,
): string {
  if (!text) return '(none)';
  let sub: unknown;
  try {
    sub = walkPath(JSON.parse(text), path);
  } catch {
    sub = undefined;
  }
  if (sub === undefined) return clip(text, max);
  return clip(JSON.stringify(sub) ?? String(sub), max);
}

// --- state building --------------------------------------------------------------

/** Render the value with its shape annotation — the model reads format, not the full literal. */
function valueText(value: string): string {
  return `${clip(value, MAX_VALUE_CHARS)} (${value.length} chars, ${valueShape(value)})`;
}

/**
 * The path of `path`'s parent object, so a fragment shows the field name in its
 * surroundings rather than the bare value ('data.items[0].id' → 'data.items[0]';
 * a root-level path has no parent, which clipAround handles via its fallback).
 */
export function parentPath(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? '' : path.slice(0, i);
}

/** The consuming-request fragment for a dependency's target location. */
function requestFragment(call: ApiCall, dep: FieldDependency): string {
  switch (dep.toLocation) {
    case 'body':
      return `request-body: ${clipAround(call.reqBody, parentPath(dep.toPath))}`;
    case 'query': {
      let v: string | null = null;
      try {
        v = new URL(call.url).searchParams.get(dep.toPath);
      } catch {
        v = null;
      }
      return `request-query: ${dep.toPath}=${clip(v ?? dep.value, MAX_VALUE_CHARS)}`;
    }
    case 'header':
      return `request-header: ${dep.toPath}: ${clip(call.reqHeaders[dep.toPath] ?? dep.value, MAX_VALUE_CHARS)}`;
    case 'url':
      return `request-url: ${clip(call.url, MAX_CONTEXT_CHARS)}`;
  }
}

/**
 * Build the batch predict inputs: one state per INFERRRED edge whose two
 * endpoint calls both still exist. `edges[i]` is the dependency `states[i]`
 * describes — mergeDepChecks consumes the same array, so the alignment is
 * guaranteed by construction. Confirmed/manual edges are excluded here.
 */
export function buildDepStates(
  calls: ApiCall[],
  deps: FieldDependency[],
): {
  states: Array<Record<string, string>>;
  edges: FieldDependency[];
  questions: Record<string, unknown>;
} {
  const bySeq = new Map(calls.map((c) => [c.seq, c]));
  const states: Array<Record<string, string>> = [];
  const edges: FieldDependency[] = [];
  for (const dep of deps) {
    if (dep.origin !== 'inferred') continue;
    const from = bySeq.get(dep.fromSeq);
    const to = bySeq.get(dep.toSeq);
    if (!from || !to) continue;
    states.push({
      link: `response #${dep.fromSeq} ${dep.fromPath || '(body)'} → request #${dep.toSeq} ${dep.toLocation}${dep.toPath ? `.${dep.toPath}` : ''}`,
      value: valueText(dep.value),
      from: `#${from.seq} ${from.method} ${from.url}\nresponse-body: ${clipAround(from.resBody, dep.fromPath)}`,
      to: `#${to.seq} ${to.method} ${to.url}\n${requestFragment(to, dep)}`,
    });
    edges.push(dep);
  }
  return { states, edges, questions: depConfidenceQuestions() };
}

// --- verdicts --------------------------------------------------------------------

function confidenceOf(ans: DepAnswers['is_real_dependency']): number {
  const c = ans?.answer_confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : 0.5;
}

/**
 * Fold one state's answers into a verdict. The noul head is p(real dependency);
 * the band between the two bars stays 'uncertain' — an uncertain edge stays
 * visible and neutral in the UI rather than being dropped either way.
 */
export function depVerdictFromAnswers(
  answers: DepAnswers,
): { verdict: DepCheck['verdict']; confidence: number } {
  const p = answers.is_real_dependency?.noul;
  const confidence = confidenceOf(answers.is_real_dependency);
  if (typeof p !== 'number' || !Number.isFinite(p)) {
    return { verdict: 'uncertain', confidence };
  }
  if (p >= LIKELY_AT) return { verdict: 'likely', confidence };
  if (p <= UNLIKELY_AT) return { verdict: 'unlikely', confidence };
  return { verdict: 'uncertain', confidence };
}

/**
 * Fold batch predict results onto the edges returned by buildDepStates (same
 * order). A null result degrades to 'uncertain' — absence of evidence is never
 * promoted to either verdict.
 */
export function mergeDepChecks(
  edges: FieldDependency[],
  results: Array<DepAnswers | null>,
): Array<{ depId: string; depCheck: DepCheck }> {
  const analyzedAt = Date.now();
  return edges.map((dep, i) => {
    const v = results[i]
      ? depVerdictFromAnswers(results[i]!)
      : { verdict: 'uncertain' as const, confidence: 0.5 };
    return { depId: dep.id, depCheck: { ...v, analyzedAt } };
  });
}
