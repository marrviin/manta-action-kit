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
      // WXT's virtual module — tests only need the storage facade, which
      // never touches extension APIs until an actual read/write call.
      '#imports': fileURLToPath(new URL('./test/imports-shim.ts', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      // text → 终端摘要；html → coverage/index.html（浏览器打开逐文件下钻）。
      reporter: ['text', 'html'],
      // Only count shipped lib code (entrypoints/components are UI shells the
      // node suite can't reach — they're e2e territory).
      include: ['lib/**'],
      // Browser-only modules (content-script DOM, canvas, CDP, locale JSON)
      // can't execute under node — they're covered by the e2e suite instead.
      exclude: [
        'lib/i18n/**',
        'lib/inspector/capture.ts',
        'lib/screenshot/capture.ts',
        'lib/screenshot/stitch.ts',
        'lib/screenshot/stitch-page.ts',
        'lib/gif-recording/encode.ts',
        'lib/ai/capture-fx.ts',
      ],
      thresholds: {
        // Floors sit just under the measured baseline of the current suite
        // (global 45/44/43/46) — mostly held down by the laya model runtime in
        // lib/ai and deferred orchestration (relevance-run, capture-flow).
        // Raise as coverage grows; never lower without a reason.
        statements: 44,
        branches: 42,
        functions: 42,
        lines: 45,
        // Security-critical + most-complex modules carry higher floors.
        'lib/gateway/**': { statements: 80, branches: 80, functions: 72, lines: 80 },
        'lib/mcp/**': { statements: 60, branches: 65, functions: 45, lines: 60 },
        'lib/db.ts': { statements: 70, branches: 45, functions: 60, lines: 78 },
        'lib/recording/**': { statements: 88, branches: 78, lines: 90 },
      },
    },
  },
});
