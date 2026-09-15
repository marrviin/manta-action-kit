import { useCallback, useEffect, useState } from 'react';
import { sendMessage } from '@/lib/messaging';
import type { GatewayProxyRule } from '@/lib/gateway/types';

/**
 * Loads the proxy rules (script-driven gateway entry) and exposes add/update/delete,
 * each going through the background (which validates) and then refreshing the list.
 */
export function useGatewayProxyRules() {
  const [rules, setRules] = useState<GatewayProxyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sendMessage('LIST_GATEWAY_PROXY_RULES', undefined);
      if (res && '__error' in res) throw new Error((res as { __error: string }).__error);
      setRules(res.rules);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addRule = useCallback(
    async (input: { sandboxPrefix: string; targetBase: string }) => {
      const res = await sendMessage('ADD_GATEWAY_PROXY_RULE', input);
      if (res && '__error' in res) throw new Error((res as { __error: string }).__error);
      await refresh();
    },
    [refresh],
  );

  const updateRule = useCallback(
    async (id: string, patch: Partial<Omit<GatewayProxyRule, 'id' | 'createdAt'>>) => {
      const res = await sendMessage('UPDATE_GATEWAY_PROXY_RULE', { id, patch });
      if (res && '__error' in res) throw new Error((res as { __error: string }).__error);
      await refresh();
    },
    [refresh],
  );

  const removeRule = useCallback(
    async (id: string) => {
      await sendMessage('DELETE_GATEWAY_PROXY_RULE', { id });
      await refresh();
    },
    [refresh],
  );

  return { rules, loading, error, refresh, addRule, updateRule, removeRule };
}
