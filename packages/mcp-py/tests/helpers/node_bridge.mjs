// Spawns the REAL Node bridge (packages/mcp/dist/bridge.js — built by
// `pnpm --filter @manta-action-kit/mcp build`) and prints its bound port as a
// JSON line on stdout. Used by test_cross_node_bridge.py to prove the Python
// client handshake against the actual TS server implementation.
//
// Usage: node node_bridge.mjs <port> <token>
import { startBridge } from '../../../mcp/dist/bridge.js';

const port = Number(process.argv[2] || 0);
const token = process.argv[3];
const bridge = startBridge(port, token);
bridge.whenReady().then(() => {
  process.stdout.write(JSON.stringify({ ready: true, port: bridge.port() }) + '\n');
});
process.on('SIGTERM', () => {
  void bridge.close().then(() => process.exit(0));
});
process.stdin.resume(); // stay alive until the test kills us
