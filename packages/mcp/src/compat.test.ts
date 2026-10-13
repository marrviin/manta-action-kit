/**
 * Version-compat diagnostics tests: semver comparison, the verdict/hint
 * matrix, and the lockstep version invariant across packages (extension ↔ MCP
 * server ship on one version number — py ↔ node is pinned separately by
 * packages/mcp-py/tests/test_node_parity.py).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { semverCompare, compatVerdict, continueOnErrorHint } from './compat.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('semverCompare', () => {
  it('orders patch/minor/major and tolerates missing segments', () => {
    expect(semverCompare('1.2.3', '1.2.3')).toBe(0);
    expect(semverCompare('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(semverCompare('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(semverCompare('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(semverCompare('1.2', '1.2.1')).toBeLessThan(0);
    expect(semverCompare('v1.2.3', '1.2.3')).toBe(0);
  });
});

describe('compatVerdict', () => {
  it('matches on identical versions', () => {
    expect(compatVerdict('0.5.4', '0.5.4')).toEqual({ match: true, hint: null });
  });

  it('points at the extension when the server is newer', () => {
    const { match, hint } = compatVerdict('0.6.0', '0.5.4');
    expect(match).toBe(false);
    expect(hint).toContain('extension');
    expect(hint).toContain('NEWER than the Chrome extension');
    expect(hint).toContain('0.6.0');
  });

  it('points at the MCP server when the extension is newer', () => {
    const { match, hint } = compatVerdict('0.5.4', '0.6.0');
    expect(match).toBe(false);
    expect(hint).toContain('NEWER than the MCP server');
    expect(hint).toContain('npx');
  });

  it('stays silent (but not matching) when either version is unknown', () => {
    expect(compatVerdict(null, '0.5.4')).toEqual({ match: false, hint: null });
    expect(compatVerdict('0.5.4', undefined)).toEqual({ match: false, hint: null });
    expect(compatVerdict('', '')).toEqual({ match: false, hint: null });
  });
});

describe('continueOnErrorHint', () => {
  it('explains the ignored param and the fix', () => {
    const hint = continueOnErrorHint();
    expect(hint).toContain('continueOnError');
    expect(hint).toContain("'aborted'");
    expect(hint).toContain('health');
  });
});

describe('lockstep version invariant', () => {
  it('extension and MCP server package versions are identical', () => {
    const read = (rel: string) =>
      (JSON.parse(readFileSync(path.join(pkgRoot, rel), 'utf8')) as { version: string })
        .version;
    const ext = read('extension/package.json');
    const mcp = read('mcp/package.json');
    expect(ext).toBe(mcp);
    // The py side is pinned to the Node server by
    // packages/mcp-py/tests/test_node_parity.py::test_version_matches_node_server.
  });
});
