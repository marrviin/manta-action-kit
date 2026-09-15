import { useCallback, useEffect, useState } from 'react';
import { deleteRecording as dbDelete, listRecordings, renameRecording as dbRename } from '@/lib/db';
import { recordingState } from '@/lib/storage';
import type { Recording } from '@/lib/recording/types';

/**
 * Loads the recording list and keeps it fresh: reloads when a recording finishes
 * (recordingState flips from active back to idle).
 */
export function useRecordings() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listRecordings();
      setRecordings(list);
    } catch (err) {
      // If IndexedDB fails to open (e.g. version upgrade blocked after a hot
      // reload) listRecordings() rejects. Without this catch the promise chain
      // would swallow the error and loading would stay true forever.
      console.error('[manta-action-kit] failed to load recordings', err);
      setRecordings([]);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Always clear loading so the UI never gets stuck on the spinner.
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // When recording stops (active -> false), a new recording was likely saved.
    const unwatch = recordingState.watch((next, prev) => {
      if (prev?.active && !next?.active) refresh();
    });
    return unwatch;
  }, [refresh]);

  const rename = useCallback(
    async (id: string, name: string) => {
      await dbRename(id, name);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await dbDelete(id);
      await refresh();
    },
    [refresh],
  );

  return { recordings, loading, error, refresh, rename, remove };
}
