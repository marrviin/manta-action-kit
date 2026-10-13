/**
 * MCP bridge (extension side).
 *
 * MV3 service workers can't listen on a port, so the extension is the WebSocket
 * CLIENT: it always dials the local MCP server (packages/mcp) at
 * ws://127.0.0.1:<port>. The server forwards agent tool calls as `rpc` frames; we
 * run them via handleRpc() and reply with `rpc-result`.
 *
 * There is no MCP master switch — the bridge is always trying to connect (the real
 * per-call gate is each tool's native permission prompt, and unwanted tools can be
 * turned off individually). Only the port is configurable. A backoff reconnect
 * keeps retrying (the server may not be running yet), and when dials keep failing
 * a throttled fallback scan probes the ports above the configured one for a
 * bridge that proves it knows the token — that covers the MCP server relocating
 * after a port conflict (see the discovery block near the constants). The live
 * connection state is published to settings' session storage (mcpConnStatus) for
 * the Settings tab's Connector card to show.
 *
 * Keepalive: MV3 service workers sleep when idle, which would silently drop the WS
 * (and with it the agent's ability to call proxy_fetch). Two layers guard against
 * that: a sub-30s app-level `ping` frame — since Chrome 116, active WebSocket
 * traffic resets the SW's idle timer, so a connected bridge keeps the SW alive
 * indefinitely — and, as the fallback for when the socket IS dropped (server
 * gone, older Chrome), a chrome.alarms tick wakes the worker periodically and
 * re-dials. Both keep the bridge alive in the background without the user
 * having to keep a panel open.
 */
import { settings, mcpConnStatus, mcpServerVersion, type McpConnStatus } from '@/lib/storage';
import { handleRpc } from './handlers';
import { authProof, newNonce, verifyWelcomeProof } from './auth';
import { ensureMcpAuthToken } from './install-prompt';
import {
  BRIDGE_SCAN_RANGE,
  DEFAULT_MCP_PORT,
  type ClientFrame,
  type RpcRequestFrame,
  type ServerFrame,
} from './protocol';

/** Alarm that wakes the SW to keep the WS alive. Min period on MV3 is ~1 min. */
const KEEPALIVE_ALARM = 'mcp-bridge-keepalive';
const KEEPALIVE_PERIOD_MIN = 1;

/**
 * App-level ping cadence. Must stay under 30s: Chrome 116+ keeps the service
 * worker alive as long as the WebSocket sees traffic within its ~30s idle
 * window, so this ping IS the SW keepalive while the bridge is connected.
 * The server answers with `pong` and uses inbound frames as liveness signals.
 */
const PING_INTERVAL_MS = 20_000;

/**
 * Fallback-port discovery. When the configured port is squatted by a non-manta
 * process, the MCP server claims the first free port ABOVE it as a fallback
 * bridge (see elect() in packages/mcp). The extension can't be told — it isn't
 * connected — so on repeated dial failures it probes the same range here: each
 * probe does the handshake's first half, and only a server that proves it knows
 * the shared token (verifyWelcomeProof) is trusted. A squatter can neither fake
 * that proof nor extract the token from the nonce. Scans are throttled — when
 * the server simply isn't running (the common case), every dial fails and a
 * sweep per reconnect would be wasteful, even though refused dials cost almost
 * nothing.
 */
const SCAN_INTERVAL_MS = 30_000;
/** Consecutive dial failures before a scan is worth firing (a sweep is
 * bounded but not free; the first couple of backoff retries are noise). */
const SCAN_AFTER_FAILURES = 3;
const PROBE_TIMEOUT_MS = 1000;

/** Port found by the last discovery scan, dialed instead of desiredPort. */
let discoveredPort: number | null = null;
let lastScanAt = 0;
/** Consecutive dial failures (reset by a completed handshake). */
let dialFailures = 0;

let socket: WebSocket | null = null;
let desiredPort = DEFAULT_MCP_PORT;
/** Shared handshake secret (settings.mcpAuthToken) — see lib/mcp/auth.ts. */
let desiredToken = '';
/** True when the CURRENT attempt failed the handshake, so onclose reports
 * 'unauthorized' (token mismatch) instead of a plain 'disconnected'. */
let unauthorized = false;
/** Nonce of the in-flight hello, needed to verify the matching welcome proof. */
let helloNonce = '';
/** Set once the server proved it knows the token; rpc frames before this are dropped. */
let handshakeOk = false;
/** Bumped on every (re)configuration so stale timers/handlers no-op. */
let generation = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 15000;
let pingTimer: ReturnType<typeof setInterval> | null = null;

// Dev-only diagnostics. Vite strips `import.meta.env.DEV` to `false` in production
// builds, so these logs (and the reconnect/keepalive chatter they emit) never ship.
function log(...args: unknown[]) {
  if (import.meta.env.DEV) console.log('[mcp-bridge]', ...args);
}

/**
 * Publish the connection state for the UI. Writes are chained so they land in call
 * order: on loopback the socket opens so fast that a fire-and-forget 'connected'
 * write can race the preceding 'connecting' write and lose, pinning the UI at
 * "connecting". Serializing guarantees the last call wins. Best-effort — a failed
 * write is swallowed so it can't break the chain.
 */
let statusWriteChain: Promise<void> = Promise.resolve();
function publishStatus(status: McpConnStatus) {
  statusWriteChain = statusWriteChain.then(() =>
    mcpConnStatus.setValue(status).catch(() => {}),
  );
}

function send(frame: ClientFrame) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function clearReconnect() {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** Start the SW-keepalive ping loop (cleared by stopPing on close/teardown). */
function startPing() {
  stopPing();
  pingTimer = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer != null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function teardown() {
  clearReconnect();
  stopPing();
  if (socket) {
    // Detach handlers so onclose doesn't schedule a reconnect for a stale gen.
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
}

function scheduleReconnect(gen: number) {
  clearReconnect();
  reconnectTimer = setTimeout(() => {
    if (gen !== generation) return;
    connect(gen);
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function connect(gen: number) {
  if (gen !== generation) return;
  teardownSocketOnly();
  unauthorized = false;
  handshakeOk = false;
  publishStatus('connecting');

  // Never dial without the token — an unauthenticated socket is useless (the
  // server drops it) and initMcpBridge guarantees one; this is just a guard.
  if (!desiredToken) {
    log('no auth token — skipping dial');
    unauthorized = true;
    publishStatus('unauthorized');
    scheduleReconnect(gen);
    return;
  }

  // A discovered fallback port outranks the configured one — the configured
  // port is (still) squatted, that's how the discovery found it.
  const dialedPort = discoveredPort ?? desiredPort;
  const url = `ws://127.0.0.1:${dialedPort}`;
  log('connecting', url);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    log('construct failed', err);
    publishStatus('disconnected');
    scheduleReconnect(gen);
    return;
  }
  socket = ws;

  ws.onopen = () => {
    if (gen !== generation) return;
    backoffMs = 1000;
    log('connected');
    // NOT 'connected' yet — the socket is unauthenticated until the handshake
    // completes (see onMessage's welcome branch).
    helloNonce = newNonce();
    send({
      type: 'hello',
      role: 'extension',
      version: browser.runtime.getManifest().version,
      nonce: helloNonce,
    });
  };

  ws.onmessage = (ev) => {
    if (gen !== generation) return;
    void onMessage(ev);
  };

  ws.onerror = () => {
    // Errors are followed by onclose; just log.
    log('socket error');
  };

  ws.onclose = () => {
    if (gen !== generation) return;
    stopPing();
    socket = null;
    if (!handshakeOk) {
      // Dial failure (the socket never completed its handshake). A discovered
      // port that just failed is stale — the owner moved, possibly back to the
      // configured port; drop it so the next dial retries there.
      dialFailures += 1;
      if (discoveredPort === dialedPort) {
        discoveredPort = null;
        log('discovered port stopped answering — rediscovering');
      }
      maybeScan(gen);
    }
    publishStatus(unauthorized ? 'unauthorized' : 'disconnected');
    scheduleReconnect(gen);
  };
}

/** Close only the socket (used before a fresh connect), keep timers/gen intact. */
function teardownSocketOnly() {
  stopPing();
  if (socket) {
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
}

/**
 * Kick off a fallback-port scan if enough time has passed since the last one.
 * Called on dial failures (close before the handshake). Never scans while
 * unauthorized — a token mismatch is a config error no port can fix, and the
 * status should keep pointing at it.
 */
function maybeScan(gen: number) {
  if (unauthorized || dialFailures < SCAN_AFTER_FAILURES) return;
  const now = Date.now();
  if (now - lastScanAt < SCAN_INTERVAL_MS) return;
  lastScanAt = now;
  void discoverBridge(gen).then((found) => {
    if (gen !== generation || found == null) return;
    if (isConnected() || socket?.readyState === WebSocket.CONNECTING) return;
    log('discovered bridge on fallback port', found);
    discoveredPort = found;
    backoffMs = 1000;
    clearReconnect();
    connect(gen); // dial the relocated bridge immediately
  });
}

/** Probe the ports above the configured one, first verified bridge wins. */
async function discoverBridge(gen: number): Promise<number | null> {
  for (let p = desiredPort + 1; p <= desiredPort + BRIDGE_SCAN_RANGE; p++) {
    if (gen !== generation) return null;
    if (await probeBridge(p)) return p;
  }
  return null;
}

/**
 * One-shot handshake probe: does <p> host a bridge that knows our token? Only
 * the handshake's first half runs — we send the hello, and trust the server
 * only when its welcome proof verifies. The auth answer (and anything else)
 * never goes to an unproven server.
 */
function probeBridge(p: number): Promise<boolean> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${p}`);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let nonce = '';
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    ws.onopen = () => {
      nonce = newNonce();
      ws.send(
        JSON.stringify({
          type: 'hello',
          role: 'extension',
          version: browser.runtime.getManifest().version,
          nonce,
        } satisfies ClientFrame),
      );
    };
    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return; // not JSON — never our bridge
      }
      if (frame.type !== 'welcome') return;
      void verifyWelcomeProof(desiredToken, nonce, frame.proof)
        .then((ok) => done(ok))
        .catch(() => done(false));
    };
    ws.onerror = () => done(false);
    ws.onclose = () => done(false);
  });
}

async function onMessage(ev: MessageEvent) {
  let frame: ServerFrame;
  try {
    frame = JSON.parse(String(ev.data)) as ServerFrame;
  } catch {
    log('bad frame (not JSON)');
    return;
  }

  // Handshake step 2: the server proves it knows the token over OUR hello nonce.
  // Until this passes we send nothing else and accept nothing else; a failed
  // proof means the server doesn't share our token (MANTA_TOKEN out of sync) —
  // drop the socket and surface 'unauthorized' so the UI can point at the fix.
  if (frame.type === 'welcome') {
    const ok = await verifyWelcomeProof(desiredToken, helloNonce, frame.proof).catch(
      () => false,
    );
    if (!ok) {
      log('server failed the welcome proof — token mismatch (re-copy the install prompt)');
      unauthorized = true;
      publishStatus('unauthorized');
      socket?.close(); // onclose schedules the next attempt
      return;
    }
    log('handshake ok');
    handshakeOk = true;
    dialFailures = 0; // the current port works — scan counters start over
    // Remember the server's self-declared version (WelcomeFrame.version) for
    // the settings page's skew hint. Old servers omit it → null, which the UI
    // reads as "server predates the version exchange — update the MCP server".
    void mcpServerVersion
      .setValue(typeof frame.version === 'string' ? frame.version : null)
      .catch(() => {});
    send({ type: 'auth', proof: await authProof(desiredToken, frame.nonce) });
    startPing(); // sub-30s traffic keeps the SW alive while connected
    publishStatus('connected'); // server drops us if the auth proof fails — onclose reports it
    return;
  }

  if (frame.type !== 'rpc') return;
  // Never serve an unauthenticated peer: a port squatter could otherwise send
  // rpc frames before the handshake and walk away with recording data.
  if (!handshakeOk) {
    log('dropping rpc frame before handshake completed');
    return;
  }

  const req = frame as RpcRequestFrame;
  try {
    const result = await handleRpc(req.method, req.params);
    send({ type: 'rpc-result', id: req.id, ok: true, result });
  } catch (err) {
    send({
      type: 'rpc-result',
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Apply the desired port, restarting the connection when it changes. */
function reconfigure(port: number) {
  if (port === desiredPort && socket) return;
  desiredPort = port;
  // The setting is authoritative — forget any fallback discovery bound to the
  // old port's neighborhood and let the next scan start fresh.
  discoveredPort = null;
  lastScanAt = 0;
  dialFailures = 0;
  generation += 1; // invalidate all in-flight timers/handlers
  const gen = generation;
  backoffMs = 1000;
  teardown();
  connect(gen);
  ensureKeepaliveAlarm();
}

/** Is the socket currently open? */
function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/**
 * Ensure a connection exists. Called on every keepalive alarm: if not connected
 * (e.g. the SW just woke and the socket was dropped while it slept), dial
 * immediately with a fresh backoff.
 */
export function ensureConnected() {
  if (isConnected()) return;
  // A pending socket (CONNECTING) will settle on its own; only kick if truly idle.
  if (socket?.readyState === WebSocket.CONNECTING) return;
  backoffMs = 1000;
  connect(generation);
}

/** Register the keepalive alarm (idempotent — create() overwrites by name). */
function ensureKeepaliveAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  } catch (err) {
    log('failed to create keepalive alarm', err);
  }
}

/**
 * Start the bridge: dial the MCP server immediately, then re-dial whenever the
 * port setting changes. Call once from the background entrypoint.
 */
export async function initMcpBridge() {
  // Ensure the shared handshake token exists before the first dial (generated
  // once, injected into the install prompt as MANTA_TOKEN).
  desiredToken = await ensureMcpAuthToken();
  const port = await settings.mcpPort.getValue();
  reconfigure(port ?? DEFAULT_MCP_PORT);

  settings.mcpPort.watch((v) => reconfigure(v ?? DEFAULT_MCP_PORT));

  // Keepalive: every alarm tick wakes the SW; re-dial if the socket was dropped
  // while the worker slept. Registered once; MV3 re-runs this module on each wake.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) ensureConnected();
  });
}
