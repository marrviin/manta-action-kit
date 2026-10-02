/**
 * Pure logic for the recording-relevance analysis: turn a recording's calls
 * into laya batch inputs, map the model's answers back onto per-call verdicts,
 * and merge them with the data-flow anchors. No extension APIs here — the
 * background orchestration lives in relevance-run.ts, and this module is
 * unit-testable in isolation (relevance.test.ts).
 */
import type { ApiCall, CallRelevance, FieldDependency } from '@/lib/recording/types';
import { relevanceQuestions } from './presets';

/** Cap on the chain summary lines fed as context (each state embeds the chain). */
export const MAX_CHAIN_LINES = 50;
/** Hard character cap on the chain summary (state-token budget). */
export const MAX_CHAIN_CHARS = 4000;
/** Per-body character cap inside the per-call `request` text. */
export const MAX_BODY_CHARS = 600;
/** How many SSE event names to include for a streaming call. */
const MAX_SSE_EVENTS = 4;

/** Truncate `text` to `max` chars with an ellipsis marker. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** `"{pathname}{?query}"` with the query truncated; falls back to a raw clip. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${clip(u.search, 120)}`;
  } catch {
    return clip(url, 200);
  }
}

/**
 * The whole chain as compact lines — the context the model judges each call
 * against. Lines keep the HOST (calls to a dedicated reporting host are the
 * strongest general noise signal) and are DEDUPED into one line per distinct
 * method+host+path with an `(xN)` repeat count — telemetry repeats while
 * business writes rarely do, and deduping keeps the shared `chain` field from
 * eating the 512-token window that the per-call `request` text needs.
 * Capped by line count and total chars; a truncation marker replaces the
 * dropped tail.
 */
export function chainSummary(calls: ApiCall[]): string {
  const seen = new Map<string, { line: string; n: number }>();
  for (const c of calls) {
    const host = hostOf(c.url);
    const key = `${c.method} ${host}${pathOf(c.url)}`;
    const entry = seen.get(key);
    if (entry) entry.n += 1;
    else seen.set(key, { line: `${c.method} ${host}${pathOf(c.url)}`, n: 1 });
  }
  const all = [...seen.values()].map(
    ({ line, n }) => line + (n > 1 ? ` (x${n})` : ''),
  );
  const lines = [...all];
  if (lines.length > MAX_CHAIN_LINES) {
    lines.length = MAX_CHAIN_LINES;
    lines.push(`…(+${all.length - MAX_CHAIN_LINES} more endpoints)`);
  }
  let out = lines.join('\n');
  if (out.length > MAX_CHAIN_CHARS) out = `${out.slice(0, MAX_CHAIN_CHARS)}…`;
  return out;
}

/** Hostname of `url`; falls back to a clipped raw string when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 80);
  }
}

/** One call rendered as the `request` text the model classifies. */
export function callSummary(call: ApiCall): string {
  const parts = [`#${call.seq} ${call.method} ${call.url}`];
  if (call.reqBody) parts.push(`request-body: ${clip(call.reqBody, MAX_BODY_CHARS)}`);
  if (call.streaming) {
    const names = (call.sseEvents ?? [])
      .slice(0, MAX_SSE_EVENTS)
      .map((e) => e.event || 'message')
      .join(', ');
    parts.push(`response: SSE stream${names ? ` [${names}]` : ''}`);
  } else {
    // Reporting endpoints typically answer with a tiny/empty body while data
    // calls return real payloads — the size is a general noise signal, so it
    // is stated explicitly even when the body itself is opaque.
    const size = call.resBody ? `${call.resBody.length} chars` : 'empty';
    parts.push(`response: HTTP ${call.status}, ${size}`);
    if (call.resBody) parts.push(`response-body: ${clip(call.resBody, MAX_BODY_CHARS)}`);
  }
  if (call.errored) parts.push(`error: ${clip(call.errorText ?? 'network error', 120)}`);
  return parts.join('\n');
}

/**
 * Build the batch predict inputs: one state per call (chain context + the call
 * itself), with `callIds[i]` the call that `states[i]` describes. `request`
 * comes FIRST in the state dict: sequences are truncated from the TAIL, so the
 * per-call signal must sit before the shared `chain` context — the collapse of
 * per-call differences (identical answers for every call) is exactly what
 * request-last + truncation produces.
 */
export function buildRelevanceStates(calls: ApiCall[]): {
  states: Array<Record<string, string>>;
  callIds: string[];
  questions: Record<string, unknown>;
} {
  const chain = chainSummary(calls);
  return {
    states: calls.map((c) => ({ request: callSummary(c), chain })),
    callIds: calls.map((c) => c.id),
    questions: relevanceQuestions(),
  };
}

/** The subset of the laya answer shape this module reads (answers cross the message relay untyped). */
export interface RelevanceAnswers {
  is_noise?: { noul?: number; answer_confidence?: number };
  role?: { choice?: string };
}

/**
 * Verdict thresholds. The base bar for 'irrelevant' is adjusted by the role
 * head — the model's own second opinion, not a keyword list:
 *  - telemetry / polling_heartbeat → 0.5: when the role head already votes
 *    noise, a weak noise score is enough (reporting payloads are opaque and
 *    systematically score below data calls).
 *  - business_data / auth_session → 0.8: a call the role head believes carries
 *    the user's data needs strong evidence to be marked irrelevant (a false
 *    irrelevant breaks downstream action generation; a missed noise call
 *    merely adds noise).
 * Both bars only ever MOVE DOWN the uncertainty band; 'relevant' keeps the
 * same 0.3 bar everywhere.
 */
export const IRRELEVANT_AT = 0.7;
export const RELEVANT_AT = 0.3;
export const NOISE_ROLE_AT = 0.5;
export const PROTECTED_ROLE_AT = 0.8;

/** Roles that vote noise / protect the call, by criterion key. */
const NOISE_ROLES = new Set(['telemetry', 'polling_heartbeat']);
const PROTECTED_ROLES = new Set(['business_data', 'auth_session']);

export function verdictFromAnswers(answers: RelevanceAnswers): {
  relevance: Omit<CallRelevance, 'analyzedAt'>;
  role?: string;
} {
  const p = answers.is_noise?.noul;
  const conf = answers.is_noise?.answer_confidence;
  const role = typeof answers.role?.choice === 'string' ? answers.role.choice : undefined;
  const bar = NOISE_ROLES.has(role ?? '')
    ? NOISE_ROLE_AT
    : PROTECTED_ROLES.has(role ?? '')
      ? PROTECTED_ROLE_AT
      : IRRELEVANT_AT;
  let verdict: CallRelevance['verdict'] = 'uncertain';
  if (typeof p === 'number' && Number.isFinite(p)) {
    if (p >= bar) verdict = 'irrelevant';
    else if (p <= RELEVANT_AT) verdict = 'relevant';
  }
  return {
    relevance: {
      verdict,
      confidence: typeof conf === 'number' && Number.isFinite(conf) ? conf : 0.5,
      ...(role ? { role } : {}),
    },
    role,
  };
}

/**
 * Fold batch predict results onto calls: model verdict per call, then the
 * data-flow anchors — both endpoints of every inferred dependency are part of
 * the main flow by construction, so they are forced 'relevant' (the model
 * mis-killing a chained call is the costliest failure mode).
 */
export function mergeVerdicts(
  calls: ApiCall[],
  deps: FieldDependency[] | undefined,
  results: Array<RelevanceAnswers | null>,
): Array<{ callId: string; relevance: CallRelevance }> {
  const analyzedAt = Date.now();
  const anchored = new Set<number>();
  for (const d of deps ?? []) {
    anchored.add(d.fromSeq);
    anchored.add(d.toSeq);
  }
  return calls.map((call, i) => {
    const parsed = results[i] ? verdictFromAnswers(results[i]!) : null;
    const relevance: CallRelevance = anchored.has(call.seq)
      ? { verdict: 'relevant', confidence: 1, analyzedAt }
      : {
          verdict: parsed?.relevance.verdict ?? 'uncertain',
          confidence: parsed?.relevance.confidence ?? 0.5,
          ...(parsed?.role ? { role: parsed.role } : {}),
          analyzedAt,
        };
    return { callId: call.id, relevance };
  });
}
