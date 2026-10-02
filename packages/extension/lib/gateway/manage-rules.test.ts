/**
 * manage-rules tests (db mocked): the single add/patch path both the UI and the
 * agent tools share. Security property under test: `enabled` and `createdBy`
 * are ALWAYS caller-decided — no agent input can smuggle them in — and content
 * patches re-validate with the self-rule excluded from the prefix uniqueness check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  listGatewayProxyRules: vi.fn(),
  upsertGatewayProxyRule: vi.fn(async () => {}),
}));

import { addProxyRule, updateProxyRuleContent } from '@/lib/gateway/manage-rules';
import { listGatewayProxyRules, upsertGatewayProxyRule } from '@/lib/db';
import type { GatewayProxyRule } from '@/lib/gateway/types';

const listRules = vi.mocked(listGatewayProxyRules);
const upsert = vi.mocked(upsertGatewayProxyRule);

const rule = (over: Partial<GatewayProxyRule> = {}): GatewayProxyRule => ({
  id: 'p1',
  sandboxPrefix: '/api',
  targetBase: 'https://api.example.com',
  enabled: true,
  createdBy: 'user',
  createdAt: 1,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listRules.mockResolvedValue([]);
});

describe('addProxyRule', () => {
  it('normalizes the prefix and persists caller-decided enabled/createdBy', async () => {
    const created = await addProxyRule(
      { sandboxPrefix: 'api', targetBase: '  https://api.example.com  ' as never },
      true,
      'agent',
    );
    expect(created.sandboxPrefix).toBe('/api');
    expect(created.enabled).toBe(true);
    expect(created.createdBy).toBe('agent');
    expect(upsert).toHaveBeenCalledWith(created);
  });

  it('rejects invalid input without touching the store', async () => {
    await expect(addProxyRule({ sandboxPrefix: '', targetBase: 'https://x' }, true, 'user')).rejects.toThrow();
    await expect(
      addProxyRule({ sandboxPrefix: '/sp ace', targetBase: 'https://x' }, true, 'user'),
    ).rejects.toThrow(/spaces/);
    await expect(
      addProxyRule({ sandboxPrefix: '/api', targetBase: 'not a url' }, true, 'user'),
    ).rejects.toThrow(/http/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('enforces unique prefixes against existing rules', async () => {
    listRules.mockResolvedValue([rule({ sandboxPrefix: '/api' })]);
    await expect(
      addProxyRule({ sandboxPrefix: '/api', targetBase: 'https://other' }, true, 'user'),
    ).rejects.toThrow(/already used/);
  });
});

describe('updateProxyRuleContent', () => {
  it('patches content fields only and preserves enabled/createdBy/timestamps', async () => {
    const existing = rule({ enabled: false, createdBy: 'user', createdAt: 42 });
    listRules.mockResolvedValue([existing]);
    const next = await updateProxyRuleContent('p1', { targetBase: 'https://new.example.com' });
    expect(next).toEqual({
      ...existing,
      targetBase: 'https://new.example.com',
      id: 'p1',
    });
    expect(next.enabled).toBe(false);
    expect(upsert).toHaveBeenCalledWith(next);
  });

  it('throws for a missing rule', async () => {
    listRules.mockResolvedValue([]);
    await expect(
      updateProxyRuleContent('nope', { targetBase: 'https://x' }),
    ).rejects.toThrow(/not found/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('re-validates a changed prefix against OTHER rules only (self-excluded)', async () => {
    listRules.mockResolvedValue([
      rule({ id: 'p1', sandboxPrefix: '/api' }),
      rule({ id: 'p2', sandboxPrefix: '/other' }),
    ]);
    // Moving p1 onto p2's prefix collides.
    await expect(
      updateProxyRuleContent('p1', { sandboxPrefix: '/other' }),
    ).rejects.toThrow();
    // Keeping its own prefix is fine (a naive uniqueness check would collide with itself).
    const next = await updateProxyRuleContent('p1', { sandboxPrefix: '/api/' });
    expect(next.sandboxPrefix).toBe('/api');
  });

  it('an empty patch is a valid no-op save', async () => {
    const existing = rule();
    listRules.mockResolvedValue([existing]);
    const next = await updateProxyRuleContent('p1', {});
    expect(next).toEqual(existing);
    expect(upsert).toHaveBeenCalledWith(next);
  });
});
