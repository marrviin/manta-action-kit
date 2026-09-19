/**
 * Gateway URL parsing helper.
 *
 * Authorization is not a whitelist admission check: on the agent path the MCP
 * tool's native permission prompt (requiresUserInteraction) gates every call, and
 * on the script path an enabled proxy rule authorizes forwarding (see
 * lib/gateway/run.ts). This module only exposes URL parsing.
 *
 * Runs in the background service worker.
 */

/** Parse a URL into origin + normalized pathname, or null if it isn't a valid http(s) URL. */
export function parseHttpUrl(
  url: string,
): { origin: string; host: string; pathname: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { origin: u.origin, host: u.hostname, pathname: u.pathname };
  } catch {
    return null;
  }
}

/**
 * Best-effort SSRF guard: is this hostname a loopback / private / link-local /
 * internal address the gateway must never forward to? The gateway injects the
 * user's cookies and runs inside the browser, so an attacker-controlled URL
 * pointing at localhost, a LAN host, or the cloud metadata endpoint
 * (169.254.169.254) could reach services that trust the local network. We refuse
 * those before forwarding, as defense in depth on top of the confirmation popup /
 * rule. Runs BEFORE the allowlist — a domain on the allowlist cannot bypass this.
 *
 * This is a literal-address + known-name check (no DNS resolution — a service
 * worker can't resolve, and blocking on DNS would race). It therefore does NOT
 * stop DNS-rebinding (a public name resolving to a private IP); it blocks the
 * common, direct cases. `hostname` is a URL.hostname (IPv6 has no brackets).
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, ''); // drop any trailing dot

  // Known local / internal hostnames and suffixes.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  // IPv6 (URL.hostname strips the [] brackets). Normalize IPv4-mapped forms.
  if (host.includes(':')) {
    const v6 = host;
    if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
    // IPv4-mapped/-compatible: ::ffff:127.0.0.1 etc. — test the trailing v4 part.
    const mapped = v6.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (mapped?.[1]) return isBlockedIpv4(mapped[1]);
    if (v6.startsWith('fe80') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb'))
      return true; // link-local fe80::/10
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique-local fc00::/7
    return false;
  }

  // IPv4 literal?
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return isBlockedIpv4(host);

  return false;
}

/** Whether a dotted-quad IPv4 string falls in a loopback/private/link-local range. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed — refuse rather than forward something ambiguous
  }
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  return false;
}

/**
 * Normalize a user-entered domain for the allow/deny lists: lowercase, strip a
 * scheme / path / port / trailing dot. Returns null when nothing domain-like
 * remains (callers treat that as invalid input).
 */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  // Drop an optional scheme so "https://api.com" is accepted, then anything
  // after the first "/" (path) — we only ever match against URL.hostname.
  d = d.replace(/^[a-z][a-z\d+.-]*:\/\//, '');
  d = d.split('/')[0]!;
  d = d.split(':')[0]!;
  d = d.replace(/\.$/, '');
  // Reject obvious non-domains: empty, whitespace, label-less ("com" is fine —
  // a bare TLD is technically matchable — but empty or spaced input is not).
  if (!d || /\s/.test(d) || !d.includes('.')) return null;
  return d;
}

/**
 * Whether `host` (a URL.hostname) matches a list pattern: exact match or any
 * subdomain ("example.com" matches api.example.com but not notexample.com).
 * Both sides are assumed pre-normalized (lowercase, no trailing dot).
 */
export function matchesDomain(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

/** What the gateway should do with a call to this host. */
export type DomainVerdict = 'allow' | 'deny' | 'confirm';

/**
 * Apply the sandbox domain policy. Deny wins over allow (a host on both lists
 * is refused — security beats convenience), allow skips the confirmation popup,
 * anything else falls through to the (default-on) confirmation popup. The SSRF
 * guard is checked before this and is not bypassable by either list.
 */
export function classifyHost(
  host: string,
  allowDomains: string[],
  denyDomains: string[],
): DomainVerdict {
  if (denyDomains.some((d) => matchesDomain(host, d))) return 'deny';
  if (allowDomains.some((d) => matchesDomain(host, d))) return 'allow';
  return 'confirm';
}
