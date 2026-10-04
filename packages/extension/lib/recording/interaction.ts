/**
 * User-interaction capture — the pure descriptor builder (see session-core.ts for
 * where accepted interactions are buffered, and injected-api-hook.ts for the DOM
 * listeners that call describeInteraction).
 *
 * Deliberately pure and dependency-free apart from redact.ts: it must be
 * importable from the MAIN-world injected hook (no extension APIs) and
 * unit-testable in a node vitest environment (no DOM) — hence the structural
 * ElementLike instead of the real Element type.
 *
 * Capture philosophy (agreed design): record READABLE INTENT (the element's own
 * text / aria-label, plus up to 3 ancestor semantic texts) and FORM-CONTROL
 * SEMANTICS (change events' name/value), plus a page route snapshot. No
 * coordinates, no id/cssPath/testid, no per-keystroke data. Every text is
 * truncated and redacted; password-type control values are never captured.
 */
import type { CapturedInteraction, InteractionKind, PrecedingInteraction } from './types';
import { isSensitiveValue, redactExample, REDACTION_MASK } from './redact';

/**
 * Structural subset of Element that describeInteraction actually reads. Real
 * Elements satisfy it (aria-label is read via getAttribute in the hook before
 * being passed in as `ariaLabel`); tests pass plain objects. Ancestors are
 * passed as a separate closest-first array (see describeInteraction) so the
 * hook never has to touch textContent beyond the few levels we keep.
 */
export interface ElementLike {
  tagName?: string;
  /** input/select type attribute (only meaningful for change events). */
  type?: string;
  /** The element's aria-label, when present. */
  ariaLabel?: string;
  textContent?: string | null;
  /** The control's current value (change events only). */
  value?: string;
  /** The control's name attribute (change events only). */
  name?: string;
  /** autoComplete attribute, when present (e.g. "cc-number"). */
  autocomplete?: string;
}

/** Max lengths per captured text piece. */
export const TEXT_MAX = 64;
export const CONTAINER_MAX = 32;
export const CONTAINER_MAX_COUNT = 3;

/** Trim, collapse internal whitespace runs, and cap length. */
export function truncate(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * A display-safe, capped version of captured text: truncate, then mask entirely
 * when what remains LOOKS like a credential/PII (JWT / email / long hex...).
 * Returns undefined for empty results so optional fields can be omitted.
 */
export function redactText(text: string, max: number): string | undefined {
  const trimmed = truncate(text, max);
  if (!trimmed) return undefined;
  return isSensitiveValue(trimmed) ? REDACTION_MASK : trimmed;
}

/** The element's own readable text: aria-label wins over visible text. */
export function extractText(el: ElementLike): string | undefined {
  const text = el.ariaLabel?.trim() || el.textContent?.trim() || '';
  return text || undefined;
}

/**
 * Up to `max` ancestor semantic texts from `ancestors` (closest first — the
 * hook supplies only the few levels we keep). For each ancestor we take its
 * aria-label or its subtree text WHEN that text is short (a heading / dialog
 * title / card label) — never the front slice of a giant container's text,
 * which would just be the first words of the whole page. Ancestors repeating
 * the element's own text or an already-collected container are skipped;
 * everything passes through redactText.
 */
export function extractContainers(
  el: ElementLike,
  ancestors: readonly ElementLike[],
  max = CONTAINER_MAX_COUNT,
): string[] {
  const own = extractText(el);
  const out: string[] = [];
  for (const cur of ancestors) {
    if (out.length >= max) break;
    const text = cur.ariaLabel?.trim() || cur.textContent?.trim() || '';
    if (text && text.length <= CONTAINER_MAX) {
      const capped = truncate(text, CONTAINER_MAX);
      if (capped && capped !== own) {
        const redacted = redactText(capped, CONTAINER_MAX);
        if (redacted && redacted !== own && !out.includes(redacted)) out.push(redacted);
      }
    }
  }
  return out;
}

/** Non-semantic targets we never describe a click/submit for. */
function isDocumentLevel(el: ElementLike): boolean {
  const tag = (el.tagName ?? '').toLowerCase();
  return tag === 'html' || tag === 'body' || tag === '';
}

/** Controls whose value must never be captured on a change event. */
function isForbiddenControl(el: ElementLike): boolean {
  if ((el.type ?? '').toLowerCase() === 'password') return true;
  // Credit-card autofill hints; phase-1 guard alongside password.
  const ac = (el.autocomplete ?? '').toLowerCase();
  return ac.startsWith('cc-');
}

/**
 * A 4-8 digit pure-numeric final value is treated as a verification/OTP code
 * and masked: short numeric codes are almost always one-time secrets (SMS /
 * email codes, e.g. what a "获取验证码" flow types in), while longer digit
 * runs (phone numbers, order ids) and shorter ones (quantities) stay visible.
 * Deliberately name-agnostic — most code inputs are unnamed controls.
 */
const CODE_VALUE_RE = /^\d{4,8}$/;

/**
 * Build the CapturedInteraction descriptor for one DOM event target. Returns
 * null when there is nothing worth recording: document-level targets (clicks on
 * html/body), password/cc- controls on change, or targets with no text, no
 * name, no final value, and no container context at all.
 *
 * `ancestors` are the target's ancestor elements, closest first, pre-extracted
 * by the caller (which owns the real DOM) — at most CONTAINER_MAX_COUNT levels
 * are ever consumed.
 */
export function describeInteraction(
  kind: InteractionKind,
  target: ElementLike | null | undefined,
  ancestors: readonly ElementLike[],
  at: number,
  page: { path: string; title?: string },
): CapturedInteraction | null {
  if (!target) return null;
  if (isDocumentLevel(target)) return null;
  if (kind === 'change' && isForbiddenControl(target)) return null;

  const text = redactText(extractText(target) ?? '', TEXT_MAX);
  const containers = extractContainers(target, ancestors);

  if (kind === 'change') {
    const name = target.name?.trim() || undefined;
    const rawValue = target.value ?? '';
    // A non-empty final value carries param semantics on its own — a change
    // into an unnamed, unlabeled control is still worth capturing.
    if (!text && !name && !rawValue && containers.length === 0) return null;
    // redactExample masks by field NAME (e.g. a control named "token") OR by
    // value shape — the same rule schema examples use. Verification-code-shaped
    // values are masked regardless of the control's name (see CODE_VALUE_RE).
    const value = truncate(
      CODE_VALUE_RE.test(rawValue) ? REDACTION_MASK : redactExample(name ?? '', rawValue),
      TEXT_MAX,
    );
    return {
      kind,
      at,
      ...(text ? { text } : {}),
      ...(containers.length > 0 ? { containers } : {}),
      page,
      ...(name ? { name } : {}),
      ...(value ? { value } : {}),
    };
  }

  if (!text && containers.length === 0) return null;
  return {
    kind,
    at,
    ...(text ? { text } : {}),
    ...(containers.length > 0 ? { containers } : {}),
    page,
  };
}

/**
 * Attach to each call the interaction nearest before its start (within
 * `windowMs`) — the likely trigger. A hint for consumers, not causality: no
 * interaction in the window simply leaves the field absent.
 *
 * One interaction is attached to at most `maxPerInteraction` calls (the
 * chronologically FIRST ones after it): on a busy page a single committed input
 * can be followed by dozens of unrelated page-load calls within the window,
 * and smearing the mark across all of them destroys its value as a causal
 * hint. The genuinely triggered calls sit at the head of that burst; the tail
 * keeps no mark instead of a misleading one.
 *
 * Mutates `calls` in place; both inputs may arrive unsorted (sorted internally).
 */
export function attachPrecedingInteractions(
  calls: Array<{ startedAt: number; precedingInteraction?: PrecedingInteraction }>,
  interactions: readonly CapturedInteraction[],
  windowMs = 2000,
  maxPerInteraction = 5,
): void {
  const sorted = [...interactions].sort((a, b) => a.at - b.at);
  // Chronological call order — the cap counts the FIRST calls after an
  // interaction, which is meaningful even when `calls` arrives unordered.
  const order = calls
    .map((_, i) => i)
    .sort((a, b) => calls[a]!.startedAt - calls[b]!.startedAt);
  const attached = new Map<number, number>();
  for (const idx of order) {
    const call = calls[idx]!;
    let best = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]!.at > call.startedAt) break;
      best = i;
    }
    if (best < 0) continue;
    const deltaMs = call.startedAt - sorted[best]!.at;
    if (deltaMs > windowMs) continue;
    const n = attached.get(best) ?? 0;
    if (n >= maxPerInteraction) continue;
    attached.set(best, n + 1);
    const it = sorted[best]!;
    call.precedingInteraction = {
      kind: it.kind,
      ...(it.text ? { text: it.text } : {}),
      deltaMs,
    };
  }
}
