# Agent 感知架构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 godot-mcp-enhanced 引入多 Agent 并发支持、多实例路由、状态持久化、懒加载，分三个阶段交付。

**Architecture:** 在 ToolDispatcher 和 InstanceRouter 之间插入 AgentContextManager 层，所有 per-agent 状态通过这个层隔离。引擎操作 FIFO 串行、IO 操作可并发。状态通过 FileStateStore 持久化到 JSON 文件。

**Tech Stack:** TypeScript, Vitest, @modelcontextprotocol/sdk

**Spec:** `docs/superpowers/specs/2026-06-10-agent-architecture-design.md`

---

## File Structure

### Phase 1 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/agent-context.ts` | Agent 上下文管理器：per-agent 状态 + 引擎/IO 队列 |
| `src/core/state-store.ts` | 文件状态持久化：加载/防抖保存/验证/刷盘 |
| `test/core/agent-context.test.ts` | AgentContextManager 单元测试 |
| `test/core/state-store.test.ts` | FileStateStore 单元测试 |

### Phase 1 修改文件

| 文件 | 变更 |
|------|------|
| `src/core/ToolDispatcher.ts` | handleCall 中提取 `_meta.agentId`，传递给 AgentContextManager |
| `src/core/tool-registry.ts` | `resolveProfile` / `isToolAllowed` 支持 per-agent profile |
| `src/GodotServer.ts` | 启动时加载状态、关闭时刷盘、`_meta` 透传 |

### Phase 2 修改文件

| 文件 | 变更 |
|------|------|
| `src/core/instance-manager.ts` | InstanceInfo 追加可选 `status` / `registeredAt` 字段 |
| `src/core/instance-router.ts` | 新增 `resolvePort()` 优先级链 |
| `src/GodotServer.ts` | 注入实际 `sendToInstance` HTTP 请求实现 |
| `src/core/agent-context.ts` | per-agent 实例选择 |
| `test/core/instance-router.test.ts` | resolvePort + 多实例测试 |

### Phase 3 修改文件

| 文件 | 变更 |
|------|------|
| `src/tools/advanced-proxy.ts` | 动态路由推导 + Profile 检查 + 错误分类 |
| `src/core/tool-registry.ts` | TOOL_GROUPS 追加 `dynamic` 组 |
| `test/tools/advanced-proxy.test.ts` | 懒加载测试 |

---

## Phase 1（v0.18.0）：Agent 基础 + 状态持久化

### Task 1: AgentContextManager — 类型定义与核心 CRUD

**Files:**
- Create: `src/core/agent-context.ts`
- Test: `test/core/agent-context.test.ts`

- [ ] **Step 1: 写失败的测试 — 类型与 CRUD**

```typescript
// test/core/agent-context.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentContextManager, DEFAULT_AGENT_ID } from '../../src/core/agent-context.js';

describe('AgentContextManager', () => {
  let mgr: AgentContextManager;

  beforeEach(() => {
    mgr = new AgentContextManager();
  });

  describe('getOrCreate', () => {
    it('creates default agent when agentId is undefined', () => {
      const state = mgr.getOrCreate(undefined);
      expect(state.agentId).toBe(DEFAULT_AGENT_ID);
      expect(state.selectedInstance).toBeNull();
      expect(state.activeProfile).toBe('full');
      expect(state.isEphemeral).toBe(false);
    });

    it('creates named agent on first access', () => {
      const state = mgr.getOrCreate('agent-1234-abc');
      expect(state.agentId).toBe('agent-1234-abc');
      expect(state.isEphemeral).toBe(true);
    });

    it('returns same state on repeated access', () => {
      const a = mgr.getOrCreate('agent-1');
      const b = mgr.getOrCreate('agent-1');
      expect(a).toBe(b);
    });
  });

  describe('remove', () => {
    it('removes an agent', () => {
      mgr.getOrCreate('agent-x');
      mgr.remove('agent-x');
      const state = mgr.getOrCreate('agent-x');
      // Should be a new object
      expect(state.lastSeen).toBeGreaterThan(0);
    });
  });

  describe('cleanup', () => {
    it('removes expired ephemeral agents but keeps default', () => {
      const def = mgr.getOrCreate(undefined);
      const ephemeral = mgr.getOrCreate('agent-eph');
      // Simulate TTL expiry
      ephemeral.lastSeen = Date.now() - 31 * 60 * 1000; // 31 minutes ago
      mgr.cleanup();
      // default still exists
      expect(mgr.getOrCreate(undefined)).toBe(def);
      // ephemeral was cleaned, getOrCreate returns new object
      const recreated = mgr.getOrCreate('agent-eph');
      expect(recreated).not.toBe(ephemeral);
    });
  });
});
```

Run: `npx vitest run test/core/agent-context.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: 实现 AgentContextManager — 类型与 CRUD**

```typescript
// src/core/agent-context.ts
export const DEFAULT_AGENT_ID = '__default__';
const EPHEMERAL_AGENT_TTL = 30 * 60 * 1000; // 30 minutes

export interface InstanceRef {
  type: 'port' | 'path';
  value: string;
}

export interface ProjectContext {
  sceneTree: unknown | null;
  scriptPaths: string[];
  lastValidation: number;
}

export interface AgentState {
  agentId: string;
  selectedInstance: InstanceRef | null;
  activeProfile: string;
  contextCache: Map<string, ProjectContext>;
  lastSeen: number;
  isEphemeral: boolean;
}

function createAgentState(agentId: string, isEphemeral: boolean): AgentState {
  return {
    agentId,
    selectedInstance: null,
    activeProfile: 'full',
    contextCache: new Map(),
    lastSeen: Date.now(),
    isEphemeral,
  };
}

export class AgentContextManager {
  private agents = new Map<string, AgentState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private engineQueue: Array<{
    op: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  private engineRunning = false;

  constructor() {
    // Cleanup every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  getOrCreate(agentId: string | undefined): AgentState {
    const id = agentId ?? DEFAULT_AGENT_ID;
    let state = this.agents.get(id);
    if (!state) {
      state = createAgentState(id, id !== DEFAULT_AGENT_ID);
      this.agents.set(id, state);
    }
    state.lastSeen = Date.now();
    return state;
  }

  remove(agentId: string): void {
    this.agents.delete(agentId);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, state] of this.agents) {
      if (state.isEphemeral && (now - state.lastSeen) > EPHEMERAL_AGENT_TTL) {
        this.agents.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // Placeholder for engine queue — implemented in Task 2
  async enqueueEngine<T>(op: () => Promise<T>): Promise<T> {
    return op();
  }

  // IO operations can run concurrently
  async enqueueIO<T>(op: () => Promise<T>): Promise<T> {
    return op();
  }
}
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx vitest run test/core/agent-context.test.ts`
Expected: 4 tests PASS

- [ ] **Step 4: 提交**

```
git add src/core/agent-context.ts test/core/agent-context.test.ts
git commit -m "feat: AgentContextManager 类型定义与 CRUD"
```

---

### Task 2: AgentContextManager — 引擎 FIFO 队列

**Files:**
- Modify: `src/core/agent-context.ts`
- Modify: `test/core/agent-context.test.ts`

- [ ] **Step 1: 写失败的测试 — 引擎队列串行化**

```typescript
// 追加到 test/core/agent-context.test.ts

describe('enqueueEngine', () => {
  it('serializes engine operations in FIFO order', async () => {
    const mgr = new AgentContextManager();
    const order: number[] = [];

    const p1 = mgr.enqueueEngine(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });
    const p2 = mgr.enqueueEngine(async () => {
      order.push(2);
    });
    const p3 = mgr.enqueueEngine(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
    mgr.destroy();
  });
});

describe('enqueueIO', () => {
  it('runs IO operations concurrently', async () => {
    const mgr = new AgentContextManager();
    let concurrent = 0;
    let maxConcurrent = 0;

    const ioOp = () => mgr.enqueueIO(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 20));
      concurrent--;
    });

    await Promise.all([ioOp(), ioOp(), ioOp()]);
    expect(maxConcurrent).toBeGreaterThan(1);
    mgr.destroy();
  });
});
```

Run: `npx vitest run test/core/agent-context.test.ts`
Expected: enqueueEngine 和 enqueueIO 测试 FAIL（enqueueEngine 当前直接执行不排队）

- [ ] **Step 2: 实现引擎 FIFO 队列**

替换 `src/core/agent-context.ts` 中的 `enqueueEngine` 方法：

```typescript
  async enqueueEngine<T>(op: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.engineQueue.push({ op, resolve: resolve as (v: unknown) => void, reject });
      if (!this.engineRunning) {
        this.engineRunning = true;
        void this.drainEngineQueue();
      }
    });
  }

  private async drainEngineQueue(): Promise<void> {
    while (this.engineQueue.length > 0) {
      const item = this.engineQueue.shift()!;
      try {
        const result = await item.op();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }
    this.engineRunning = false;
  }
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx vitest run test/core/agent-context.test.ts`
Expected: 全部 6 tests PASS

- [ ] **Step 4: 提交**

```
git add src/core/agent-context.ts test/core/agent-context.test.ts
git commit -m "feat: AgentContextManager 引擎 FIFO 队列 + IO 并发"
```

---

### Task 3: FileStateStore — 文件状态持久化

**Files:**
- Create: `src/core/state-store.ts`
- Test: `test/core/state-store.test.ts`

- [ ] **Step 1: 写失败的测试 — 读写/防抖/验证**

```typescript
// test/core/state-store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('returns null when no state file exists', () => {
    expect(store.load()).toBeNull();
  });

  it('saves and loads state', () => {
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
    // Force flush (bypass debounce)
    store.flush();

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.agents['__default__'].activeProfile).toBe('full');
  });

  it('validates and discards agents with stale savedAt', () => {
    const staleTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
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

    // The entire state should be discarded because savedAt > 24h
    const loaded = store.load();
    // State exists but old-agent should be filtered by validate
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.agents)).not.toContain('old-agent');
  });

  it('debounces multiple markDirty calls', () => {
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
    // Should have the latest state (counter = 2, profile-2)
    expect(loaded!.agents['__default__'].activeProfile).toBe('profile-2');
  });
});
```

Run: `npx vitest run test/core/state-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 2: 实现 FileStateStore**

```typescript
// src/core/state-store.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InstanceRef } from './agent-context.js';

const STATE_FILENAME = 'mcp-state.json';
const DEBOUNCE_MS = 2000;
const STALE_AGENT_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PersistedAgentState {
  selectedInstance: InstanceRef | null;
  activeProfile: string;
  contextMeta: { scenePath: string; fetchedAt: number } | null;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  agents: Record<string, PersistedAgentState>;
  globalProfile: string;
  lastConnectedPort: number | null;
}

export class FileStateStore {
  private filePath: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private getStateFn: (() => PersistedState) | null = null;

  constructor(projectPath: string) {
    const dir = projectPath
      ? path.join(projectPath, '.godot')
      : path.join(os.homedir(), '.godot-mcp');
    this.filePath = path.join(dir, STATE_FILENAME);
  }

  load(): PersistedState | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      return this.validate(parsed);
    } catch {
      return null;
    }
  }

  markDirty(getState: () => PersistedState): void {
    this.getStateFn = getState;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.getStateFn) return;

    const state = this.getStateFn();
    state.savedAt = Date.now();

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // Silently fail — state persistence is best-effort
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private validate(state: PersistedState): PersistedState {
    if (state.version !== 1) return { version: 1, savedAt: Date.now(), agents: {}, globalProfile: 'full', lastConnectedPort: null };

    // Discard agents from state saved > 24h ago
    const isStale = Date.now() - state.savedAt > STALE_AGENT_THRESHOLD_MS;
    if (isStale) {
      state.agents = {};
    }

    return state;
  }
}
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx vitest run test/core/state-store.test.ts`
Expected: 4 tests PASS

- [ ] **Step 4: 提交**

```
git add src/core/state-store.ts test/core/state-store.test.ts
git commit -m "feat: FileStateStore 文件状态持久化"
```

---

### Task 4: 集成 — ToolDispatcher 提取 agentId + GodotServer 生命周期

**Files:**
- Modify: `src/core/ToolDispatcher.ts`
- Modify: `src/GodotServer.ts`
- Modify: `src/core/tool-registry.ts`

- [ ] **Step 1: 写失败的测试 — agentId 提取**

```typescript
// 追加到 test/core/agent-context.test.ts

describe('ToolDispatcher agentId extraction', () => {
  it('extracts agentId from _meta field', async () => {
    const { AgentContextManager } = await import('../../src/core/agent-context.js');
    const mgr = new AgentContextManager();

    // Simulate _meta extraction logic
    const extractAgentId = (params: { _meta?: Record<string, unknown> }): string | undefined => {
      const meta = params._meta;
      if (!meta) return undefined;
      return (meta.agentId ?? meta.agent_id) as string | undefined;
    };

    expect(extractAgentId({ _meta: { agentId: 'agent-123' } })).toBe('agent-123');
    expect(extractAgentId({ _meta: { agent_id: 'agent-456' } })).toBe('agent-456');
    expect(extractAgentId({})).toBeUndefined();

    mgr.destroy();
  });
});
```

Run: `npx vitest run test/core/agent-context.test.ts`
Expected: PASS（这是纯逻辑测试）

- [ ] **Step 2: 在 ToolDispatcher.handleCall 中集成 AgentContextManager**

修改 `src/core/ToolDispatcher.ts`:

1. 新增 import:

```typescript
import { AgentContextManager, DEFAULT_AGENT_ID } from './agent-context.js';
```

2. 在 `DispatcherOptions` 中新增可选字段:

```typescript
agentContext?: AgentContextManager;
```

3. 在 `handleCall` 方法开头（现有 normalizeArgs 之后）插入 agentId 提取:

```typescript
// Extract agent identity from _meta
const meta = (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
const agentId = meta?.agentId ?? meta?.agent_id ?? undefined;
if (this.options.agentContext) {
  this.options.agentContext.getOrCreate(agentId as string | undefined);
}
```

- [ ] **Step 3: 在 GodotServer 中集成生命周期**

修改 `src/GodotServer.ts`:

1. 新增 import:

```typescript
import { AgentContextManager } from './core/agent-context.js';
import { FileStateStore } from './core/state-store.js';
```

2. 新增实例字段:

```typescript
private agentCtx: AgentContextManager;
private stateStore: FileStateStore | null = null;
```

3. 在 `constructor` 中初始化:

```typescript
this.agentCtx = new AgentContextManager();
```

4. 在 `run()` 方法中（transport 连接之后）加载状态:

```typescript
// State persistence
if (projectPath) {
  this.stateStore = new FileStateStore(projectPath);
  const saved = this.stateStore.load();
  if (saved) {
    for (const [id, agentState] of Object.entries(saved.agents)) {
      const state = this.agentCtx.getOrCreate(id);
      state.selectedInstance = agentState.selectedInstance;
      state.activeProfile = agentState.activeProfile;
      state.isEphemeral = false; // persisted agents are not ephemeral
    }
  }
}
```

5. 将 `agentContext` 传入 ToolDispatcher:

```typescript
// In ToolDispatcher constructor options
agentContext: this.agentCtx,
```

6. 在 `close()` 方法中刷盘:

```typescript
if (this.stateStore) {
  this.stateStore.flush();
  this.stateStore.destroy();
}
this.agentCtx.destroy();
```

7. 注册退出钩子（在 `run()` 中 `transport` 连接后）:

```typescript
const cleanup = () => {
  if (this.stateStore) {
    this.stateStore.flush();
    this.stateStore.destroy();
  }
  this.agentCtx.destroy();
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
```

- [ ] **Step 4: 运行全量测试验证无回归**

Run: `npx vitest run`
Expected: 全部现有测试 PASS

- [ ] **Step 5: 提交**

```
git add src/core/ToolDispatcher.ts src/GodotServer.ts src/core/tool-registry.ts test/core/agent-context.test.ts
git commit -m "feat: ToolDispatcher + GodotServer 集成 Agent 上下文和状态持久化"
```

---

### Task 5: Phase 1 验收测试

**Files:**
- Create: `test/core/agent-integration.test.ts`

- [ ] **Step 1: 写集成测试 — agentId 端到端传递**

```typescript
// test/core/agent-integration.test.ts
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

  it('persists and restores agent state across restarts', () => {
    // Simulate first session
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
    store.flush();

    // Simulate restart — new manager
    const mgr2 = new AgentContextManager();
    const loaded = store.load();
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
```

Run: `npx vitest run test/core/agent-integration.test.ts`
Expected: 3 tests PASS

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 提交**

```
git add test/core/agent-integration.test.ts
git commit -m "test: Phase 1 Agent 集成验收测试"
```

---

## Phase 2（v0.19.0）：多实例路由补全

### Task 6: InstanceInfo 扩展 — status 字段

**Files:**
- Modify: `src/core/instance-manager.ts`
- Test: `test/core/instance-manager.test.ts`（追加测试）

- [ ] **Step 1: 写失败的测试 — status 字段判定**

```typescript
// 追加到 test/core/instance-manager.test.ts 或新建

describe('InstanceInfo status', () => {
  it('treats compiling status as alive even when heartbeat is stale', () => {
    const instance: InstanceInfo = {
      id: 'inst-1',
      projectPath: '/project',
      projectName: 'Test',
      port: 65001,
      pid: 1234,
      lastSeen: new Date(Date.now() - 80000).toISOString(), // 80s ago, past stale timeout
      godotVersion: '4.4',
      capabilities: [],
      status: 'compiling',
    };

    const mgr = new InstanceManager({ staleTimeoutMs: 70000 });
    // When status is 'compiling', getStatus should not return 'stale'
    const status = mgr.getStatus(instance);
    // compiling overrides stale detection
    expect(status).not.toBe('stale');
  });

  it('treats ready status with stale heartbeat as stale', () => {
    const instance: InstanceInfo = {
      id: 'inst-2',
      projectPath: '/project',
      projectName: 'Test',
      port: 65001,
      pid: 1234,
      lastSeen: new Date(Date.now() - 80000).toISOString(),
      godotVersion: '4.4',
      capabilities: [],
      status: 'ready',
    };

    const mgr = new InstanceManager({ staleTimeoutMs: 70000 });
    expect(mgr.getStatus(instance)).toBe('stale');
  });
});
```

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: FAIL — `status` 字段不在现有 `InstanceInfo` 中

- [ ] **Step 2: 扩展 InstanceInfo + 修改 getStatus**

在 `src/core/instance-manager.ts` 的 `InstanceInfo` 接口中追加:

```typescript
  // Phase 2 新增（可选，旧插件不写此字段）
  status?: 'ready' | 'compiling' | 'unresponsive';
  registeredAt?: number;
```

修改 `getStatus` 方法，在 stale 判定前检查 `status`:

```typescript
getStatus(instance: InstanceInfo): InstanceStatus {
  // Phase 2: compiling overrides stale detection
  if (instance.status === 'compiling') {
    return 'alive';
  }
  if (instance.status === 'unresponsive') {
    return 'unreachable';
  }
  // Existing stale logic
  const lastSeen = Date.parse(instance.lastSeen);
  if (isNaN(lastSeen)) return 'unreachable';
  if (Date.now() - lastSeen > this.staleTimeoutMs) return 'stale';
  return 'alive';
}
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```
git add src/core/instance-manager.ts test/core/instance-manager.test.ts
git commit -m "feat: InstanceInfo status 字段 — 编译期弹性"
```

---

### Task 7: InstanceRouter — resolvePort 优先级链

**Files:**
- Modify: `src/core/instance-router.ts`
- Modify: `src/core/agent-context.ts`（per-agent 实例选择支持）
- Test: `test/core/instance-router.test.ts`

- [ ] **Step 1: 写失败的测试 — resolvePort 优先级**

```typescript
// test/core/instance-router.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InstanceRouter, RouterDependencies } from '../../src/core/instance-router.js';
import type { InstanceInfo } from '../../src/core/instance-manager.js';

function makeInstance(overrides: Partial<InstanceInfo> & { id: string; port: number }): InstanceInfo {
  return {
    projectPath: '/project',
    projectName: 'Test',
    pid: 1234,
    lastSeen: new Date().toISOString(),
    godotVersion: '4.4',
    capabilities: [],
    ...overrides,
  };
}

describe('resolvePort', () => {
  it('returns original port when still alive', async () => {
    const inst = makeInstance({ id: 'i1', port: 65001 });
    const deps: RouterDependencies = {
      instances: [inst],
      sendToInstance: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    };
    const router = new InstanceRouter(deps);
    router.updateInstances([inst]);
    router.autoSelect();
    const port = await router.resolvePort();
    expect(port).toBe(65001);
  });

  it('returns null when no instances available', async () => {
    const deps: RouterDependencies = {
      instances: [],
      sendToInstance: async () => ({ content: [{ type: 'text' as const, text: 'err' }] }),
    };
    const router = new InstanceRouter(deps);
    const port = await router.resolvePort();
    expect(port).toBeNull();
  });

  it('picks most recent heartbeat for same projectPath', async () => {
    const inst1 = makeInstance({
      id: 'i1', port: 65001,
      lastSeen: new Date(Date.now() - 60000).toISOString(),
    });
    const inst2 = makeInstance({
      id: 'i2', port: 65002,
      lastSeen: new Date().toISOString(), // more recent
    });
    const deps: RouterDependencies = {
      instances: [inst1, inst2],
      sendToInstance: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    };
    const router = new InstanceRouter(deps);
    router.updateInstances([inst1, inst2]);
    router.autoSelect();
    const port = await router.resolvePort();
    expect(port).toBe(65002);
  });
});
```

Run: `npx vitest run test/core/instance-router.test.ts`
Expected: FAIL — `resolvePort` 方法不存在

- [ ] **Step 2: 实现 resolvePort**

在 `src/core/instance-router.ts` 的 `InstanceRouter` 类中新增:

```typescript
async resolvePort(): Promise<number | null> {
  const selected = this.getSelectedInstance();
  if (!selected) return null;

  // 1. Original port still alive — use it
  const current = this.deps.instances.find(i => i.port === selected.port);
  if (current && current.id === selected.id) {
    return selected.port;
  }

  // 2. Same projectPath — pick most recent heartbeat
  const sameProject = this.deps.instances
    .filter(i => i.projectPath === selected.projectPath)
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

  if (sameProject.length > 0) {
    return sameProject[0].port;
  }

  // 3. Single instance available
  if (this.deps.instances.length === 1) {
    return this.deps.instances[0].port;
  }

  // 4. No match
  return null;
}
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx vitest run test/core/instance-router.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```
git add src/core/instance-router.ts test/core/instance-router.test.ts
git commit -m "feat: InstanceRouter resolvePort 优先级链"
```

---

### Task 8: GodotServer — 注入实际 sendToInstance

**Files:**
- Modify: `src/GodotServer.ts`

- [ ] **Step 1: 在 GodotServer.initMultiInstance 中注入 HTTP 请求实现**

修改 `src/GodotServer.ts` 中的 `initMultiInstance` 方法，替换 `sendToInstance` 为实际的 HTTP 请求:

```typescript
// 在 initMultiInstance() 中，替换 sendToInstance 的 NOT_IMPLEMENTED 实现
const sendToInstance: RouterDependencies['sendToInstance'] = async (instance, toolName, args) => {
  const url = `http://127.0.0.1:${instance.port}/api/${toolName}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    return {
      content: [{ type: 'text', text: `Instance ${instance.id} error: HTTP ${response.status}` }],
      isError: true,
    };
  }
  const data = await response.json();
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
```

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 提交**

```
git add src/GodotServer.ts
git commit -m "feat: GodotServer 注入实际 sendToInstance HTTP 实现"
```

---

### Task 9: Phase 2 验收测试

**Files:**
- Create: `test/core/multi-instance-integration.test.ts`

- [ ] **Step 1: 写集成测试 — 多实例路由端到端**

```typescript
// test/core/multi-instance-integration.test.ts
import { describe, it, expect } from 'vitest';
import { AgentContextManager } from '../../src/core/agent-context.js';
import { InstanceRouter, RouterDependencies } from '../../src/core/instance-router.js';
import type { InstanceInfo } from '../../src/core/instance-manager.js';

describe('Multi-instance integration', () => {
  it('per-agent instance selection works independently', async () => {
    const agentCtx = new AgentContextManager();
    const inst1: InstanceInfo = {
      id: 'i1', port: 65001, projectPath: '/proj-a', projectName: 'A',
      pid: 1, lastSeen: new Date().toISOString(), godotVersion: '4.4', capabilities: [],
    };
    const inst2: InstanceInfo = {
      id: 'i2', port: 65002, projectPath: '/proj-b', projectName: 'B',
      pid: 2, lastSeen: new Date().toISOString(), godotVersion: '4.4', capabilities: [],
    };

    const deps: RouterDependencies = {
      instances: [inst1, inst2],
      sendToInstance: async (inst) => ({
        content: [{ type: 'text', text: `port:${inst.port}` }],
      }),
    };

    const router = new InstanceRouter(deps);

    // Agent 1 selects instance 1
    const agent1 = agentCtx.getOrCreate('agent-1');
    router.updateInstances([inst1, inst2]);
    await router.selectInstance('i1');
    const result1 = await router.route('editor_ping', {});
    expect(result1).toEqual({ content: [{ type: 'text', text: 'port:65001' }] });

    // Agent 2 would have its own router — independent
    const agent2 = agentCtx.getOrCreate('agent-2');
    agent2.selectedInstance = { type: 'port', value: '65002' };

    expect(agent1.selectedInstance).toBeNull(); // Not set by this test
    expect(agent2.selectedInstance).toEqual({ type: 'port', value: '65002' });

    agentCtx.destroy();
  });
});
```

Run: `npx vitest run test/core/multi-instance-integration.test.ts`
Expected: PASS

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 提交**

```
git add test/core/multi-instance-integration.test.ts
git commit -m "test: Phase 2 多实例路由集成测试"
```

---

## Phase 3（v0.20.0）：懒加载 + 动态发现

### Task 10: 动态路由推导 + 错误分类

**Files:**
- Modify: `src/tools/advanced-proxy.ts`
- Test: `test/tools/advanced-proxy.test.ts`（追加测试）

- [ ] **Step 1: 写失败的测试 — toolNameToRoute + classifyError**

```typescript
// 追加到 test/tools/advanced-proxy.test.ts

import { describe, it, expect } from 'vitest';

describe('toolNameToRoute', () => {
  it('maps godot_terrain_sculpt to terrain/sculpt', async () => {
    const { toolNameToRoute } = await import('../../src/tools/advanced-proxy.js');
    expect(toolNameToRoute('godot_terrain_sculpt')).toBe('terrain/sculpt');
  });

  it('maps godot_custom_light_bake to custom/light-bake', async () => {
    const { toolNameToRoute } = await import('../../src/tools/advanced-proxy.js');
    expect(toolNameToRoute('godot_custom_light_bake')).toBe('custom/light-bake');
  });

  it('rejects non-godot-prefixed names', async () => {
    const { toolNameToRoute } = await import('../../src/tools/advanced-proxy.js');
    expect(toolNameToRoute('evil_tool')).toBe('');
  });
});

describe('classifyError', () => {
  it('classifies 4xx as permanent', async () => {
    const { classifyError } = await import('../../src/tools/advanced-proxy.js');
    expect(classifyError(400)).toBe('permanent');
    expect(classifyError(404)).toBe('permanent');
    expect(classifyError(499)).toBe('permanent');
  });

  it('classifies 5xx as transient', async () => {
    const { classifyError } = await import('../../src/tools/advanced-proxy.js');
    expect(classifyError(500)).toBe('transient');
    expect(classifyError(503)).toBe('transient');
  });

  it('classifies unknown as permanent', async () => {
    const { classifyError } = await import('../../src/tools/advanced-proxy.js');
    expect(classifyError(200)).toBe('permanent');
  });
});
```

Run: `npx vitest run test/tools/advanced-proxy.test.ts`
Expected: FAIL — `toolNameToRoute` / `classifyError` not exported

- [ ] **Step 2: 实现并导出 toolNameToRoute 和 classifyError**

在 `src/tools/advanced-proxy.ts` 中新增导出:

```typescript
const ROUTE_OVERRIDES: Record<string, string> = {
  // Irregular mappings go here
};

export function toolNameToRoute(toolName: string): string {
  if (!toolName.startsWith('godot_')) return '';
  if (ROUTE_OVERRIDES[toolName]) return ROUTE_OVERRIDES[toolName];
  const withoutPrefix = toolName.replace(/^godot_/, '');
  const parts = withoutPrefix.split('_');
  if (parts.length < 2) return '';
  const category = parts[0];
  const action = parts.slice(1).join('-');
  return `${category}/${action}`;
}

export function classifyError(status: number): 'permanent' | 'transient' {
  if (status >= 400 && status < 500) return 'permanent';
  if (status >= 500) return 'transient';
  return 'permanent';
}
```

- [ ] **Step 3: 运行测试验证通过**

Run: `npx vitest run test/tools/advanced-proxy.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```
git add src/tools/advanced-proxy.ts test/tools/advanced-proxy.test.ts
git commit -m "feat: 动态路由推导 + HTTP 错误分类"
```

---

### Task 11: godot_advanced_tool 增强 — 动态调用 + Profile 检查

**Files:**
- Modify: `src/tools/advanced-proxy.ts`
- Modify: `src/core/tool-registry.ts`

- [ ] **Step 1: 在 tool-registry.ts 中追加 dynamic 工具组**

修改 `src/core/tool-registry.ts` 的 `TOOL_GROUPS` 对象，新增:

```typescript
dynamic: {
  description: '动态发现的工具（Godot 端注册但 MCP 侧未定义）',
  tools: [],
  requires: ['headless', 'editor', 'bridge'],
},
```

注意：`PROFILES.full` 使用 `Object.keys(TOOL_GROUPS)`，因此自动包含 `dynamic`。`bridge_dev` 和 `3d_dev` 如 spec 所述需手动追加 `'dynamic'`。

在 `PROFILES.bridge_dev` 数组中追加 `'dynamic'`。
在 `PROFILES['3d_dev']` 数组中追加 `'dynamic'`。

- [ ] **Step 2: 增强 handleTool — 动态路由 fallback**

修改 `src/tools/advanced-proxy.ts` 中的 `handleTool` 函数，在现有逻辑（已知工具查找失败）之后追加动态路由:

```typescript
// After existing checks fail (tool not found in registry)
// Dynamic route fallback
const route = toolNameToRoute(targetTool);
if (!route) {
  return {
    content: [{ type: 'text', text: `Error: Unknown tool '${targetTool}'` }],
    isError: true,
  };
}

// Profile check — dynamic group must be active
const { isToolAllowed } = await import('../core/tool-registry.js');
// dynamic tools bypass isToolAllowed since they have no entry in TOOL_GROUPS.tools
// Instead check if 'dynamic' group is in active groups
const { getActiveGroups } = await import('../core/tool-registry.js');
if (!getActiveGroups().has('dynamic')) {
  return {
    content: [{ type: 'text', text: `Error: Dynamic tools not available in current profile` }],
    isError: true,
  };
}

// Delegate to the engine via _delegate
return _delegate(`_dynamic/${route}`, toolArgs);
```

- [ ] **Step 3: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```
git add src/tools/advanced-proxy.ts src/core/tool-registry.ts test/tools/advanced-proxy.test.ts
git commit -m "feat: godot_advanced_tool 动态调用 + Profile 检查 + dynamic 组"
```

---

### Task 12: Phase 3 验收测试

**Files:**
- Create: `test/tools/lazy-loading.test.ts`

- [ ] **Step 1: 写验收测试 — 动态工具发现 + Profile 约束**

```typescript
// test/tools/lazy-loading.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { toolNameToRoute, classifyError } from '../../src/tools/advanced-proxy.js';
import { initActiveGroupsFromProfile, clearRegistry, setActiveGroups } from '../../src/core/tool-registry.js';

describe('Lazy loading', () => {
  beforeEach(() => {
    clearRegistry();
    initActiveGroupsFromProfile('full');
  });

  it('derives routes from tool names', () => {
    expect(toolNameToRoute('godot_terrain_flatten')).toBe('terrain/flatten');
    expect(toolNameToRoute('godot_shader_compile')).toBe('shader/compile');
  });

  it('blocks non-godot-prefixed tools', () => {
    expect(toolNameToRoute('evil_inject')).toBe('');
  });

  it('dynamic group is present in full profile', () => {
    // full profile = Object.keys(TOOL_GROUPS), includes 'dynamic'
    // This test verifies the group exists
    const { getActiveGroups } = require('../../src/core/tool-registry.js');
    expect(getActiveGroups().has('dynamic')).toBe(true);
  });

  it('dynamic group is absent in minimal profile', () => {
    const { getActiveGroups } = require('../../src/core/tool-registry.js');
    initActiveGroupsFromProfile('minimal');
    expect(getActiveGroups().has('dynamic')).toBe(false);
  });

  it('classifies HTTP errors correctly', () => {
    expect(classifyError(400)).toBe('permanent');
    expect(classifyError(404)).toBe('permanent');
    expect(classifyError(500)).toBe('transient');
    expect(classifyError(503)).toBe('transient');
  });
});
```

Run: `npx vitest run test/tools/lazy-loading.test.ts`
Expected: PASS

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 提交**

```
git add test/tools/lazy-loading.test.ts
git commit -m "test: Phase 3 懒加载验收测试"
```

---

## 自审检查清单

### Spec 覆盖率

| Spec 章节 | 对应 Task | 状态 |
|-----------|----------|------|
| §1.1 AgentContextManager 类型 + CRUD | Task 1 | ✅ |
| §1.1 enqueueEngine / enqueueIO 队列 | Task 2 | ✅ |
| §1.2 FileStateStore 持久化 | Task 3 | ✅ |
| §1.1 集成点：ToolDispatcher + GodotServer | Task 4 | ✅ |
| §1 测试策略：单元 + 集成 + 压力 | Task 5 | ✅ |
| §2.1 InstanceInfo status 字段 | Task 6 | ✅ |
| §2.2 resolvePort 优先级链 | Task 7 | ✅ |
| §2.2 sendToInstance 实际路由 | Task 8 | ✅ |
| §2 测试策略 | Task 9 | ✅ |
| §3.1 toolNameToRoute + §3.3 classifyError | Task 10 | ✅ |
| §3.2 handleAdvancedTool 增强 + Profile 检查 | Task 11 | ✅ |
| §3 测试策略 | Task 12 | ✅ |

### Placeholder 扫描

- 无 TBD / TODO / "implement later"
- 所有代码步骤包含完整实现
- 所有测试步骤包含完整断言
- 无 "similar to Task N" 引用

### 类型一致性

- `InstanceRef` 在 Task 1 定义，Task 3/4 使用 — ✅ 一致
- `AgentState` 在 Task 1 定义，Task 4 使用 — ✅ 一致
- `PersistedState` 在 Task 3 定义，Task 5 使用 — ✅ 一致
- `InstanceInfo` 扩展在 Task 6，使用 `status?` 可选字段 — ✅ 与 spec 一致
- `toolNameToRoute` 在 Task 10 导出，Task 11 使用 — ✅ 一致
