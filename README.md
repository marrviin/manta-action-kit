# Manta Action Kit

Give AI agents (Claude Code, Codex, …) secure access to your real, logged-in
APIs — without ever handing over your credentials. You record a business API
flow once in your browser; your agent then reads the flow and calls those
endpoints through a controlled sandbox proxy, while your cookies and tokens stay
locked inside the browser.

A pnpm **monorepo** with two packages:

- **`packages/extension`** — the Chrome extension (Manifest V3), the main
  implementation.
- **`packages/mcp`** — [`@manta-action-kit/mcp`](packages/mcp/README.md), the
  MCP server that bridges an agent to the extension over a local WebSocket.

## Stack

- **[WXT](https://wxt.dev)** — file-based MV3 framework, auto-generates the
  manifest, type-safe storage & messaging.
- **React 19 + TypeScript**
- **[Ant Design v6](https://ant.design)** — native React 19 support (no compat
  patch). Wrapped in `components/app-providers.tsx`; theme driven by
  `settings.theme`.
- **Tailwind CSS v4** — layout utilities only; **preflight disabled** so it
  doesn't fight antd.
- **i18n** — react-i18next (en / zh-CN); agent-facing copy is fixed English.

## Features

### 1. API recording (录制)

- **Popup** — one-click start/stop recording of the current tab's API calls,
  with a live captured count.
- **Side panel** — recording management: list (rename / delete) and a detail
  view showing the call chain as a vertical timeline (expand each node for its
  request/response) plus an aggregated **endpoint contract** view.
- Capture: a MAIN-world script hooks the page's `fetch`/`XHR` (no debugger
  banner). SSE (`text/event-stream`) is captured incrementally via `body.tee()`.
- Storage: IndexedDB (database `manta-action-kit`).

### 2. MCP service — let an agent read recordings

There is no MCP master switch: the extension background dials into the local MCP
server (`packages/mcp`) as a **WebSocket client** (an MV3 service worker can't
listen on a port, so the socket direction is inverted). The server speaks MCP
over **stdio** to the agent and runs the WS server the extension connects to.
The loopback bridge is **mutually authenticated** with a token-based
challenge-response (`MANTA_TOKEN` from the extension's install prompt; the
token never crosses the wire). Tools include the recording readers
(`list_recordings` / `get_recording` / `get_call` / `get_endpoints` /
`get_flow`) and the **actions** toolset (create, update, and execute reusable,
parameterized flows distilled from a recording).

### 3. Sandbox proxy — let an agent call authenticated APIs

The reverse direction: a `proxy_fetch` tool takes only `method/url/headers/body`
(**no credentials**). The extension injects the user's browser cookies at
forward time via `chrome.cookies` + a short-lived `declarativeNetRequest`
session rule — so **cookies never reach the AI**. Guards: a per-tool kill
switch, an extension-side human-in-the-loop confirmation popup (covers both the
agent path and the script-driven path, independent of MCP client behavior), and
an audit log (cookie **names** logged, values never). See
[`packages/mcp/README.md`](packages/mcp/README.md) and `lib/gateway/`.

## Prerequisites

- Node ≥ 20 (developed on Node 24)
- pnpm ≥ 9 (developed on pnpm 11)

## Getting started

```bash
pnpm install          # installs deps + runs `wxt prepare`
pnpm dev              # start dev server with HMR (Chrome)
pnpm dev:firefox      # dev for Firefox
```

`pnpm dev` launches a browser with the extension auto-loaded. Popup/side panel
get full HMR; content scripts & background auto-reload.

## Build, test & package

```bash
pnpm build            # production build -> packages/extension/.output/chrome-mv3/
pnpm build:firefox    # -> .output/firefox-mv2/
pnpm zip              # zipped, store-ready package
pnpm compile          # type-check the whole workspace (tsc --noEmit)
pnpm test             # run the unit suite (vitest)
pnpm build:mcp        # build the MCP server -> packages/mcp/dist/
pnpm start:mcp        # run the MCP server (stdio + local WS bridge)
```

To load an unpacked build manually: open `chrome://extensions`, enable Developer
mode, "Load unpacked", select `packages/extension/.output/chrome-mv3/`.

Tests cover the pure, security-critical modules — proxy-rule resolution
(origin-escape prevention), schema inference, example redaction (credential
masking), SSE parsing, endpoint aggregation, and the WS bridge handshake auth
(cross-checked against the server's node:crypto implementation). See
`lib/**/*.test.ts`.

## Project structure

```
packages/
├─ extension/     # Chrome extension (below)
└─ mcp/           # MCP server: bridges an agent to the extension over local WS

packages/extension/
├─ entrypoints/
│  ├─ background.ts          # MV3 service worker: message hub, recording session, gateway
│  ├─ injected-api-hook.ts   # MAIN-world script: patches fetch/XHR to capture calls
│  ├─ popup/ · sidepanel/    # React UIs (recording controls; management)
│  └─ content/               # content script: injects the hook, relays captures
├─ components/               # app-providers, settings, recording/ and gateway/ panels
├─ lib/
│  ├─ db.ts                  # IndexedDB wrapper
│  ├─ storage.ts             # reactive storage items (WXT storage API)
│  ├─ messaging.ts           # typed cross-context message protocol
│  ├─ sse-parse.ts           # pure SSE parser (shared by hook + gateway)
│  ├─ gateway/               # sandbox proxy: cookie injection, proxy-rule routing, audit
│  ├─ mcp/                   # MCP protocol + RPC handlers (extension side)
│  ├─ i18n/                  # react-i18next catalog (en / zh-CN)
│  └─ recording/             # domain types, session state machine, aggregation
├─ assets/tailwind.css       # Tailwind entry + @theme tokens
├─ public/icon/              # extension icons (replace placeholders before release)
└─ wxt.config.ts             # manifest, permissions, Tailwind plugin
```

## Key conventions

- **Adding an entrypoint:** create a file/folder under `entrypoints/`; WXT wires
  the manifest — no manual manifest edits.
- **Permissions** (`wxt.config.ts`): `storage`, `sidePanel`, `scripting`,
  `tabs`, `cookies`, `declarativeNetRequestWithHostAccess`, `alarms`, plus
  `host_permissions: ['<all_urls>']` (hook injection + cookie forwarding).
- **Storage:** structured prefs/toggles → `lib/storage.ts` items (reactive,
  cross-context); bulk recording data → IndexedDB (`lib/db.ts`).
- **Domain types:** the single source of truth is `lib/recording/types.ts`.
- **MAIN-world injection:** `injected-api-hook.ts` is injected by the content
  script; it's registered in `web_accessible_resources` and may only import pure
  types/constants (no extension APIs).
- **Path alias:** `@/` maps to the extension package root.
- **File naming:** lowercase kebab-case for files; components stay PascalCase,
  hooks camelCase.

## Notes

- Capture covers **fetch/XHR** only (WebSocket / sendBeacon / worker requests are
  out of scope). Native `EventSource` is not intercepted; SSE-over-fetch is.
- `pnpm-workspace.yaml` pins which native build scripts pnpm may run and disables
  pnpm 11's redundant pre-run deps check.

## License

MIT — see [LICENSE](LICENSE).
