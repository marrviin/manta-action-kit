/**
 * install-prompt tests: token generation persists exactly once and the copied
 * prompt carries the ports + token the MCP server needs (MANTA_TOKEN env).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/storage', () => ({
  settings: {
    mcpAuthToken: {
      getValue: vi.fn(async () => undefined as unknown),
      setValue: vi.fn(async () => undefined as unknown),
    },
  },
}));

import { buildInstallPrompt, ensureMcpAuthToken, MCP_PACKAGE } from '@/lib/mcp/install-prompt';
import { settings } from '@/lib/storage';

const tokenStore = settings.mcpAuthToken as unknown as {
  getValue: ReturnType<typeof vi.fn>;
  setValue: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  tokenStore.getValue.mockResolvedValue(undefined);
});

describe('ensureMcpAuthToken', () => {
  it('returns the stored token without regenerating', async () => {
    tokenStore.getValue.mockResolvedValue('stored-token');
    await expect(ensureMcpAuthToken()).resolves.toBe('stored-token');
    expect(tokenStore.setValue).not.toHaveBeenCalled();
  });

  it('generates, persists and returns a fresh token on first use', async () => {
    const token = await ensureMcpAuthToken();
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokenStore.setValue).toHaveBeenCalledWith(token);
  });
});

describe('buildInstallPrompt', () => {
  it('embeds the package, ports and token env', () => {
    const prompt = buildInstallPrompt(8765, 9000, 'tok-1');
    expect(prompt).toContain(MCP_PACKAGE);
    expect(prompt).toContain('"MANTA_WS_PORT": "8765"');
    expect(prompt).toContain('"MANTA_PROXY_PORT": "9000"');
    expect(prompt).toContain('"MANTA_TOKEN": "tok-1"');
    expect(prompt).toContain('- args: ["-y","@manta-action-kit/mcp"]');
  });
});
