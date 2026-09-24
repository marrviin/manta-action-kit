import { useCallback, useEffect, useState } from 'react';
import {
  deleteGifDraft,
  deleteInspectorCapture,
  deleteScreenshotHistory,
  listGifHistory,
  listInspectorCaptures,
  listScreenshotHistory,
} from '@/lib/db';
import type { InspectorHistoryEntry } from '@/lib/db';
import type { GifDraftMeta } from '@/lib/gif-recording/types';
import type { ScreenshotHistoryMeta } from '@/lib/screenshot/types';

/**
 * Loads the three "page capture" histories (element captures / screenshots /
 * GIF recordings) for the side-panel capture tab. There is no cross-context
 * storage signal for IDB writes, so the lists refresh on mount, when the panel
 * becomes visible again, and after any local removal.
 */
export function useCaptureHistory() {
  const [captures, setCaptures] = useState<InspectorHistoryEntry[]>([]);
  const [screenshots, setScreenshots] = useState<ScreenshotHistoryMeta[]>([]);
  const [gifs, setGifs] = useState<GifDraftMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [c, s, g] = await Promise.all([
        listInspectorCaptures(),
        listScreenshotHistory(),
        listGifHistory(),
      ]);
      setCaptures(c);
      setScreenshots(s);
      setGifs(g);
    } catch (err) {
      // Same rationale as useRecordings: a rejected openDb() must not leave
      // the UI stuck on the spinner.
      console.error('[capture-history] failed to load histories', err);
      setCaptures([]);
      setScreenshots([]);
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Captures/screenshots/GIFs are written by the background or preview tabs —
    // refresh whenever the user comes back to this panel.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const removeCapture = useCallback(
    async (id: string) => {
      await deleteInspectorCapture(id);
      await refresh(true);
    },
    [refresh],
  );

  const removeScreenshot = useCallback(
    async (id: string) => {
      await deleteScreenshotHistory(id);
      await refresh(true);
    },
    [refresh],
  );

  const removeGif = useCallback(
    async (id: string) => {
      await deleteGifDraft(id);
      await refresh(true);
    },
    [refresh],
  );

  return {
    captures,
    screenshots,
    gifs,
    loading,
    refresh,
    removeCapture,
    removeScreenshot,
    removeGif,
  };
}
