# Privacy Policy — Manta Action Kit

_Last updated: 2026-09-04_

Manta Action Kit ("the extension") is a developer tool that records API calls
made by pages you visit and lets an AI agent, running on your own machine, read
those recordings and call your authenticated APIs through a local sandbox proxy.

The guiding principle of this extension is simple: **your data stays on your
machine, and your credentials are never exposed to the AI.** We do not operate a
server, we do not have an account system, and we do not collect analytics.

## Data the extension handles

Google's Chrome Web Store asks us to declare the categories of user data the
extension handles. For transparency, the extension reads and/or stores the
following — **all of it locally, none of it transmitted to us or any third party
we control:**

- **Authentication information** — the extension reads your existing browser
  session cookies for a target host in order to inject them into an outgoing
  request (see "How cookies are handled" below). Recorded requests may also
  contain authentication headers or tokens present in the traffic you record.
- **Website content** — when you actively record a flow, the extension captures
  the request and response payloads of the API calls (method, URL, headers,
  request/response bodies, timing, and parsed SSE events for streaming
  responses).
- **User activity (network request capture)** — the extension observes the
  fetch/XHR network requests made by the page **only while you are actively
  recording**. It does not track clicks, mouse movement, scrolling, keystrokes,
  or your browsing history.

**We do not sell or transfer this data to third parties, do not use it for any
purpose unrelated to the extension's single purpose, and do not use it for
creditworthiness or lending.**

## Where data is stored

Everything the extension stores lives **locally in your browser**. Nothing is
transmitted to us or to any third party we control.

| Data | Where it is stored | Why |
| --- | --- | --- |
| **Recorded API calls** — request method, URL, headers, request/response bodies, timing, and (for streaming responses) parsed SSE events | IndexedDB, in your browser profile | So you can review a recorded business flow and expose it to your agent |
| **Settings** — enabled toggles, MCP port, sandbox-proxy toggle, UI language/theme | `chrome.storage` (sync/local/session) | To remember your preferences |
| **Sandbox-proxy audit log** — for each agent-initiated call: method, URL, status, timing, the **names** of the cookies that were injected, and truncated request/response previews | IndexedDB | So you can audit exactly what your agent did |

**Cookie values are never stored.** The audit log records only cookie *names*
(e.g. that a `session` cookie was attached), never their values.

## How cookies are handled (sandbox proxy)

When you enable the sandbox proxy and your agent asks to call an API:

1. The agent sends only the request `method`, `url`, `headers`, and `body`. It
   sends **no credentials**.
2. The extension reads the cookies your browser would send to that URL (via the
   `chrome.cookies` API) and injects them into that single outbound request
   using a short-lived `declarativeNetRequest` session rule.
3. The request is forwarded from your browser. The response is sanitized
   (`Set-Cookie` headers are stripped) before being returned to the agent.

The cookie value transits the extension's own code in order to be injected into
the network request, but it is **never returned to, visible to, or stored for
the AI agent.** This is the core security property of the extension.

You remain in control at all times:

- **Human-in-the-loop confirmation** — every agent-initiated proxy call requires
  a native approval prompt before it is made; this cannot be bypassed.
- **Per-tool kill switch** — each MCP tool can be disabled.
- **SSRF guard** — requests to loopback, private, and link-local hosts
  (including cloud metadata endpoints) are refused.
- **Audit log** — every forwarded call is recorded locally (cookie names, not
  values).

## Data we do NOT collect

- We do **not** send your recordings, requests, responses, cookies, tokens, or
  browsing activity to any remote server operated by us.
- There is **no** analytics, telemetry, tracking, advertising, or fingerprinting.
- There is **no** account, sign-in, or user identifier.
- The extension uses **no remote code**: all scripts are bundled in the package;
  nothing is fetched or executed from a remote source.

## Data you send to third parties (by your own action)

- **Target APIs.** When your agent (via the sandbox proxy) calls an API, the
  request goes to whatever host you targeted in a proxy rule. That destination
  receives the request and your injected cookies, exactly as if you had made the
  request yourself in the browser.
- **Your AI agent / MCP client.** The extension exposes recordings and endpoint
  contracts to the local MCP client you connect (e.g. Claude Code, Codex).
  Recorded request/response bodies you choose to expose are shared with that
  client. Before those bodies and endpoint contracts are surfaced, representative
  example values that look like credentials or PII (tokens, JWTs, emails, long
  opaque blobs) are automatically **redacted**. Review your recordings before
  exposing them, and consult your MCP client's own privacy policy for how it
  handles data.

The local MCP bridge connects only to a process on the loopback interface
(`127.0.0.1`) that you run yourself, and is not reachable from the network.

## Permissions and why they are needed

- `cookies`, `declarativeNetRequestWithHostAccess`, `host_permissions:
  <all_urls>` — read and inject session cookies to forward authenticated
  requests, and inject the capture hook on the pages you record.
- `scripting`, `tabs` — inject the API-capture hook and coordinate recording per
  tab.
- `sidePanel` — host the management UI (recordings, audit log, proxy rules).
- `storage` — persist settings and (via IndexedDB) recordings and the audit log.
- `alarms` — internal keepalive for the background service worker so the local
  MCP bridge survives MV3 service-worker sleep.

## Data retention and deletion

All data is under your control and stored locally. You can delete it at any time:

- Remove individual recordings or clear the audit log from the side panel.
- Remove the extension from `chrome://extensions`, which deletes its IndexedDB
  and stored settings.

## Children

This is a developer tool and is not directed at children.

## Changes

If this policy changes, the "Last updated" date above will change and the new
version will be published in the extension's repository.

## Contact

For questions about this policy, open an issue in the project's repository.
