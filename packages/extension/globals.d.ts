// Ensure the `chrome` global namespace (from @types/chrome) is loaded by the
// TS language service. WXT's generated .wxt/tsconfig relies on automatic
// @types resolution, which the IDE's TS server can miss in a pnpm monorepo,
// surfacing "Cannot find name 'chrome'". This explicit reference fixes that.
/// <reference types="chrome" />
// Asset-import suffixes (e.g. lib/inspector/ufo-small.png?inline) — Vite's
// client types declare the `*?raw` / `*?inline` ambient modules. WXT's
// generated tsconfig doesn't include them, so reference explicitly.
/// <reference types="vite/client" />
