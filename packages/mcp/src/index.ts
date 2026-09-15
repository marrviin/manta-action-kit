#!/usr/bin/env node
/**
 * Manta Action Kit MCP server.
 *
 * Exposes the Chrome extension's recorded API calls to an agent as MCP tools,
 * over stdio. Data lives in the extension's IndexedDB, so every tool forwards to
 * the extension via the local WebSocket bridge (see bridge.ts).
 *
 * This milestone: read-only access to recordings, plus a cookie-injecting gateway.
 *   - list_recordings     : all recordings' metadata
 *   - get_recording       : one recording + its full call chain
 *   - get_flow            : a recording's ordered steps + inferred field dependencies
 *   - get_endpoints       : a recording's deduped endpoints + redacted request/response schemas
 *   - get_call            : a single API call by id
 *   - proxy_fetch         : forward a call through the extension with cookies injected
 *   - proxy_sse           : forward an SSE call and drain its events
 *
 * Config:
 *   MANTA_WS_PORT — local bridge port (must match the extension setting).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { startBridge, type Bridge } from './bridge.js';
import { startPeerClient, type PeerClient } from './peer-client.js';
import { startProxyHttp, type ProxyHttpServer } from './proxy-http.js';
import {
  DEFAULT_MCP_PORT,
  DEFAULT_PROXY_PORT,
  type RpcMethod,
  type RpcResults,
} from './protocol.js';

const port = Number(process.env.MANTA_WS_PORT) || DEFAULT_MCP_PORT;
const proxyPort = Number(process.env.MANTA_PROXY_PORT) || DEFAULT_PROXY_PORT;

// Single source of truth for the server version: derive it from package.json at
// runtime so the reported version can never drift from the published one. tsconfig
// has rootDir=src and package.json lives OUTSIDE src, so a static import would be
// rejected by tsc; createRequire resolves it at runtime. dist/index.js sits in dist/,
// package.json is at ../package.json relative to it, and package.json ships in the tarball.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };

// The WS bridge and HTTP proxy must not share a port; otherwise the second bind
// fails (EADDRINUSE) and the proxy silently degrades. Fail fast with a clear
// message instead of a confusing runtime warning.
if (port === proxyPort) {
  console.error(
    `[manta-action-kit-mcp] fatal: MANTA_WS_PORT (${port}) and MANTA_PROXY_PORT (${proxyPort}) ` +
      `must differ. Set them to two distinct free ports.`,
  );
  process.exit(1);
}

/**
 * Single-instance runtime. Every MCP process starts identically (installed via
 * `npx`), then races for the WS bridge port:
 *   - OWNER: won the port. Hosts the WS bridge (extension dials in) + the local
 *     HTTP proxy. Tool calls go straight to the extension.
 *   - PEER : lost the port. Dials the owner's bridge as a client and forwards
 *     every tool call to it (`peer-rpc`). No HTTP proxy — the owner's one on the
 *     shared proxyPort already serves scripts.
 * When the owner exits, each peer's link drops and it re-runs the election, so
 * one of them takes over without a manual restart.
 */
type Role = 'owner' | 'peer';
const rt: {
  role: Role;
  bridge: Bridge | null;
  proxyHttp: ProxyHttpServer | null;
  peer: PeerClient | null;
} = { role: 'peer', bridge: null, proxyHttp: null, peer: null };

/**
 * Role-agnostic RPC entry used by every tool. Routes to the extension directly
 * (owner) or forwards to the owner (peer). Rejects if neither link is up.
 */
function call(method: RpcMethod, params: unknown, timeoutMs?: number): Promise<unknown> {
  if (rt.role === 'owner' && rt.bridge) return rt.bridge.call(method, params, timeoutMs);
  if (rt.role === 'peer' && rt.peer) return rt.peer.call(method, params, timeoutMs);
  return Promise.reject(new Error('MCP bridge not ready (no owner or peer link).'));
}

/** Is the extension reachable from here (directly as owner, or via the owner as peer)? */
function extensionReachable(): boolean {
  if (rt.role === 'owner') return !!rt.bridge?.isConnected();
  return !!rt.peer?.isConnected();
}

const server = new McpServer({
  name: 'manta-action-kit-mcp',
  version: PKG_VERSION,
});

/** Wrap a result object as MCP text content (pretty JSON). */
function jsonContent(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorContent(err: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: err instanceof Error ? err.message : String(err),
      },
    ],
  };
}

/**
 * Probe whether a TCP port on 127.0.0.1 is free by briefly binding it. Used by
 * rebind_proxy so the agent can pick a known-free port. Resolves true if the bind
 * succeeds (then immediately releases it), false on EADDRINUSE.
 */
function isPortFree(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(p, '127.0.0.1');
  });
}

/** Find the first free port scanning upward from `start` (skipping `avoid`). */
async function findFreePort(start: number, avoid: number): Promise<number | null> {
  for (let p = start; p <= start + 50 && p <= 65535; p++) {
    if (p === avoid) continue;
    if (await isPortFree(p)) return p;
  }
  return null;
}

server.registerTool(
  'list_recordings',
  {
    title: 'List recordings',
    description:
      'List all API recordings captured by the Manta Action Kit Chrome extension (metadata only: id, name, origin, createdAt, callCount).',
    inputSchema: {},
  },
  async () => {
    try {
      const res = (await call('list_recordings', undefined)) as RpcResults['list_recordings'];
      return jsonContent(res.recordings);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'get_recording',
  {
    title: 'Get recording detail',
    description:
      "Get a single recording plus its full API call chain (each call's request/response, status, timing). Use list_recordings first to find the id. The result includes the recording's agent-authored `description` when present; if it is missing, the result carries a `descriptionHint` nudging you to write one via set_recording_description so downstream steps understand this recording.",
    inputSchema: {
      id: z.string().describe('The recording id (from list_recordings).'),
    },
  },
  async ({ id }) => {
    try {
      const res = (await call('get_recording', { id })) as RpcResults['get_recording'];
      if (!res.recording) return errorContent(`No recording found with id "${id}".`);
      return jsonContent(res);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'set_recording_description',
  {
    title: 'Set recording description',
    description:
      "Write (or overwrite) a recording's `description`: a business-level, agent-authored summary of the WHOLE FLOW this recording represents — what real task it accomplishes, what you can DO with it (inputs it needs and results it yields), how the steps chain end to end, and what to watch out for when reusing it (required inputs to change, stale/time-bound or sensitive data, auth/login assumptions, side effects). Write for a reader deciding whether and how to reuse this flow — NOT an endpoint reference. Do NOT restate per-endpoint request/response field contracts, schemas, or field lists: that already lives in get_endpoints / get_flow and duplicating it here is noise. Study the flow first (get_flow for the chain, get_endpoints for contracts, get_recording for bodies), then distill the intent. This is the ONLY way to set a description; it is a dedicated write path that touches nothing else on the recording. Shown read-only at the top of the recording detail page.",
    inputSchema: {
      id: z.string().describe('The recording id (from list_recordings).'),
      description: z
        .string()
        .describe(
          'The description text to store. A concise, human-readable summary of the flow: its purpose, what it can do, how the steps chain, and caveats for reuse. Not a per-endpoint field/schema dump (that lives in get_endpoints/get_flow).',
        ),
    },
  },
  async ({ id, description }) => {
    try {
      const res = (await call('set_recording_description', {
        id,
        description,
      })) as RpcResults['set_recording_description'];
      if (!res.recording) return errorContent(`No recording found with id "${id}".`);
      return jsonContent(res.recording);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'get_flow',
  {
    title: 'Get call dependency flow',
    description:
      "Get a recording's FLOW: its calls as ordered lightweight steps (seq/method/url/status, no bodies) plus the inferred field dependencies linking them — i.e. which response value from an earlier call feeds a later call's request. Use this to understand how the calls chain together before replaying or proxying them; use get_recording for full request/response bodies. Find the id via list_recordings.",
    inputSchema: {
      id: z.string().describe('The recording id (from list_recordings).'),
    },
  },
  async ({ id }) => {
    try {
      const res = (await call('get_flow', { id })) as RpcResults['get_flow'];
      if (!res.flow) return errorContent(`No recording found with id "${id}".`);
      return jsonContent(res.flow);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'get_endpoints',
  {
    title: 'Get API contracts',
    description:
      "Get a recording's distinct ENDPOINTS: its calls collapsed by method + normalized URL path (numeric ids / uuids become \":id\") into one contract each, with request/response bodies inferred into REDACTED schemas — field names, types, optional/nullable flags, and one masked example per scalar, but no real values or credentials. Use this to learn a site's API surface cleanly, without wading through repetitive raw calls. Each endpoint may also carry inputsFrom: request fields whose VALUES come from an upstream endpoint's response (e.g. body.orderId ← `GET /orders` response `.data[].id`) — so before calling an endpoint, resolve its inputsFrom by first calling the upstream endpoint and reading the value from there, instead of guessing ids/tokens. inputsFrom carries only the source location, never the literal value. Use get_recording for concrete bodies, get_flow for the raw per-call dependency chain. Find the id via list_recordings.",
    inputSchema: {
      id: z.string().describe('The recording id (from list_recordings).'),
    },
  },
  async ({ id }) => {
    try {
      const res = (await call('get_endpoints', { id })) as RpcResults['get_endpoints'];
      return jsonContent(res.endpoints);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'get_call',
  {
    title: 'Get a single call',
    description:
      'Get one captured API call by its id, including full request and response bodies/headers.',
    inputSchema: {
      callId: z.string().describe("The API call id (from a recording's calls)."),
    },
  },
  async ({ callId }) => {
    try {
      const res = (await call('get_call', { callId })) as RpcResults['get_call'];
      if (!res.call) return errorContent(`No call found with id "${callId}".`);
      return jsonContent(res.call);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'list_proxy_rules',
  {
    title: 'List proxy rules',
    description:
      'List the sandbox proxy rules (the script-driven gateway entry). Each rule maps a ' +
      'local sandbox prefix (http://127.0.0.1:<proxyPort><sandboxPrefix>) to a real target ' +
      'base URL; a script points its baseURL at the sandbox prefix and the extension ' +
      "rewrites + forwards the request with the user's cookies injected. Returns each rule's " +
      '{id, sandboxPrefix, targetBase, enabled, createdBy, createdAt}. Use this before ' +
      'add_proxy_rule / update_proxy_rule to see existing prefixes (prefixes must be unique). ' +
      'NOTE: `enabled` is the user-controlled kill switch — you can read it here but cannot ' +
      'change it.',
    inputSchema: {},
  },
  async () => {
    try {
      const res = (await call('list_proxy_rules', undefined)) as RpcResults['list_proxy_rules'];
      return jsonContent(res.rules);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'add_proxy_rule',
  {
    title: 'Add proxy rule',
    description:
      'Create a sandbox proxy rule so a script can call a target API through the extension ' +
      "(with the user's cookies injected, never exposed to you). Provide sandboxPrefix (a " +
      'local path prefix like "/api", normalized to a leading "/" and unique across rules) and ' +
      'targetBase (the real http(s) base URL like "https://api.com/v1"). After this, requests ' +
      'to http://127.0.0.1:<proxyPort><sandboxPrefix>/... are rewritten onto targetBase. ' +
      '⚠️ Creating a rule requires the user to approve a native confirmation prompt (it shows ' +
      'the prefix and target — the user should verify them). On approval the rule is enabled ' +
      'immediately; if the user declines, the call fails and no rule is created. You still ' +
      'CANNOT set the `enabled` flag yourself — approving the prompt is what enables the rule. ' +
      'Fails if the prefix collides or the target is not a valid http(s) URL.',
    inputSchema: {
      sandboxPrefix: z
        .string()
        .describe('Local path prefix on the proxy, e.g. "/api". Must be unique across rules.'),
      targetBase: z
        .string()
        .describe('Real target base URL (http/https), e.g. "https://api.com/v1".'),
    },
    // Force a native permission prompt on EVERY rule creation — an enabled rule
    // becomes a standing, no-prompt cookie-injection tunnel for scripts, so the human
    // must approve it just like a proxy_fetch call. Approving IS what enables the rule
    // (the agent can never flip `enabled` itself). Mirrors proxy_fetch/proxy_sse.
    _meta: {
      'anthropic/requiresUserInteraction': true,
    },
  },
  async ({ sandboxPrefix, targetBase }) => {
    try {
      const res = (await call('add_proxy_rule', {
        sandboxPrefix,
        targetBase,
      })) as RpcResults['add_proxy_rule'];
      return jsonContent(res.rule);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'update_proxy_rule',
  {
    title: 'Update proxy rule',
    description:
      "Update an existing proxy rule's CONTENT by id. You may patch either sandboxPrefix or " +
      'targetBase — only the fields you pass change. Get the id from list_proxy_rules. ' +
      'IMPORTANT: you CANNOT enable or disable a rule — the `enabled` kill switch is reserved for ' +
      'the user and is not accepted here. Changing sandboxPrefix/targetBase is re-validated ' +
      '(prefix must stay unique, target must be a valid http(s) URL). Fails if the id is unknown.',
    inputSchema: {
      id: z.string().describe('The rule id (from list_proxy_rules).'),
      sandboxPrefix: z.string().optional().describe('New local path prefix (must stay unique).'),
      targetBase: z.string().optional().describe('New target base URL (http/https).'),
    },
  },
  async ({ id, sandboxPrefix, targetBase }) => {
    try {
      // Build the patch from only the provided fields so omitted ones are left unchanged.
      const patch: {
        sandboxPrefix?: string;
        targetBase?: string;
      } = {};
      if (sandboxPrefix !== undefined) patch.sandboxPrefix = sandboxPrefix;
      if (targetBase !== undefined) patch.targetBase = targetBase;
      const res = (await call('update_proxy_rule', {
        id,
        patch,
      })) as RpcResults['update_proxy_rule'];
      return jsonContent(res.rule);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'proxy_fetch',
  {
    title: 'Forward a call through the gateway',
    description:
      'Make an authenticated API call THROUGH the Manta Action Kit extension (edge gateway). ' +
      'You provide only method/url and optionally headers/body — DO NOT send any ' +
      "credentials (no Cookie, no Authorization); the extension injects the user's " +
      'browser cookies for the target site at forward time, so you never see them. ' +
      '⚠️ EVERY call requires the user to approve a native confirmation prompt before it ' +
      'runs (the prompt shows the method and url below — the user should verify them). ' +
      'Approving is also what authorizes the endpoint. ' +
      'Returns the sanitized response (Set-Cookie stripped; large bodies truncated). ' +
      'The response includes injectedCookieCount (a COUNT, never names/values): if it ' +
      'is 0 and you get a 401/403, the user is NOT logged in to that site — tell them ' +
      'to log in rather than retrying; if it is > 0 and you still get 401/403, cookies ' +
      'were sent so the endpoint likely needs something else (a header/token), not a login.',
    inputSchema: {
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
        .describe('HTTP method.'),
      url: z.string().describe('Absolute http(s) URL of the endpoint to call.'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Optional request headers. Do NOT include Cookie/Authorization.'),
      body: z.string().optional().describe('Optional request body as text.'),
    },
    // Force a native permission prompt on EVERY call — even in auto/acceptEdits/
    // bypassPermissions modes, and even if an allow rule matches. This is the
    // human-in-the-loop gate (see CLAUDE.md / the gateway plan). Requires Claude
    // Code v2.1.199+.
    _meta: {
      'anthropic/requiresUserInteraction': true,
    },
  },
  async ({ method, url, headers, body }) => {
    try {
      const req = { method, url, headers, body };
      // The native confirmation prompt already gated this call (requiresUserInteraction),
      // so reaching here means the user approved. Forward straight through.
      const res = (await call('proxy_fetch', { req }, 130000)) as RpcResults['proxy_fetch'];
      return jsonContent(res);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'proxy_sse',
  {
    title: 'Forward an SSE streaming call through the gateway',
    description:
      'Like proxy_fetch, but for a Server-Sent Events (text/event-stream) endpoint. ' +
      "The extension injects the user's cookies, opens the stream, and drains it, " +
      'then returns ALL collected events at once — this is not a live per-token feed ' +
      '(MCP tool calls are request/response). Use it for streaming endpoints (e.g. an ' +
      'AI chat stream). Same authorization rules as proxy_fetch; Accept defaults to ' +
      'text/event-stream. The gateway makes NO assumption about how a stream ends: by ' +
      'default it stops at EOF, an 8s idle gap, or a size/time cap. If you know the ' +
      "stream's terminator (from a recording via get_recording — SSE responses are " +
      'captured as an event sequence there), pass stopOnEventName or stopOnData to ' +
      'stop promptly. Result: {events:[{event?,id?,data}], endReason, eventCount}. ' +
      'endReason: "complete"=EOF, "stop-match"=your stop condition matched, ' +
      '"idle"=stream went quiet, "max-events"/"max-bytes"/"timeout"=a cap was hit. ' +
      'Also includes injectedCookieCount (a COUNT, never names/values): 0 alongside a ' +
      '401/403 status means the user is not logged in to that site — surface that rather ' +
      'than retrying. ' +
      '⚠️ EVERY call requires the user to approve a native confirmation prompt before it runs.',
    inputSchema: {
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
        .describe('HTTP method (usually GET for SSE).'),
      url: z.string().describe('Absolute http(s) URL of the SSE endpoint.'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Optional request headers. Do NOT include Cookie/Authorization.'),
      body: z.string().optional().describe('Optional request body as text.'),
      stopOnEventName: z
        .string()
        .optional()
        .describe(
          'Stop once an event with this `event:` name arrives (e.g. the terminator you saw in a recording).',
        ),
      stopOnData: z
        .string()
        .optional()
        .describe('Stop once an event\'s data equals this exact string (e.g. "[DONE]").'),
    },
    // Force a native permission prompt on every call (see proxy_fetch).
    _meta: {
      'anthropic/requiresUserInteraction': true,
    },
  },
  async ({ method, url, headers, body, stopOnEventName, stopOnData }) => {
    try {
      const req = { method, url, headers, body, stopOnEventName, stopOnData };
      // Gated by the native confirmation prompt (requiresUserInteraction) — forward.
      const res = (await call('proxy_sse', { req }, 130000)) as RpcResults['proxy_sse'];
      return jsonContent(res);
    } catch (err) {
      return errorContent(err);
    }
  },
);

server.registerTool(
  'health',
  {
    title: 'Check MCP service port and connection health',
    description:
      "Report the MCP server's runtime health so an agent can detect and recover from " +
      'port problems. Returns: wsPort (the WebSocket bridge port — fixed for the process ' +
      "lifetime), proxyPort (the local HTTP proxy's CURRENT port), proxyListening (whether " +
      'the HTTP proxy is bound — false means script-driven proxy rules are unavailable, ' +
      'usually a port conflict), and extensionConnected (whether the Chrome extension is ' +
      'connected over the bridge). If proxyListening is false, call rebind_proxy to move the ' +
      'proxy to a free port and self-heal without a restart.',
    inputSchema: {},
  },
  async () => {
    // As a peer, the proxy runs in the OWNER process; report the owner's shared
    // proxyPort with listening=unknown-from-here (we don't host it).
    return jsonContent({
      role: rt.role,
      wsPort: port,
      proxyPort: rt.proxyHttp ? rt.proxyHttp.currentPort() : proxyPort,
      proxyListening: rt.proxyHttp ? rt.proxyHttp.isListening() : rt.role === 'peer',
      extensionConnected: extensionReachable(),
    });
  },
);

server.registerTool(
  'rebind_proxy',
  {
    title: 'Rebind the local HTTP proxy to a free port',
    description:
      'Move the local HTTP proxy to a new port at runtime WITHOUT restarting the MCP ' +
      "server, then sync that port into the extension so proxy-rule scripts' baseURL " +
      '(http://127.0.0.1:<proxyPort>) keeps working. Use this to recover when health ' +
      'reports proxyListening=false (a port conflict). Omit `port` to auto-pick the first ' +
      'free port (scanning up from the current one); pass `port` to force a specific one. ' +
      'The new port must differ from wsPort. Returns the resulting {proxyPort, proxyListening}. ' +
      'NOTE: this cannot fix a WS bridge port conflict — that is a fatal startup error and ' +
      'requires changing MANTA_WS_PORT and restarting.',
    inputSchema: {
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe('Target proxy port. Omit to auto-select a free port. Must differ from wsPort.'),
    },
  },
  async ({ port: requested }) => {
    try {
      // Only the owner hosts the HTTP proxy. A peer forwards everything to the
      // owner, so there is no local proxy to rebind here.
      if (rt.role !== 'owner' || !rt.proxyHttp) {
        return errorContent(
          new Error(
            'This MCP process is a peer (another instance owns the proxy). ' +
              'Rebind is a no-op here; the owning process manages the shared proxy port.',
          ),
        );
      }
      const proxyHttp = rt.proxyHttp;
      let target = requested;
      if (target == null) {
        const found = await findFreePort(proxyHttp.currentPort() + 1, port);
        if (found == null) {
          return errorContent(new Error('No free port found near the current proxy port.'));
        }
        target = found;
      }
      if (target === port) {
        return errorContent(
          new Error(`Proxy port ${target} collides with the WS bridge port; choose another.`),
        );
      }
      const bound = await proxyHttp.rebind(target);
      // Sync the new port into the extension so script baseURLs stay valid. Best-effort:
      // if the extension isn't connected, the rebind still succeeded locally.
      let synced = false;
      try {
        await call('set_proxy_port', { proxyPort: bound });
        synced = true;
      } catch {
        synced = false;
      }
      return jsonContent({
        proxyPort: bound,
        proxyListening: proxyHttp.isListening(),
        extensionSynced: synced,
      });
    } catch (err) {
      return errorContent(err);
    }
  },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Try to become the OWNER: bind the WS bridge. Resolves true on success (rt is
 * populated with a live bridge + HTTP proxy), false if the port is taken (someone
 * else owns it — we should become a peer instead).
 */
async function tryBecomeOwner(): Promise<boolean> {
  const bridge = startBridge(port);
  try {
    await bridge.whenReady();
  } catch {
    // Port busy (EADDRINUSE) — abandon this bridge and let the caller go peer.
    await bridge.close().catch(() => {});
    return false;
  }
  rt.role = 'owner';
  rt.bridge = bridge;
  rt.peer = null;

  // Owner also hosts the local HTTP proxy (script gateway). A bind failure here is
  // NOT fatal: MCP tools over stdio + WS still work; only script proxy rules break.
  const proxyHttp = startProxyHttp(bridge, proxyPort);
  rt.proxyHttp = proxyHttp;
  try {
    await proxyHttp.whenReady();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[manta-action-kit-mcp] warning: HTTP proxy could not bind port ${proxyPort}: ${msg}. ` +
        `Script-driven proxy rules will be unavailable. Free the port or set MANTA_PROXY_PORT.`,
    );
  }
  console.error(
    `[manta-action-kit-mcp] role=owner. Bridge on ws://127.0.0.1:${port}; ` +
      `HTTP proxy on http://127.0.0.1:${proxyPort}.`,
  );
  return true;
}

/**
 * Try to become a PEER: dial the owner's bridge and forward calls to it. Resolves
 * true on success. When the owner later exits, `onOwnerLost` re-runs the election.
 */
async function tryBecomePeer(): Promise<boolean> {
  const peer = startPeerClient(port, '127.0.0.1', {
    version: PKG_VERSION,
    onOwnerLost: () => {
      console.error('[manta-action-kit-mcp] owner lost — re-electing.');
      // Re-run the election. Any error just leaves us disconnected; tool calls
      // then reject with a clear message until an owner is available again.
      void elect();
    },
  });
  try {
    await peer.whenReady();
  } catch {
    await peer.close().catch(() => {});
    return false;
  }
  rt.role = 'peer';
  rt.peer = peer;
  rt.bridge = null;
  rt.proxyHttp = null;
  console.error(
    `[manta-action-kit-mcp] role=peer. Forwarding to owner at ws://127.0.0.1:${port}.`,
  );
  return true;
}

/**
 * Single-instance election with a small retry window. First try to own the port;
 * if it's taken, become a peer. There's an inherent race when the previous owner
 * is exiting: the port may still look busy while its listener won't accept us as a
 * peer yet. Retry a few times to let the dust settle before giving up.
 */
async function elect(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await tryBecomeOwner()) return;
    if (await tryBecomePeer()) return;
    // Neither worked (owner exiting mid-flight). Back off briefly and retry.
    await sleep(150);
  }
  console.error(
    `[manta-action-kit-mcp] warning: could not become owner or peer on port ${port} after retries. ` +
      `Tool calls will fail until an instance owns the bridge. ` +
      `Check for a stuck process or set MANTA_WS_PORT to a free port.`,
  );
}

async function main() {
  // Elect a role BEFORE serving MCP over stdio. Unlike before, losing the port
  // race is no longer fatal — we degrade to a peer that forwards to the owner, so
  // multiple concurrent agent sessions (installed via npx) coexist on one bridge.
  await elect();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[manta-action-kit-mcp] ready (role=${rt.role}); MCP on stdio.`);
}

async function shutdown() {
  await Promise.allSettled([
    rt.bridge?.close() ?? Promise.resolve(),
    rt.proxyHttp?.close() ?? Promise.resolve(),
    rt.peer?.close() ?? Promise.resolve(),
  ]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[manta-action-kit-mcp] fatal', err);
  process.exit(1);
});
