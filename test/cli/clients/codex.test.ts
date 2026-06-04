import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: any) => {
    if (_cmd === 'codex' && _args[0] === '--version') cb(null, { stdout: '1.0.0' });
    else if (_cmd === 'codex' && _args[0] === 'mcp' && _args[1] === 'list') cb(null, { stdout: 'godot' });
    else if (_cmd === 'codex' && _args[0] === 'mcp' && _args[1] === 'add') cb(null, { stdout: 'Added' });
    else cb(new Error('not found'));
  }),
}));

describe('CodexAdapter', () => {
  it('has correct name', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    expect(adapter.name).toBe('Codex');
  });

  it('detects installed codex', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    expect(await adapter.detect()).toBe(true);
  });

  it('isConfigured returns true when godot listed', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    expect(await adapter.isConfigured('/tmp')).toBe(true);
  });

  it('configure calls mcp add', async () => {
    const { CodexAdapter } = await import('../../../src/cli/clients/codex.js');
    const adapter = new CodexAdapter();
    await expect(adapter.configure('/tmp', '/godot', 'npx', ['godot-mcp-enhanced'])).resolves.toBeUndefined();
  });
});
