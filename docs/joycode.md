# Manta Action Kit on JoyCode

**English** | [中文](joycode.zh-CN.md)

How to install and use Manta Action Kit inside
[JoyCode](https://joycode.com) (an agentic IDE with a built-in MCP client).

JoyCode is an MCP client like Claude Code or WorkBuddy: it launches the same
`@manta-action-kit/mcp` server over stdio and talks to the same loopback
bridge, so every tool and safety property described in
[`packages/mcp/README.md`](../packages/mcp/README.md) applies unchanged. Only
two things are JoyCode-specific:

1. JoyCode reads its MCP servers from **`~/.joycode/joycode-mcp.json`**
   (edit it by hand — there is no CLI like `claude mcp add`).
2. Registration is **enough** — like Claude Code, no extra "trust" step. Save
   the file, restart JoyCode (or start a new session), and the tools appear.

> The filename is `joycode-mcp.json` — note there is no leading dot, and it
> is not `mcp.json`. A config in the wrong path is silently ignored.

## Prerequisites

- **Chrome** with the Manta Action Kit extension installed and logged into the
  site you want to record on.
- **Node.js ≥ 18** on your PATH (the server runs through `npx`).
- **JoyCode** desktop app.

## Step 1 — Install the extension and copy your bridge token

Same as any other client: click the extension's toolbar icon → _Open side
panel_ → **Action** tab → **Copy install prompt**. That prompt embeds your
personal `MANTA_TOKEN` and the current bridge ports. Keep it handy for step 2.

## Step 2 — Register the MCP server

Open `~/.joycode/joycode-mcp.json` and **merge** this into the existing
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
      },
      "disabled": false
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
      "disabled": false,
    },
  },
}
```

`MANTA_TOKEN` must match the extension (it is the handshake secret);
`MANTA_WS_PORT` (default 8787) must match the MCP port in the extension's
settings. You can omit the port variables if you keep the defaults.

**Sharing ports with other clients is fine.** JoyCode and Claude Code can both
register this server at once — each MCP process races for port 8787, the winner
becomes the **owner** (hosts the bridge + proxy) and the loser degrades to a
**peer** that forwards tool calls to the owner. When the owner exits, a peer
re-elects itself and takes over; no manual restart. The `health` tool reports
which role you got.

## Step 3 — Verify

Save the file, restart JoyCode (or open a new session) so it picks up the
server, then ask the agent:

> _"Search your MCP tools for manta-action-kit and run the `health` tool."_

JoyCode's agent discovers connected MCP tools on demand, so that request is
also the quickest way to confirm the server started. If `health` reports the
bridge and extension are up, the chain works. Read-only tools such as
`list_recordings` verify the rest — an empty list still means everything is
wired (nothing recorded yet).

## Step 4 — (Optional) install the agent skill

The skill is a usage guide the agent loads on demand, so phrases like
_"check environment"_, _"can't connect"_, or _"what actions do I have"_ resolve
without you explaining the toolkit. It is optional — the MCP server is what
the agent strictly needs.

JoyCode discovers user skills in `~/.joycode/skills/` (all projects) and
project skills in `<workspace>/.joycode/skills/` (that workspace only). The
easiest install is `npx skills add marrviin/manta-action-kit -y` (pick JoyCode
and a scope when prompted); or copy `packages/skills/manta-action-kit/` into
the skills directory manually.

> `scripts/check-env.mjs` needs **Node ≥ 18**. It detects whether it runs inside
> the repo checkout: in a copy installed outside this checkout it skips the
> "build output" item (the server runs from the published npx package), and it
> probes JoyCode's `~/.joycode/joycode-mcp.json` for the registration itself.

## Step 5 — Use it

Record a flow on your site, register the server once, then just talk to the
JoyCode agent:

> _"I just recorded the meeting-room booking flow. Turn it into an action and
> book room A for tomorrow 10am."_

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
| No `manta-*` tools in the conversation         | Config edited while the session was already running        | Restart JoyCode or open a new session                                                     |
| Still nothing after restarting                 | Config landed in the wrong file (`mcp.json`, `.mcp.json`)  | Use `~/.joycode/joycode-mcp.json`                                                         |
| _All_ MCP tools missing, not just ours         | JSON syntax error broke the whole config                   | Validate the file (`node -e "JSON.parse(require('fs').readFileSync(...))"`)               |
| `No authenticated Chrome extension connected`  | Chrome closed / extension not loaded / port or token drift | Open Chrome with the extension, confirm the port matches 8787, re-copy the install prompt |
| `MCP bridge has no MANTA_TOKEN configured`     | The `env` block is missing the token                       | Re-copy the install prompt and update `env.MANTA_TOKEN`                                   |
| `RPC "…" timed out`                            | Extension service worker went dormant / just reloaded      | Click the extension's side panel once to wake it, then retry                              |
| Tools work in Claude Code but the port is busy | Another client owns 8787                                   | Expected — JoyCode runs as a peer. Check `health` for the reported role                   |

## Differences from Claude Code / WorkBuddy, at a glance

| Concern         | Claude Code                                       | WorkBuddy                                                  | JoyCode                                                    |
| --------------- | ------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| MCP config path | `~/.claude.json` / `.mcp.json` / `claude mcp add` | `~/.workbuddy/mcp.json`                                    | `~/.joycode/joycode-mcp.json`                              |
| Activation      | Registration is enough                            | Registration **+ trust** in the connector UI               | Registration + session restart                             |
| Skill directory | `~/.claude/skills/`                               | `~/.workbuddy/skills/` or `<workspace>/.workbuddy/skills/` | `~/.joycode/skills/` or `<workspace>/.joycode/skills/`     |
| List servers    | `claude mcp list`                                 | The connector management page                              | Ask the agent to search MCP tools, or read the config file |
