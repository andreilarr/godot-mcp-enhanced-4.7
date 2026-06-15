import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string }) => void) => {
    if (_cmd === 'opencode' && _args[0] === '--version') cb(null, { stdout: '1.0.0' });
    else cb(new Error('unexpected execFile: ' + _cmd + ' ' + JSON.stringify(_args)));
  }),
}));

const TEST_DIR = join(tmpdir(), 'godot-mcp-test-opencode');

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('OpenCodeAdapter', () => {
  it('has correct name', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(new OpenCodeAdapter().name).toBe('OpenCode');
  });

  it('detects installed opencode via --version', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().detect()).toBe(true);
  });

  it('isConfigured returns false when no opencode.json', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().isConfigured(TEST_DIR)).toBe(false);
  });

  it('isConfigured returns true when godot present in mcp', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({ mcp: { godot: { type: 'local', command: ['x'] } } }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().isConfigured(TEST_DIR)).toBe(true);
  });

  it('isConfigured returns false for malformed json', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), '{bad');
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    expect(await new OpenCodeAdapter().isConfigured(TEST_DIR)).toBe(false);
  });

  it('configure writes opencode.json with command array + environment', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot/bin', 'npx', ['godot-mcp-enhanced']);
    const cfg = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    expect(cfg.mcp.godot).toEqual({
      type: 'local',
      command: ['npx', 'godot-mcp-enhanced'],
      environment: { GODOT_PATH: '/godot/bin' },
    });
  });

  it('configure preserves existing top-level keys and other MCP servers', async () => {
    writeFileSync(join(TEST_DIR, 'opencode.json'), JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } } }));
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot', 'node', ['/abs/index.js']);
    const cfg = JSON.parse(readFileSync(join(TEST_DIR, 'opencode.json'), 'utf-8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcp.other).toBeDefined();
    expect(cfg.mcp.godot.command).toEqual(['node', '/abs/index.js']);
  });

  it('configure does NOT call interactive `mcp add` (IMPORTANT-6 regression guard)', async () => {
    const cp = await import('child_process');
    const execFileSpy = vi.mocked(cp.execFile);
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    await new OpenCodeAdapter().configure(TEST_DIR, '/godot', 'npx', ['godot-mcp-enhanced']);
    const mcpAddCalls = execFileSpy.mock.calls.filter((c: unknown[]) => {
      const cmd = c[0] as string;
      const a = c[1] as string[];
      return cmd === 'opencode' && a[0] === 'mcp' && a[1] === 'add';
    });
    expect(mcpAddCalls.length).toBe(0);
    expect(existsSync(join(TEST_DIR, 'opencode.json'))).toBe(true);
  });
});
