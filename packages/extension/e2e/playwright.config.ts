import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * E2E config for the built MV3 extension (.output/chrome-mv3). Run `pnpm
 * build` first — the specs launch Chrome with --load-extension pointing at
 * the production bundle. One worker: every test gets its own browser
 * profile, but they'd otherwise race the same build output.
 */
export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    // playwright-report/index.html — 失败用例附截图/trace 链接；--reporter=list 可临时关掉。
    ["html", { open: "never" }],
  ],
  use: {
    trace: "retain-on-failure",
  },
});
