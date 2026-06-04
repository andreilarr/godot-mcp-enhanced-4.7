import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: any) => {
    if (_cmd === 'opencode' && _args[0] === '--version') cb(null, { stdout: '1.0.0' });
    else if (_cmd === 'opencode' && _args[0] === 'mcp' && _args[1] === 'list') cb(null, { stdout: 'godot\nother' });
    else if (_cmd === 'opencode' && _args[0] === 'mcp' && _args[1] === 'add') cb(null, { stdout: 'Added' });
    else cb(new Error('not found'));
  }),
}));

describe('OpenCodeAdapter', () => {
  it('has correct name', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    const adapter = new OpenCodeAdapter();
    expect(adapter.name).toBe('OpenCode');
  });

  it('detects installed opencode', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    const adapter = new OpenCodeAdapter();
    expect(await adapter.detect()).toBe(true);
  });

  it('isConfigured returns true when godot listed', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    const adapter = new OpenCodeAdapter();
    expect(await adapter.isConfigured('/tmp')).toBe(true);
  });

  it('configure calls mcp add', async () => {
    const { OpenCodeAdapter } = await import('../../../src/cli/clients/opencode.js');
    const adapter = new OpenCodeAdapter();
    await expect(adapter.configure('/tmp', '/godot', 'npx', ['godot-mcp-enhanced'])).resolves.toBeUndefined();
  });
});
