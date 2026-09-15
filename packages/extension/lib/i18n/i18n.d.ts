/**
 * Bind i18next's types to our bundled resources so `t('...')` keys are
 * autocompleted and type-checked against the authoritative `en` catalog. The
 * default namespace is 'translation' (see index.ts `resources`).
 */
import 'i18next';
import type { en } from './locales/en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }
}
