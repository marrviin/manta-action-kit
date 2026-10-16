/**
 * CLI subcommand tests: version/help arg routing, JSON + TOML config upserts,
 * and install-prompt field extraction. The interactive multi-select itself is
 * not unit-tested (raw-mode TTY interaction); every pure piece it relies on is.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildServerEntry,
  upsertJsonServer,
  upsertCodexServer,
  codexSection,
  extractInstallFields,
  handleCli,
  SERVER_KEY,
  MCP_PACKAGE,
} from './cli.js';

let dir: string | null = null;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

async function tempPath(name: string): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), 'manta-cli-test-'));
  return join(dir, name);
}

const ENTRY = buildServerEntry(8787, 8788, 'test-token');

describe('buildServerEntry', () => {
  it('mirrors the extension install prompt: unpinned npx + port/token env', () => {
    expect(ENTRY.command).toBe('npx');
    expect(ENTRY.args).toEqual(['-y', `${MCP_PACKAGE}@latest`]);
    expect(ENTRY.env).toEqual({
      MANTA_WS_PORT: '8787',
      MANTA_PROXY_PORT: '8788',
      MANTA_TOKEN: 'test-token',
    });
  });

  it('omits MANTA_TOKEN when no token was resolved (server fails closed, config still valid)', () => {
    const { env } = buildServerEntry(1, 2);
    expect(env).toEqual({ MANTA_WS_PORT: '1', MANTA_PROXY_PORT: '2' });
  });
});

describe('upsertJsonServer', () => {
  it('creates a fresh config with the server entry', async () => {
    const p = await tempPath('claude.json');
    const outcome = await upsertJsonServer(p, 'mcpServers', ENTRY);
    expect(outcome).toBe('created');
    const config = JSON.parse(await readFile(p, 'utf8'));
    expect(config.mcpServers[SERVER_KEY]).toEqual(ENTRY);
  });

  it('preserves other servers and keys on update, replacing only our entry', async () => {
    const p = await tempPath('cursor.json');
    await writeFile(
      p,
      JSON.stringify({
        otherSetting: true,
        mcpServers: {
          'manta-action-kit': { command: 'old', args: [], env: {} },
          'other-server': { command: 'keep', args: ['x'], env: {} },
        },
      }),
    );
    const outcome = await upsertJsonServer(p, 'mcpServers', ENTRY);
    expect(outcome).toBe('updated');
    const config = JSON.parse(await readFile(p, 'utf8'));
    expect(config.otherSetting).toBe(true);
    expect(config.mcpServers['other-server']).toEqual({
      command: 'keep',
      args: ['x'],
      env: {},
    });
    expect(config.mcpServers[SERVER_KEY]).toEqual(ENTRY);
  });

  it('uses the given root key (VS Code writes "servers")', async () => {
    const p = await tempPath('vscode-mcp.json');
    await upsertJsonServer(p, 'servers', ENTRY);
    const config = JSON.parse(await readFile(p, 'utf8'));
    expect(config.servers[SERVER_KEY]).toEqual(ENTRY);
    expect(config.mcpServers).toBeUndefined();
  });

  it('creates missing parent directories', async () => {
    const p = await tempPath('nested/deeper/mcp.json');
    await upsertJsonServer(p, 'mcpServers', ENTRY);
    expect(JSON.parse(await readFile(p, 'utf8')).mcpServers[SERVER_KEY]).toEqual(ENTRY);
  });

  it('refuses to silently truncate a corrupted config', async () => {
    const p = await tempPath('broken.json');
    await writeFile(p, '{ not json');
    await expect(upsertJsonServer(p, 'mcpServers', ENTRY)).rejects.toThrow(
      /not valid JSON/,
    );
    // The garbage must still be there — never destructive on parse failure.
    expect(await readFile(p, 'utf8')).toBe('{ not json');
  });

  it('refuses when the root key is not an object', async () => {
    const p = await tempPath('weird.json');
    await writeFile(p, JSON.stringify({ mcpServers: ['nope'] }));
    await expect(upsertJsonServer(p, 'mcpServers', ENTRY)).rejects.toThrow(
      /not an object/,
    );
  });
});

describe('upsertCodexServer', () => {
  it('creates a new config.toml with the section', async () => {
    const p = await tempPath('config.toml');
    const outcome = await upsertCodexServer(p, ENTRY);
    expect(outcome).toBe('created');
    const text = await readFile(p, 'utf8');
    expect(text).toContain('[mcp_servers.manta-action-kit]');
    expect(text).toContain('command = "npx"');
    expect(text).toContain('MANTA_TOKEN = "test-token"');
  });

  it('appends to an existing config without touching other sections', async () => {
    const p = await tempPath('config.toml');
    await writeFile(
      p,
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "uvx"\n',
    );
    const outcome = await upsertCodexServer(p, ENTRY);
    expect(outcome).toBe('created');
    const text = await readFile(p, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[mcp_servers.other]');
    expect(text.indexOf('[mcp_servers.other]')).toBeLessThan(
      text.indexOf('[mcp_servers.manta-action-kit]'),
    );
  });

  it('replaces an existing manta section in place, preserving the rest', async () => {
    const p = await tempPath('config.toml');
    const first = buildServerEntry(1111, 2222, 'old-token');
    await writeFile(
      p,
      ['model = "gpt-5"', '', ...codexSection(first), '', '[profiles.fast]', 'model = "mini"'].join('\n'),
    );
    const outcome = await upsertCodexServer(p, ENTRY);
    expect(outcome).toBe('updated');
    const text = await readFile(p, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[profiles.fast]');
    expect(text).toContain('MANTA_WS_PORT = "8787"');
    expect(text).not.toContain('1111');
    expect(text).not.toContain('old-token');
    // Section order kept: manta before the profile section that followed it.
    expect(text.indexOf('[mcp_servers.manta-action-kit]')).toBeLessThan(
      text.indexOf('[profiles.fast]'),
    );
  });
});

describe('extractInstallFields', () => {
  it('parses a full pasted install prompt', () => {
    const prompt = [
      'Install this MCP service into your MCP config:',
      '- name: manta-action-kit',
      '- command: npx',
      '- args: ["-y","@manta-action-kit/mcp@latest"]',
      '- env: { "MANTA_WS_PORT": "9100", "MANTA_PROXY_PORT": "9101", "MANTA_TOKEN": "abc-uuid" }',
    ].join('\n');
    expect(extractInstallFields(prompt)).toEqual({
      token: 'abc-uuid',
      wsPort: 9100,
      proxyPort: 9101,
    });
  });

  it('accepts a bare token UUID', () => {
    expect(
      extractInstallFields('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    ).toEqual({ token: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
  });

  it('returns empty for unrelated input', () => {
    expect(extractInstallFields('hello world')).toEqual({});
    expect(extractInstallFields('')).toEqual({});
  });
});

describe('handleCli routing', () => {
  it('handles -v / --version / version', async () => {
    for (const arg of ['-v', '--version', 'version']) {
      expect(await handleCli([arg])).toBe(true);
    }
  });

  it('handles init aliases and help', async () => {
    // runInit would block on interactive stdin, so only check the non-interactive aliases here.
    expect(await handleCli(['-h'])).toBe(true);
    expect(await handleCli(['--help'])).toBe(true);
  });

  it('returns false for no args (server mode)', async () => {
    expect(await handleCli([])).toBe(false);
  });

  it('rejects unknown args with a usage hint (still no server start)', async () => {
    expect(await handleCli(['bogus'])).toBe(true);
  });
});
