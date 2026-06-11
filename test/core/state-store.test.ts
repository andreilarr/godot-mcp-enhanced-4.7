import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileStateStore } from '../../src/core/state-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('FileStateStore', () => {
  let tmpDir: string;
  let store: FileStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-state-test-'));
    store = new FileStateStore(tmpDir);
  });

  afterEach(() => {
    store.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('无状态文件时返回 null', async () => {
    expect(await store.load()).toBeNull();
  });

  it('保存并加载状态', async () => {
    const state = {
      version: 1 as const,
      savedAt: Date.now(),
      agents: {
        '__default__': {
          selectedInstance: { type: 'port' as const, value: '65001' },
          activeProfile: 'full',
          contextMeta: null,
        },
      },
      globalProfile: 'full',
      lastConnectedPort: 65001,
    };

    store.markDirty(() => state);
    await store.flush();

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.agents['__default__'].activeProfile).toBe('full');
  });

  it('验证并丢弃过期的 agent 状态', async () => {
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
    // 直接写入 stale 数据（绕过 flush 的 savedAt 更新），验证 load 时过期检测
    const state = {
      version: 1 as const,
      savedAt: staleTime,
      agents: {
        'old-agent': {
          selectedInstance: null,
          activeProfile: 'minimal',
          contextMeta: null,
        },
      },
      globalProfile: 'full',
      lastConnectedPort: null,
    };

    const dir = path.join(tmpDir, '.godot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp-state.json'), JSON.stringify(state), 'utf-8');

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.agents)).not.toContain('old-agent');
  });

  it('多次 markDirty 调用会防抖', async () => {
    let counter = 0;
    const getState = () => ({
      version: 1 as const,
      savedAt: Date.now(),
      agents: { __default__: { selectedInstance: null, activeProfile: `profile-${counter++}`, contextMeta: null } },
      globalProfile: 'full',
      lastConnectedPort: null,
    });

    store.markDirty(getState);
    store.markDirty(getState);
    store.markDirty(getState);
    await store.flush();

    const loaded = await store.load();
    expect(loaded!.agents['__default__'].activeProfile).toBe('profile-2');
  });
});
