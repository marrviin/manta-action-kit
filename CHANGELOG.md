# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-24

### Added

#### Screenshots (visible area / full page)

- Capture from the popup: visible viewport via `captureVisibleTab`, or the full
  scrollable page via a one-shot `chrome.debugger` attach + CDP
  `Page.captureScreenshot` (`captureBeyondViewport`) — single render, no
  scrolling, no DOM changes, matching DevTools' "Capture full size screenshot".
  Oversized pages (content × DPR beyond Chromium's 16384px surface cap) fall
  back to `clip + scale: 1` instead of failing.
- Captures are handed to a preview tab (`preview.html`) for copy / download —
  nothing is saved automatically; the payload travels over `chrome.storage.session`
  (size-guarded, released as soon as the preview reads it).
- Errors surface as stable machine codes mapped to localized copy:
  unsupported page, DevTools debugger conflict, preview-too-large, capture failed.

#### GIF recording

- Record the active tab as an animated preview from the popup (start / pause /
  stop): the streamId is minted inside the popup's user gesture, the recorder
  (MediaRecorder, VP8 software-encode preferred to dodge the hardware-encoder
  corruption crbug) lives in an **offscreen document** so recordings survive
  MV3 service-worker sleep — no keepalive pings.
- The WebM draft is persisted to IndexedDB; the visible preview tab transcodes
  it to GIF on demand (gifenc: seek-based frame sampling, one global palette
  from a mosaic pass, 8×8 Bayer dithering) and offers MP4 download via mediabunny.
- Robustness: 5-minute recording cap (auto-save + system notification),
  bounded seeks (no infinite spinner on a damaged draft), race-free start/stop
  (double-click safe; track-ended vs. manual stop can't double-report), and a
  reconcile alarm that clears a stuck "recording" state if Chrome reclaims the
  offscreen document.

### Changed

- `minimum_chrome_version` is now **116** (required by
  `runtime.getContexts` / `tabCapture.getMediaStreamId`).
- Screenshot mode selection persists across sessions.

### Permissions

- New: `debugger` (full-page screenshot only, one-shot attach + single CDP
  screenshot call, immediate detach), `tabCapture` (one tab's video, user-click
  initiated, no audio), `offscreen` (hosts the invisible GIF recorder document,
  exists only while a recording is active). Justifications are documented in
  `packages/extension/store-listing.md`.

## [0.2.0] - 2026-09-19

> ⚠️ **Protocol change — the extension and the MCP server must be updated together.**
> After updating the extension, re-copy the install prompt (Action tab → Copy install
> prompt) and update your MCP config env so `MANTA_TOKEN` matches.

### Added

#### Actions toolset

- `list_actions` / `get_action` / `search_actions` / `create_action` /
  `update_action` / `delete_action` / `execute_action` — reusable, parameterized
  API flows distilled from a recording and replayed through the sandbox gateway.

#### WS bridge handshake authentication

- Mutual challenge-response between the extension and the local MCP server
  (`hello{nonce}` → `welcome{proof}` → `auth{proof}`; HMAC-SHA256 over
  domain-separated nonces). The shared token never crosses the wire.
- The token is generated once by the extension (`settings.mcpAuthToken`) and
  injected into the install prompt as the `MANTA_TOKEN` env.
- Web-origin guard: connections with an http/https `Origin` header are rejected
  outright (defends against web pages dialing `ws://127.0.0.1`).
- New connection status `unauthorized` (token mismatch → "Auth failed" in the
  extension's MCP tab) with a fix path: re-copy the install prompt.

### Security

- **Fail closed**: the server rejects every client when `MANTA_TOKEN` is unset;
  unauthenticated sockets cannot send or receive any business frame on either
  side. This closes port-spoofing in both directions (a local process or web
  page impersonating the extension, and a port squatter impersonating the
  server).

### Changed

- `check-env.mjs` performs a full authenticated probe and requires `MANTA_TOKEN`;
  stale troubleshooting copy (references to the removed "MCP service" toggle)
  updated across `SKILL.md`, `CLAUDE.md`, and both READMEs.

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
