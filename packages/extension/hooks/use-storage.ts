import { useEffect, useState } from 'react';
import type { WxtStorageItem } from 'wxt/utils/storage';

/**
 * React hook that binds a WXT storage item to component state and keeps it in sync
 * across all extension contexts (other tabs, popup, side panel, background).
 *
 * Usage:
 *   const [enabled, setEnabled] = useStorage(settings.enabled);
 *
 * Pass `initialValue` (pre-read before mount, e.g. awaited in the entrypoint) to
 * skip the fallback→stored-value flash on first paint.
 */
export function useStorage<T>(
  item: WxtStorageItem<T, Record<string, unknown>>,
  initialValue?: T,
): [T, (value: T) => Promise<void>] {
  const [value, setValue] = useState<T>(
    () => initialValue ?? (item.fallback as T),
  );

  useEffect(() => {
    let active = true;
    item.getValue().then((v) => {
      if (active) setValue(v);
    });
    const unwatch = item.watch((v) => setValue(v));
    return () => {
      active = false;
      unwatch();
    };
  }, [item]);

  const update = async (next: T) => {
    await item.setValue(next);
  };

  return [value, update];
}
