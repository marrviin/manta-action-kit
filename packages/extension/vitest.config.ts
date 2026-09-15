import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The unit suite targets the pure, dependency-free modules (no extension/DOM
// APIs): gateway proxy-rule resolution, schema inference, example redaction,
// SSE parsing, endpoint aggregation. Mirror the app's `@/` alias so tests can
// import them the same way the source does.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
