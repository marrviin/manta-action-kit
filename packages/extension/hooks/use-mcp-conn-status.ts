import { useEffect, useState } from 'react';
import { mcpConnStatus, type McpConnStatus } from '@/lib/storage';

/**
 * Live MCP bridge connection status, reactive across contexts. The background
 * service worker owns the WebSocket and publishes its state to session storage;
 * this reads + watches it so the MCP tab shows an up-to-date indicator.
 */
export function useMcpConnStatus(): McpConnStatus {
  const [status, setStatus] = useState<McpConnStatus>('connecting');

  useEffect(() => {
    let active = true;
    mcpConnStatus.getValue().then((v) => active && setStatus(v));
    const unwatch = mcpConnStatus.watch((v) => setStatus(v ?? 'connecting'));
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  return status;
}
