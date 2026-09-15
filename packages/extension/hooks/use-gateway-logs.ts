import { useCallback, useEffect, useState } from 'react';
import { sendMessage } from '@/lib/messaging';
import type { GatewayLog } from '@/lib/gateway/types';

/**
 * Loads the gateway audit log via the background (source of truth is IndexedDB).
 * Manual refresh + clear; no live subscription (new rows appear on next refresh).
 */
export function useGatewayLogs() {
  const [logs, setLogs] = useState<GatewayLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sendMessage('LIST_GATEWAY_LOGS', undefined);
      if (res && '__error' in res) throw new Error((res as { __error: string }).__error);
      setLogs(res.logs);
      setError(null);
    } catch (err) {
      // Always clear the spinner — otherwise a failed/hung background call leaves
      // the panel loading forever.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clear = useCallback(async () => {
    await sendMessage('CLEAR_GATEWAY_LOGS', undefined);
    await refresh();
  }, [refresh]);

  return { logs, loading, error, refresh, clear };
}
