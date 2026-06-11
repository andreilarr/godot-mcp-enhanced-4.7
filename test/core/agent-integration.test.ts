import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentContextManager, DEFAULT_AGENT_ID } from '../../src/core/agent-context.js';
import { FileStateStore } from '../../src/core/state-store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Agent integration', () => {
  let tmpDir: string;
  let mgr: AgentContextManager;
  let store: FileStateStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-integ-'));
    mgr = new AgentContextManager();
    store = new FileStateStore(tmpDir);
  });

  afterEach(() => {
    store.destroy();
    mgr.destroy();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists and restores agent state across restarts', async () => {
    // 模拟第一次会话
    const agent = mgr.getOrCreate('agent-abc');
    agent.selectedInstance = { type: 'port', value: '65001' };
    agent.activeProfile = 'lite';

    store.markDirty(() => ({
      version: 1,
      savedAt: Date.now(),
      agents: {
        'agent-abc': {
          selectedInstance: agent.selectedInstance,
          activeProfile: agent.activeProfile,
          contextMeta: null,
        },
      },
      globalProfile: 'full',
      lastConnectedPort: 65001,
    }));
    await store.flush();

    // 模拟重启 — 新 manager
    const mgr2 = new AgentContextManager();
    const loaded = await store.load();
    expect(loaded).not.toBeNull();

    for (const [id, agentState] of Object.entries(loaded!.agents)) {
      const state = mgr2.getOrCreate(id);
      state.selectedInstance = agentState.selectedInstance;
      state.activeProfile = agentState.activeProfile;
    }

    const restored = mgr2.getOrCreate('agent-abc');
    expect(restored.selectedInstance).toEqual({ type: 'port', value: '65001' });
    expect(restored.activeProfile).toBe('lite');

    mgr2.destroy();
  });

  it('default agent survives without persistence', () => {
    const def = mgr.getOrCreate(undefined);
    expect(def.agentId).toBe(DEFAULT_AGENT_ID);
    expect(def.isEphemeral).toBe(false);
  });

  it('engine queue blocks concurrent engine ops', async () => {
    const order: string[] = [];

    const p1 = mgr.enqueueEngine(async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push('engine-1');
    });
    const p2 = mgr.enqueueEngine(async () => {
      order.push('engine-2');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['engine-1', 'engine-2']);
  });
});
