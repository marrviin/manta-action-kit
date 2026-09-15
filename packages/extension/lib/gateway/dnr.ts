/**
 * Cookie injection for gateway forwarding (Option B — no open tab required).
 *
 * MV3 service-worker `fetch({credentials:'include'})` does NOT attach a site's
 * session cookies: the extension origin is cross-site to the target, so SameSite
 * Lax/Strict cookies are withheld. And `fetch` can't set the `Cookie` header
 * itself (forbidden header name). So we:
 *
 *   1. read the cookies the browser *would* send to this URL via chrome.cookies
 *      (works at the browser layer, so it sees HttpOnly cookies too), and
 *   2. inject them with a short-lived declarativeNetRequest SESSION rule that sets
 *      the `Cookie` request header, scoped to this exact URL, removed right after.
 *
 * The cookie value transits the extension (unavoidable for B) but is NEVER exposed
 * to the agent — that's the security property that matters here.
 *
 * ⚠️ Spike before trusting this: confirm in current Chrome that a DNR modifyHeaders
 * session rule actually sets the Cookie header on an extension SW fetch and the
 * target authenticates. If not, fall back to the chrome.cookies.get→set re-set
 * trick with credentials:'include' (see plan).
 */
import type { GatewayRequest } from './types';

/** Session DNR rule ids live in a private range; bumped per call to avoid clashes. */
let ruleSeq = 1;
const RULE_ID_BASE = 90_000;

function nextRuleId(): number {
  ruleSeq = (ruleSeq % 5000) + 1;
  return RULE_ID_BASE + ruleSeq;
}

/** Build a `name=value; name2=value2` Cookie header from the cookies for a URL. */
function buildCookieHeader(cookies: chrome.cookies.Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Forward one request with the user's cookies injected. Returns the raw Response
 * (caller reads the body) plus which cookie names were injected, for the audit log.
 *
 * Auth-ish agent headers are dropped by the caller (see run.ts); here we only add
 * the Cookie header via DNR and issue the fetch with credentials:'omit' so nothing
 * else leaks in.
 */
export async function forwardWithCookies(req: GatewayRequest): Promise<{
  res: Response;
  injectedCookieNames: string[];
  cookieDomain: string;
}> {
  const cookies = await chrome.cookies.getAll({ url: req.url });
  const cookieHeader = buildCookieHeader(cookies);
  const injectedCookieNames = cookies.map((c) => c.name);
  const cookieDomain = cookies[0]?.domain ?? '';

  const ruleId = nextRuleId();
  const usingRule = cookieHeader.length > 0;

  if (usingRule) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'cookie', operation: 'set', value: cookieHeader },
            ],
          },
          condition: {
            // Anchor to the start of the exact URL we're about to fetch. We issue
            // this precise URL ourselves, so the outgoing request matches it.
            urlFilter: `|${req.url}`,
            requestMethods: [req.method.toLowerCase() as chrome.declarativeNetRequest.RequestMethod],
          },
        },
      ],
    });
  }

  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
      // Cookies are injected via DNR; don't let fetch attach anything on its own.
      credentials: 'omit',
      redirect: 'follow',
    });
    return { res, injectedCookieNames, cookieDomain };
  } finally {
    if (usingRule) {
      await chrome.declarativeNetRequest
        .updateSessionRules({ removeRuleIds: [ruleId] })
        .catch((err) => console.error('[gateway] failed to remove DNR rule', err));
    }
  }
}
