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

  it('无状态文件时返回 null', () => {
    expect(store.load()).toBeNull();
  });

  it('保存并加载状态', () => {
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
    store.flush();

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.agents['__default__'].activeProfile).toBe('full');
  });

  it('验证并丢弃过期的 agent 状态', () => {
    const staleTime = Date.now() - 25 * 60 * 60 * 1000;
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

    store.markDirty(() => state);
    store.flush();

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.agents)).not.toContain('old-agent');
  });

  it('多次 markDirty 调用会防抖', () => {
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
    store.flush();

    const loaded = store.load();
    expect(loaded!.agents['__default__'].activeProfile).toBe('profile-2');
  });
});
