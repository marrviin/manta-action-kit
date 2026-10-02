/**
 * Baseline extension globals for every unit test. Modules like lib/storage
 * touch `browser.i18n` at import time (locale detection); individual tests
 * stub richer shapes over these with vi.stubGlobal as needed.
 */
import { vi } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
});
vi.stubGlobal('browser', {
  runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
  i18n: { getMessage: () => '' },
});
