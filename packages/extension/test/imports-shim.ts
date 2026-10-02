/**
 * Node-side stand-in for WXT's virtual `#imports` module: only the exports
 * that transitively-loaded lib modules actually reference. `browser` is a
 * minimal stub for import-time calls (lib/i18n/detect.ts reads
 * `browser.i18n.getUILanguage()` while lib/storage loads); runtime behavior
 * comes from the per-test `vi.stubGlobal('browser', ...)` globals.
 * `storage` is likewise inert: `defineItem` records nothing and reads/writes
 * resolve to undefined, so no import ever reaches chrome.storage (unit tests
 * mock the specific store they exercise).
 */
export const browser = {
  i18n: {
    getUILanguage: () => 'en',
    getMessage: () => '',
  },
  runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
};

const noop = async () => undefined;

export const storage = {
  defineItem: () => ({
    key: '',
    getValue: async () => undefined,
    setValue: noop,
    removeValue: noop,
    getMeta: async () => ({}),
    setMeta: async () => ({}),
    removeMeta: noop,
    watch: () => () => {},
  }),
  getItem: async () => undefined,
  getItems: async () => [],
  setItem: noop,
  setItems: noop,
  removeItem: noop,
  removeItems: noop,
  watch: () => () => {},
  unwatch: noop,
};
