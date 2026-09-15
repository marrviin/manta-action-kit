import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  // React support via WXT module (auto-configures @vitejs/plugin-react).
  modules: ['@wxt-dev/module-react'],

  // Source code lives at the project root (entrypoints/, components/, etc.).
  srcDir: '.',

  manifest: {
    // Localized via _locales/{en,zh_CN}/messages.json. `default_locale` makes
    // Chrome resolve __MSG_*__ placeholders against the browser's UI language
    // (independent of the in-app language switch, which drives only the UI copy).
    default_locale: 'en',
    name: '__MSG_extName__',
    short_name: '__MSG_extShortName__',
    description: '__MSG_extDescription__',
    permissions: [
      'storage',
      'sidePanel',
      'cookies',
      'declarativeNetRequestWithHostAccess',
      'alarms',
    ],
    // Needed to inject the MAIN-world hook script and read page context (incl.
    // the active tab's URL, covered by the <all_urls> host permission — so no
    // separate `tabs` permission is required).
    host_permissions: ['<all_urls>'],
    // MAIN-world scripts injected via injectScript() must be web accessible.
    web_accessible_resources: [
      {
        resources: ['injected-api-hook.js'],
        matches: ['<all_urls>'],
      },
    ],
    action: {
      default_title: '__MSG_actionTitle__',
    },
  },

  // Tailwind CSS v4 via its first-party Vite plugin.
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
