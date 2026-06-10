/**
 * Phase 2 验收测试 — 多实例路由
 *
 * 覆盖：
 * 1. InstanceInfo status 字段行为
 * 2. resolvePort 优先级链
 * 3. sendToInstance HTTP 行为（mocked）
 * 4. 多代理实例隔离
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  InstanceManager,
  type InstanceInfo,
} from '../../src/core/instance-manager.js';
import {
  InstanceRouter,
  type RouterDependencies,
} from '../../src/core/instance-router.js';
import { AgentContextManager, DEFAULT_AGENT_ID } from '../../src/core/agent-context.js';
import type { ToolResult } from '../../src/types.js';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Helpers ────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), 'godot-mcp-phase2-acceptance');

function makeInstance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: 'uuid-test',
    projectPath: 'D:/game',
    projectName: 'game',
    port: 9081,
    pid: 100,
    lastSeen: new Date().toISOString(),
    godotVersion: '4.4',
    capabilities: [],
    ...overrides,
  };
}

function writeInstanceFile(dir: string, info: InstanceInfo): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${info.id}.json`), JSON.stringify(info));
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ─── 1. InstanceInfo status 字段行为 ──────────────────────────────────────────

describe('InstanceInfo status field', () => {
  it('ready instance with recent heartbeat is alive', () => {
    const manager = new InstanceManager({ registryDir: TMP });
    const inst = makeInstance({
      status: 'ready',
      lastSeen: new Date().toISOString(),
    });
    expect(manager.getStatus(inst)).toBe('alive');
  });

  it('compiling instance stays alive even with stale heartbeat', () => {
    const manager = new InstanceManager({ registryDir: TMP, staleTimeoutMs: 70000 });
    const inst = makeInstance({
      status: 'compiling',
      lastSeen: new Date(Date.now() - 80000).toISOString(),
    });
    // compiling overrides stale detection → alive
    expect(manager.getStatus(inst)).toBe('alive');
  });

  it('unresponsive instance is unreachable', () => {
    const manager = new InstanceManager({ registryDir: TMP });
    const inst = makeInstance({
      status: 'unresponsive',
      lastSeen: new Date().toISOString(),
    });
    expect(manager.getStatus(inst)).toBe('unreachable');
  });

  it('instance without status field falls back to heartbeat logic', () => {
    const manager = new InstanceManager({ registryDir: TMP, staleTimeoutMs: 70000 });

    // Recent heartbeat → alive
    const alive = makeInstance({
      lastSeen: new Date().toISOString(),
      // no status field
    });
    expect(manager.getStatus(alive)).toBe('alive');

    // Stale heartbeat → stale
    const stale = makeInstance({
      lastSeen: new Date(Date.now() - 80000).toISOString(),
      // no status field
    });
    expect(manager.getStatus(stale)).toBe('stale');
  });

  it('registeredAt field is preserved through registry round-trip', async () => {
    const ts = Date.now();
    writeInstanceFile(TMP, makeInstance({
      id: 'uuid-reg',
      registeredAt: ts,
    }));

    const manager = new InstanceManager({ registryDir: TMP });
    const instances = await manager.loadFromRegistry();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.registeredAt).toBe(ts);
  });
});

// ─── 2. resolvePort 优先级链 ────────────────────────────────────────────────

describe('resolvePort priority chain', () => {
  it('returns original port when still reachable', async () => {
    const inst = makeInstance({ id: 'i1', port: 65001 });
    const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
    router.updateInstances([inst]);
    router.autoSelect();
    const port = await router.resolvePort();
    expect(port).toBe(65001);
  });

  it('falls back to same-projectPath most recent heartbeat', async () => {
    const inst1 = makeInstance({
      id: 'i1',
      port: 65001,
      lastSeen: new Date(Date.now() - 60000).toISOString(),
    });
    const inst2 = makeInstance({
      id: 'i2',
      port: 65002,
      lastSeen: new Date().toISOString(),
    });
    const router = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: vi.fn() });
    router.updateInstances([inst1, inst2]);

    // Select i1, then simulate i1 gone
    await router.selectInstance('i1');
    router.updateInstances([inst2]);
    // Re-select by projectPath (both share same projectPath)
    router.selectInstanceByProject(inst1.projectPath!);

    const port = await router.resolvePort();
    expect(port).toBe(65002);
  });

  it('falls back to single available instance', async () => {
    const inst = makeInstance({ id: 'i1', port: 65001, projectPath: '/other-project' });
    const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
    router.updateInstances([inst]);
    router.autoSelect();
    const port = await router.resolvePort();
    expect(port).toBe(65001);
  });

  it('returns null when no matching instance', async () => {
    const inst1 = makeInstance({ id: 'i1', port: 65001, projectPath: '/proj-a' });
    const inst2 = makeInstance({ id: 'i2', port: 65002, projectPath: '/proj-b' });
    const router = new InstanceRouter({ instances: [inst1], sendToInstance: vi.fn() });
    router.updateInstances([inst1]);
    router.autoSelect();

    // Now inst1 gone, inst2 is different project
    router.updateInstances([inst2]);
    const port = await router.resolvePort();
    expect(port).toBeNull();
  });
});

// ─── 3. sendToInstance HTTP 行为（mocked） ────────────────────────────────────

describe('sendToInstance HTTP', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Build a real sendToInstance function (mirrors GodotServer.initMultiInstance). */
  function buildSendToInstance(): RouterDependencies['sendToInstance'] {
    return async (instance, toolName, args) => {
      const url = `http://127.0.0.1:${instance.port}/api/${toolName}`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Instance ${instance.id} error: HTTP ${response.status}` }],
            isError: true,
          };
        }
        const data = await response.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Instance ${instance.id} unreachable: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    };
  }

  it('successful request returns parsed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', nodes: [] }),
    });

    const inst = makeInstance({ id: 'i1', port: 9081 });
    const send = buildSendToInstance();
    const result = await send(inst, 'game_query', { action: 'ping' }) as ToolResult;

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('"status": "ok"');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9081/api/game_query',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('HTTP error returns isError ToolResult', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const inst = makeInstance({ id: 'i1', port: 9081 });
    const send = buildSendToInstance();
    const result = await send(inst, 'game_query', { action: 'ping' }) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('HTTP 500');
  });

  it('network error returns isError ToolResult', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const inst = makeInstance({ id: 'i1', port: 9081 });
    const send = buildSendToInstance();
    const result = await send(inst, 'game_query', { action: 'ping' }) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('unreachable');
    expect(text).toContain('fetch failed');
  });

  it('timeout returns isError ToolResult', async () => {
    // Simulate AbortError (timeout)
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'AbortError'),
    );

    const inst = makeInstance({ id: 'i1', port: 9081 });
    const send = buildSendToInstance();
    const result = await send(inst, 'game_query', { action: 'ping' }) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('unreachable');
  });

  it('integrates with InstanceRouter.route for end-to-end flow', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok' }),
    });

    const inst = makeInstance({ id: 'i1', port: 9081 });
    const send = buildSendToInstance();
    const router = new InstanceRouter({ instances: [inst], sendToInstance: send });
    router.autoSelect();

    const result = await router.route('game_query', { action: 'ping' });
    // route returns ToolResult (not error string)
    expect(typeof result).toBe('object');
    expect(result).not.toBeInstanceOf(String);
    const toolResult = result as ToolResult;
    expect(toolResult.isError).toBeFalsy();
  });
});

// ─── 4. 多代理实例隔离 ─────────────────────────────────────────────────────

describe('Multi-agent instance isolation', () => {
  it('different agents can select different instances', async () => {
    const agentCtx = new AgentContextManager();
    const inst1 = makeInstance({ id: 'i1', port: 9081 });
    const inst2 = makeInstance({ id: 'i2', port: 9082 });

    // Simulate two agents each with their own router
    const router1 = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: vi.fn() });
    const router2 = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: vi.fn() });

    // Agent A selects instance i1
    const agentA = agentCtx.getOrCreate('agent-A');
    await router1.selectInstance('i1');
    agentA.selectedInstance = { type: 'port', value: '9081' };

    // Agent B selects instance i2
    const agentB = agentCtx.getOrCreate('agent-B');
    await router2.selectInstance('i2');
    agentB.selectedInstance = { type: 'port', value: '9082' };

    // Verify isolation
    expect(router1.getSelectedId()).toBe('i1');
    expect(router2.getSelectedId()).toBe('i2');
    expect(agentA.selectedInstance!.value).toBe('9081');
    expect(agentB.selectedInstance!.value).toBe('9082');

    agentCtx.destroy();
  });

  it('agent A disconnecting does not affect agent B', async () => {
    const agentCtx = new AgentContextManager();
    const inst = makeInstance({ id: 'i1', port: 9081 });

    const routerA = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
    const routerB = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });

    // Both agents select the same instance
    const agentA = agentCtx.getOrCreate('agent-A');
    const agentB = agentCtx.getOrCreate('agent-B');
    routerA.autoSelect();
    routerB.autoSelect();
    agentA.selectedInstance = { type: 'port', value: '9081' };
    agentB.selectedInstance = { type: 'port', value: '9081' };

    // Agent A disconnects
    agentCtx.remove('agent-A');

    // Agent B is unaffected
    expect(agentCtx.getOrCreate('agent-B').selectedInstance!.value).toBe('9081');
    expect(routerB.getSelectedId()).toBe('i1');

    // Agent A is gone
    expect(agentCtx.getOrCreate('agent-A')).not.toBe(agentA);

    agentCtx.destroy();
  });

  it('default agent persists after ephemeral agents are cleaned up', () => {
    const agentCtx = new AgentContextManager();

    const defaultAgent = agentCtx.getOrCreate(undefined);
    const ephemeral = agentCtx.getOrCreate('agent-eph');

    // Make ephemeral expired
    ephemeral.lastSeen = Date.now() - 31 * 60 * 1000;
    agentCtx.cleanup();

    // Default agent survives
    expect(agentCtx.getOrCreate(undefined)).toBe(defaultAgent);
    // Ephemeral was cleaned up (re-created as new object)
    expect(agentCtx.getOrCreate('agent-eph')).not.toBe(ephemeral);

    agentCtx.destroy();
  });
});
