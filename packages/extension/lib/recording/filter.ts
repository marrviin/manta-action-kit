/**
 * Recording filter rules (blacklist).
 *
 * Shared by the background session state machine (to drop matching calls while
 * recording) and the side panel (to edit rules). A rule's `pattern` is a glob
 * where `*` matches any run of characters; matching is full-string and
 * case-insensitive so a pattern surrounding "/track" with wildcards blocks any
 * URL containing that segment.
 */
import type { RecordingFilterRule } from './types';

/** Escape regex metacharacters, then turn `*` back into `.*`. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Does `url` match the wildcard `pattern`? Empty/whitespace patterns never match. */
export function matchesPattern(url: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  try {
    return patternToRegExp(p).test(url);
  } catch {
    return false;
  }
}

/** True when `url` is blacklisted by any enabled rule (i.e. should NOT be recorded). */
export function isBlacklisted(url: string, rules: RecordingFilterRule[]): boolean {
  return rules.some((r) => r.enabled && matchesPattern(url, r.pattern));
}
