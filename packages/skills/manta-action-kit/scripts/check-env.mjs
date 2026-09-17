#!/usr/bin/env node
/**
 * manta-action-kit suite health check.
 *
 * Usage: node check-env.mjs
 * Exit code: 0 = all passed; 1 = issues found (each line prefixed ✅/❌/⚠️ with a fix suggestion).
 *
 * Checks:
 *   1. packages/mcp/dist/index.js is built
 *   2. Claude Code has the manta-action-kit MCP server registered
 *   3. WS bridge port (default 8787) has an MCP server process listening
 *   4. End-to-end probe: connects to the bridge as a peer and forwards
 *      list_recordings to the extension — distinguishes "bridge up but
 *      extension not connected" from "full chain working"
 *
 * Requires Node >= 22 (native WebSocket). Ports can be overridden via
 * MANTA_WS_PORT / MANTA_PROXY_PORT.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MCP_PORT = Number(process.env.MANTA_WS_PORT) || 8787;

const results = [];
const report = (ok, label, detail = '') => {
  const mark = ok === 'skip' ? '⚠️' : ok ? '✅' : '❌';
  results.push(ok === true);
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. dist built ────────────────────────────────────────────────────────────
const distEntry = path.join(ROOT, 'packages/mcp/dist/index.js');
if (existsSync(distEntry)) {
  report(true, 'MCP build output present (packages/mcp/dist/index.js)');
} else {
  report(false, 'MCP build output missing', 'run pnpm build:mcp');
}

// ── 2. Claude Code registration ─────────────────────────────────────────────
const claude = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 30_000 });
if (claude.error) {
  report('skip', 'claude CLI unavailable, skipping registration check');
} else {
  const line = (claude.stdout + claude.stderr)
    .split('\n')
    .find((l) => l.includes('manta-action-kit'));
  if (line && line.includes('✔')) {
    report(true, 'Claude Code has manta-action-kit MCP registered');
  } else if (line) {
    report(false, `Registered but not connected: ${line.trim()}`, 'run pnpm build:mcp first, then /mcp reconnect');
  } else {
    report(
      false,
      'manta-action-kit MCP not registered in Claude Code',
      `run claude mcp add manta-action-kit --scope local -- node ${distEntry}`,
    );
  }
}

// ── 3+4. WS bridge + end-to-end probe ───────────────────────────────────────
if (typeof WebSocket === 'undefined') {
  report('skip', `Node ${process.version} has no native WebSocket, skipping connection check (requires Node >= 22)`);
} else {
  const exitCode = await probeBridge();
  process.exitCode = exitCode;
}

/** Connect to ws://127.0.0.1:<MCP_PORT> and probe the extension as a peer. Returns exit code. */
async function probeBridge() {
  let ws;
  try {
    ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${MCP_PORT}`);
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (err) => {
        cleanup();
        reject(err?.error ?? err);
      };
      const t = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error('connect timeout'));
      }, 5_000);
      const cleanup = () => {
        clearTimeout(t);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });
  } catch {
    report(false, `WS bridge port ${MCP_PORT} has no listener`, 'MCP server not running (no MCP client session started?), or the port was changed');
    return 1;
  }
  report(true, `WS bridge port ${MCP_PORT} has an MCP server listening`);

  try {
    const result = await rpc(ws, 'list_recordings', {}, 10_000);
    const count = Array.isArray(result) ? result.length : (result?.recordings?.length ?? 'unknown');
    report(true, 'End-to-end probe passed (MCP → bridge → extension)', `current recording count: ${count}`);
    return 0;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg.includes('No Chrome extension connected')) {
      report(false, 'Bridge up but extension not connected', 'confirm Chrome is open with the extension loaded; the "MCP service" switch in the side-panel settings is on; the port matches the server');
    } else if (msg.includes('timed out')) {
      report(false, 'Extension connected but unresponsive', 'the extension was just reloaded or its service worker slept; wake the side panel and retry');
    } else {
      report(false, 'End-to-end probe failed', msg);
    }
    return 1;
  } finally {
    ws.close();
  }
}

/** Send hello(peer) + peer-rpc, await the peer-rpc-result with the matching id. */
function rpc(ws, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = `check-${Date.now()}`;
    const timer = setTimeout(() => reject(new Error(`peer RPC "${method}" timed out after ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener('message', (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === 'peer-rpc-result' && frame.id === id) {
        clearTimeout(timer);
        if (frame.ok) {
          resolve(frame.result);
        } else {
          reject(new Error(frame.error));
        }
      }
    });
    ws.send(JSON.stringify({ type: 'hello', role: 'peer', version: '0.0.0' }));
    ws.send(JSON.stringify({ type: 'peer-rpc', id, method, params }));
  });
}
