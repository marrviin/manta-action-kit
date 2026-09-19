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
 * keeps retrying (the server may not be running yet). The live connection state is
 * published to settings' session storage (mcpConnStatus) for the MCP tab to show.
 *
 * Keepalive: MV3 service workers sleep when idle, which would silently drop the WS
 * (and with it the agent's ability to call proxy_fetch). A chrome.alarms tick wakes
 * the worker periodically and re-dials if the socket isn't open — so the bridge
 * survives background sleep without the user having to keep a panel open.
 */
import { settings, mcpConnStatus, type McpConnStatus } from '@/lib/storage';
import { handleRpc } from './handlers';
import { authProof, newNonce, verifyWelcomeProof } from './auth';
import { ensureMcpAuthToken } from './install-prompt';
import {
  DEFAULT_MCP_PORT,
  type ClientFrame,
  type RpcRequestFrame,
  type ServerFrame,
} from './protocol';

/** Alarm that wakes the SW to keep the WS alive. Min period on MV3 is ~1 min. */
const KEEPALIVE_ALARM = 'mcp-bridge-keepalive';
const KEEPALIVE_PERIOD_MIN = 1;

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

function teardown() {
  clearReconnect();
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

  const url = `ws://127.0.0.1:${desiredPort}`;
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
    socket = null;
    publishStatus(unauthorized ? 'unauthorized' : 'disconnected');
    scheduleReconnect(gen);
  };
}

/** Close only the socket (used before a fresh connect), keep timers/gen intact. */
function teardownSocketOnly() {
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
    send({ type: 'auth', proof: await authProof(desiredToken, frame.nonce) });
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
