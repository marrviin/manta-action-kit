/**
 * Doctor tests: pure parts only — env resolution from installed configs
 * (JSON + Codex TOML), the TOML section scraper, node-version floor, and the
 * token-update fix. The interactive check flow is exercised manually (pty).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readInstalledEnv,
  resolveDoctorEnv,
  nodeVersionOk,
  scrapeTomlEnv,
  updateInstalledToken,
} from './doctor.js';
import { AGENTS } from './cli.js';

let dir: string | null = null;
const restores: (() => void)[] = [];

afterEach(async () => {
  restores.splice(0).forEach((r) => r());
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

/** Point an agent's configPath at a temp file (or a missing one) for the test. */
function stubAgent(agentId: string, filePath?: string) {
  const agent = AGENTS.find((a) => a.id === agentId)!;
  const real = agent.configPath;
  agent.configPath = () => filePath ?? join('/nonexistent', `manta-test-${agentId}`);
  restores.push(() => {
    agent.configPath = real;
  });
}

/** Isolate ALL agents so real home configs never leak into the assertions. */
async function isolateAll(): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), 'manta-doctor-test-'));
  for (const a of AGENTS) stubAgent(a.id);
  return dir;
}

const TOML_CONFIG = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.other]',
  'command = "uvx"',
  'env = { MANTA_TOKEN = "other-token" }',
  '',
  '[mcp_servers.manta-action-kit]',
  'command = "npx"',
  'args = ["-y", "@manta-action-kit/mcp@latest"]',
  'env = { MANTA_WS_PORT = "9100", MANTA_PROXY_PORT = "9101", MANTA_TOKEN = "manta-token" }',
].join('\n');

describe('scrapeTomlEnv', () => {
  it('extracts only the manta section values (no leakage from other servers)', () => {
    const env = scrapeTomlEnv(TOML_CONFIG);
    expect(env).not.toBeNull();
    expect(env!.command).toBe('npx');
    expect(env!.args).toBe('["-y", "@manta-action-kit/mcp@latest"]');
    expect(env!.MANTA_TOKEN).toBe('manta-token');
    expect(env!.MANTA_WS_PORT).toBe('9100');
    expect(env!.MANTA_PROXY_PORT).toBe('9101');
  });

  it('returns null when the section is absent', () => {
    expect(scrapeTomlEnv('[mcp_servers.other]\ncommand = "x"\n')).toBeNull();
    expect(scrapeTomlEnv('')).toBeNull();
  });
});

describe('readInstalledEnv / resolveDoctorEnv', () => {
  it('reads ports+token from a JSON config', async () => {
    const root = await isolateAll();
    const path = join(root, 'claude.json');
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          'manta-action-kit': {
            command: 'npx',
            args: [],
            env: { MANTA_WS_PORT: '9200', MANTA_PROXY_PORT: '9201', MANTA_TOKEN: 'json-token' },
          },
        },
      }),
    );
    stubAgent('claude-code', path); // re-stub over the missing-path stub
    const env = await readInstalledEnv();
    expect(env).toEqual({ wsPort: '9200', proxyPort: '9201', token: 'json-token' });
    const resolved = await resolveDoctorEnv();
    // No env vars set in the test process → the installed config wins over defaults.
    if (!process.env.MANTA_WS_PORT) expect(resolved.wsPort).toBe(9200);
    if (!process.env.MANTA_PROXY_PORT) expect(resolved.proxyPort).toBe(9201);
    if (!process.env.MANTA_TOKEN) expect(resolved.token).toBe('json-token');
  });

  it('reads ports+token from a Codex TOML config', async () => {
    const root = await isolateAll();
    const path = join(root, 'config.toml');
    await writeFile(path, TOML_CONFIG);
    stubAgent('codex', path);
    const env = await readInstalledEnv();
    expect(env.token).toBe('manta-token');
    expect(env.wsPort).toBe('9100');
  });

  it('falls back to defaults when nothing is installed', async () => {
    await isolateAll(); // every agent points at a missing path
    const resolved = await resolveDoctorEnv('env-token');
    if (!process.env.MANTA_WS_PORT) expect(resolved.wsPort).toBe(8787);
    if (!process.env.MANTA_PROXY_PORT) expect(resolved.proxyPort).toBe(8788);
    expect(resolved.token).toBe('env-token'); // explicit token wins over installed
  });
});

describe('nodeVersionOk', () => {
  it('accepts >= 18 and rejects older', () => {
    expect(nodeVersionOk('18.0.0')).toBe(true);
    expect(nodeVersionOk('24.19.0')).toBe(true);
    expect(nodeVersionOk('17.9.9')).toBe(false);
    expect(nodeVersionOk('16')).toBe(false);
  });
});

describe('updateInstalledToken', () => {
  it('updates the token in JSON configs preserving other env', async () => {
    const root = await isolateAll();
    const path = join(root, 'cursor.json');
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          'manta-action-kit': {
            command: 'npx',
            args: ['-y', '@manta-action-kit/mcp@latest'],
            env: { MANTA_WS_PORT: '9200', MANTA_PROXY_PORT: '9201', MANTA_TOKEN: 'old' },
          },
          'other-server': { command: 'keep', args: [], env: {} },
        },
      }),
    );
    stubAgent('cursor', path);
    const updated = await updateInstalledToken('new-token');
    expect(updated).toEqual([path]);
    const config = JSON.parse(await readFile(path, 'utf8'));
    const entry = config.mcpServers['manta-action-kit'];
    expect(entry.env).toEqual({
      MANTA_WS_PORT: '9200',
      MANTA_PROXY_PORT: '9201',
      MANTA_TOKEN: 'new-token',
    });
    expect(config.mcpServers['other-server'].command).toBe('keep');
  });

  it('updates the token in a Codex TOML section preserving ports', async () => {
    const root = await isolateAll();
    const path = join(root, 'config.toml');
    await writeFile(path, TOML_CONFIG);
    stubAgent('codex', path);
    const updated = await updateInstalledToken('fresh-token');
    expect(updated).toEqual([path]);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('MANTA_TOKEN = "fresh-token"');
    expect(text).toContain('MANTA_WS_PORT = "9100"');
    expect(text).toContain('MANTA_PROXY_PORT = "9101"');
    expect(text).toContain('command = "npx"');
    expect(text).toContain('"-y"'); // args preserved
    expect(text).toContain('MANTA_TOKEN = "other-token"'); // other server untouched
  });

  it('skips agents without a manta entry (never creates configs)', async () => {
    const root = await isolateAll();
    const path = join(root, 'windsurf.json');
    await writeFile(path, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    stubAgent('windsurf', path);
    const updated = await updateInstalledToken('new-token');
    expect(updated).toEqual([]);
    // File untouched — no entry created as a side effect of a token fix.
    expect(await readFile(path, 'utf8')).toBe(
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
  });
});
