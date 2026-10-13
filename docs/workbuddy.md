# Manta Action Kit on WorkBuddy

**English** | [中文](workbuddy.zh-CN.md)

How to install and use Manta Action Kit inside
[WorkBuddy](https://www.workbuddy.cn) (Tencent's AI workbench).

WorkBuddy is an MCP client like Claude Code or Codex: it launches the same
`@manta-action-kit/mcp` server over stdio and talks to the same loopback bridge,
so every tool and safety property described in
[`packages/mcp/README.md`](../packages/mcp/README.md) applies unchanged. Only
two things differ:

1. WorkBuddy reads its MCP servers from **`~/.workbuddy/mcp.json`** (global).
2. Adding an entry to that file is **not enough** — a newly added server stays
   inert until you explicitly **trust** it in the connector UI (step 3 below).

> Note the filename: `mcp.json`, **not** `.mcp.json`. Putting the config in the
> dotted path is silently ignored.

## Prerequisites

- **Chrome** with the Manta Action Kit extension installed and logged into the
  site you want to record on.
- **Node.js ≥ 18** on your PATH (the server runs through `npx`).
- **WorkBuddy** desktop app.

## Step 1 — Install the extension and copy your bridge token

Same as any other client: click the extension's toolbar icon → _Open side
panel_ → **Action** tab → **Copy install prompt**. That prompt embeds your
personal `MANTA_TOKEN` and the current bridge ports. Keep it handy for step 2.

## Step 2 — Register the MCP server

Open `~/.workbuddy/mcp.json` and **merge** this into the existing
`mcpServers` object (do not replace the file — other servers may already live
there):

```json
{
  "mcpServers": {
    "manta-action-kit": {
      "type": "stdio",
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

Running from a local checkout instead of the published package:

```jsonc
{
  "mcpServers": {
    "manta-action-kit": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/manta-action-kit/packages/mcp/dist/index.js"],
      "env": {
        "MANTA_WS_PORT": "8787",
        "MANTA_PROXY_PORT": "8788",
        "MANTA_TOKEN": "<from the extension>",
      },
    },
  },
}
```

`MANTA_TOKEN` must match the extension (it is the handshake secret);
`MANTA_WS_PORT` (default 8787) must match the MCP port in the extension's
settings. You can omit the port variables if you keep the defaults.

**Sharing ports with other clients is fine.** WorkBuddy and Claude Code can
both register this server at once — each MCP process races for port 8787, the
winner becomes the **owner** (hosts the bridge + proxy) and the loser degrades to
a **peer** that forwards tool calls to the owner. When the owner exits, a peer
re-elects itself and takes over; no manual restart. The `health` tool reports
which role you got.

## Step 3 — Trust the server (required, easy to miss)

Editing the JSON only declares the server. WorkBuddy will not start the process
or expose any tool until you approve it:

1. Open the **connector management** page in WorkBuddy.
2. Click the **custom connectors** entry at the **top right** of that page.
3. Find `manta-action-kit` in the list and click **Trust**.

WorkBuddy records the approval in `~/.workbuddy/mcp-approvals.json`, launches
the server, and its tools become available in the conversation (as
`mcp__manta-action-kit__<tool>`).

If you later edit the command, args, or env of the entry, expect to re-trust or
start a fresh session before the change takes effect.

## Step 4 — (Optional) install the agent skill

The skill is a usage guide the agent loads on demand, so phrases like
_"check environment"_, _"can't connect"_, or _"what actions do I have"_ resolve
without you explaining the toolkit. It is optional — the MCP server is what the
agent strictly needs.

WorkBuddy discovers personal skills in `~/.workbuddy/skills/` (all projects) and
project skills in `<workspace>/.workbuddy/skills/` (that workspace only):

```bash
npx skills add marrviin/manta-action-kit -y   # interactive: pick WorkBuddy + scope
```

> `scripts/check-env.mjs` needs **Node ≥ 18**. It detects whether it runs inside
> the repo checkout: in a copy installed outside this checkout it skips the
> "build output" item (the server runs from the published npx package) and
> probes WorkBuddy's `~/.workbuddy/mcp.json` for the registration itself.

## Step 5 — Use it

Record a flow on your site, trust the server once, then just talk to
WorkBuddy:

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

| Symptom                                        | Cause                                                      | Fix                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No `manta-*` tools in the conversation at all  | Server written into the config but never trusted           | Step 3 — trust it from the custom-connectors entry                                        |
| Still nothing after trusting                   | Config landed in `~/.workbuddy/.mcp.json` (dotted)         | Use `~/.workbuddy/mcp.json`                                                               |
| `No authenticated Chrome extension connected`  | Chrome closed / extension not loaded / port or token drift | Open Chrome with the extension, confirm the port matches 8787, re-copy the install prompt |
| `MCP bridge has no MANTA_TOKEN configured`     | The `env` block is missing the token                       | Re-copy the install prompt and update `env.MANTA_TOKEN`                                   |
| `RPC "…" timed out`                            | Extension service worker went dormant / just reloaded      | Click the extension's side panel once to wake it, then retry                              |
| Tools work in Claude Code but the port is busy | Another client owns 8787                                   | Expected — WorkBuddy runs as a peer. Check `health` for the reported role                 |

## Differences from Claude Code, at a glance

| Concern         | Claude Code                                       | WorkBuddy                                                  |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| MCP config path | `~/.claude.json` / `.mcp.json` / `claude mcp add` | `~/.workbuddy/mcp.json`                                    |
| Activation      | Registration is enough                            | Registration **+ trust** in the connector UI               |
| Skill directory | `~/.claude/skills/`                               | `~/.workbuddy/skills/` or `<workspace>/.workbuddy/skills/` |
| List servers    | `claude mcp list`                                 | The connector management page                              |
