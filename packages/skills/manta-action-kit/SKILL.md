---
name: manta-action-kit
description: Usage guide for the manta-action-kit suite (Chrome extension + MCP server): environment checks and initialization, extension/MCP/connection troubleshooting, recording APIs, and action management — creating actions from recordings, searching and executing actions, cookie-injecting proxy forwarding. Use when the user says "manta", "check recordings", "view call chains", "create an action / turn a recording into an action", "execute an action / run that action", "search actions / what actions are available", "call the API with my login state", "proxy_fetch", "check environment", "initialize environment", "can't connect", etc.
---

# manta-action-kit Suite Usage Guide

The suite consists of two parts; see the repo root `CLAUDE.md` for how they collaborate:

- **Chrome extension** (`packages/extension`): records page API calls (IndexedDB storage); acts as
  the MCP bridge (an MV3 service worker can only be a WS client, so it dials out to the local MCP
  process); sandboxed proxy gateway (injects cookies when forwarding — cookies are never exposed to
  the agent).
- **MCP server** (`packages/mcp`, stdio): provides the tools in this file. Tool names carry the
  prefix `mcp__manta-action-kit__`. **"manta" is the user-facing short alias** for it.

## 1. Environment Check (run in order when the user says "check environment / initialize / can't connect / troubleshoot")

**Run the bundled script first (one command covers all checks, printing ✅/❌ per item with fix suggestions):**

```bash
MANTA_TOKEN=<from the MCP config env> node packages/skills/manta-action-kit/scripts/check-env.mjs
```

The script needs `MANTA_TOKEN` (the handshake secret in the MCP config env — read it from the
config you installed) and performs a full authenticated probe.

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
- ❌ That line missing → register it (from the repo root):

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
  messages, `protocol.ts` frame protocol and port constants 8787/8788).
- Extension source: `packages/extension/` (`lib/gateway/` gateway, `lib/action/` action types and
  replay engine, `lib/mcp/handlers.ts` per-tool toggles, `components/action/` action tab UI).
