# Chrome Web Store Listing

> Backup of the Chrome Web Store listing copy. The manifest only carries `name` /
> `short_name` / `description` (see `wxt.config.ts`); the "detailed description"
> is entered separately in the developer dashboard, not in the manifest.

## Name (display name, manifest `name`, ≤75 chars)

```
Manta Action Kit - AI Developer Toolkit & Agent Browser Bridge
```

## Short name（manifest `short_name`）

```
Manta Action Kit
```

## Short description (manifest `description`, hard limit 132 chars, no line breaks/HTML)

```
Secure access to your authenticated APIs for Claude Code & Codex. Record business flows via a sandbox proxy — cookies stay private.
```

## Detailed description (store dashboard "Detailed description", long text supported)

🔐 Give your AI agents secure access to your real, logged-in APIs — without ever handing over your credentials.

Tools like Claude Code and Codex are great at writing code, but they can't safely call your authenticated business APIs. Manta Action Kit fixes that: you record the real API flow once, then let your agent call those endpoints through a controlled sandbox proxy — while your cookies and tokens stay locked inside your browser.

How it works:
• Record: You actively capture a real business API flow (fetch/XHR) in your browser — requests and responses included.
• Actions: Turn a recording into a reusable, parameterized action your agent can search and replay later — e.g. "track order shipment" with the order ID as a runtime parameter.
• Sandbox Proxy: Your agent sends only method/URL/body. The extension injects your session cookies at the trust boundary and forwards the call, so credentials are NEVER exposed to the AI.
• Stay in control: human-in-the-loop confirmation on every agent call, a per-tool kill switch, an SSRF guard that refuses loopback/private hosts, and a full audit log (cookie names logged, values never) — you decide what the agent can reach.

Built as an AI Developer Toolkit, bridged to your agent over MCP.

(Coming Soon: DOM Simplifier, Authentication State Injector, and more!)

## Permission justification (store dashboard "Privacy practices", item by item)

- **host_permissions `<all_urls>`**: The recording hook must be injected into any
  site the user chooses to record (a MAIN-world script that patches fetch/XHR at
  document_start), and the sandbox proxy forwards agent calls to whatever
  authenticated host the user's recorded flow targets. The set of hosts is
  user-driven and open-ended, so no fixed match list is possible.
- **cookies + declarativeNetRequestWithHostAccess**: Read the user's existing
  session cookies and inject them as a request header at forward time, so the
  agent can call authenticated APIs without ever seeing credentials.
- **notifications**: Purely informational system notifications — a "recording
  saved" nudge when a recording finishes, and an alert that a sandbox request
  is awaiting your confirmation (clicking it just focuses the confirmation
  window). Nothing is collected or transmitted.
- **sidePanel**: Host the management UI (recordings, audit log, proxy rules).
- **storage**: Persist settings and reactive UI state.
- **alarms**: Keep the MCP WebSocket bridge alive across MV3 service-worker sleep.
- **clipboardWrite**: Copy the in-page element-capture result (a JSON snapshot of
  the picked element and its subtree, with source coordinates and styles) to the
  clipboard so you can paste it to your agent. Only written on your explicit
  capture action; nothing is read from the clipboard.
- **debugger**: Full-page screenshot only. A one-shot attach to the tab you
  explicitly capture, followed by the single CDP call `Page.captureScreenshot`
  (with `captureBeyondViewport`) — this is the only reliable way to render a
  page taller than the viewport without scrolling or altering the DOM. Detach
  happens immediately after the frame is captured; nothing is inspected,
  modified, or injected, and no other tab is ever attached to. While attached
  Chrome briefly shows its standard "being debugged" banner.
- **tabCapture**: Record a short animated preview of the tab you explicitly
  choose to record (from the popup's record controls), used to produce a GIF
  you can copy or download. Capture starts only on your click, covers exactly
  one tab's video output, and no audio is requested or recorded.
- **offscreen**: Host an offscreen document that runs the GIF recorder
  (MediaRecorder has no DOM in an MV3 service worker). The document exists only
  while a recording is active, is invisible, and is closed as soon as the
  recording finishes.
- **No remote code, no analytics, no external servers.** All data stays local
  (IndexedDB + chrome.storage). See PRIVACY.md.
