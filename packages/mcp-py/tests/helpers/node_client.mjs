// An independent client-side handshake implementation (mirrors
// packages/extension/lib/mcp/auth.ts) used by test_cross_node_bridge.py to
// prove the Python BRIDGE accepts a real ws client speaking the wire contract.
//
// Usage: node node_client.mjs <ws-url> <token>
// Exits 0 and prints OK after a completed handshake + ping/pong.
//
// `ws` is resolved from packages/mcp (the Python package has no node_modules).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mcpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../mcp');
const WebSocket = createRequire(path.join(mcpDir, 'package.json'))('ws');
import { createHmac, randomUUID } from 'node:crypto';

const [, , url, token] = process.argv;
const hmacHex = (t, m) => createHmac('sha256', t).update(m).digest('hex');
const fail = (msg) => {
  console.error('FAIL: ' + msg);
  process.exit(1);
};

const ws = new WebSocket(url);
let helloNonce = '';

ws.on('open', () => {
  helloNonce = randomUUID();
  ws.send(
    JSON.stringify({ type: 'hello', role: 'extension', version: '0.0.0', nonce: helloNonce }),
  );
});

ws.on('message', (data) => {
  let frame;
  try {
    frame = JSON.parse(String(data));
  } catch {
    fail('non-JSON frame');
  }
  if (frame.type === 'welcome') {
    // The server must prove it knows the token before we trust it.
    if (frame.proof !== hmacHex(token, `manta/welcome/${helloNonce}`)) {
      fail('welcome proof mismatch');
    }
    ws.send(JSON.stringify({ type: 'auth', proof: hmacHex(token, `manta/auth/${frame.nonce}`) }));
    ws.send(JSON.stringify({ type: 'ping' }));
  } else if (frame.type === 'pong') {
    console.log('OK');
    process.exit(0);
  }
});

ws.on('close', (code) => fail(`closed with ${code} before pong`));
ws.on('error', (err) => fail(String(err)));
setTimeout(() => fail('timeout'), 10_000);
