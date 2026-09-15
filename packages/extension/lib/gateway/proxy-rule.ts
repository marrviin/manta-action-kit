/**
 * Proxy-rule resolution: the script-driven gateway entry's routing layer.
 *
 * A script hits the local proxy at http://127.0.0.1:<port><sandboxPrefix>/<rest>?<q>;
 * the MCP server tunnels {method, rawPath} here (rawPath = the full path+query as
 * received). We match rawPath against the ENABLED rules by longest sandboxPrefix and
 * rewrite it onto the rule's targetBase, producing the real URL to forward.
 *
 * This is a security boundary: a resolved URL authorizes cookie injection onto that
 * host, so the rewrite must never let a crafted rawPath escape the rule's target
 * origin. We therefore build the URL from targetBase + the leftover path and then
 * REJECT anything whose resulting origin differs from targetBase's origin.
 *
 * Pure module — no extension API imports — so it can be unit-tested in isolation.
 */
import type { GatewayProxyRule } from './types';

/** Outcome of resolving a rawPath against the proxy rules. */
export type ProxyResolution =
  { ok: true; url: string; rule: GatewayProxyRule } | { ok: false; status: number; error: string };

/**
 * Validate a proxy-rule input before storing. A rule authorizes cookie injection
 * onto the target, so we require a well-formed prefix + an http(s) absolute target,
 * and reject a prefix that collides with an existing rule (ambiguous routing).
 * Returns an error string, or null when valid. `ignoreId` skips one rule (for edits).
 *
 * Pure: the caller supplies the current rule list (this module touches no db/API),
 * so both the side-panel message path and the agent RPC path reuse it.
 */
export function validateProxyRuleInput(
  input: { sandboxPrefix: string; targetBase: string },
  existingRules: GatewayProxyRule[],
  ignoreId?: string,
): string | null {
  const prefix = normalizePrefix(input.sandboxPrefix);
  if (prefix === '/' || prefix.length < 2) return 'Sandbox prefix cannot be empty and must look like /api';
  if (/\s/.test(prefix)) return 'Sandbox prefix cannot contain spaces';
  let target: URL;
  try {
    target = new URL(input.targetBase.trim());
  } catch {
    return 'Target address must be a complete http(s) URL';
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return 'Target address only supports http/https';
  }
  const clash = existingRules.some(
    (r) => r.id !== ignoreId && normalizePrefix(r.sandboxPrefix) === prefix,
  );
  if (clash) return `Sandbox prefix ${prefix} is already used by another rule`;
  return null;
}

/** Normalize a sandbox prefix: ensure a single leading "/", drop a trailing "/". */
export function normalizePrefix(prefix: string): string {
  let p = prefix.trim();
  if (!p.startsWith('/')) p = `/${p}`;
  // Collapse a lone "/" to itself; otherwise strip the trailing slash.
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

/** Split a rawPath ("/api/order?x=1") into its pathname and query (incl. leading "?"). */
function splitPathQuery(rawPath: string): { pathname: string; query: string } {
  const qi = rawPath.indexOf('?');
  if (qi === -1) return { pathname: rawPath, query: '' };
  return { pathname: rawPath.slice(0, qi), query: rawPath.slice(qi) };
}

/**
 * Does `pathname` sit under `prefix`? True when it equals the prefix or continues
 * with a "/" right after it — so "/api" matches "/api" and "/api/x" but not "/apix".
 */
function pathnameUnderPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Parse an http(s) origin, or null. */
function originOfHttp(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve one inbound request. Picks the longest-prefix ENABLED rule whose
 * sandboxPrefix covers the rawPath, then rewrites onto targetBase and verifies
 * the result stays on the target's origin.
 *
 *  - no matching enabled rule → 404
 *  - rewrite escaped the target origin / bad target → 502 (rule misconfigured)
 */
export function resolveProxyRule(
  rules: GatewayProxyRule[],
  method: string,
  rawPath: string,
): ProxyResolution {
  const { pathname, query } = splitPathQuery(rawPath);

  // Longest-prefix wins: sort enabled rules by normalized-prefix length desc.
  const candidates = rules
    .filter((r) => r.enabled)
    .map((r) => ({ rule: r, prefix: normalizePrefix(r.sandboxPrefix) }))
    .filter((c) => pathnameUnderPrefix(pathname, c.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const top = candidates[0];
  if (!top) {
    return { ok: false, status: 404, error: `No matching proxy rule: ${pathname}` };
  }

  const { rule, prefix } = top;

  const targetOrigin = originOfHttp(rule.targetBase);
  if (!targetOrigin) {
    return {
      ok: false,
      status: 502,
      error: `Rule "${prefix}" has an invalid target address: ${rule.targetBase}`,
    };
  }

  // Leftover path after the prefix (prefix==='/' consumes nothing).
  const rest = prefix === '/' ? pathname : pathname.slice(prefix.length);
  // Join targetBase + rest without doubling or dropping slashes.
  const base = rule.targetBase.replace(/\/+$/, '');
  const restPath = rest.startsWith('/') || rest === '' ? rest : `/${rest}`;
  const candidateUrl = `${base}${restPath}${query}`;

  // Security check: the built URL must stay on the target's origin. A crafted
  // rawPath (e.g. containing "//evil.com" or backslashes) could otherwise re-point
  // the URL at another host, which would leak the target's cookies elsewhere.
  const builtOrigin = originOfHttp(candidateUrl);
  if (builtOrigin !== targetOrigin) {
    return { ok: false, status: 502, error: `Rewritten address escaped the target origin: ${candidateUrl}` };
  }

  return { ok: true, url: candidateUrl, rule };
}
