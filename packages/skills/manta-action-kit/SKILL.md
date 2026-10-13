---
name: manta-action-kit
description: >-
  Setup and usage guide for the manta-action-kit suite (Chrome extension +
  local MCP server): first-time setup (install the extension, register the MCP
  server in any client), environment checks and connection troubleshooting,
  and tool recipes — reading recordings, distilling recordings into
  parameterized actions, executing actions, cookie-injecting proxy_fetch
  forwarding, and agent-driven page capture (screenshots, element
  serialization, GIF tab recording). Use when the user mentions "manta", wants
  to install / set up / initialize the environment, can't connect, or says
  "check recordings", "view call chains", "create an action / turn a recording
  into an action", "execute an action", "search actions", "call the API with
  my login state", "show element captures", "screenshot this page", "capture
  this element", "record a GIF", "check environment". Chinese triggers:
  「安装 manta」「初始化环境」「检查环境」「连不上」「查录制」「看调用链路」
  「创建 action」「执行 action」「用我的登录态调这个接口」「截个图」「录个 GIF」.
  Chinese quick reference: references/zh-CN.md.
---

# manta-action-kit Suite Usage Guide

The suite consists of two parts:

- **Chrome extension** (`packages/extension`): records page API calls (IndexedDB storage); acts as
  the MCP bridge (an MV3 service worker can only be a WS client, so it dials out to the local MCP
  process); sandboxed proxy gateway (injects cookies when forwarding — cookies are never exposed to
  the agent).
- **MCP server** (`packages/mcp`, stdio): provides the tools in this file. Tool names carry the
  prefix `mcp__manta-action-kit__`. **"manta" is the user-facing short alias** for it. A Python
  port lives in `packages/mcp-py` (same tool surface, versioned in lockstep).

> **Path note.** `packages/...` paths below are relative to the manta-action-kit repo root — they
> apply when working inside that repo. If this skill was installed into another project, the MCP
> server runs from the published package (`npx @manta-action-kit/mcp`) and all build steps are
> irrelevant (development-only guidance lives in [references/dev-setup.md](references/dev-setup.md)).
> `check-env.mjs` detects whether it runs inside the repo itself — invoke it by absolute path from
> any cwd.

## 1. First-Time Setup (when the user says "install manta / set it up / initialize the environment / getting started")

### 1a. Standard path — Web Store extension + published server (no repo checkout)

Requirements: Chrome, and Node ≥ 18 on PATH (the server runs through `npx`).

1. **Install the extension** from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/manta-action-kit/pghddhbhbnlcehlmgnnalgaephllkeel)
   (a repo checkout can load `packages/extension/.output/chrome-mv3/` unpacked instead — see
   [references/dev-setup.md](references/dev-setup.md)).
2. **Copy the install prompt**: extension toolbar icon → _Open side panel_ → **Action** tab →
   _Copy install prompt_. It embeds the personal bridge token (`MANTA_TOKEN`) and current ports.
3. **Register the MCP server** in the user's client. The pasted install prompt already contains a
   working registration (JSON block / command) — follow it. Manual equivalents:
   - **Claude Code**:
     `claude mcp add manta-action-kit --env MANTA_TOKEN=<token> -- npx -y @manta-action-kit/mcp`
     then `/mcp` reconnect or restart the session.
   - **Codex**: add to `~/.codex/config.toml`:
     `[mcp_servers.manta-action-kit]` with `command = "npx"`, `args = ["-y", "@manta-action-kit/mcp"]`,
     `env = { MANTA_TOKEN = "<token>" }`; restart the session.
   - **Cursor**: merge the install prompt's JSON block into `~/.cursor/mcp.json` (or the project's
     `.cursor/mcp.json`); restart the session.
   - **WorkBuddy**: merge into `~/.workbuddy/mcp.json` (no leading dot in the filename — a dotted
     path is silently ignored), then **trust** the server in WorkBuddy's connector UI (registration
     alone stays inert until trusted).
   - **JoyCode**: merge into `~/.joycode/joycode-mcp.json` (no leading dot), then restart JoyCode.
4. **Verify** with the environment check below (or just call `list_recordings`).
5. **First run**: have the user record a flow in the popup (Start → use the site → Stop), then ask
   the agent to distill and replay it, e.g. _"I just recorded the order-tracking flow. Turn it into
   an action and run it."_ — that maps to `get_flow` / `get_endpoints` → `create_action` →
   `execute_action` (section 3).

### 1b. Repo-checkout path (development only)

If the user has this repo cloned and wants a local build instead of the published package, follow
the dev setup in [references/dev-setup.md](references/dev-setup.md) (build + register `node .../dist/index.js`).

## 2. Environment Check (run in order when the user says "check environment / can't connect / troubleshoot")

**Run the bundled script first (one command covers all checks, printing ✅/❌ per item with fix
suggestions):**

```bash
MANTA_TOKEN=<from the MCP config env> node <skill-dir>/scripts/check-env.mjs
```

The script needs `MANTA_TOKEN` (the handshake secret in the MCP config env — see below) and
performs a full authenticated probe. It resolves its own location, so it works from any cwd; inside
a repo checkout it also checks the build output. Requires Node ≥ 18 — the connection probe uses
native `WebSocket` on Node ≥ 22 and a built-in raw-socket fallback on older versions.

**How to get `MANTA_TOKEN`:** run `claude mcp get manta-action-kit` (its output shows the server's
`env` block), or read your MCP client's config file. If you can't retrieve it, ask the user to
re-copy the install prompt from the extension (Action tab → _Copy install prompt_) — the token is
embedded there.

The script covers the checks below (including an end-to-end probe as a peer, distinguishing
"bridge up but extension not connected" from "full chain works"). Exit code 0 = all pass. **For any
❌ item, dig in and fix it with the manual steps below, then re-run the script to confirm.**

Report results per item rather than only the final conclusion.

### Check 1. MCP server is registered and can start

- **Claude Code**: `claude mcp list 2>/dev/null | grep manta-action-kit`
  - ✅ Pass: output contains `✔ Connected`.
  - ❌ Line missing → register it (the `claude mcp add` command from section 1a, step 3 — or, in a
    repo checkout with a local build, the command in
    [references/dev-setup.md](references/dev-setup.md)). Then ask the user to run `/mcp` reconnect
    or restart the session.
  - ❌ `✘ Failed to connect` → the server process starts and dies immediately: check for a missing
    dist (repo checkouts: `pnpm build:mcp`) or a port conflict (check 2).
- **Other clients**: re-check the config file / trust state from section 1a step 3 for that client.
  The `check-env.mjs` script probes the known config files automatically.

### Check 2. Ports (only on startup failure or mismatch)

Default ports: WS bridge `MANTA_WS_PORT` 8787, sandbox proxy `MANTA_PROXY_PORT` 8788.

- If startup dies immediately with a port-conflict fatal error, check what's holding the port:
  `lsof -nP -iTCP:8787 -sTCP:LISTEN` (same for 8788). Kill leftover processes, or switch to a free
  port: add `--env MANTA_WS_PORT=<port>` when registering, and update the port on the extension
  settings page to match.
- Note: if 8787 is held by a NON-manta process, the server self-heals by claiming the first free
  port above it (up to 8787+32) and the extension discovers the relocation automatically — this
  takes ~20–30s (ten dial retries, then the scan). Check stderr for
  `Bridge on ws://127.0.0.1:<port> (fallback …)` and the `health` tool's `wsPort` before assuming a
  restart is needed.

### Check 3. Extension online, WS connected (probe with a tool — `list_recordings` is cheapest)

Just call `mcp__manta-action-kit__list_recordings` (probe for errors; ignore the payload):

- ✅ Pass: returns JSON (even an empty list). **An empty list ≠ a fault** — it just means nothing
  has been recorded yet.
- ❌ Error `No authenticated Chrome extension connected...` → have the user confirm, in order:
  1. Chrome is open with the extension installed (Web Store build, or a repo checkout loaded via
     `chrome://extensions` developer mode → load `packages/extension/.output/chrome-mv3/`).
  2. The port on the extension settings page matches the server port (default 8787);
  3. If the extension's **Settings tab → Connector card** shows **"Auth failed"** (handshake
     token mismatch): re-copy the install prompt (Action tab → Copy install prompt) and update
     the MCP config env
     `MANTA_TOKEN` to the new value, then reconnect (`/mcp`).
- ❌ Error `MCP bridge has no MANTA_TOKEN configured...` → the MCP config env is missing
  `MANTA_TOKEN`; re-copy the install prompt from the extension and update the config env.
- ❌ Error `RPC "..." timed out after ...ms` → the extension's WS is connected but unresponsive,
  usually because the extension just reloaded / the service worker went dormant. Ask the user to
  click the extension sidebar once to wake it, then retry.

### Check 4. Summary report

Output a checklist as "✅/❌ + fix action (already done / requires the user)". **Any action the
user must do in Chrome — flipping a toggle, confirming a dialog — must be called out explicitly
for the user to perform; do not spin retrying in the agent.**

## 3. Feature Usage (trigger phrase → tool)

When the user says these things, call `mcp__manta-action-kit__<tool>` directly — **do not ask
follow-up questions and do not write your own scripts to parse IndexedDB**:

**Core principle: recording data is merely raw material for "creating actions".** To execute a
recorded flow, the correct path is: analyze the recording (`get_flow` / `get_endpoints`) →
`create_action` to distill it into a parameterized action → `execute_action` for end-to-end
replay. **Do not manually replay recorded calls one by one with `proxy_fetch`**; `proxy_fetch` is
only for ad-hoc, one-off single calls.

### Actions — the executable form of recordings

| User says                                       | Tool             | Notes                                                                                                                                                                             |
| ----------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "check actions / what actions are there"        | `list_actions`   | All saved actions                                                                                                                                                                 |
| "find an action that can do X"                  | `search_actions` | Filter by keyword (the discovery entry point before executing)                                                                                                                    |
| "show this action's definition / parameters"    | `get_action`     | Full definition of a single action                                                                                                                                                |
| "turn this recording into an action / reusable" | `create_action`  | Declare parameters + steps referencing callIds + template rewrites, distilled                                                                                                     |
| "change the action's parameters / steps / desc" | `update_action`  | Update the action definition                                                                                                                                                      |
| "delete this action"                            | `delete_action`  | Delete the action                                                                                                                                                                 |
| "execute the action / run that action"          | `execute_action` | End-to-end replay: auto-resolved dependencies, template parameter injection; runs through the extension gateway (same channel and same confirmation-dialog gating as proxy_fetch) |

### Recordings (raw material, for analysis / action creation)

| User says                                                      | Tool                        | Notes                                                                                                     |
| -------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| "check recordings / list recordings / what APIs I've recorded" | `list_recordings`           | All recording metadata (index of action material)                                                         |
| "show this recording's call chain / full req-res"              | `get_recording`             | Single recording + full chain (for analysis)                                                              |
| "analyze step dependencies / where fields come from"           | `get_flow`                  | Ordered steps + inferred field dependencies (must read before create_action)                              |
| "show API contracts / deduplicated endpoints"                  | `get_endpoints`             | Deduplicated endpoints + sanitized schemas (must read before create_action)                               |
| "show a single call"                                           | `get_call`                  | Fetch a single API call by id                                                                             |
| "describe this recording / what does this flow do"             | `set_recording_description` | Agent-authored business-level summary of the whole flow (shown in `list_recordings` to help future reuse) |

**Relevance marks**: after a recording is saved, the extension auto-runs a local
model pass that marks each call's `relevance` (`relevant` / `irrelevant` /
`uncertain`, with a `role` like `telemetry`). When `get_flow` steps or `get_call`
carry `relevance.verdict === 'irrelevant'`, that call is background noise
(analytics, polling, preflight) — skip it when analyzing the flow or distilling
an action. No `relevance` field means the recording has not been analyzed; treat
every call as potentially relevant then.

**User-intent marks**: `get_flow` steps may carry a
`precedingInteraction` field — the user interaction (click/typing, with its
text and `deltaMs`) that most likely triggered that call, captured from the
page during recording. Use it to identify which steps are direct consequences
of user intent vs. calls that merely co-occur (analytics, preloads fire without
one). Absent field = the call had no interaction within the lookback window.

**Dep-confidence marks**: inferred field dependencies in `get_flow` deps (and
`get_endpoints` `inputsFrom`) can carry a `depCheck` mark
(`likely` / `unlikely` / `uncertain`). `depCheck.verdict === 'unlikely'` means
the local model considers the edge a coincidental value match (a timestamp or
nonce that happened to collide) rather than a real data flow — do not build
action parameterization on it. Absent `depCheck` = not analyzed; treat the edge
as the heuristic inference it is.

**Field dynamism marks**: `get_endpoints` request-schema leaves may carry a
`dynamism` mark and query params appear in `queryDynamism`
(`verdict: 'varies' | 'stable' | 'uncertain'`, `source: 'stats' | 'model'`).
`varies` = the value would differ on a replay in a fresh session (a timestamp,
session token, auto-generated id) — make it an action parameter, never a
hardcoded literal. `stable` = safe to hardcode. `source: 'stats'` is a
multi-observation fact and outranks `'model'` (a single-observation judgment).
No mark = not analyzed (or the field was seen only once and the model pass
failed) — judge from the value shape yourself then.

### Element captures (UI reference / visual diffing)

The user can capture any on-page element from the extension popup (click or box-select; Alt+Shift+I
also works). Each capture is a faithful, LLM-ready snapshot of how the element is built: a flattened
element tree where every node carries tag/id/classes/text, whitelisted attributes, full computed
styles (including custom properties and `::before`/`::after` rules), and a source-file hint when
available. Captures are stored locally (up to 20, oldest evicted) and the user can diff any two of
them in the extension's preview tab.

| User says                                               | Tool                    | Notes                                                                              |
| ------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| "list element captures / what UI snapshots do I have"   | `list_element_captures` | Summaries only (page, title, element count) — pick an id here first                |
| "show that capture / how is this component built"       | `get_element_capture`   | Full element tree with computed styles                                             |
| "compare these two captures / why do the styles differ" | `diff_element_captures` | Returns a text report of property-level changes per DOM path + an `identical` flag |

Typical use cases: the user rebuilt a UI and wants you to check it, they reference another project's
module when building a new one, or a component renders differently standalone vs. as a micro-app
child (capture both, then diff).

Consuming a capture to recreate UI: build semantic HTML and clean CSS rules from the snapshot —
**do not copy the inlined computed styles verbatim**. Each node inlines the full computed style of
the moment; treat it as ground truth for _what it should look like_, not as the stylesheet to ship.
Pay attention to custom properties and pseudo-element rules, which are emitted in a `<style>` block.

### Page capture (agent-driven: screenshots / live element serialization / GIF recording)

These tools act on the **active tab** of the user's Chrome window and run silently (no preview tab,
no success notifications — outcomes come back in the tool result). Element capture and GIF recording
cannot run on `chrome://` pages, but screenshots CAN (they fall back to a CDP render there) — only
Chrome-protected targets such as the Web Store still refuse (`screenshot:protected-page`).

| User says                                                 | Tool                                           | Notes                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "screenshot this page / full-page screenshot"             | `capture_screenshot`                           | `visible` or `fullPage` (scroll-and-stitch); returns a downscaled image + `historyId`                                                                                                                                                      |
| "grab this element from the page / serialize the nav bar" | `capture_element`                              | selector / `point` / `box` (exactly one) + optional `coordinates` (`"viewport"` default / `"page"` — pass `"page"` for coordinates read off a fullPage screenshot); returns a lean tree — full detail via `get_element_capture(captureId)` |
| "record my screen as a GIF / record this tab"             | `start_gif_recording`                          | ⚠️ Blocks up to ~2 min on a confirmation popup the USER must Allow (that click is Chrome's required gesture for tab capture); 5-min auto-stop                                                                                              |
| "stop the recording"                                      | `stop_gif_recording`                           | Returns the WebM `draftId` (if briefly absent, read `lastResult.draftId` from the status tool)                                                                                                                                             |
| "pause / resume the recording"                            | `pause_gif_recording` / `resume_gif_recording` | —                                                                                                                                                                                                                                          |
| "is it recording?"                                        | `get_gif_recording_status`                     | Current state + how the last recording ended (`lastResult`)                                                                                                                                                                                |
| "list my recordings"                                      | `list_gif_history`                             | WebM drafts (metadata only)                                                                                                                                                                                                                |

Notes:

- `capture_screenshot` fails with `screenshot:debugger-conflict` if DevTools is attached to the tab —
  tell the user to close DevTools. On a recording tab, the CDP fallback may leave Chrome's
  "being debugged" infobar inside the shot.
- `capture_element` pierces into iframes (up to depth 3): the page's iframes are searched when the
  top frame has no match (write the selector as seen INSIDE the frame), a `point` hit on an
  `<iframe>` captures the inner element, and a `box` covering only an iframe captures that frame's
  content. Timeout is 45s to cover the worst-case relay chain — don't give up early on a slow
  first response.
- GIF drafts are **pre-transcode WebM**: WebM→GIF/MP4 conversion runs inside the extension's preview
  tab and cannot be triggered remotely — after `stop_gif_recording`, tell the user to open the draft
  from the side panel's capture tab to transcode/download it.

### Proxy rules (script-driven gateway entry)

Lets a user script (e.g. an SDK client) call a target API through the extension's sandbox proxy:
the script points its baseURL at `http://127.0.0.1:<proxyPort><sandboxPrefix>` and the extension
rewrites + forwards each request with the user's cookies injected (never exposed). This is the
gateway path behind `proxy_fetch`, for repeated scripted use rather than one-off calls.

| User says                                      | Tool                | Notes                                                                                                   |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| "what proxy rules are there"                   | `list_proxy_rules`  | All rules ({id, sandboxPrefix, targetBase, enabled}) — read before add/update to keep prefixes unique   |
| "let my script call api.com through the proxy" | `add_proxy_rule`    | ⚠️ Pops a NATIVE confirmation prompt showing prefix + target — the user must verify and approve         |
| "change that rule's target / prefix"           | `update_proxy_rule` | Patch sandboxPrefix/targetBase by id; re-validated. The `enabled` kill switch is user-only — cannot set |

### Direct forwarding (ad-hoc / one-off calls)

| User says                                                   | Tool          | Notes                                                                  |
| ----------------------------------------------------------- | ------------- | ---------------------------------------------------------------------- |
| "call this API with my login state / make a request for me" | `proxy_fetch` | Forwarded via the extension with cookie injection (single ad-hoc call) |
| "pull SSE / watch streaming events"                         | `proxy_sse`   | Forward SSE and collect events                                         |

About `proxy_fetch` / `proxy_sse`:

- Every call pops the **extension's own confirmation popup** (human-in-the-loop, rendered by the
  extension itself). This is the primary gate by design — it also covers the script-driven gateway
  path and does not depend on the MCP client honoring native prompts. Tell the user to click
  Allow; it is not a fault.
- Cookies are injected only inside the extension and **never appear in tool results**; just relay
  the response to the user.
- Loopback / private-network / cloud-metadata addresses (including 169.254.169.254) are rejected
  by SSRF protection — that is expected blocking.

About `create_action` / `execute_action`:

- **Confirmation behavior**: creating/updating/deleting an action is silent (validation only — no
  popup on either the MCP or the extension side). The human gate lives at replay time:
  `execute_action` runs through the extension gateway, whose confirmation popup fires **once per
  target host for the whole run**, so the user can verify before approving.
- Action steps only reference recorded callIds and **contain no credentials**; during replay the
  extension gateway injects the user's cookies, and inter-step dependencies (upstream response
  values → downstream request fields) are resolved automatically by `execute_action` — no manual
  orchestration needed.
- **Template overrides** support the built-in fresh-value helpers `{{nowMs}}` / `{{nowSec}}` /
  `{{uuid}}` (a declared param of the same name wins) — use them for timestamps, nonces and
  one-shot ids a replay cannot reuse from the recording; never hardcode those. Form-encoded
  bodies can be overridden too, including an embedded URL-encoded JSON envelope (paths address
  the embedded JSON, e.g. `data[0].id`), and array-root bodies are overridden by index.
- **CSRF/XSRF cookies**: a request header fed by a browser cookie (double-submit pattern, e.g.
  `X-XSRF-TOKEN` ← `XSRF-TOKEN` cookie) is marked in `get_flow` deps as `fromPath:
"cookie:<NAME>"` (fromSeq -1) and in `get_endpoints` inputsFrom as `fromCookie`. Author it as
  a `{{cookie:<NAME>}}` **header** override — the replay resolves the LIVE cookie value at
  execute time, so the recorded (stale) token never breaks the run. Cookie templates are
  accepted in header overrides only, and the cookie value never appears in tool results.
- **Diagnosing a failed run**: re-run `execute_action` with `continueOnError: true` — every step
  is attempted and `endReason: "completed-with-errors"` reports each step's outcome in one pass
  (later steps consuming a failed step's outputs fail with precise template errors), instead of
  stopping at the first failure.

## 4. Troubleshooting Quick Reference

| Symptom                                      | Cause                                          | Fix                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude mcp list` missing this server or ✘   | Not registered / dist missing (repo checkout)  | Section 2, check 1                                                                                                                                                          |
| Tool reports `No Chrome extension connected` | Chrome closed / port mismatch / token mismatch | Section 2, check 3's three items                                                                                                                                            |
| Tool reports `RPC ... timed out`             | Service worker dormant / just reloaded         | Wake the extension, then retry                                                                                                                                              |
| Startup fatal: port conflict                 | 8787/8788 occupied                             | WS bridge: self-heals to a fallback port (see section 2, check 2). Proxy: call `rebind_proxy`. Only a same-port `MANTA_WS_PORT`/`MANTA_PROXY_PORT` config error stays fatal |
| Source changes not taking effect (repo dev)  | tsc watch doesn't hot-restart                  | `/mcp` reconnect or restart the session                                                                                                                                     |
| New features do nothing / odd results        | Version skew between extension and MCP server  | Call `health` — `compatHint` names the outdated side and how to update it                                                                                                   |

## 5. Going Deeper

- **Chinese quick reference** (trigger phrases → tool, core principles, marks):
  [references/zh-CN.md](references/zh-CN.md).
- **Development / repo work** (building from source, debugging workflow, the wire-compat
  checklist, repository layout): [references/dev-setup.md](references/dev-setup.md).
- Architecture, design trade-offs, and the message protocol: see the repo root `CLAUDE.md`
  (in a repo checkout only — not shipped with the installed skill).
