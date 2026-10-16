# manta-action-kit — Development & Repo Guide

Everything in this file applies **only when working inside the manta-action-kit repo checkout**.
If this skill is installed into another project, the MCP server runs from the published package
(`npx @manta-action-kit/mcp`) and none of the build steps here are relevant. The repo root
`CLAUDE.md` documents architecture, design trade-offs, and the message protocol (features 1/2/3).

## 1. Build from source (repo-checkout setup)

Run in order; the first two steps are repo builds, the rest are user-side actions:

1. `pnpm install && pnpm build && pnpm build:mcp` (extension output lands in
   `packages/extension/.output/chrome-mv3/`, MCP output in `packages/mcp/dist/`).
2. Register the MCP server pointing at the local dist:
   `claude mcp add manta-action-kit --scope local --env MANTA_TOKEN=<from the extension's install prompt, Action tab → Copy install prompt> -- node "$(pwd)/packages/mcp/dist/index.js"`
3. Guide the user: Chrome → `chrome://extensions` → developer mode → Load unpacked → select
   `packages/extension/.output/chrome-mv3/`.
4. No toggle to flip — the extension dials in automatically once Chrome is running with it
   loaded; just confirm the extension's MCP port matches the server port (default 8787).
5. Run the environment check (SKILL.md section 2) to confirm the chain works.

## 2. Debugging Workflow (when modifying `packages/mcp` source)

- `pnpm dev:mcp` — tsc --watch compiling dist live. **It does NOT hot-restart a running MCP
  process**: after changing code, have the user `/mcp` reconnect that server, or restart the
  session.
- `pnpm start:mcp` — run it once manually to inspect startup logs (stdio + WS bridge).
- Extension side: `pnpm dev` to load the dev build; after changing extension code you may
  occasionally need to click refresh ↻ on `chrome://extensions`.

## 3. Wire-compat checklist (when changing RPC params/results or tool semantics)

The extension and the MCP server ship on ONE version number (`pnpm version:minor` / `version:patch`,
synced across packages) but are INSTALLED independently — the extension auto-updates through
Chrome, the server only when the user's MCP config re-runs. A version skew degrades silently, so:

1. **Sync the tool-description copies**: update `packages/mcp/src/index.ts`, then re-run
   `pnpm --filter @manta-action-kit/mcp contract:export` to refresh
   `packages/mcp/tests/fixtures/tool-contract.json`.
   The skill must stay in sync too: `pnpm sync:skill` fails if a registered tool is missing from
   SKILL.md or SKILL.md references a tool that no longer exists.
2. **New RPC params must degrade safely on an older extension** (which ignores unknown params):
   verify the old behavior is a no-op or a clear error, and note the requirement in the tool
   description. New result fields/enums (e.g. a new `endReason`) must not be assumed present by
   older readers.
3. **Version-sensitive behavior gets a sentinel**: if a new param changes what result shape to
   expect (e.g. `continueOnError`), add the version-skew warning at the suspicious result (see
   `packages/mcp/src/compat.ts` and the `execute_action` handler) so the skew is diagnosable.
4. **Version probes**: `WelcomeFrame.version` (server→client) and the `extension_info` RPC
   (extension version) feed the `health` tool, the extension settings page, and `check-env.mjs` —
   keep those consistent when touching the handshake.

## 4. Repository Context

- MCP source: `packages/mcp/src/` (`index.ts` tool definitions, `bridge.ts` WS bridge and error
  messages). Frame protocol and port constants 8787/8788 live in `packages/protocol/src/`
  (`@manta-action-kit/protocol`); `packages/mcp/src/protocol.ts` is just a re-export.
- Extension source: `packages/extension/` (`lib/gateway/` gateway, `lib/action/` action types and
  replay engine, `lib/mcp/handlers.ts` per-tool toggles, `components/action/` action tab UI).
- The agent skill package: `packages/skills/` (this skill; `.claude/skills/manta-action-kit` at
  the repo root is a symlink to it so Claude Code discovers it locally).
