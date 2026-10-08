# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.2] - 2026-10-08

### Fixed

#### Lint: satisfy the React Compiler rules (CI green again)

- `recording-detail` read `Date.now()` during render to decide whether a
  persisted `analyzing` status had gone stale. Rendering is now pure: a 1s
  tick driven from an effect supplies the clock, and the first tick stays
  optimistic so the banner cannot flash "failed" for a frame.
- `laya-card` wrote the latest-ref (`loadRef.current = load`) during render;
  the write moved into an effect.
- ESLint config: ignore the vendored ONNX Runtime wasm loader
  (`public/ort/**`) and generated coverage output; give the website's plain
  JS browser globals; fix two empty `catch` blocks in `site.js`.

### Changed

#### Release pipeline: protocol is now published to npm

- `@manta-action-kit/mcp` depends on `@manta-action-kit/protocol`, but npm
  publish left the `workspace:*` literal unresolved in the published manifest
  (and protocol was never published), so `mcp@0.2.0` was uninstallable. The
  release workflow now publishes protocol first and packs mcp with pnpm (which
  resolves `workspace:*` to the real version) before publishing with npm OIDC.
  `protocol@0.4.1` is the first published version.

#### Git hooks keep verification local

- `simple-git-hooks` + `lint-staged`: pre-commit runs `eslint --fix` +
  prettier on staged files; pre-push runs `pnpm compile && pnpm test`.
  Activate after a fresh clone with `pnpm hooks`.

## [0.4.1] - 2026-10-08

### Fixed

#### Relevance verdicts: unconfident noise roles no longer lower the bar

- The relevance pass marks a call `irrelevant` when the model's noise
  probability clears a threshold. A `telemetry` / `polling_heartbeat` /
  `preflight_static` role lowered that threshold from 0.7 to 0.5 — and the role
  head often picks those roles at near-chance confidence (0.2–0.4) on clean
  business chains, which mass-mislabelled business calls as "irrelevant" on
  single-host sites. The lowered bar now applies only when the role head's own
  confidence is ≥ 0.5; an unsure role falls back to the base 0.7 bar.
- Form-encoded request bodies (a `body=%7B…%7D`-style percent-encoded JSON
  envelope) are decoded one level before being shown to the model, so payload
  fields stay readable instead of hiding the request parameters that align a
  call with the user's action. JSON bodies pass through untouched.
- The preceding-interaction lookback window is widened from 2 s to 5 s: a
  navigation click routinely settles into a burst of page-load calls 1.5–3 s
  later, and the tight window stripped the causal hint from exactly those
  calls, nudging the model towards "no interaction = noise".

## [0.4.0] - 2026-10-08

### Added

#### User-interaction capture feeds the relevance verdict

- Recording now captures the human side of the flow: clicks, form submissions
  and committed field changes, relayed with the element's text, container
  semantics and name/value, redacted at capture time (password fields never
  recorded; 4–8 digit values such as OTP codes masked).
- At stop, each captured call is attached its most likely preceding
  interaction, shown as timeline marks in the detail view and exposed to the
  agent as `precedingInteraction` on `get_flow` steps and as a `user-action:`
  line in the relevance model's per-call state.

#### Laya decision-model marks with graceful degradation

- The relevance analysis runs four passes in order, each degrading
  independently: stats-only field dynamism (no model needed), dep-confidence
  on inferred dependency edges, the headline relevance verdict, and
  model-based dynamism for single-observation fields.
- Dep-confidence re-judges each inferred dependency edge as `likely` /
  `unlikely` / `uncertain`; surfaced in the UI and on `get_flow` /
  `get_endpoints`. A failed pass simply leaves its marks absent, which every
  consumer reads as _unanalyzed_.
- Field-dynamism leaves carry `verdict` (`varies` / `stable` / `uncertain`),
  `confidence`, and a `source` (`stats` or `model`).

#### Screenshot page-type policy relaxed, CDP fallback

- Full-page screenshots keep the `debugger`-based CDP fallback for pages
  taller than the viewport; the page-type policy deciding when to attach is
  relaxed, and protected pages degrade gracefully with a notification.

#### Element capture: preview tab & history comparison

- Every capture opens a preview tab (`preview.html?mode=element&id=…`): the
  element tree is rebuilt inside a Shadow DOM with its capture-time computed
  styles inlined (pseudo-elements re-attached via generated rules), so the
  snapshot renders exactly as it did on the page.
- The preview toolbar copies four flavors: rebuilt HTML (pseudo-element rules
  included), lean JSON (same as the capture clipboard), full JSON, and an
  agent-ready prompt wrapping the HTML.
- Captures are kept as a bounded history (last 20, oldest evicted) in IndexedDB.
  The preview's _Compare_ dropdown lists the other records and opens a
  side-by-side diff for any pair: both snapshots rebuilt in parallel panes,
  property-level differences below as collapsible cards (hover a card to
  spotlight the node in both panes), and a git-style delta on each pane's
  title bar (red `−` removed in A, green `+` added in B, blue `~` modified).
- Diff results are recomputed on load — never stored — and diff pages are
  addressed by URL (`preview.html?mode=diff&a=…&b=…`), so refreshing restores
  the same comparison. The toolbar copies the diff as a report or JSON, and
  _Back_ returns to the preview the comparison was launched from.

#### Page capture history (side panel tab)

- New side panel tab **Page capture** with a bottom segmented bar (Elements /
  Screenshots / Recordings) aggregating the histories of the three capture
  flows: open any record's preview tab by id, or delete it inline.
- Screenshots now keep a persistent history (last 20, oldest evicted) instead
  of the one-shot session handoff; the preview URL is id-addressed
  (`preview.html?mode=screenshot&id=…`) with the session channel kept as a
  fallback.
- GIF recordings keep a history too (last 10, oldest evicted): each recording
  gets a uuid that is threaded through the offscreen-done message to the
  id-addressed preview URL (`preview.html?mode=gif&id=…`).

#### Element capture: shadow DOM support

- Capture now descends into open and closed shadow roots (via
  `chrome.dom.openOrClosedShadowRoot`): hit-testing, subtree description,
  box-select collection and the nesting pass all traverse the composed tree,
  so elements inside micro-frontend shadow hosts are captured like any other.

#### Element capture MCP tools (read-only)

- `list_element_captures` — summaries of saved snapshots (page, title,
  capturedAt, element count).
- `get_element_capture` — one capture's full element tree with computed
  styles, an LLM-ready description of how the element is built.
- `diff_element_captures` — diff two snapshots and return a text report of
  property-level changes per DOM path, plus an `identical` flag.

### Changed

#### Decision-model weights download instead of shipping in the package

- The Laya model weights (~800 MB) are no longer bundled in the extension.
  They are fetched once from Hugging Face (`marrviin/laya-en-fp16`) into the
  browser's local CacheStorage — on install/upgrade (preload) or lazily on
  first use — and every analysis still runs on-device. Model data only; no
  scripts are fetched remotely and no page data is sent in that request.

### Removed

#### Replay feature (removed after 0.1.0; retroactively documented here)

- The standalone replay feature (`lib/recording/replay.ts`,
  `lib/recording/replay-runs.ts`, the `components/recording/replay-*` UI and
  `hooks/use-replay-*` hooks) has been fully removed from the codebase,
  superseded by parameterized **Actions** (`create_action` / `execute_action`),
  which replay flows through the sandbox gateway.
- The `replayRuns` IndexedDB store was deleted in the v9 schema upgrade, along
  with the `REPLAY_*` message types, `ReplayRun`/`ReplayResult` types, and the
  `replayProgress` storage item.

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
