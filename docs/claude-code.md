# Manta Action Kit on Claude Code

**English** | [中文](claude-code.zh-CN.md)

How to install and use Manta Action Kit inside
[Claude Code](https://claude.com/claude-code).

Claude Code is the reference MCP client for this toolkit: it launches the same
`@manta-action-kit/mcp` server over stdio and talks to the same loopback
bridge, so every tool and safety property described in
[`packages/mcp/README.md`](../packages/mcp/README.md) applies unchanged. Only
two things are Claude Code–specific:

1. The server is registered with the **`claude mcp add`** CLI (or an
   `.mcp.json` at the project root) instead of a hand-edited config file.
2. Registration is **enough** — unlike WorkBuddy there is no extra "trust"
   step in a UI. New tools appear after a session restart or `/mcp` reconnect.

## Prerequisites

- **Chrome** with the Manta Action Kit extension installed and logged into the
  site you want to record on.
- **Node.js ≥ 18** on your PATH (the server runs through `npx`).
- **Claude Code** CLI.

## Step 1 — Install the extension and copy your bridge token

Same as any other client: click the extension's toolbar icon → _Open side
panel_ → **Action** tab → **Copy install prompt**. That prompt embeds your
personal `MANTA_TOKEN` and the current bridge ports. Keep it handy for step 2.
Can't see the toolbar icon? Chrome tucks new extensions behind the
puzzle-piece menu next to the address bar — open it and pin Manta Action Kit.

## Step 2 — Register the MCP server

The easiest path: paste the install prompt from step 1 into Claude Code —
it lists the server's name/command/args/env, and Claude Code registers it
into its own config for you.

Or run it manually. **Production** (published package):

```bash
claude mcp add manta-action-kit \
  --env MANTA_TOKEN=<token from the extension> \
  -- npx -y @manta-action-kit/mcp
```

**Development** (local checkout — build first with `pnpm build:mcp`):

```bash
claude mcp add manta-action-kit \
  --env MANTA_TOKEN=<token from the extension> \
  -- node "$(pwd)/packages/mcp/dist/index.js"
```

`MANTA_TOKEN` must match the extension (it is the handshake secret);
`MANTA_WS_PORT` (default 8787) must match the MCP port in the extension's
settings. The proxy port (`MANTA_PROXY_PORT`, default 8788) likewise only
needs setting if you changed it from the default. Omit the port variables if
you keep the defaults.

**Pick the right scope.** By default `claude mcp add` registers the server as
`local` — available in the current project, stored in `~/.claude.json`, and
private to you. Alternatives:

| Scope     | Flag              | Stored in                    | Visible to                     |
| --------- | ----------------- | ---------------------------- | ------------------------------ |
| `local`   | (default)         | `~/.claude.json`             | You, this project only         |
| `project` | `--scope project` | `.mcp.json` in the repo root | Anyone who checks out the repo |
| `user`    | `--scope user`    | `~/.claude.json`             | You, all projects              |

Use `--scope project` to commit the config for your team (each teammate still
substitutes their own `MANTA_TOKEN` — it is personal), or `--scope user` to
have the server available everywhere. You can also edit `~/.claude.json` or
`.mcp.json` directly and **merge** this into the existing `mcpServers` object
(do not replace the file — other servers may already live there). ⚠️ These
files are **strict JSON** — no comments, no trailing commas; the snippet below
is paste-safe:

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

**Sharing ports with other clients is fine.** Claude Code and WorkBuddy can
both register this server at once — each MCP process races for port 8787, the
winner becomes the **owner** (hosts the bridge + proxy) and the loser degrades
to a **peer** that forwards tool calls to the owner. When the owner exits, a
peer re-elects itself and takes over; no manual restart. The `health` tool
reports which role you got.

## Step 3 — Verify

Registration is all it takes — no approval UI. Check that the server starts:

```bash
claude mcp list            # should show manta-action-kit ✔ Connected
claude mcp get manta-action-kit   # shows command, args and the env block
```

Inside a Claude Code session, `/mcp` shows live connection status (use it to
reconnect after changing the config), and the `health` tool reports bridge and
extension status. Tools appear as `mcp__manta-action-kit__<tool>`.

## Step 4 — (Optional) install the agent skill

The skill is a usage guide the agent loads on demand, so phrases like
_"check environment"_, _"can't connect"_, or _"what actions do I have"_ resolve
without you explaining the toolkit. It is optional — the MCP server is what the
agent strictly needs.

```bash
npx skills add marrviin/manta-action-kit -g -a claude-code -y   # global
```

Drop `-g -a claude-code -y` for an interactive install (choose any supported
agent and project/global scope). Update later by re-running the same command,
or `npx skills update -g`. Manual equivalent — Claude Code discovers skills in
`~/.claude/skills/` (all projects) and `<repo>/.claude/skills/` (that repo
only); copy `packages/skills/manta-action-kit/` there.

> `scripts/check-env.mjs` needs **Node ≥ 18**. It detects whether it runs inside
> the repo checkout: in a copy installed outside this checkout it skips the
> "build output" item (the server runs from the published npx package), and it
> probes the `claude` CLI for the registration itself.

## Step 5 — Use it

Record a flow on your site, register the server once, then just talk to
Claude Code:

> _"I just recorded the meeting-room booking flow. Turn it into an action and
> book room A for tomorrow 10am."_

Verify the link is live by asking for the environment check, or simply let the
agent call a read-only tool such as `list_recordings` — an empty list still
means the chain works (nothing recorded yet).

> `list_recordings` returns each recording's metadata **plus** its dependency,
> interaction and field-dynamism marks, so the payload can be large (hundreds of
> KB with a few dozen recordings). If a client truncates it, narrow the request
> — `get_flow` / `get_endpoints` for one recording at a time.

## Prompt → tool cheat sheet

| You say                                                   | Tool                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| "check recordings" / "what have I recorded"               | `list_recordings`                              |
| "show the call chain" / "where do these fields come from" | `get_recording` · `get_flow` · `get_endpoints` |
| "turn this recording into an action" / "make it reusable" | `create_action`                                |
| "run that action" / "replay it"                           | `execute_action`                               |
| "call this API with my login state" / "fetch this for me" | `proxy_fetch` · `proxy_sse`                    |
| "screenshot this page" / "serialize this element"         | `capture_screenshot` · `capture_element`       |

Every `proxy_fetch`, `proxy_sse` and `execute_action` still passes the
extension's own confirmation popup, exactly as in any other client.

## Troubleshooting

The extension's own view of the connection lives in its side panel:
**Settings tab → Connector card**. What it should look like when everything is
fine: a green **Connected** tag plus the MCP server version (a yellow hint
there means the extension and the MCP server versions drifted apart). The
other states you may see: _Connecting_, _Disconnected_ (server not running or
wrong port), and _Auth failed_ (token mismatch — re-copy the install prompt).

| Symptom                                       | Cause                                                                                    | Fix                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `manta-*` tools in the conversation        | Server registered after the session started                                              | Run `/mcp` reconnect, or restart the session                                                                                                            |
| `claude mcp list` shows `✘ Failed to connect` | dist missing (dev build)                                                                 | `pnpm build:mcp`, then retry                                                                                                                            |
| `command not found: npx` / `node`             | Node.js not installed (or not on PATH)                                                   | Install Node ≥ 18 from [nodejs.org](https://nodejs.org), verify with `node -v`, then retry                                                              |
| 8787 bound by an unrelated process            | Port conflict — but this self-heals                                                      | Nothing to do: the server scans up 32 ports and the extension follows within ~20–30 s (watch stderr for `Bridge on ws://127.0.0.1:<port> (fallback …)`) |
| `No authenticated Chrome extension connected` | Chrome closed / extension not loaded / port or token drift                               | Open Chrome with the extension, confirm the port matches 8787, re-copy the install prompt                                                               |
| `MCP bridge has no MANTA_TOKEN configured`    | The `env` block is missing the token                                                     | Re-copy the install prompt, then update with `claude mcp add` again                                                                                     |
| `RPC "…" timed out`                           | Extension service worker went dormant / just reloaded                                    | Click the extension's side panel once to wake it, then retry                                                                                            |
| Call hangs, but no confirmation popup appears | The approval popup is behind another window or folded into Chrome's hidden notifications | Bring Chrome to the front and check the extension for a pending confirmation                                                                            |
| Works in one Chrome profile, dead in another  | The extension (and its logins) live per profile                                          | Run Chrome with the profile that has the extension installed and logged in                                                                              |
| Tools work in WorkBuddy but the port is busy  | Another client owns 8787                                                                 | Expected — this process runs as a peer. Check `health` for the reported role                                                                            |

## Differences from WorkBuddy, at a glance

| Concern         | Claude Code                                       | WorkBuddy                                                  |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| MCP config path | `~/.claude.json` / `.mcp.json` / `claude mcp add` | `~/.workbuddy/mcp.json`                                    |
| Activation      | Registration is enough                            | Registration **+ trust** in the connector UI               |
| Skill directory | `~/.claude/skills/`                               | `~/.workbuddy/skills/` or `<workspace>/.workbuddy/skills/` |
| List servers    | `claude mcp list`                                 | The connector management page                              |
