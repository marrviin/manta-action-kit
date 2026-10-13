/**
 * Cookie-source dependency detection — the complement to infer-deps.ts.
 *
 * infer-deps links a value from one call's RESPONSE to a later call's REQUEST.
 * But the most common session-bound values — CSRF/XSRF tokens (double-submit
 * pattern), session echoes — never pass through a recorded response body: the
 * page's JS reads a COOKIE and copies it into a request header. Those edges
 * have no producer call at all, so they were invisible to distillation: the
 * action replayed with the recorded (stale) token and got a 403, costing
 * record/retry cycles to diagnose by hand.
 *
 * This pass compares each call's request fields against the LIVE cookies the
 * browser would send to that call's URL. A request field whose value matches a
 * cookie value (equal, or cookie contained in the field — Bearer prefixes,
 * "token=..." wrappers) becomes a FieldDependency with no producer:
 *   - fromSeq: -1 (sentinel — there is no producing call)
 *   - fromPath: `cookie:<NAME>` (the machine-readable source, and what the UI
 *     and agent read; also the exact syntax of the `{{cookie:NAME}}` replay
 *     template that resolves the fresh value at execute time)
 *
 * Matching runs at RECORD time against then-current cookies — the value link
 * is evidence of mechanism ("this header is fed by that cookie"), not of a
 * specific token; at replay time `{{cookie:NAME}}` re-reads the live cookie.
 *
 * Pure over its inputs: cookies arrive via an injected lookup, so the pass is
 * unit-testable without extension APIs and runs in the background SW at stop().
 */
import type { ApiCall, FieldDependency } from './types';
import { uuid } from '@/lib/utils';
import { flatten, MIN_VALUE_LEN, type Leaf } from './infer-deps';

/** The minimal cookie info the pass needs (keeps it free of chrome types). */
export interface CookieRef {
  name: string;
  value: string;
}

/** Cookie lookup the extension wires to lib/gateway/dnr.ts's collectCookiesForUrl. */
export type CookieLookup = (url: string) => Promise<CookieRef[]>;

/**
 * Hard cap on cookie edges per recording. A header echoing a very generic
 * cookie (or several) could otherwise mint one edge per (field, cookie) pair;
 * the first calls' edges are the ones closest to the token's actual use.
 */
export const MAX_COOKIE_DEPS = 50;

/**
 * Is the cookie value "present in" the request field value? Equality always
 * matches; otherwise the FIELD must CONTAIN the cookie value (above the shared
 * noise floor — same threshold infer-deps uses — so short/ambiguous values
 * can't forge edges). One direction only, deliberately: "Bearer <cookie>" and
 * "token=<cookie>" wrappers are real mechanism evidence, but the reverse
 * (cookie happens to contain a 6-char body leaf as a substring) is mostly
 * base64 coincidence — allowing it would mint false edges.
 */
export function cookieValueMatches(fieldValue: string, cookieValue: string): boolean {
  if (fieldValue === cookieValue) return true;
  if (cookieValue.length < MIN_VALUE_LEN) return false;
  return fieldValue.includes(cookieValue);
}

/**
 * Detect cookie-sourced dependencies across a recording's calls.
 *
 * For each call (capture order), the cookies the browser would send to its URL
 * are matched against the request's headers and body leaves. The first matching
 * cookie name wins per field (header order = browser Cookie-header order, so
 * "last occurrence wins" duplicates resolve the same way the server sees them);
 * each (toSeq, toLocation, toPath, cookie) is linked at most once.
 *
 * @param calls The recording's calls (sorted by seq defensively, like infer-deps).
 * @param lookup Injected cookie source (extension: collectCookiesForUrl mapped
 *   to {name, value}; tests: fakes).
 * @returns Inferred cookie edges (origin 'inferred', fromSeq -1, fromPath
 *   `cookie:<NAME>`), capped at MAX_COOKIE_DEPS.
 */
export async function inferCookieDependencies(
  calls: ApiCall[],
  lookup: CookieLookup,
): Promise<FieldDependency[]> {
  const ordered = [...calls].sort((a, b) => a.seq - b.seq);
  const deps: FieldDependency[] = [];
  const seen = new Set<string>();

  for (const call of ordered) {
    if (deps.length >= MAX_COOKIE_DEPS) break;
    let cookies: CookieRef[];
    try {
      cookies = await lookup(call.url);
    } catch {
      continue; // Cookie read failed for this URL — skip, never break the save.
    }
    if (!cookies.length) continue;

    // Match headers first, then body leaves. per-field first-match-wins keeps
    // one edge per request field even when several cookies share a prefix.
    const fields: Array<{ location: 'header' | 'body'; path: string; value: string }> = [];
    for (const [name, value] of Object.entries(call.reqHeaders)) {
      if (name.toLowerCase() === 'cookie') continue; // The gateway re-injects cookies wholesale.
      fields.push({ location: 'header', path: name, value });
    }
    const body = safeParse(call.reqBody);
    if (body !== undefined) {
      const leaves: Leaf[] = [];
      flatten(body, '', leaves);
      for (const leaf of leaves) {
        fields.push({ location: 'body', path: leaf.path, value: leaf.value });
      }
    }

    for (const field of fields) {
      if (deps.length >= MAX_COOKIE_DEPS) break;
      const hit = cookies.find(
        (c) =>
          c.value.length >= MIN_VALUE_LEN && cookieValueMatches(field.value, c.value),
      );
      if (!hit) continue;
      const key = `${call.seq}:${field.location}:${field.path}:${hit.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push({
        id: uuid(),
        fromSeq: -1,
        fromPath: `cookie:${hit.name}`,
        toSeq: call.seq,
        toLocation: field.location,
        toPath: field.path,
        value: field.value,
        origin: 'inferred',
      });
    }
  }

  return deps;
}

/** Safe JSON.parse that returns undefined instead of throwing (mirrors infer-deps). */
function safeParse(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
