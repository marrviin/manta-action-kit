import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

// See https://wxt.dev/api/config.html
export default defineConfig({
  // React support via WXT module (auto-configures @vitejs/plugin-react).
  modules: ["@wxt-dev/module-react"],

  // Source code lives at the project root (entrypoints/, components/, etc.).
  srcDir: ".",

  manifest: {
    // Localized via _locales/{en,zh_CN}/messages.json. `default_locale` makes
    // Chrome resolve __MSG_*__ placeholders against the browser's UI language
    // (independent of the in-app language switch, which drives only the UI copy).
    default_locale: "en",
    name: "__MSG_extName__",
    short_name: "__MSG_extShortName__",
    description: "__MSG_extDescription__",
    permissions: [
      "storage",
      "sidePanel",
      "cookies",
      "declarativeNetRequestWithHostAccess",
      "alarms",
      // Recording-complete system notification (chrome.notifications). Genuinely
      // used — see the STOP_RECORDING handler in background.ts.
      "notifications",
      // In-page element capture writes its JSON result to the clipboard from
      // the content script (lib/inspector/capture.ts).
      "clipboardWrite",
      // Full-page screenshot: one-shot chrome.debugger attach + CDP
      // Page.captureScreenshot (captureBeyondViewport) — see
      // lib/screenshot/capture.ts. captureVisibleTab needs no extra permission
      // (covered by the <all_urls> host permission below).
      "debugger",
      // GIF recording: capture the active tab (streamId minted in the popup's
      // user gesture, consumed in the offscreen document) — see
      // lib/gif-recording/ and entrypoints/offscreen/.
      "tabCapture",
      // GIF recording pipeline needs a DOM (video/canvas/MediaRecorder) that
      // the MV3 service worker lacks — hosted in an offscreen document.
      "offscreen",
    ],
    // Needed to inject the MAIN-world hook script and read page context (incl.
    // the active tab's URL, covered by the <all_urls> host permission — so no
    // separate `tabs` permission is required).
    host_permissions: ["<all_urls>"],
    // GIF recording uses chrome.runtime.getContexts and
    // chrome.tabCapture.getMediaStreamId — both Chrome 116+. Without this the
    // Store won't filter older browsers and those calls fail at runtime.
    minimum_chrome_version: "116",
    // MAIN-world scripts injected via injectScript() must be web accessible.
    web_accessible_resources: [
      {
        resources: ["injected-api-hook.js"],
        matches: ["<all_urls>"],
      },
    ],
    action: {
      default_title: "__MSG_actionTitle__",
    },
  },

  // Tailwind CSS v4 via its first-party Vite plugin.
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
