# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-03

Initial release of the Manta Action Kit monorepo (`packages/extension` +
`packages/mcp`).

### Added

#### API recording

- One-click start/stop recording of a tab's API calls from the popup, with a
  live captured count.
- Capture via a MAIN-world script that hooks the page's `fetch`/`XHR` (no
  debugger banner); SSE (`text/event-stream`) responses captured incrementally
  via `body.tee()`.
- Side-panel management: recording list (rename / delete) and a detail view
  with a vertical call-chain timeline plus an aggregated endpoint contract view.
- Storage in IndexedDB.

#### MCP service

- MCP server (`packages/mcp`) bridging an agent to the extension over a local
  WebSocket (the extension dials in as a client; the server speaks MCP over
  stdio to the agent).
- Read tools: `list_recordings`, `get_recording`, `get_call`, `get_endpoints`,
  `get_flow`, and `set_recording_description`, including endpoint-flow
  dependency inference and contract aggregation.

#### Sandbox proxy

- `proxy_fetch` tool that takes only `method/url/headers/body` (no credentials);
  the extension injects the user's browser cookies at forward time via
  `chrome.cookies` + a short-lived `declarativeNetRequest` session rule, so
  cookies never reach the AI.
- Human-in-the-loop confirmation, a per-tool kill switch, and an audit log
  (cookie names logged, values never).

#### Internationalization

- react-i18next catalog (en / zh-CN); agent-facing copy is fixed English.

### Changed

- Replay is retained in the codebase but hidden from the UI; MCP is the default
  and preferred side-panel tab.
- Unified branding to "Manta Action Kit" and the MCP package to
  `manta-action-kit-mcp`.
