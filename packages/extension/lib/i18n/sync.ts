/**
 * Keep the i18next language in sync with the stored `settings.locale`.
 *
 * Two entry points:
 *  - `initLocaleFromStorage()` — for non-React contexts (the content-script
 *    toolbar): read the stored locale once and watch for changes, calling
 *    `changeLanguage`. Returns an unwatch function.
 *  - `useSyncLocale()` — a React hook (used inside AppProviders) that reads the
 *    stored locale reactively and pushes it into i18next. Returns whether the
 *    initial stored value has resolved yet, so callers can gate first paint to
 *    avoid a language flash (see [[popup-dev-flicker]]).
 */
import { useEffect, useState } from 'react';
import { settings } from '@/lib/storage';
import i18n, { type Locale } from './index';

/**
 * Read the stored locale once and keep i18next in sync with later changes.
 * For contexts without React providers (e.g. the content-script toolbar).
 * Returns an unwatch function to stop listening.
 */
export function initLocaleFromStorage(): () => void {
  void settings.locale.getValue().then((loc) => {
    if (loc && loc !== i18n.language) void i18n.changeLanguage(loc);
  });
  return settings.locale.watch((loc) => {
    if (loc && loc !== i18n.language) void i18n.changeLanguage(loc);
  });
}

/**
 * React hook: reflect `settings.locale` into i18next. Returns `{ locale, ready }`
 * — `locale` is the current stored language (fallback until resolved) and `ready`
 * flips true once the initial stored value has loaded, letting the caller gate
 * rendering to prevent a visible language switch on first paint.
 */
export function useSyncLocale(): { locale: Locale; ready: boolean } {
  const [locale, setLocale] = useState<Locale>(settings.locale.fallback as Locale);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    settings.locale.getValue().then((loc) => {
      if (!active) return;
      setLocale(loc);
      setReady(true);
    });
    const unwatch = settings.locale.watch((loc) => {
      setLocale(loc);
    });
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  useEffect(() => {
    if (locale && locale !== i18n.language) void i18n.changeLanguage(locale);
  }, [locale]);

  return { locale, ready };
}
