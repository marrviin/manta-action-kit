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
        // (global 55/51/53/57) — mostly held down by the laya model runtime in
        // lib/ai and deferred orchestration (relevance-run, capture-flow).
        // Raise as coverage grows; never lower without a reason.
        statements: 52,
        branches: 49,
        functions: 50,
        lines: 54,
        // Security-critical + most-complex modules carry higher floors.
        'lib/gateway/**': { statements: 81, branches: 82, functions: 74, lines: 81 },
        'lib/mcp/**': { statements: 84, branches: 75, functions: 85, lines: 88 },
        'lib/db.ts': { statements: 85, branches: 60, functions: 72, lines: 92 },
        'lib/recording/**': { statements: 90, branches: 83, lines: 93 },
        'lib/utils.ts': { statements: 85, branches: 79, functions: 88, lines: 83 },
        'lib/screenshot/capture-flow.ts': {
          statements: 100,
          branches: 80,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
