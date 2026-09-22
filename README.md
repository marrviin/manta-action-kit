<div align="center">

# Manta Action Kit

**Give your AI agents secure access to your real, logged-in APIs — without ever handing over your credentials.**

[![Chrome Web Store](https://img.shields.io/chromewebstore/v/pghddhbhbnlcehlmgnnalgaephllkeel?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white&color=4285F4)](https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-compatible-8A2BE2)](https://modelcontextprotocol.io)
[![Privacy: local-only](https://img.shields.io/badge/data-local--only-success)](PRIVACY.md)

**English** | [中文](README.zh-CN.md)

</div>

Claude Code, Codex, Cursor — they write great code, but they can't safely touch
your **authenticated** business APIs. Either you paste cookies and tokens into
agent configs (leaking credentials into transcripts and logs), or you tell the
agent "sorry, you can't do that."

**Manta Action Kit** fixes this. Record a real API flow once in your browser,
then let your agent replay it or call those endpoints freely — while your
cookies and tokens stay locked inside your browser. The agent never sees a
single credential.

## How it works

```
 You operate the site once              Your agent (Claude Code, Codex, Cursor, …)
        │                                        │
        ▼                                        │ MCP over stdio
 ┌──────────────────────┐                  ┌──────▼───────────────┐
 │  Manta extension     │◀─── local WS ───│  @manta-action-kit/  │
 │  hooks fetch/XHR,    │  (mutually      │  mcp                 │
 │  records every API   │   authenticated)└──────────────────────┘
 │  call to IndexedDB   │
 └──────────┬───────────┘
            │  injects YOUR cookies at the network layer,
            │  only when YOU approve
            ▼
      Target site API   ← request goes out from your browser, with your session
```

1. **Record** — click *Start* in the popup, use the site normally, click *Stop*.
   The extension captures every `fetch`/`XHR` (requests **and** responses,
   including SSE streams) into a local, inspectable call chain.
2. **Distill** — your agent reads the recording through MCP and distills it
   into a reusable, parameterized **Action** (`{{param}}` templates,
   step-to-step output passing).
3. **Replay** — `execute_action` or `proxy_fetch` re-fires the flow through a
   sandbox gateway. The extension injects your session cookies at forward time;
   the AI only ever sent `method/url/headers/body`.

## Why it's safe

Credentials live in your browser and **never travel to the AI** — that's the
whole point, and it's enforced at several layers:

- **Cookie injection at the trust boundary** — the extension reads cookies via
  `chrome.cookies` and injects them as a network-layer header. Cookie *values*
  never appear in any tool result, transcript, or log.
- **Human-in-the-loop gate** — every new target host pops an extension-side
  confirmation window showing method/URL/body. You approve once per host per
  run; deny or ignore and the call never goes out. Works on *every* path
  (agent calls and script-driven calls alike), independent of MCP client
  behavior.
- **SSRF guard** — loopback, private-network, link-local and cloud-metadata
  addresses (`169.254.169.254` included) are refused *before* any other policy,
  on every path.
- **Domain policy you own** — deny-list blocks outright, allow-list flows
  silently. The agent has **no tools** to read or change these.
- **Per-tool kill switch** — toggle any MCP tool off from the extension UI.
- **Audit log** — every forwarded call is logged locally. Cookie *names* are
  logged; values never.
- **Mutually-authenticated local bridge** — the loopback WebSocket does a
  two-way challenge-response (`HMAC(token, …)` in both directions; the token
  itself never crosses the wire). Unauthenticated peers get dropped, web pages
  dialing `ws://127.0.0.1` are rejected, and without a token the server fails
  closed.
- **All data stays local** — IndexedDB + `chrome.storage`. No analytics, no
  external servers, no remote code. See [PRIVACY.md](PRIVACY.md).

## What your agent gets

Recordings are the raw material; **Actions are the product**. A distilled
action is a parameterized, replayable flow — your agent lists and runs them
like any other tool:

| Area | Tools |
| --- | --- |
| Read recordings | `list_recordings` · `get_recording` · `get_call` · `get_flow` · `get_endpoints` (redacted schemas) |
| Actions | `list_actions` · `search_actions` · `create_action` · `execute_action` … |
| Sandbox proxy | `proxy_fetch` · `proxy_sse` (with your login state) |
| Ops | `health` · proxy-rule management |

Example of what an action looks like from the agent's side:

> `search_actions("track shipment")` → *track-order-shipment* — params:
> `orderId`. Steps: fetch order → pass `{{steps[0].outputs[id]}}` into the
> tracking call → `execute_action({ actionId, params: { orderId: "A1002" } })`
> → done, through your logged-in session, one confirmation popup, full audit.

## Quick start

**1. Install the extension** from the
[Chrome Web Store](https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel).

**2. Copy the install prompt** — open the extension's side panel → *Action*
tab → *Copy install prompt*. It embeds your personal bridge token
(`MANTA_TOKEN`).

**3. Add the MCP server to your agent.** Paste the prompt into Claude Code /
Codex / any MCP client — or add this to your MCP config:

```json
{
  "mcpServers": {
    "manta-action-kit": {
      "command": "npx",
      "args": ["-y", "@manta-action-kit/mcp"],
      "env": {
        "MANTA_WS_PORT": "8787",
        "MANTA_PROXY_PORT": "8788",
        "MANTA_TOKEN": "<token from the extension>"
      }
    }
  }
}
```

**4. Use it.** Record a flow on your site, then ask your agent:

> *"I just recorded the order-tracking flow. Turn it into an action and tell
> me where order A1002 is."*

The bridge runs 100% on `127.0.0.1` — nothing leaves your machine except the
API calls you approved.

## Development

```bash
pnpm install          # deps + wxt prepare
pnpm dev              # dev Chrome with HMR (auto-loads the extension)
pnpm build            # production build -> packages/extension/.output/chrome-mv3/
pnpm compile          # type-check the whole workspace
pnpm test             # vitest unit suite (security-critical pure modules)
pnpm zip              # store-ready package
```

A pnpm monorepo: `packages/extension` (WXT + React 19 + Ant Design v6 +
Tailwind v4, Manifest V3) and `packages/mcp`
([`@manta-action-kit/mcp`](packages/mcp/README.md), Node MCP server). See
[CONTRIBUTING.md](CONTRIBUTING.md) and
[CLAUDE.md](CLAUDE.md) for architecture and conventions — including why the
MV3 service worker dials *out* as a WebSocket client, and why cookie injection
goes through `declarativeNetRequest` instead of `fetch credentials`.

## License

MIT — see [LICENSE](LICENSE).
