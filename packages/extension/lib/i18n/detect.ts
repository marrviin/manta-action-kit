/**
 * Detect the default UI language from the browser itself — not the OS, not
 * `navigator.language` (which follows per-site content settings). Chrome exposes
 * the language the browser chrome runs in via `i18n.getUILanguage()` (BCP-47,
 * e.g. 'zh-CN' / 'en-US'), which is what "follow the browser" should mean here.
 *
 * Kept dependency-free (no i18next) so it can be used as the storage fallback
 * in `lib/storage.ts` from any context.
 */
import { browser } from '#imports';
import type { Locale } from './index';

/** Map the browser UI language onto the locales we actually bundle. */
export function detectLocale(): Locale {
  const ui = browser.i18n.getUILanguage().toLowerCase();
  return ui.startsWith('zh') ? 'zh-CN' : 'en';
}
