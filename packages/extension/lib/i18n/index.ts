/**
 * Single i18next instance shared by every React entrypoint (popup / side panel)
 * and the content-script toolbar. Resources are bundled (no network load).
 *
 * Default language is English; `sync.ts` reconciles the live setting
 * (`settings.locale`) into `i18n.changeLanguage` on startup and on change, so the
 * initial `lng` here is just the pre-storage fallback.
 *
 * Note: this module only sets up i18next. To keep the UI language in sync with the
 * stored setting, call `initLocaleFromStorage()` (non-React contexts) or render
 * under a component that runs `useSyncLocale()` (see AppProviders).
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';

/** The app's supported UI languages. `settings.locale` is one of these. */
export type Locale = 'en' | 'zh-CN';

/** Ordered list for language pickers. */
export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh-CN'];

/** Bundled translation resources, one namespace ('translation', the default). */
export const resources = {
  en: { translation: en },
  'zh-CN': { translation: zhCN },
} as const;

// Guard against double-init under React StrictMode / multiple entrypoints sharing
// the module in one context.
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export default i18next;
