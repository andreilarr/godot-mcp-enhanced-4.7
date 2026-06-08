# Phase 2b: 多实例发现与路由 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现多实例发现与路由，让 MCP 服务端能发现、选择、路由到多个同时运行的 Godot 游戏实例。

**Architecture:** 两级注册表（机器级 + 项目级）+ 端口扫描 + 僵尸检测。InstanceManager 负责发现和维护实例列表，InstanceRouter 负责请求路由和切换锁。默认关闭（`GODOT_MCP_MULTI_INSTANCE=false`），需显式启用。

**Tech Stack:** TypeScript, Vitest, Node.js net/fs/path

**设计文档:** `docs/superpowers/specs/2026-06-08-competitive-borrowing-design.md` §2b

**前置:** Phase 1（Tag 过滤 + manage_tools）+ Phase 2a（sanitizePath）已完成。

---

## 文件结构映射

### 新建文件（3 个 TS + 1 个 GDScript 改动）

| 文件 | 职责 |
|------|------|
| `src/core/instance-manager.ts` | InstanceManager：注册表读写、端口扫描、僵尸检测、实例生命周期 |
| `src/core/instance-router.ts` | InstanceRouter：请求路由、切换锁、实例选择策略 |
| `src/tools/instance-tools.ts` | godot_list_instances + godot_select_instance 工具定义与处理 |
| `src/scripts/mcp_bridge.gd` | Bridge autoload 增加注册表心跳（~30 行新增） |

### 改动文件（4 个）

| 文件 | 改动内容 |
|------|---------|
| `src/core/module-loader.ts` | 导入并注册 instanceTools 模块 |
| `src/core/tool-registry.ts` | TOOL_GROUPS 新增 `multi_instance` 组 |
| `src/GodotServer.ts` | 集成 InstanceManager/Router 初始化 |
| `src/core/feature-flags.ts` | MULTI_INSTANCE flag 已存在，无需改动 |

### 测试文件（3 个）

| 文件 | 测试内容 |
|------|---------|
| `test/core/instance-manager.test.ts` | 注册表读写、端口扫描、僵尸检测、实例发现 |
| `test/core/instance-router.test.ts` | 路由、切换锁、选择策略 |
| `test/tools/instance-tools.test.ts` | 工具定义、handleTool |

---

## Task 0: InstanceManager 核心类型与注册表

**Files:**
- Create: `src/core/instance-manager.ts`
- Test: `test/core/instance-manager.test.ts`

- [ ] **Step 1: 写 InstanceManager 测试 — 类型与注册表读写**

```typescript
// test/core/instance-manager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  InstanceManager,
  type InstanceInfo,
  type InstanceStatus,
  discoverInstances,
  getMachineRegistryDir,
} from '../../src/core/instance-manager.js';

const TMP = join(tmpdir(), 'godot-mcp-test-instances');

// Helper: create a mock instance registry file
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

describe('InstanceManager', () => {
  describe('types', () => {
    it('InstanceInfo has required fields', () => {
      const info: InstanceInfo = {
        id: 'uuid-test-1',
        projectPath: 'D:/projects/game',
        projectName: 'game',
        port: 9081,
        pid: 12345,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: ['registry-heartbeat'],
      };
      expect(info.id).toBe('uuid-test-1');
      expect(info.port).toBe(9081);
    });
  });

  describe('registry read/write', () => {
    it('reads instances from machine-level registry', () => {
      const manager = new InstanceManager({ registryDir: TMP });
      writeInstanceFile(TMP, {
        id: 'uuid-1',
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });

      const instances = manager.loadFromRegistry();
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('uuid-1');
    });

    it('reads instances from project-level registry', () => {
      const projectDir = join(TMP, 'project');
      const manager = new InstanceManager({
        registryDir: TMP,
        projectRegistryDir: projectDir,
      });

      writeInstanceFile(projectDir, {
        id: 'uuid-proj-1',
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9082,
        pid: 200,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });

      const instances = manager.loadFromRegistry();
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('uuid-proj-1');
    });

    it('merges machine + project registries, dedup by id', () => {
      const projectDir = join(TMP, 'project');
      const manager = new InstanceManager({
        registryDir: TMP,
        projectRegistryDir: projectDir,
      });

      writeInstanceFile(TMP, {
        id: 'uuid-1',
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });
      writeInstanceFile(projectDir, {
        id: 'uuid-1', // same id, different data — project wins
        projectPath: 'D:/game1',
        projectName: 'game1',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.5',
        capabilities: [],
      });
      writeInstanceFile(projectDir, {
        id: 'uuid-2',
        projectPath: 'D:/game2',
        projectName: 'game2',
        port: 9082,
        pid: 200,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });

      const instances = manager.loadFromRegistry();
      expect(instances).toHaveLength(2);
      const updated = instances.find(i => i.id === 'uuid-1');
      expect(updated?.godotVersion).toBe('4.5');
    });

    it('handles corrupt JSON files gracefully', () => {
      mkdirSync(TMP, { recursive: true });
      writeFileSync(join(TMP, 'bad.json'), '{not valid json');
      writeFileSync(join(TMP, 'good.json'), JSON.stringify({
        id: 'uuid-good',
        projectPath: 'D:/game',
        projectName: 'game',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      }));

      const manager = new InstanceManager({ registryDir: TMP });
      const instances = manager.loadFromRegistry();
      expect(instances).toHaveLength(1);
      expect(instances[0].id).toBe('uuid-good');
    });

    it('handles missing registry directory gracefully', () => {
      const manager = new InstanceManager({ registryDir: join(TMP, 'nonexistent') });
      const instances = manager.loadFromRegistry();
      expect(instances).toHaveLength(0);
    });
  });

  describe('zombie detection', () => {
    it('reports alive for recent instance', () => {
      const manager = new InstanceManager({ registryDir: TMP });
      const status = manager.getStatus({
        id: 'uuid-1',
        projectPath: 'D:/game',
        projectName: 'game',
        port: 9081,
        pid: 100,
        lastSeen: new Date().toISOString(),
        godotVersion: '4.4',
        capabilities: [],
      });
      expect(status).toBe('alive');
    });

    it('reports stale for old instance', () => {
      const manager = new InstanceManager({ registryDir: TMP });
      const oldDate = new Date(Date.now() - 80000).toISOString();
      const status = manager.getStatus({
        id: 'uuid-1',
        projectPath: 'D:/game',
        projectName: 'game',
        port: 9081,
        pid: 100,
        lastSeen: oldDate,
        godotVersion: '4.4',
        capabilities: [],
      });
      expect(status).toBe('stale');
    });
  });

  describe('port range', () => {
    it('default port range is 9081-9090', () => {
      const manager = new InstanceManager({ registryDir: TMP });
      expect(manager.portRange).toEqual([9081, 9090]);
    });

    it('custom port range from env var', () => {
      const original = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
      process.env.GODOT_MCP_INSTANCE_PORT_RANGE = '9000-9010';
      const manager = new InstanceManager({ registryDir: TMP });
      expect(manager.portRange).toEqual([9000, 9010]);
      if (original !== undefined) process.env.GODOT_MCP_INSTANCE_PORT_RANGE = original;
      else delete process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 InstanceManager**

```typescript
// src/core/instance-manager.ts
/**
 * InstanceManager — multi-instance discovery and registry management (Phase 2b)
 *
 * Discovers running Godot instances via:
 * 1. Machine-level registry: ~/.godot-mcp/instances/
 * 2. Project-level registry: {project}/.godot/mcp-instances/
 * 3. Port scanning: 9081-9090
 *
 * Each instance writes its own JSON file (no concurrent write contention).
 * Stale detection: lastSeen > staleTimeout → stale status.
 */

import { readFileSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InstanceInfo {
  id: string;
  projectPath: string;
  projectName: string;
  port: number;
  pid: number;
  lastSeen: string;       // ISO 8601
  godotVersion: string;
  capabilities: string[];  // e.g. ['registry-heartbeat']
}

export type InstanceStatus = 'alive' | 'stale' | 'unreachable';

export interface InstanceManagerOptions {
  /** Machine-level registry directory. Defaults to ~/.godot-mcp/instances/ */
  registryDir?: string;
  /** Project-level registry directory. Optional. */
  projectRegistryDir?: string;
  /** Stale timeout in ms. Defaults to 70000 (70s). */
  staleTimeoutMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_STALE_TIMEOUT_MS = 70000; // 30s × 2 + 10s jitter margin
const DEFAULT_PORT_START = 9081;
const DEFAULT_PORT_END = 9090;

function getDefaultRegistryDir(): string {
  return join(homedir(), '.godot-mcp', 'instances');
}

function parsePortRange(): [number, number] {
  const env = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
  if (!env) return [DEFAULT_PORT_START, DEFAULT_PORT_END];
  const parts = env.split('-').map(Number);
  if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    return [parts[0], parts[1]];
  }
  return [DEFAULT_PORT_START, DEFAULT_PORT_END];
}

// ─── InstanceManager ────────────────────────────────────────────────────────

export class InstanceManager {
  private readonly registryDir: string;
  private readonly projectRegistryDir?: string;
  private readonly staleTimeoutMs: number;
  private readonly _portRange: [number, number];
  private instances: Map<string, InstanceInfo> = new Map();

  constructor(opts: InstanceManagerOptions = {}) {
    this.registryDir = opts.registryDir ?? getDefaultRegistryDir();
    this.projectRegistryDir = opts.projectRegistryDir;
    this.staleTimeoutMs = opts.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
    this._portRange = parsePortRange();
  }

  /** Get configured port range. */
  get portRange(): [number, number] {
    return this._portRange;
  }

  /** Load instances from both registry levels. Machine-level first, then project-level overrides. */
  loadFromRegistry(): InstanceInfo[] {
    const merged = new Map<string, InstanceInfo>();

    // Machine-level first
    const machineInstances = this.readRegistryDir(this.registryDir);
    for (const inst of machineInstances) {
      merged.set(inst.id, inst);
    }

    // Project-level overrides (project wins on duplicate id)
    if (this.projectRegistryDir) {
      const projectInstances = this.readRegistryDir(this.projectRegistryDir);
      for (const inst of projectInstances) {
        merged.set(inst.id, inst);
      }
    }

    this.instances = merged;
    return [...merged.values()];
  }

  /** Get instance by id. */
  getInstance(id: string): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  /** Get all loaded instances. */
  getAllInstances(): InstanceInfo[] {
    return [...this.instances.values()];
  }

  /** Determine status of an instance based on lastSeen timestamp. */
  getStatus(instance: InstanceInfo): InstanceStatus {
    const lastSeen = new Date(instance.lastSeen).getTime();
    const elapsed = Date.now() - lastSeen;
    if (elapsed < this.staleTimeoutMs) return 'alive';
    return 'stale';
  }

  /** Read instance JSON files from a directory. Corrupt/invalid files are skipped. */
  private readRegistryDir(dir: string): InstanceInfo[] {
    const results: InstanceInfo[] = [];
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = readFileSync(join(dir, file), 'utf-8');
          const parsed = JSON.parse(content);
          // Validate required fields
          if (parsed.id && parsed.port && parsed.projectPath) {
            results.push(parsed as InstanceInfo);
          }
        } catch {
          // Skip corrupt/invalid files (ENOENT, SyntaxError, etc.)
        }
      }
    } catch {
      // Directory doesn't exist — return empty
    }
    return results;
  }
}

/** Convenience: get machine-level registry directory path. */
export function getMachineRegistryDir(): string {
  return getDefaultRegistryDir();
}

/** Convenience: discover all instances. Creates a temporary manager and runs discovery. */
export async function discoverInstances(opts?: InstanceManagerOptions): Promise<InstanceInfo[]> {
  const manager = new InstanceManager(opts);
  return manager.loadFromRegistry();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/instance-manager.ts test/core/instance-manager.test.ts
git commit -m "feat(instance): add InstanceManager with registry read/write and zombie detection"
```

---

## Task 1: InstanceRouter 请求路由与切换锁

**Files:**
- Create: `src/core/instance-router.ts`
- Test: `test/core/instance-router.test.ts`

- [ ] **Step 1: 写 InstanceRouter 测试**

```typescript
// test/core/instance-router.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  InstanceRouter,
  type RouterDependencies,
} from '../../src/core/instance-router.js';
import type { InstanceInfo } from '../../src/core/instance-manager.js';

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

describe('InstanceRouter', () => {
  describe('selection strategy', () => {
    it('returns error when no instances available', async () => {
      const router = new InstanceRouter({ instances: [], sendToInstance: vi.fn() });
      const result = await router.route('game_query', { action: 'ping' });
      expect(result).toContain('No instance selected');
    });

    it('auto-selects single instance', () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      expect(router.autoSelect()).toBe('uuid-test');
      expect(router.getSelectedId()).toBe('uuid-test');
    });

    it('requires explicit selection for 2+ instances', () => {
      const inst1 = makeInstance({ id: 'uuid-1', port: 9081 });
      const inst2 = makeInstance({ id: 'uuid-2', port: 9082 });
      const router = new InstanceRouter({
        instances: [inst1, inst2],
        sendToInstance: vi.fn(),
      });
      expect(router.autoSelect()).toBeNull();
    });

    it('selects instance by id', () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      router.selectInstance('uuid-test');
      expect(router.getSelectedId()).toBe('uuid-test');
    });

    it('selects instance by project_path', () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      router.selectInstanceByProject('D:/game');
      expect(router.getSelectedId()).toBe('uuid-test');
    });

    it('rejects unknown instance id', () => {
      const inst = makeInstance();
      const router = new InstanceRouter({ instances: [inst], sendToInstance: vi.fn() });
      expect(() => router.selectInstance('nonexistent')).toThrow('Instance not found');
    });
  });

  describe('routing', () => {
    it('routes request to selected instance', async () => {
      const inst = makeInstance();
      const mockSend = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const router = new InstanceRouter({ instances: [inst], sendToInstance: mockSend });
      router.selectInstance('uuid-test');

      const result = await router.route('game_query', { action: 'ping' });
      expect(mockSend).toHaveBeenCalledWith(inst, 'game_query', { action: 'ping' });
    });

    it('returns error when no instance selected', async () => {
      const inst1 = makeInstance({ id: 'uuid-1' });
      const inst2 = makeInstance({ id: 'uuid-2' });
      const router = new InstanceRouter({
        instances: [inst1, inst2],
        sendToInstance: vi.fn(),
      });
      const result = await router.route('game_query', { action: 'ping' });
      expect(result).toContain('No instance selected');
    });
  });

  describe('switch lock', () => {
    it('queues requests during instance switch', async () => {
      const inst1 = makeInstance({ id: 'uuid-1', port: 9081 });
      const inst2 = makeInstance({ id: 'uuid-2', port: 9082 });
      let resolveSend: () => void;
      const mockSend = vi.fn().mockImplementation(() => new Promise(r => { resolveSend = r; }));

      const router = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: mockSend });
      router.selectInstance('uuid-1');

      // Start a request (will hang until we resolve)
      const reqPromise = router.route('game_query', { action: 'ping' });

      // Switch instance while request is in-flight
      const switchPromise = router.selectInstance('uuid-2');

      // Resolve the in-flight request
      resolveSend!();

      await reqPromise;
      await switchPromise;

      expect(router.getSelectedId()).toBe('uuid-2');
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/instance-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 InstanceRouter**

```typescript
// src/core/instance-router.ts
/**
 * InstanceRouter — request routing with switch lock (Phase 2b)
 *
 * Routes tool requests to the currently selected Godot instance.
 * Instance switching is atomic: in-flight requests complete before the switch.
 */

import type { InstanceInfo } from './instance-manager.js';
import type { ToolResult } from '../types.js';

export interface RouterDependencies {
  instances: InstanceInfo[];
  sendToInstance: (instance: InstanceInfo, toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onInstanceChanged?: (instance: InstanceInfo | null) => void;
}

export class InstanceRouter {
  private readonly deps: RouterDependencies;
  private selectedId: string | null = null;
  private switchLock: Promise<void> = Promise.resolve();

  constructor(deps: RouterDependencies) {
    this.deps = deps;
  }

  /** Get currently selected instance id. */
  getSelectedId(): string | null {
    return this.selectedId;
  }

  /** Get the currently selected InstanceInfo, or null. */
  getSelectedInstance(): InstanceInfo | null {
    if (!this.selectedId) return null;
    return this.deps.instances.find(i => i.id === this.selectedId) ?? null;
  }

  /**
   * Auto-select instance based on count:
   * - 0 instances → null
   * - 1 instance → auto-select
   * - 2+ instances → null (requires explicit selection)
   */
  autoSelect(): string | null {
    if (this.deps.instances.length === 1) {
      this.selectedId = this.deps.instances[0].id;
      return this.selectedId;
    }
    return null;
  }

  /** Select instance by id. Throws if not found. */
  async selectInstance(id: string): Promise<void> {
    const inst = this.deps.instances.find(i => i.id === id);
    if (!inst) throw new Error(`Instance not found: ${id}`);

    // Wait for in-flight requests to complete
    await this.switchLock;

    const prev = this.selectedId;
    this.selectedId = id;
    if (prev !== id) {
      this.deps.onInstanceChanged?.(inst);
    }
  }

  /** Select instance by project path. Returns selected id or null. */
  selectInstanceByProject(projectPath: string): string | null {
    const inst = this.deps.instances.find(i => i.projectPath === projectPath);
    if (!inst) return null;
    this.selectedId = inst.id;
    this.deps.onInstanceChanged?.(inst);
    return inst.id;
  }

  /** Route a tool request to the selected instance. Returns error string if no selection. */
  async route(toolName: string, args: Record<string, unknown>): Promise<ToolResult | string> {
    if (!this.selectedId) {
      return 'No instance selected. Use godot_select_instance first.';
    }
    const instance = this.deps.instances.find(i => i.id === this.selectedId);
    if (!instance) {
      this.selectedId = null;
      return 'Selected instance no longer available. Use godot_list_instances to discover.';
    }

    // Create a new lock entry for this request
    let releaseLock: () => void;
    this.switchLock = new Promise<void>(resolve => { releaseLock = resolve; });

    try {
      return await this.deps.sendToInstance(instance, toolName, args);
    } finally {
      releaseLock!();
    }
  }

  /** Update the available instances list (e.g. after rediscovery). */
  updateInstances(instances: InstanceInfo[]): void {
    this.deps.instances = instances;
    // If selected instance is gone, clear selection
    if (this.selectedId && !instances.find(i => i.id === this.selectedId)) {
      this.selectedId = null;
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/instance-router.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/instance-router.ts test/core/instance-router.test.ts
git commit -m "feat(instance): add InstanceRouter with request routing and switch lock"
```

---

## Task 2: 实例工具 — godot_list_instances + godot_select_instance

**Files:**
- Create: `src/tools/instance-tools.ts`
- Test: `test/tools/instance-tools.test.ts`

- [ ] **Step 1: 写实例工具测试**

```typescript
// test/tools/instance-tools.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  setInstanceManager,
  setInstanceRouter,
} from '../../src/tools/instance-tools.js';
import type { InstanceManager } from '../../src/core/instance-manager.js';
import type { InstanceRouter } from '../../src/core/instance-router.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const mockCtx = {} as ToolContext;

function makeManager(instances: any[] = []): InstanceManager {
  return {
    loadFromRegistry: vi.fn().mockReturnValue(instances),
    getInstance: vi.fn((id: string) => instances.find((i: any) => i.id === id)),
    getAllInstances: vi.fn().mockReturnValue(instances),
    getStatus: vi.fn().mockReturnValue('alive'),
    portRange: [9081, 9090] as [number, number],
  } as unknown as InstanceManager;
}

function makeRouter(selected: string | null = null): InstanceRouter {
  return {
    getSelectedId: vi.fn().mockReturnValue(selected),
    getSelectedInstance: vi.fn().mockReturnValue(null),
    selectInstance: vi.fn().mockResolvedValue(undefined),
    selectInstanceByProject: vi.fn().mockReturnValue(selected),
    autoSelect: vi.fn().mockReturnValue(null),
    route: vi.fn(),
    updateInstances: vi.fn(),
  } as unknown as InstanceRouter;
}

describe('instance-tools', () => {
  describe('getToolDefinitions', () => {
    it('returns 2 tool definitions', () => {
      const defs = getToolDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.name)).toContain('godot_list_instances');
      expect(defs.map(d => d.name)).toContain('godot_select_instance');
    });

    it('godot_list_instances has correct input schema', () => {
      const defs = getToolDefinitions();
      const listDef = defs.find(d => d.name === 'godot_list_instances');
      expect(listDef?.inputSchema).toBeDefined();
      expect(listDef?.annotations?.tags).toContain('group:multi_instance');
    });

    it('godot_select_instance requires instance_id', () => {
      const defs = getToolDefinitions();
      const selectDef = defs.find(d => d.name === 'godot_select_instance');
      expect((selectDef?.inputSchema as any)?.required).toContain('instance_id');
    });
  });

  describe('handleTool', () => {
    it('returns null for unknown tool', async () => {
      const result = await handleTool('unknown_tool', {}, mockCtx);
      expect(result).toBeNull();
    });

    it('godot_list_instances returns instance list', async () => {
      const manager = makeManager([
        { id: 'uuid-1', projectPath: 'D:/game', projectName: 'game', port: 9081, pid: 100, lastSeen: new Date().toISOString(), godotVersion: '4.4', capabilities: [] },
      ]);
      setInstanceManager(manager);
      setInstanceRouter(makeRouter('uuid-1'));

      const result = await handleTool('godot_list_instances', {}, mockCtx);
      expect(result).not.toBeNull();
      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(true);
      expect(parsed.data.instances).toHaveLength(1);
    });

    it('godot_select_instance selects by id', async () => {
      const manager = makeManager([
        { id: 'uuid-1', projectPath: 'D:/game', projectName: 'game', port: 9081, pid: 100, lastSeen: new Date().toISOString(), godotVersion: '4.4', capabilities: [] },
      ]);
      const router = makeRouter(null);
      setInstanceManager(manager);
      setInstanceRouter(router);

      const result = await handleTool('godot_select_instance', { instance_id: 'uuid-1' }, mockCtx);
      expect(result).not.toBeNull();
      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(true);
    });

    it('godot_select_instance rejects unknown id', async () => {
      setInstanceManager(makeManager([]));
      setInstanceRouter(makeRouter(null));

      const result = await handleTool('godot_select_instance', { instance_id: 'nonexistent' }, mockCtx);
      expect(result).not.toBeNull();
      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/instance-tools.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现实例工具**

```typescript
// src/tools/instance-tools.ts
/**
 * Instance tools — godot_list_instances + godot_select_instance (Phase 2b)
 *
 * Tools for discovering and selecting Godot instances in multi-instance mode.
 * Belongs to the 'multi_instance' group. Only available when GODOT_MCP_MULTI_INSTANCE=true.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsSuccess, opsError } from './shared.js';
import type { InstanceManager } from '../core/instance-manager.js';
import type { InstanceRouter } from '../core/instance-router.js';

// ─── Module-level state (set by GodotServer during initialization) ──────────

let _manager: InstanceManager | null = null;
let _router: InstanceRouter | null = null;

export function setInstanceManager(manager: InstanceManager | null): void {
  _manager = manager;
}

export function setInstanceRouter(router: InstanceRouter | null): void {
  _router = router;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'godot_list_instances',
      description: '列出所有发现的 Godot 实例（id/项目/端口/状态）。需要 GODOT_MCP_MULTI_INSTANCE=true。',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
      annotations: { tags: ['group:multi_instance'] },
    },
    {
      name: 'godot_select_instance',
      description: '选择 Godot 实例（id 或 project_path），后续调用路由到该实例。需要 GODOT_MCP_MULTI_INSTANCE=true。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          instance_id: {
            type: 'string',
            description: '实例 ID（从 godot_list_instances 获取）',
          },
          project_path: {
            type: 'string',
            description: '项目路径（二选一，优先 instance_id）',
          },
        },
        required: ['instance_id'],
      },
      annotations: { tags: ['group:multi_instance'] },
    },
  ];
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName === 'godot_list_instances') return handleListInstances();
  if (toolName === 'godot_select_instance') return handleSelectInstance(args);
  return null;
}

function handleListInstances(): ToolResult {
  if (!_manager) {
    return textResult(JSON.stringify(opsError('NOT_INITIALIZED', 'InstanceManager not initialized. Set GODOT_MCP_MULTI_INSTANCE=true.')));
  }

  const instances = _manager.loadFromRegistry();
  const list = instances.map(inst => ({
    id: inst.id,
    projectPath: inst.projectPath,
    projectName: inst.projectName,
    port: inst.port,
    status: _manager.getStatus(inst),
    godotVersion: inst.godotVersion,
  }));

  const selectedId = _router?.getSelectedId() ?? null;

  return textResult(JSON.stringify(opsSuccess({
    instances: list,
    selectedInstanceId: selectedId,
    total: list.length,
  })));
}

async function handleSelectInstance(args: Record<string, unknown>): Promise<ToolResult> {
  if (!_router || !_manager) {
    return textResult(JSON.stringify(opsError('NOT_INITIALIZED', 'InstanceManager/Router not initialized. Set GODOT_MCP_MULTI_INSTANCE=true.')));
  }

  const instanceId = args.instance_id as string | undefined;
  const projectPath = args.project_path as string | undefined;

  if (!instanceId && !projectPath) {
    return textResult(JSON.stringify(opsError('MISSING_PARAMS', 'instance_id or project_path is required')));
  }

  // Refresh instances before selection
  _manager.loadFromRegistry();
  const instances = _manager.getAllInstances();

  let targetId = instanceId;

  // Fallback to project_path match
  if (!targetId && projectPath) {
    const match = instances.find(i => i.projectPath === projectPath);
    if (match) targetId = match.id;
  }

  if (!targetId || !instances.find(i => i.id === targetId)) {
    return textResult(JSON.stringify(opsError('INSTANCE_NOT_FOUND', `Instance not found: ${targetId ?? projectPath}`)));
  }

  try {
    await _router.selectInstance(targetId);
    const instance = _manager.getInstance(targetId)!;
    return textResult(JSON.stringify(opsSuccess({
      selected: {
        id: instance.id,
        projectName: instance.projectName,
        port: instance.port,
      },
    })));
  } catch (err) {
    return textResult(JSON.stringify(opsError('SELECT_FAILED', (err as Error).message)));
  }
}

export const TOOL_META = {
  godot_list_instances: { readonly: true, long_running: false },
  godot_select_instance: { readonly: true, long_running: false },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/instance-tools.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/instance-tools.ts test/tools/instance-tools.test.ts
git commit -m "feat(instance): add godot_list_instances and godot_select_instance tools"
```

---

## Task 3: 注册到 TOOL_GROUPS + module-loader + 集成测试

**Files:**
- Modify: `src/core/tool-registry.ts` — 新增 `multi_instance` 组
- Modify: `src/core/module-loader.ts` — 导入并注册 instanceTools
- Test: 验证全量测试通过

- [ ] **Step 1: 在 tool-registry.ts 新增 multi_instance 组**

在 `TOOL_GROUPS` 中新增一个条目：

```typescript
// 在 TOOL_GROUPS 对象中，recording 之后添加：
  multi_instance: { description: '多实例', tools: ['godot_list_instances', 'godot_select_instance'], requires: [], protected: false },
```

使用 search_and_replace：
- search: `  recording:  { description: '录制', tools: ['recording'], requires: ['bridge'] },`
- replace: `  recording:  { description: '录制', tools: ['recording'], requires: ['bridge'] },\n  multi_instance: { description: '多实例', tools: ['godot_list_instances', 'godot_select_instance'], requires: [] },`

- [ ] **Step 2: 在 module-loader.ts 注册 instanceTools**

在 `module-loader.ts` 中：
1. 新增 import：`import * as instanceTools from '../tools/instance-tools.js';`
2. 在 `ALL_MODULES` 数组末尾添加 `instanceTools`

使用 search_and_replace：
- search: `import * as manageTools from '../tools/manage-tools.js';`
- replace: `import * as manageTools from '../tools/manage-tools.js';\nimport * as instanceTools from '../tools/instance-tools.js';`

- search: `delivery, codeTemplates, ikTools, gameDesign, sceneCommit, manageTools,`
- replace: `delivery, codeTemplates, ikTools, gameDesign, sceneCommit, manageTools, instanceTools,`

- [ ] **Step 3: 运行全量测试**

Run: `npx vitest run`
Expected: ALL PASS（增量 +0，无回归）

- [ ] **Step 4: Commit**

```bash
git add src/core/tool-registry.ts src/core/module-loader.ts
git commit -m "feat(instance): register multi_instance group and instance tools in module loader"
```

---

## Task 4: Bridge GDScript 注册表心跳

**Files:**
- Modify: `src/scripts/mcp_bridge.gd` — 新增注册表写入与清理

- [ ] **Step 1: 在 mcp_bridge.gd 中添加注册表心跳常量和变量**

在现有常量之后（`INACTIVITY_TIMEOUT` 之后）添加：

```gdscript
# ─── Instance Registry (Phase 2b) ─────────────────────────────────────────
const REGISTRY_HEARTBEAT_INTERVAL := 30.0
var _registry_heartbeat_timer: Timer = null
var _registry_file: String = ""
var _instance_id: String = ""
```

- [ ] **Step 2: 在 _start_server() 中启动心跳**

在 `_start_server()` 末尾添加注册表心跳初始化：

```gdscript
	# Instance registry heartbeat (Phase 2b)
	_start_registry_heartbeat()
```

- [ ] **Step 3: 添加注册表心跳方法**

在文件中（`_stop_server()` 之前）添加：

```gdscript
# ─── Instance Registry (Phase 2b) ─────────────────────────────────────────

func _start_registry_heartbeat() -> void:
	_instance_id = str(randi())
	# Machine-level registry
	var machine_dir: String = OS.get_data_dir().get_base_dir().get_base_dir().path_join(".godot-mcp").path_join("instances")
	# Project-level registry
	var project_dir: String = ProjectSettings.globalize_path("user://").path_join(".godot").path_join("mcp-instances")
	_dir_ensure(machine_dir)
	_dir_ensure(project_dir)
	# Write to project-level (machine-level is optional for later)
	_registry_file = project_dir.path_join(_instance_id + ".json")
	_write_registry_entry()
	# Timer
	_registry_heartbeat_timer = Timer.new()
	_registry_heartbeat_timer.wait_time = REGISTRY_HEARTBEAT_INTERVAL
	_registry_heartbeat_timer.one_shot = false
	_registry_heartbeat_timer.autostart = true
	_registry_heartbeat_timer.timeout.connect(_write_registry_entry)
	add_child(_registry_heartbeat_timer)


func _write_registry_entry() -> void:
	if _registry_file == "":
		return
	var entry: Dictionary = {
		"id": _instance_id,
		"projectPath": ProjectSettings.globalize_path("res://"),
		"projectName": ProjectSettings.get_setting("application/config/name"),
		"port": PORT,
		"pid": OS.get_process_id(),
		"lastSeen": Time.get_datetime_string_from_system(),
		"godotVersion": Engine.get_version_info().get("string", "unknown"),
		"capabilities": ["registry-heartbeat"],
	}
	var json: String = JSON.stringify(entry, "\t")
	# Atomic write: temp file → rename
	var tmp_file: String = _registry_file + ".tmp"
	var f: FileAccess = FileAccess.open(tmp_file, FileAccess.WRITE)
	if f == null:
		push_warning("[MCP Bridge] Failed to write registry entry: %s" % FileAccess.get_open_error())
		return
	f.store_string(json)
	f.close()
	DirAccess.rename_absolute(tmp_file, _registry_file)


func _stop_registry_heartbeat() -> void:
	if _registry_heartbeat_timer != null:
		_registry_heartbeat_timer.stop()
		_registry_heartbeat_timer.queue_free()
		_registry_heartbeat_timer = null
	# Clean up registry file on exit
	if _registry_file != "" and FileAccess.file_exists(_registry_file):
		DirAccess.remove_absolute(_registry_file)
	_registry_file = ""


func _dir_ensure(dir: String) -> void:
	if not DirAccess.dir_exists_absolute(dir):
		DirAccess.make_dir_recursive_absolute(dir)
```

- [ ] **Step 4: 在 _stop_server() 中清理注册表**

在 `_stop_server()` 方法的最前面添加：

```gdscript
	_stop_registry_heartbeat()
```

- [ ] **Step 5: 验证 GDScript 语法**

Run: `npx vitest run test/core/instance-manager.test.ts test/core/instance-router.test.ts test/tools/instance-tools.test.ts`
Expected: ALL PASS（GDScript 不在 TS 测试范围内，但确保 TS 侧无回归）

- [ ] **Step 6: Commit**

```bash
git add src/scripts/mcp_bridge.gd
git commit -m "feat(bridge): add instance registry heartbeat to mcp_bridge.gd"
```

---

## Task 5: GodotServer 集成 + 全量回归测试

**Files:**
- Modify: `src/GodotServer.ts` — 条件初始化 InstanceManager/Router

- [ ] **Step 1: 在 GodotServer.ts 中集成 InstanceManager**

在 GodotServer 的 `setupHandlers()` 方法中（或构造后初始化），添加条件初始化：

```typescript
// 在 import 区域添加:
import { InstanceManager } from './core/instance-manager.js';
import { InstanceRouter } from './core/instance-router.js';
import { setInstanceManager, setInstanceRouter } from './tools/instance-tools.js';
import { isFeatureEnabled } from './core/feature-flags.js';
```

在 `setupHandlers()` 或 `run()` 的适当位置添加：

```typescript
    // Phase 2b: Multi-instance initialization (gated by feature flag)
    if (isFeatureEnabled('MULTI_INSTANCE')) {
      const projectDir = ps.getProjectDir();
      const manager = new InstanceManager({
        projectRegistryDir: projectDir
          ? join(projectDir, '.godot', 'mcp-instances')
          : undefined,
      });
      const router = new InstanceRouter({
        instances: manager.loadFromRegistry(),
        sendToInstance: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ error: 'Direct bridge routing not yet implemented' }) }],
        }),
      });
      setInstanceManager(manager);
      setInstanceRouter(router);
      logger.info('instance', 'Multi-instance mode enabled');
    }
```

注意：`sendToInstance` 的完整实现需要桥接到现有 Bridge TCP 连接系统。此处先提供 stub，Phase 4 再完善。

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: 2082+ tests ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/GodotServer.ts
git commit -m "feat(server): integrate InstanceManager/Router initialization with feature flag"
```

---

## 验收标准

- [ ] InstanceManager 能从两级注册表读取、合并、去重实例
- [ ] 僵尸实例检测（70s 阈值）区分 alive/stale
- [ ] InstanceRouter 路由请求到选定实例，切换时带锁保护
- [ ] 自动选择策略：0→错误、1→自动、2+→显式
- [ ] godot_list_instances + godot_select_instance 工具定义和 handler 正确
- [ ] multi_instance 组注册到 TOOL_GROUPS + module-loader
- [ ] mcp_bridge.gd 注册表心跳（30s）+ 退出清理
- [ ] GODOT_MCP_MULTI_INSTANCE=false（默认）时实例工具不可见
- [ ] 全量 2082+ 测试通过，零回归
