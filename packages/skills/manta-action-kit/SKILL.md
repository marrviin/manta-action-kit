---
name: manta-action-kit
description: Usage guide for the manta-action-kit suite (Chrome extension + MCP server): environment checks and initialization, extension/MCP/connection troubleshooting, recording APIs, and action management — creating actions from recordings, searching and executing actions, cookie-injecting proxy forwarding, and agent-driven page capture (screenshots, element serialization, GIF tab recording). Use when the user says "manta", "check recordings", "view call chains", "create an action / turn a recording into an action", "execute an action / run that action", "search actions / what actions are available", "call the API with my login state", "proxy_fetch", "show element captures / compare element captures", "screenshot this page / capture this element", "record my screen / record a GIF", "check environment", "initialize environment", "can't connect", etc.
---

# manta-action-kit Suite Usage Guide

The suite consists of two parts; see the repo root `CLAUDE.md` for how they collaborate:

- **Chrome extension** (`packages/extension`): records page API calls (IndexedDB storage); acts as
  the MCP bridge (an MV3 service worker can only be a WS client, so it dials out to the local MCP
  process); sandboxed proxy gateway (injects cookies when forwarding — cookies are never exposed to
  the agent).
- **MCP server** (`packages/mcp`, stdio): provides the tools in this file. Tool names carry the
  prefix `mcp__manta-action-kit__`. **"manta" is the user-facing short alias** for it.

> **Path note.** `packages/...` paths below are relative to the manta-action-kit repo root — they
> apply when working inside that repo. If this skill was installed into another project, locate the
> repo checkout first; if there is none, the MCP server should run from the published package
> (`npx @manta-action-kit/mcp`) and the build steps don't apply. `check-env.mjs` itself resolves its
> own paths — invoke it by absolute path from any cwd.

## 1. Environment Check (run in order when the user says "check environment / initialize / can't connect / troubleshoot")

**Run the bundled script first (one command covers all checks, printing ✅/❌ per item with fix
suggestions; requires Node ≥ 22 — older Node skips the connection checks):**

```bash
MANTA_TOKEN=<from the MCP config env> node <path-to>/packages/skills/manta-action-kit/scripts/check-env.mjs
```

The script needs `MANTA_TOKEN` (the handshake secret in the MCP config env — see below) and
performs a full authenticated probe.

**How to get `MANTA_TOKEN`:** run `claude mcp get manta-action-kit` (its output shows the server's
`env` block), or read your MCP client's config file. If you can't retrieve it, ask the user to
re-copy the install prompt from the extension (Action tab → *Copy install prompt*) — the token is
embedded there.

The script covers steps 1–3 below (including an end-to-end probe as a peer, distinguishing "bridge
up but extension not connected" from "full chain works"). Exit code 0 = all pass. **For any ❌ item,
dig in and fix it with the manual steps below, then re-run the script to confirm.**

Four checks in order — **each with pass criteria and a fix action; report results per item rather
than only the final conclusion.**

### 1. MCP server is registered and can start

```bash
claude mcp list 2>/dev/null | grep manta-action-kit
```

- ✅ Pass: output contains `✔ Connected`.
- ❌ That line missing → register it (from the repo root; outside the repo, replace the `node ...`
  path with `npx -y @manta-action-kit/mcp`):

  ```bash
  pnpm build:mcp   # make sure dist exists first, see step 2
  claude mcp add manta-action-kit --scope local \
    --env MANTA_TOKEN=<from the extension's install prompt, Action tab → Copy install prompt> \
    -- node "$(pwd)/packages/mcp/dist/index.js"
  ```

  Then ask the user to run `/mcp` reconnect or restart the session.

- ❌ `✘ Failed to connect` → check step 2 first (missing dist / port in use).

### 2. dist is built

```bash
test -f packages/mcp/dist/index.js && echo OK
```

- ❌ Missing → `pnpm build:mcp`.
- If startup dies immediately with a port-conflict fatal error (related to `MANTA_WS_PORT (8787)`),
  check what's holding it: `lsof -nP -iTCP:8787 -sTCP:LISTEN` (same for the proxy port 8788). Kill
  leftover processes, or switch to a free port: add `--env MANTA_WS_PORT=<port>` when registering,
  and update the port on the extension settings page to match.

### 3. Extension online, WS connected (probe with a tool — `list_recordings` is cheapest)

Just call `mcp__manta-action-kit__list_recordings` (probe for errors; ignore the payload):

- ✅ Pass: returns JSON (even an empty list). **An empty list ≠ a fault** — it just means nothing
  has been recorded yet.
- ❌ Error `No authenticated Chrome extension connected...` → have the user confirm, in order:
  1. Chrome is open with the extension loaded (`chrome://extensions`, developer mode, load
     `packages/extension/.output/chrome-mv3/`, or run `pnpm dev`);
  2. The port on the extension settings page matches the server port (default 8787);
  3. If the extension's MCP tab shows **"Auth failed"** (handshake token mismatch): re-copy the
     install prompt (Action tab → Copy install prompt) and update the MCP config env
     `MANTA_TOKEN` to the new value, then reconnect (`/mcp`).
- ❌ Error `MCP bridge has no MANTA_TOKEN configured...` → the MCP config env is missing
  `MANTA_TOKEN`; re-copy the install prompt from the extension and update the config env.
- ❌ Error `RPC "..." timed out after ...ms` → the extension's WS is connected but unresponsive,
  usually because the extension just reloaded / the service worker went dormant. Ask the user to
  click the extension sidebar once to wake it, then retry.

### 4. Summary report

Output a checklist as "✅/❌ + fix action (already done / requires the user)". **Any action the
user must do in Chrome — flipping a toggle, confirming a dialog — must be called out explicitly
for the user to perform; do not spin retrying in the agent.**

## 2. Fresh-Environment Initialization (when the user says "set it up on a new machine / initialize the environment")

Run in order; the first two steps are repo builds, the last two are user-side actions:

1. `pnpm install && pnpm build && pnpm build:mcp` (extension output lands in
   `packages/extension/.output/chrome-mv3/`, MCP output in `packages/mcp/dist/`).
2. Register the MCP server (the `claude mcp add` command from step 1 above).
3. Guide the user: Chrome → `chrome://extensions` → developer mode → Load unpacked → select
   `packages/extension/.output/chrome-mv3/`.
4. No toggle to flip — the extension dials in automatically once Chrome is running with it
   loaded; just confirm the extension's MCP port matches the server port (default 8787).
5. Run the environment check above (at least items 1 and 3) to confirm the chain works.

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

| User says                                                      | Tool              | Notes                                                                        |
| -------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| "check recordings / list recordings / what APIs I've recorded" | `list_recordings` | All recording metadata (index of action material)                            |
| "show this recording's call chain / full req-res"              | `get_recording`   | Single recording + full chain (for analysis)                                 |
| "analyze step dependencies / where fields come from"           | `get_flow`        | Ordered steps + inferred field dependencies (must read before create_action) |
| "show API contracts / deduplicated endpoints"                  | `get_endpoints`   | Deduplicated endpoints + sanitized schemas (must read before create_action)  |
| "show a single call"                                           | `get_call`        | Fetch a single API call by id                                                |

**Relevance marks**: after a recording is saved, the extension auto-runs a local
model pass that marks each call's `relevance` (`relevant` / `irrelevant` /
`uncertain`, with a `role` like `telemetry`). When `get_flow` steps or `get_call`
carry `relevance.verdict === 'irrelevant'`, that call is background noise
(analytics, polling, preflight) — skip it when analyzing the flow or distilling
an action. No `relevance` field means the recording has not been analyzed; treat
every call as potentially relevant then.

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

| User says                                                      | Tool                     | Notes                                                                       |
| -------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| "list element captures / what UI snapshots do I have"          | `list_element_captures`  | Summaries only (page, title, element count) — pick an id here first         |
| "show that capture / how is this component built"              | `get_element_capture`    | Full element tree with computed styles                                      |
| "compare these two captures / why do the styles differ"        | `diff_element_captures`  | Returns a text report of property-level changes per DOM path + an `identical` flag |

Typical use cases: the user rebuilt a UI and wants you to check it, they reference another project's
module when building a new one, or a component renders differently standalone vs. as a micro-app
child (capture both, then diff).

Consuming a capture to recreate UI: build semantic HTML and clean CSS rules from the snapshot —
**do not copy the inlined computed styles verbatim**. Each node inlines the full computed style of
the moment; treat it as ground truth for *what it should look like*, not as the stylesheet to ship.
Pay attention to custom properties and pseudo-element rules, which are emitted in a `<style>` block.

### Page capture (agent-driven: screenshots / live element serialization / GIF recording)

These tools act on the **active tab** of the user's Chrome window and run silently (no preview tab,
no success notifications — outcomes come back in the tool result). `chrome://` pages and similar
cannot be captured or injected.

| User says                                                       | Tool                     | Notes                                                                        |
| --------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| "screenshot this page / full-page screenshot"                   | `capture_screenshot`     | `visible` or `fullPage` (scroll-and-stitch); returns a downscaled image + `historyId` |
| "grab this element from the page / serialize the nav bar"       | `capture_element`        | selector / `point` / `box` (exactly one); returns a lean tree — full detail via `get_element_capture(captureId)` |
| "record my screen as a GIF / record this tab"                   | `start_gif_recording`    | ⚠️ Blocks up to ~2 min on a confirmation popup the USER must Allow (that click is Chrome's required gesture for tab capture); 5-min auto-stop |
| "stop the recording"                                            | `stop_gif_recording`     | Returns the WebM `draftId` (if briefly absent, read `lastResult.draftId` from the status tool) |
| "pause / resume the recording"                                  | `pause_gif_recording` / `resume_gif_recording` | —                                                            |
| "is it recording?"                                              | `get_gif_recording_status` | Current state + how the last recording ended (`lastResult`)                |
| "list my recordings"                                            | `list_gif_history`       | WebM drafts (metadata only)                                                  |

Notes:

- `capture_screenshot` fails with `screenshot:debugger-conflict` if DevTools is attached to the tab —
  tell the user to close DevTools. On a recording tab, the CDP fallback may leave Chrome's
  "being debugged" infobar inside the shot.
- GIF drafts are **pre-transcode WebM**: WebM→GIF/MP4 conversion runs inside the extension's preview
  tab and cannot be triggered remotely — after `stop_gif_recording`, tell the user to open the draft
  from the side panel's capture tab to transcode/download it.

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

- These also pass the **extension's confirmation popup** (creating/updating shows the action name
  and description; executing confirms once per target host for the whole run, so the user can
  verify before approving).
- Action steps only reference recorded callIds and **contain no credentials**; during replay the
  extension gateway injects the user's cookies, and inter-step dependencies (upstream response
  values → downstream request fields) are resolved automatically by `execute_action` — no manual
  orchestration needed.

## 4. Debugging Workflow (when modifying `packages/mcp` source)

- `pnpm dev:mcp` — tsc --watch compiling dist live. **It does NOT hot-restart a running MCP
  process**: after changing code, have the user `/mcp` reconnect that server, or restart the
  session.
- `pnpm start:mcp` — run it once manually to inspect startup logs (stdio + WS bridge).
- Extension side: `pnpm dev` to load the dev build; after changing extension code you may
  occasionally need to click refresh ↻ on `chrome://extensions`.

## 5. Troubleshooting Quick Reference

| Symptom                                      | Cause                                      | Fix                                                                                 |
| -------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `claude mcp list` missing this server or ✘   | Not registered / dist missing              | Section 1, steps 1 and 2                                                            |
| Tool reports `No Chrome extension connected` | Chrome closed / port mismatch / token mismatch | Section 1, step 3's three items                                                     |
| Tool reports `RPC ... timed out`             | Service worker dormant / just reloaded     | Wake the extension, then retry                                                      |
| Startup fatal: port conflict                 | 8787/8788 occupied                         | `lsof -nP -iTCP:<port>` to find the holder; kill it or change the port on both ends |
| Source changes not taking effect             | tsc watch doesn't hot-restart              | `/mcp` reconnect or restart the session                                             |

## 6. Repository Context

- Architecture, design trade-offs, and the message protocol: see root `CLAUDE.md` (features 1/2/3).
- MCP source: `packages/mcp/src/` (`index.ts` tool definitions, `bridge.ts` WS bridge and error
  messages). Frame protocol and port constants 8787/8788 live in `packages/protocol/src/`
  (`@manta-action-kit/protocol`); `packages/mcp/src/protocol.ts` is just a re-export.
- Extension source: `packages/extension/` (`lib/gateway/` gateway, `lib/action/` action types and
  replay engine, `lib/mcp/handlers.ts` per-tool toggles, `components/action/` action tab UI).
