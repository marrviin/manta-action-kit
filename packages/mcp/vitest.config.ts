import { defineConfig } from 'vitest/config';

// The MCP package is pure Node (ws + node:crypto + node:http), so its suite
// runs real WebSocket/HTTP servers on ephemeral ports — no mocks, the tests
// exercise the actual wire protocol.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
