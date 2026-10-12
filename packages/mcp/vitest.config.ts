import { defineConfig } from 'vitest/config';

// The MCP package is pure Node (ws + node:crypto + node:http), so its suite
// runs real WebSocket/HTTP servers on ephemeral ports — no mocks, the tests
// exercise the actual wire protocol.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    // The suite bare-imports src/index.ts for the registered tool surface;
    // this flag keeps that import from binding the bridge/proxy ports.
    env: { MCP_NO_AUTORUN: '1' },
  },
});
