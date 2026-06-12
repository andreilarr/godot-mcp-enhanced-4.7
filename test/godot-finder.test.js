import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process and fs before importing the module under test.
// godot-finder uses execFile (promisified) and existsSync/readdirSync.
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import {
  clearGodotPathCache,
  getCachedGodotPath,
  findGodot,
} from '../src/core/godot-finder.js';

const execFileMock = vi.mocked(execFile);
const existsSyncMock = vi.mocked(existsSync);
const readFileSyncMock = vi.mocked(readFileSync);

beforeEach(() => {
  clearGodotPathCache();
  vi.unstubAllEnvs();
  execFileMock.mockReset();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

// Helper: make execFile return successfully for a given stdout.
function mockExecFileSuccess(stdout) {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    // Handle (cmd, args, cb) form and (cmd, args, opts, cb) form
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (callback) callback(null, { stdout, stderr: '' });
    return undefined;
  });
}

function mockExecFileError() {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    if (callback) callback(new Error('not found'), null);
    return undefined;
  });
}

// ─── clearGodotPathCache / getCachedGodotPath ────────────────────────────────

describe('clearGodotPathCache', () => {
  it('resets cache to null', async () => {
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess('Godot v4.3');

    await findGodot();
    expect(getCachedGodotPath()).toBeTruthy();

    clearGodotPathCache();
    expect(getCachedGodotPath()).toBeNull();
  });
});

describe('getCachedGodotPath', () => {
  it('returns null initially', () => {
    expect(getCachedGodotPath()).toBeNull();
  });
});

// ─── findGodot ───────────────────────────────────────────────────────────────

describe('findGodot', () => {
  it('throws when no godot found anywhere', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileError();

    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('returns GODOT_PATH when valid', async () => {
    vi.stubEnv('GODOT_PATH', '/usr/local/bin/godot4');
    existsSyncMock.mockReturnValue(true);
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot();
    expect(result).toBe('/usr/local/bin/godot4');
    expect(getCachedGodotPath()).toBe('/usr/local/bin/godot4');
  });

  it('skips GODOT_PATH when file does not exist', async () => {
    vi.stubEnv('GODOT_PATH', '/nonexistent/godot');
    // existsSync returns false for GODOT_PATH, true for nothing else needed
    existsSyncMock.mockReturnValue(false);
    // PATH godot also fails
    mockExecFileError();

    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('skips GODOT_PATH when validation fails', async () => {
    vi.stubEnv('GODOT_PATH', '/usr/bin/not-godot');
    // Only GODOT_PATH exists; all other candidates (POSIX paths, etc.) do not
    existsSyncMock.mockImplementation((p) => p === '/usr/bin/not-godot');
    // execFile returns something that is NOT a godot version
    mockExecFileSuccess('some-other-binary 1.0');

    // Will fall through to PATH search (also fails due to mock) then POSIX candidates (all !existsSync)
    await expect(findGodot()).rejects.toThrow('Godot binary not found');
  });

  it('falls back to PATH godot', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);

    // execFile called with 'godot' succeeds
    mockExecFileSuccess('4.3.stable');

    const result = await findGodot();
    expect(result).toBe('godot');
    expect(getCachedGodotPath()).toBe('godot');
  });

  it('accepts godot --version output containing "Godot"', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileSuccess('Godot Engine v4.2.1.stable.official');

    const result = await findGodot();
    expect(result).toBe('godot');
  });

  it('caches result and does not re-search on second call', async () => {
    vi.stubEnv('GODOT_PATH', '');
    existsSyncMock.mockReturnValue(false);
    mockExecFileSuccess('4.3.stable');

    const first = await findGodot();
    expect(first).toBe('godot');

    // Reset mock to track second-call count
    execFileMock.mockClear();

    const second = await findGodot();
    expect(second).toBe('godot');

    // execFile should NOT have been called again (cache hit)
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ─── Project-level override tests ──────────────────────────────────────────────

describe('findGodot with projectPath', () => {
  it('reads godot_path from .godot/mcp-godot.json', async () => {
    const projectPath = '/projects/my-game';
    const godotBin = '/opt/godot/Godot_v4.6.3';

    // existsSync: mcp-godot.json exists, godotBin exists
    existsSyncMock.mockImplementation((p) =>
      p === godotBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: 1, godot_path: godotBin }));
    mockExecFileSuccess('Godot v4.6.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(godotBin);
    expect(getCachedGodotPath(projectPath)).toBe(godotBin);
  });

  it('reads godot_path from project.godot [godot_mcp] section', async () => {
    const projectPath = '/projects/my-game';
    const godotBin = '/opt/godot/Godot_v4.5';

    existsSyncMock.mockImplementation((p) =>
      p === godotBin || p.endsWith('project.godot')
    );
    // mcp-godot.json does NOT exist, but project.godot does
    readFileSyncMock.mockReturnValue(
      '[application]\nconfig/name="Test"\n\n[godot_mcp]\ngodot_path=/opt/godot/Godot_v4.5\n'
    );
    mockExecFileSuccess('Godot v4.5');

    const result = await findGodot(projectPath);
    expect(result).toBe(godotBin);
  });

  it('mcp-godot.json takes priority over project.godot', async () => {
    const projectPath = '/projects/my-game';
    const mcpBin = '/opt/godot/Godot_mcp';
    const pgBin = '/opt/godot/Godot_pg';

    existsSyncMock.mockImplementation((p) =>
      p === mcpBin || p.endsWith('mcp-godot.json') || p.endsWith('project.godot')
    );
    let readCount = 0;
    readFileSyncMock.mockImplementation(() => {
      readCount++;
      if (readCount === 1) return JSON.stringify({ godot_path: mcpBin });
      return `[godot_mcp]\ngodot_path=${pgBin}\n`;
    });
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(mcpBin);
  });

  it('project config takes priority over GODOT_PATH env', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const envBin = '/opt/godot/Env';

    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(projectBin);
  });

  it('falls back to GODOT_PATH when project config has no godot_path', async () => {
    const projectPath = '/projects/my-game';
    const envBin = '/opt/godot/Env';

    vi.stubEnv('GODOT_PATH', envBin);
    // mcp-godot.json exists but has no godot_path
    existsSyncMock.mockImplementation((p) =>
      p === envBin || p.endsWith('mcp-godot.json') || p.endsWith('project.godot')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: 1 }));
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(envBin);
  });

  it('gracefully handles invalid mcp-godot.json', async () => {
    const projectPath = '/projects/my-game';
    const envBin = '/opt/godot/Env';

    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) =>
      p === envBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue('not valid json {{{');
    mockExecFileSuccess('Godot v4.3');

    const result = await findGodot(projectPath);
    expect(result).toBe(envBin); // falls back to env var
  });

  it('per-project cache is independent from global cache', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const globalBin = '/opt/godot/Global';

    // First: resolve for project
    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');
    const projectResult = await findGodot(projectPath);
    expect(projectResult).toBe(projectBin);

    // Second: resolve globally (different path)
    vi.stubEnv('GODOT_PATH', globalBin);
    existsSyncMock.mockImplementation((p) => p === globalBin);
    const globalResult = await findGodot();
    expect(globalResult).toBe(globalBin);

    // Both caches are independent
    expect(getCachedGodotPath(projectPath)).toBe(projectBin);
    expect(getCachedGodotPath()).toBe(globalBin);
  });

  it('clearGodotPathCache(projectPath) only clears that project', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const envBin = '/opt/godot/Env';

    // Setup project cache
    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');
    await findGodot(projectPath);

    // Setup global cache
    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) => p === envBin);
    await findGodot();

    // Clear only project cache
    clearGodotPathCache(projectPath);
    expect(getCachedGodotPath(projectPath)).toBeNull();
    expect(getCachedGodotPath()).toBe(envBin); // global still cached
  });

  it('clearGodotPathCache() without args clears all caches', async () => {
    const projectPath = '/projects/my-game';
    const projectBin = '/opt/godot/Project';
    const envBin = '/opt/godot/Env';

    existsSyncMock.mockImplementation((p) =>
      p === projectBin || p.endsWith('mcp-godot.json')
    );
    readFileSyncMock.mockReturnValue(JSON.stringify({ godot_path: projectBin }));
    mockExecFileSuccess('Godot v4.3');
    await findGodot(projectPath);

    vi.stubEnv('GODOT_PATH', envBin);
    existsSyncMock.mockImplementation((p) => p === envBin);
    await findGodot();

    // Clear all
    clearGodotPathCache();
    expect(getCachedGodotPath(projectPath)).toBeNull();
    expect(getCachedGodotPath()).toBeNull();
  });

  it('error message suggests project config when projectPath is given', async () => {
    const projectPath = '/projects/my-game';

    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue('');
    mockExecFileError();

    await expect(findGodot(projectPath)).rejects.toThrow('mcp-godot.json');
  });

  it('error message does NOT mention project config without projectPath', async () => {
    existsSyncMock.mockReturnValue(false);
    mockExecFileError();

    await expect(findGodot()).rejects.not.toThrow('mcp-godot.json');
  });
});
