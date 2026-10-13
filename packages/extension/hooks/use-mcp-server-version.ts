import { useEffect, useState } from 'react';
import { mcpServerVersion } from '@/lib/storage';

/**
 * Live MCP server version, reactive across contexts. The background service
 * worker records the server's WelcomeFrame.version after each successful
 * handshake; null means nothing connected this SW lifetime, or the connected
 * server predates the version exchange (the UI pairs this with the connection
 * status to tell those apart).
 */
export function useMcpServerVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    mcpServerVersion.getValue().then((v) => active && setVersion(v));
    const unwatch = mcpServerVersion.watch((v) => setVersion(v ?? null));
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  return version;
}
