import { useCallback, useEffect, useState } from 'react';
import { recordingFilterRules } from '@/lib/storage';
import { uuid } from '@/lib/utils';
import type { RecordingFilterRule } from '@/lib/recording/types';

/**
 * Reactive access to the recording filter rules (blacklist). Reads from `local`
 * storage and stays in sync across contexts; exposes add/update/remove that
 * persist back. All mutations go through storage so the background session picks
 * them up immediately.
 */
export function useRecordingFilterRules() {
  const [rules, setRules] = useState<RecordingFilterRule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    recordingFilterRules.getValue().then((v) => {
      if (!active) return;
      setRules(v);
      setLoading(false);
    });
    const unwatch = recordingFilterRules.watch((v) => setRules(v ?? []));
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  const addRule = useCallback(async (pattern: string) => {
    const rule: RecordingFilterRule = {
      id: uuid(),
      pattern: pattern.trim(),
      enabled: true,
      createdAt: Date.now(),
    };
    const current = await recordingFilterRules.getValue();
    await recordingFilterRules.setValue([rule, ...current]);
  }, []);

  const updateRule = useCallback(
    async (id: string, patch: Partial<Omit<RecordingFilterRule, 'id' | 'createdAt'>>) => {
      const current = await recordingFilterRules.getValue();
      await recordingFilterRules.setValue(
        current.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const removeRule = useCallback(async (id: string) => {
    const current = await recordingFilterRules.getValue();
    await recordingFilterRules.setValue(current.filter((r) => r.id !== id));
  }, []);

  return { rules, loading, addRule, updateRule, removeRule };
}
