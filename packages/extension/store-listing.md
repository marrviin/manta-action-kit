# Chrome Web Store Listing

> 商店后台上架文案备份。manifest 里只放 `name` / `short_name` / `description`(见 `wxt.config.ts`);
> 「长描述」在开发者后台单独填写,不在 manifest 内。

## Name（展示名，manifest `name`，≤75 字符）

```
Manta Action Kit - AI Developer Toolkit & Agent Browser Bridge
```

## Short name（manifest `short_name`）

```
Manta Action Kit
```

## Short description（manifest `description`，硬上限 132 字符，无换行/HTML）

```
Secure access to your authenticated APIs for Claude Code & Codex. Record business flows via a sandbox proxy — cookies stay private.
```

## Detailed description（商店后台「详细描述」，支持长文本）

🔐 Give your AI agents secure access to your real, logged-in APIs — without ever handing over your credentials.

Tools like Claude Code and Codex are great at writing code, but they can't safely call your authenticated business APIs. Manta Action Kit fixes that: you record the real API flow once, then let your agent call those endpoints through a controlled sandbox proxy — while your cookies and tokens stay locked inside your browser.

How it works:
• Record: You actively capture a real business API flow (fetch/XHR) in your browser — requests and responses included.
• Sandbox Proxy: Your agent sends only method/URL/body. The extension injects your session cookies at the trust boundary and forwards the call, so credentials are NEVER exposed to the AI.
• Stay in control: human-in-the-loop confirmation on every agent call, a per-tool kill switch, an SSRF guard that refuses loopback/private hosts, and a full audit log (cookie names logged, values never) — you decide what the agent can reach.

Built as an AI Developer Toolkit, bridged to your agent over MCP.

(Coming Soon: DOM Simplifier, Authentication State Injector, and more!)

## Permission justification（商店后台「隐私权做法」逐条说明）

- **host_permissions `<all_urls>`**: The recording hook must be injected into any
  site the user chooses to record (a MAIN-world script that patches fetch/XHR at
  document_start), and the sandbox proxy forwards agent calls to whatever
  authenticated host the user's recorded flow targets. The set of hosts is
  user-driven and open-ended, so no fixed match list is possible.
- **cookies + declarativeNetRequestWithHostAccess**: Read the user's existing
  session cookies and inject them as a request header at forward time, so the
  agent can call authenticated APIs without ever seeing credentials.
- **scripting**: Inject the MAIN-world capture hook.
- **tabs**: Resolve the active tab to start recording it and target injection.
- **sidePanel**: Host the management UI (recordings, audit log, proxy rules).
- **storage**: Persist settings and reactive UI state.
- **alarms**: Keep the MCP WebSocket bridge alive across MV3 service-worker sleep.
- **No remote code, no analytics, no external servers.** All data stays local
  (IndexedDB + chrome.storage). See PRIVACY.md.
