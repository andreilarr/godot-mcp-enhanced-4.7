import { describe, it, expect, vi, afterEach } from 'vitest';

// mock child_process —— launcher 不应真正启动终端
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
  spawnSync: vi.fn(() => ({ error: null, status: 0, stdout: '', stderr: '' })),
}));

const ORIG_PLATFORM = process.platform;
const ORIG_ENV = { ...process.env };

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}
function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
}

afterEach(() => {
  restorePlatform();
  process.env = { ...ORIG_ENV };
  vi.resetModules();
  vi.clearAllMocks();
});

describe('launchDashboardOnce', () => {
  it('skips when GODOT_MCP_NO_DASHBOARD=1', async () => {
    process.env.GODOT_MCP_NO_DASHBOARD = '1';
    const cp = await import('child_process');
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it('skips when GODOT_MCP_NO_DASHBOARD=true', async () => {
    process.env.GODOT_MCP_NO_DASHBOARD = 'true';
    const cp = await import('child_process');
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it('launches only once per module instance (_launched guard)', async () => {
    const cp = await import('child_process');
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    const countAfterFirst = vi.mocked(cp.spawn).mock.calls.length;
    launchDashboardOnce(); // 第二次调用应为 no-op
    expect(vi.mocked(cp.spawn).mock.calls.length).toBe(countAfterFirst);
  });

  it('win32: spawns powershell Start-Process (IMPORTANT-1 single-quote escape path)', async () => {
    setPlatform('win32');
    const cp = await import('child_process');
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    const psCall = vi.mocked(cp.spawn).mock.calls.find(c => c[0] === 'powershell.exe');
    expect(psCall).toBeDefined();
    const cmdArg = psCall![1].find((a: string) => a.includes('Start-Process'));
    expect(cmdArg).toBeDefined();
    // IMPORTANT-1: ArgumentList 在单引号字面量内(转义后)
    expect(cmdArg).toMatch(/-ArgumentList\s+'/);
  });

  it('linux: probes terminals via spawnSync then spawns (IMPORTANT-2 sync detection)', async () => {
    setPlatform('linux');
    const cp = await import('child_process');
    vi.mocked(cp.spawnSync).mockReturnValue({ error: null, status: 0, stdout: '', stderr: '' });
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    expect(cp.spawnSync).toHaveBeenCalled();
    expect(cp.spawn).toHaveBeenCalled();
  });

  it('linux: skips ENOENT terminal and tries next (IMPORTANT-2 regression)', async () => {
    setPlatform('linux');
    const cp = await import('child_process');
    // gnome-terminal 不存在(ENOENT),konsole 可用
    vi.mocked(cp.spawnSync)
      .mockReturnValueOnce({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' })
      .mockReturnValue({ error: null, status: 0, stdout: '', stderr: '' });
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    // spawnSync 至少探测两次(gnome 失败 → konsole 成功),证明不再"只试第一个就 break"
    expect(vi.mocked(cp.spawnSync).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cp.spawn).toHaveBeenCalled();
  });

  it('darwin: spawns osascript', async () => {
    setPlatform('darwin');
    const cp = await import('child_process');
    const { launchDashboardOnce } = await import('../../src/dashboard/launcher.js');
    launchDashboardOnce();
    const osaCall = vi.mocked(cp.spawn).mock.calls.find(c => c[0] === 'osascript');
    expect(osaCall).toBeDefined();
  });

  it('I-2: clearing GODOT_MCP_NO_DASHBOARD allows launch on next call', async () => {
    process.env.GODOT_MCP_NO_DASHBOARD = '1';
    const cp = await import('child_process');
    const mod = await import('../../src/dashboard/launcher.js');
    mod.launchDashboardOnce();
    expect(cp.spawn).not.toHaveBeenCalled();
    delete process.env.GODOT_MCP_NO_DASHBOARD;
    mod.launchDashboardOnce(); // 清除后应能启动(_launched 未被首次禁用置位)
    expect(cp.spawn).toHaveBeenCalled();
  });
});
