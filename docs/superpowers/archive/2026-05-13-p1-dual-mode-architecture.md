# godot-mcp-enhanced v0.8.0 P1 实施计划：双模式架构

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 godot-mcp-enhanced 添加编辑器插件模式（WebSocket 实时连接），同时保留现有 Headless 模式，支持 UndoRedo、心跳、只读模式。

**Architecture:** Node.js 服务器根据 `GODOT_MCP_MODE` 环境变量选择 Headless（现有 CLI）或 Editor（WebSocket JSON-RPC）执行器。编辑器插件是一个 Godot EditorPlugin，通过 WebSocket 暴露编辑器 API。工具标签化支持只读模式。

**Tech Stack:** TypeScript (Node.js)、GDScript (Godot 4.4+)、WebSocket、JSON-RPC 2.0、Node.js test runner

**设计文档:** `docs/superpowers/specs/2026-05-13-v080-feature-upgrade-design.md`

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/core/EditorConnection.ts` | WebSocket 客户端：连接、重连、心跳、请求发送 |
| `src/core/EditorToolExecutor.ts` | 编辑器模式工具执行器：将工具调用转为 JSON-RPC 请求 |
| `src/core/ReadOnlyGuard.ts` | 只读模式拦截器：基于工具标签判断是否放行 |
| `src/core/tool-registry.ts` | 工具注册中心：集中管理工具名、标签（readonly/long_running） |
| `addons/godot_mcp_server/plugin.cfg` | Godot 插件元数据 |
| `addons/godot_mcp_server/plugin.gd` | EditorPlugin 入口：注册面板、管理生命周期 |
| `addons/godot_mcp_server/websocket_server.gd` | WebSocket 服务端：监听端口、管理连接 |
| `addons/godot_mcp_server/command_handler.gd` | JSON-RPC 命令分发：路由到具体命令实现 |
| `addons/godot_mcp_server/heartbeat.gd` | 心跳检测：ping/pong、超时判定 |
| `addons/godot_mcp_server/undo_manager.gd` | UndoRedo 封装：按请求粒度合并操作 |
| `addons/godot_mcp_server/commands/node_commands.gd` | 节点操作命令 |
| `addons/godot_mcp_server/commands/scene_commands.gd` | 场景操作命令 |
| `addons/godot_mcp_server/ui/status_panel.tscn` | 编辑器底部状态面板场景 |
| `addons/godot_mcp_server/ui/status_panel.gd` | 状态面板脚本：连接状态、日志、取消按钮 |
| `scripts/install-plugin.js` | 插件安装脚本 |
| `test/tool-registry.test.js` | 工具注册中心测试 |
| `test/readonly-guard.test.js` | ReadOnlyGuard 测试 |
| `test/editor-connection.test.js` | EditorConnection 测试 |
| `test/editor-tool-executor.test.js` | 编辑器工具执行器测试 |
| `test/integration/editor-mode.test.js` | 编辑器模式集成测试 |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/index.ts` | 增加模式检测（editor/headless）、降级逻辑、NO_FALLBACK |
| `src/GodotServer.ts` | 增加编辑器模式初始化、ReadOnlyGuard 集成、工具标签注册 |
| `src/tools/*.ts`（所有工具文件） | 每个模块导出 `TOOL_META` 标签映射 |
| `package.json` | 增加 ws 依赖、install-plugin 脚本 |

---

## Task 1: 工具注册中心 + 只读标签

**Files:**
- Create: `src/core/tool-registry.ts`
- Create: `test/tool-registry.test.js`

这是整个 P1 的基础——所有后续功能（ReadOnlyGuard、EditorToolExecutor）都依赖它。

- [ ] **Step 1: 编写 tool-registry 的测试**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTools,
  isReadOnly,
  isLongRunning,
  getReadOnlyTools,
  getWriteTools,
  getAllToolNames,
} from '../build/core/tool-registry.js';

describe('tool-registry', () => {
  it('registers tools with tags', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'nav_bake_mesh', readonly: false, long_running: true },
    ]);
    assert.equal(isReadOnly('read_scene'), true);
    assert.equal(isReadOnly('add_node'), false);
    assert.equal(isLongRunning('nav_bake_mesh'), true);
    assert.equal(isLongRunning('add_node'), false);
  });

  it('returns false for unknown tools', () => {
    assert.equal(isReadOnly('nonexistent_tool'), false);
    assert.equal(isLongRunning('nonexistent_tool'), false);
  });

  it('lists all readonly tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
    ]);
    const ro = getReadOnlyTools();
    assert.ok(ro.includes('read_scene'));
    assert.ok(ro.includes('get_project_info'));
    assert.ok(!ro.includes('add_node'));
  });

  it('lists all write tools', () => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
    ]);
    const wr = getWriteTools();
    assert.ok(wr.includes('add_node'));
    assert.ok(wr.includes('write_script'));
    assert.ok(!wr.includes('read_scene'));
  });

  it('getAllToolNames returns all registered names', () => {
    registerTools([
      { name: 'a', readonly: true, long_running: false },
      { name: 'b', readonly: false, long_running: false },
    ]);
    const names = getAllToolNames();
    assert.deepEqual(names.sort(), ['a', 'b']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/tool-registry.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 tool-registry**

```typescript
// src/core/tool-registry.ts

export interface ToolMeta {
  name: string;
  readonly: boolean;
  long_running: boolean;
}

const registry = new Map<string, ToolMeta>();

export function registerTools(tools: ToolMeta[]): void {
  registry.clear();
  for (const t of tools) {
    registry.set(t.name, t);
  }
}

export function isReadOnly(name: string): boolean {
  return registry.get(name)?.readonly ?? false;
}

export function isLongRunning(name: string): boolean {
  return registry.get(name)?.long_running ?? false;
}

export function getReadOnlyTools(): string[] {
  return [...registry.entries()].filter(([, m]) => m.readonly).map(([n]) => n);
}

export function getWriteTools(): string[] {
  return [...registry.entries()].filter(([, m]) => !m.readonly).map(([n]) => n);
}

export function getAllToolNames(): string[] {
  return [...registry.keys()];
}

export function getToolMeta(name: string): ToolMeta | undefined {
  return registry.get(name);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/tool-registry.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add src/core/tool-registry.ts test/tool-registry.test.js
git commit -m "feat: add tool-registry with readonly/long_running tags"
```

---

## Task 2: ReadOnlyGuard

**Files:**
- Create: `src/core/ReadOnlyGuard.ts`
- Create: `test/readonly-guard.test.js`

- [ ] **Step 1: 编写 ReadOnlyGuard 测试**

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyGuard } from '../build/core/ReadOnlyGuard.js';
import { registerTools } from '../build/core/tool-registry.js';

describe('ReadOnlyGuard', () => {
  beforeEach(() => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
      { name: 'get_project_info', readonly: true, long_running: false },
      { name: 'write_script', readonly: false, long_running: false },
    ]);
  });

  it('allows readonly tools when guard is active', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('read_scene');
    assert.equal(result.blocked, false);
  });

  it('blocks write tools when guard is active', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('add_node');
    assert.equal(result.blocked, true);
    assert.equal(result.errorCode, -32001);
    assert.ok(result.message.includes('read-only'));
  });

  it('allows all tools when guard is inactive', () => {
    const guard = new ReadOnlyGuard(false);
    assert.equal(guard.check('add_node').blocked, false);
    assert.equal(guard.check('write_script').blocked, false);
    assert.equal(guard.check('read_scene').blocked, false);
  });

  it('blocks unknown tools in readonly mode (safe default)', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('unknown_tool');
    assert.equal(result.blocked, true);
  });

  it('returns proper error structure', () => {
    const guard = new ReadOnlyGuard(true);
    const result = guard.check('write_script');
    assert.deepEqual(result, {
      blocked: true,
      errorCode: -32001,
      message: 'Operation blocked: read-only mode enabled (GODOT_MCP_READ_ONLY=true)',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/readonly-guard.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 ReadOnlyGuard**

```typescript
// src/core/ReadOnlyGuard.ts
import { isReadOnly } from './tool-registry.js';

export interface GuardResult {
  blocked: boolean;
  errorCode?: number;
  message?: string;
}

export class ReadOnlyGuard {
  constructor(private readonly enabled: boolean) {}

  check(toolName: string): GuardResult {
    if (!this.enabled) return { blocked: false };
    if (isReadOnly(toolName)) return { blocked: false };

    return {
      blocked: true,
      errorCode: -32001,
      message: 'Operation blocked: read-only mode enabled (GODOT_MCP_READ_ONLY=true)',
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/readonly-guard.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add src/core/ReadOnlyGuard.ts test/readonly-guard.test.js
git commit -m "feat: add ReadOnlyGuard with tool-tag based blocking"
```

---

## Task 3: 将只读标签集成到现有工具

**Files:**
- Modify: `src/GodotServer.ts`
- Modify: `src/tools/scene.ts`, `script.ts`, `project.ts`, `runtime.ts`, `tilemap-ops.ts`, `material-ops.ts`, `animation-ops.ts`, `game-bridge.ts`, `godot-ops.ts`, `workflow.ts`, `profiler-ops.ts`, `spatial-ops.ts`, `docs.ts`, `screenshot.ts`, `validation.ts`

这一步在每个工具模块中导出 `TOOL_META` 标签映射，并在 GodotServer 中注册。

- [ ] **Step 1: 在每个工具模块末尾导出 TOOL_META**

以 `src/tools/scene.ts` 为例：

```typescript
export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  read_scene: { readonly: true, long_running: false },
  create_scene: { readonly: false, long_running: false },
  add_node: { readonly: false, long_running: false },
  save_scene: { readonly: false, long_running: false },
  load_sprite: { readonly: false, long_running: false },
  batch_add_nodes: { readonly: false, long_running: false },
  query_scene_tree: { readonly: true, long_running: false },
  inspect_node: { readonly: true, long_running: false },
  edit_node: { readonly: false, long_running: false },
  remove_node: { readonly: false, long_running: false },
};
```

标签规则（参考设计文档 2.6 节白/黑名单）：
- `readonly: true`：read/get/list/query/validate/inspect 开头的工具
- `readonly: false`：create/add/edit/write/remove/save/batch/import/play/stop/set/connect/disconnect/emit/build/bake 开头的工具

需要在以下所有文件中添加 `TOOL_META` 导出：
`scene.ts`, `script.ts`, `project.ts`, `runtime.ts`, `tilemap-ops.ts`, `material-ops.ts`, `animation-ops.ts`, `game-bridge.ts`, `godot-ops.ts`, `workflow.ts`, `profiler-ops.ts`, `spatial-ops.ts`, `docs.ts`, `screenshot.ts`, `validation.ts`

- [ ] **Step 2: 在 GodotServer 中收集并注册标签**

```typescript
// src/GodotServer.ts 顶部新增
import { registerTools } from './core/tool-registry.js';
import type { ToolMeta } from './core/tool-registry.js';

// 在 toolModules 定义之后、run() 方法之前
const allMeta: ToolMeta[] = [];
for (const mod of toolModules) {
  if ((mod as any).TOOL_META) {
    for (const [name, meta] of Object.entries((mod as any).TOOL_META as Record<string, { readonly: boolean; long_running: boolean }>)) {
      allMeta.push({ name, ...meta });
    }
  }
}
registerTools(allMeta);
```

- [ ] **Step 3: 构建验证**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build`
Expected: 编译成功

- [ ] **Step 4: 运行全部现有测试确认无回归**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add -A
git commit -m "feat: add readonly/long_running tags to all tool modules"
```

---

## Task 4: ReadOnlyGuard 集成到 GodotServer

**Files:**
- Modify: `src/GodotServer.ts`

将 ReadOnlyGuard 集成到工具调用分发链中。

- [ ] **Step 1: 在 GodotServer 中集成 ReadOnlyGuard**

```typescript
// 构造函数中新增
import { ReadOnlyGuard } from './ReadOnlyGuard.js';
this.readOnlyGuard = new ReadOnlyGuard(options.readOnly ?? false);
```

在 `handleTool` 方法中，确认令牌检查之前加入守卫检查：

```typescript
const guardResult = this.readOnlyGuard.check(name);
if (guardResult.blocked) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: guardResult.errorCode, message: guardResult.message } }) }],
    isError: true,
  };
}
```

移除现有的基于工具列表过滤的只读逻辑（如果存在），由 guard 统一拦截。

- [ ] **Step 2: 构建并测试**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 所有测试通过

- [ ] **Step 3: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add src/GodotServer.ts
git commit -m "feat: integrate ReadOnlyGuard into tool dispatch chain"
```

---

## Task 5: EditorConnection — WebSocket 客户端

**Files:**
- Create: `src/core/EditorConnection.ts`
- Create: `test/editor-connection.test.js`

- [ ] **Step 1: 安装 ws 依赖**

```bash
cd D:/GitHub/godot-mcp-enhanced && npm install ws && npm install -D @types/ws
```

- [ ] **Step 2: 编写 EditorConnection 测试**

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorConnection } from '../build/core/EditorConnection.js';
import { WebSocketServer } from 'ws';

describe('EditorConnection', () => {
  let wss;
  let port;

  beforeEach((_t, done) => {
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
    done();
  });

  afterEach(() => {
    wss.close();
  });

  it('connects and sends JSON-RPC request', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    const result = await conn.request('test_method', { key: 'value' });
    assert.deepEqual(result, { status: 'ok' });
    conn.disconnect();
  });

  it('handles connection refused gracefully', async () => {
    const conn = new EditorConnection({ port: 59999, reconnect: false, connectTimeout: 1000 });
    await assert.rejects(() => conn.connect(), { message: /connect/i });
  });

  it('handles request timeout', async () => {
    wss.on('connection', (ws) => {
      // 不回复，模拟超时
    });

    const conn = new EditorConnection({ port, reconnect: false, requestTimeout: 500 });
    await conn.connect();
    await assert.rejects(() => conn.request('slow_method', {}), { message: /timeout/i });
    conn.disconnect();
  });

  it('sends operation_start for long running operations', async () => {
    let received = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    await conn.startOperation(300);
    assert.ok(received.some(m => m.method === 'operation_start'));
    await conn.endOperation();
    assert.ok(received.some(m => m.method === 'operation_end'));
    conn.disconnect();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/editor-connection.test.js`
Expected: FAIL — module not found

- [ ] **Step 4: 实现 EditorConnection**

```typescript
// src/core/EditorConnection.ts
import WebSocket from 'ws';

interface EditorConnectionOptions {
  port: number;
  host?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  connectTimeout?: number;
  requestTimeout?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EditorConnection {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private reconnectEnabled = true;

  private readonly host: string;
  private readonly shouldReconnect: boolean;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectMs: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private reconnectAttempt = 0;

  constructor(private readonly options: EditorConnectionOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.shouldReconnect = options.reconnect ?? true;
    this.reconnectEnabled = this.shouldReconnect;
    this.reconnectBaseMs = options.reconnectInterval ?? 1000;
    this.maxReconnectMs = options.maxReconnectInterval ?? 60000;
    this.connectTimeoutMs = options.connectTimeout ?? 10000;
    this.requestTimeoutMs = options.requestTimeout ?? 30000;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${this.host}:${this.options.port}`;
      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout to ${url}`));
        ws.terminate();
      }, this.connectTimeoutMs);

      const ws = new WebSocket(url);
      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.connected = true;
        this.reconnectAttempt = 0;
        this.setupMessageHandler();
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Connection failed: ${err.message}`));
      });

      ws.on('close', () => {
        this.connected = false;
        this.ws = null;
        if (this.reconnectEnabled) this.scheduleReconnect();
      });
    });
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;
    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id != null && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          clearTimeout(pending.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || 'JSON-RPC error'));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch { /* ignore non-JSON messages (notifications) */ }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.ws.send(msg);
    });
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!this.ws || !this.connected) throw new Error('Not connected');
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  async startOperation(timeoutSec: number): Promise<unknown> {
    return this.request('operation_start', { timeout: Math.min(timeoutSec, 600) });
  }

  async endOperation(): Promise<unknown> {
    return this.request('operation_end', {});
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectMs,
    );
    this.reconnectAttempt++;
    console.error(`[EditorConnection] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.error('[EditorConnection] Reconnected');
      } catch {
        // close handler will schedule next reconnect
      }
    }, delay);
  }

  disconnect(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/editor-connection.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add src/core/EditorConnection.ts test/editor-connection.test.js package.json package-lock.json
git commit -m "feat: add EditorConnection WebSocket client with reconnect and operation control"
```

---

## Task 6: EditorToolExecutor

**Files:**
- Create: `src/core/EditorToolExecutor.ts`
- Create: `test/editor-tool-executor.test.js`

- [ ] **Step 1: 编写测试**

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditorToolExecutor } from '../build/core/EditorToolExecutor.js';
import { EditorConnection } from '../build/core/EditorConnection.js';
import { WebSocketServer } from 'ws';

describe('EditorToolExecutor', () => {
  let wss;
  let port;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => {
    wss.close();
  });

  it('forwards tool call as JSON-RPC and returns result', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { node_path: 'root/Player' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('add_node', {
      project_path: '/test',
      scene_path: 'res://main.tscn',
      node_type: 'Sprite2D',
      node_name: 'Player',
    });
    assert.deepEqual(JSON.parse(result.content[0].text), { node_path: 'root/Player' });
    conn.disconnect();
  });

  it('handles JSON-RPC error from plugin', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Node not found' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('edit_node', { node_path: 'root/Missing' });
    assert.equal(result.isError, true);
    conn.disconnect();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/editor-tool-executor.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 EditorToolExecutor**

```typescript
// src/core/EditorToolExecutor.ts
import type { EditorConnection } from './EditorConnection.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class EditorToolExecutor {
  constructor(private readonly conn: EditorConnection) {}

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.conn.request(toolName, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/editor-tool-executor.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add src/core/EditorToolExecutor.ts test/editor-tool-executor.test.js
git commit -m "feat: add EditorToolExecutor for JSON-RPC tool forwarding"
```

---

## Task 7: 模式检测 + 降级逻辑

**Files:**
- Modify: `src/index.ts`
- Modify: `src/GodotServer.ts`

- [ ] **Step 1: 修改 index.ts 支持三种模式**

```typescript
// src/index.ts
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const toolMode = args.includes('--lite') ? 'lite'
  : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
  : 'full';

const connectionMode = process.env.GODOT_MCP_MODE === 'editor' ? 'editor' : 'headless';
const readOnly = process.env.GODOT_MCP_READ_ONLY === 'true';
const noFallback = process.env.GODOT_MCP_NO_FALLBACK === 'true';

const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'), {
  mode: toolMode,
  connectionMode,
  readOnly,
  noFallback,
});

server.run().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : 'Unknown error';
  console.error('Failed to run server:', msg);
  process.exit(1);
});
```

- [ ] **Step 2: 修改 GodotServer 支持编辑器模式**

在 `GodotServer` 中：

```typescript
import { EditorConnection } from './core/EditorConnection.js';
import { EditorToolExecutor } from './core/EditorToolExecutor.js';

// 新增属性
private editorConn: EditorConnection | null = null;
private editorExecutor: EditorToolExecutor | null = null;
private connectionMode: 'headless' | 'editor';
private noFallback: boolean;
```

在 `run()` 方法中 MCP 服务器启动后：

```typescript
if (this.connectionMode === 'editor') {
  const port = parseInt(process.env.GODOT_EDITOR_PORT ?? '9090', 10);
  this.editorConn = new EditorConnection({ port, reconnect: true });
  try {
    await this.editorConn.connect();
    this.editorExecutor = new EditorToolExecutor(this.editorConn);
    console.error(`[Editor] Connected to Godot plugin on port ${port}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (this.noFallback) {
      console.error(`[FATAL] Editor mode required but connection failed: ${msg}`);
      console.error('Set GODOT_MCP_NO_FALLBACK=false to allow fallback, or install the plugin.');
      process.exit(1);
    }
    console.error(`[FALLBACK] Editor mode requested but plugin not found at port ${port}.`);
    console.error(`[FALLBACK] Running in Headless mode. UndoRedo disabled, no scene state persistence.`);
    console.error(`[FALLBACK] To enforce editor mode, set GODOT_MCP_NO_FALLBACK=true.`);
    this.connectionMode = 'headless';
    this.editorConn = null;
  }
}
```

在 `handleTool` 中 ReadOnlyGuard 检查之后：

```typescript
if (this.connectionMode === 'editor' && this.editorExecutor) {
  return this.editorExecutor.execute(name, args);
}
// 否则走现有的 headless 分发
```

- [ ] **Step 3: 构建并测试**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/*.test.js`
Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add src/index.ts src/GodotServer.ts
git commit -m "feat: add editor/headless dual mode with fallback and NO_FALLBACK"
```

---

## Task 8: 编辑器插件 — 基础框架

**Files:**
- Create: `addons/godot_mcp_server/plugin.cfg`
- Create: `addons/godot_mcp_server/plugin.gd`
- Create: `addons/godot_mcp_server/ui/status_panel.gd`

- [ ] **Step 1: 创建 plugin.cfg**

```ini
[plugin]

name="MCP Server"
description="AI Model Context Protocol bridge for Godot Editor"
author="godot-mcp-enhanced"
version="0.8.0"
script="plugin.gd"
```

- [ ] **Step 2: 创建 plugin.gd**

```gdscript
@tool
extends EditorPlugin

var websocket_server: Node
var status_panel: Control

func _enter_tree() -> void:
	websocket_server = preload("websocket_server.gd").new()
	websocket_server.name = "MCPServer"
	websocket_server.setup(self)
	add_child(websocket_server)

	var panel_scene = preload("ui/status_panel.tscn")
	status_panel = panel_scene.instantiate()
	add_control_to_bottom_panel(status_panel, "MCP")

func _exit_tree() -> void:
	if websocket_server:
		websocket_server.queue_free()
	if status_panel:
		remove_control_from_bottom_panel(status_panel)
		status_panel.queue_free()

func get_plugin() -> EditorPlugin:
	return self
```

- [ ] **Step 3: 创建 status_panel.gd**

```gdscript
@tool
extends VBoxContainer

var status_label: Label
var cancel_button: Button

func _ready() -> void:
	status_label = Label.new()
	status_label.text = "MCP: Disconnected"
	add_child(status_label)

	cancel_button = Button.new()
	cancel_button.text = "Cancel Operation"
	cancel_button.disabled = true
	cancel_button.pressed.connect(_on_cancel_pressed)
	add_child(cancel_button)

func update_status(text: String) -> void:
	if status_label:
		status_label.text = text

func set_operation_active(active: bool) -> void:
	if cancel_button:
		cancel_button.disabled = not active

func _on_cancel_pressed() -> void:
	var server = get_node_or_null("/root/EditorNode/MCPServer")
	if server:
		server.cancel_current_operation()
```

注意：`status_panel.tscn` 需要在 Godot 编辑器中手动创建（根节点为 VBoxContainer，绑定 `status_panel.gd` 脚本），或以文本 .tscn 格式创建。

- [ ] **Step 4: 在 Godot 编辑器中验证插件可加载**

将 `addons/godot_mcp_server/` 复制到一个测试项目的 `addons/` 下，启用插件。预期：底部面板出现 "MCP" 标签。

- [ ] **Step 5: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add addons/godot_mcp_server/plugin.cfg addons/godot_mcp_server/plugin.gd addons/godot_mcp_server/ui/
git commit -m "feat: add minimal Godot EditorPlugin with status panel"
```

---

## Task 9: 编辑器插件 — WebSocket 服务器 + 心跳

**Files:**
- Create: `addons/godot_mcp_server/websocket_server.gd`
- Create: `addons/godot_mcp_server/heartbeat.gd`

- [ ] **Step 1: 创建 heartbeat.gd**

```gdscript
extends Node

const PING_INTERVAL := 5.0
const INACTIVITY_TIMEOUT := 30.0

signal timeout_detected()

var _last_activity: float = 0.0
var _ping_timer: float = 0.0
var _is_paused: bool = false
var _operation_timeout: float = 0.0
var _operation_timer: float = 0.0

func reset_activity() -> void:
	_last_activity = 0.0

func tick(delta: float, peer: WebSocketPeer) -> void:
	if _is_paused:
		_operation_timer += delta
		if _operation_timer > _operation_timeout:
			_is_paused = false
			emit_signal("timeout_detected")
		return

	_last_activity += delta
	_ping_timer += delta

	if _last_activity > INACTIVITY_TIMEOUT:
		emit_signal("timeout_detected")
		return

	if _ping_timer >= PING_INTERVAL:
		_ping_timer = 0.0
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "method": "ping", "params": {}}))

func pause_for_operation(timeout_sec: float) -> void:
	_is_paused = true
	_operation_timeout = min(timeout_sec, 600.0)
	_operation_timer = 0.0

func resume() -> void:
	_is_paused = false
	_last_activity = 0.0
	_ping_timer = 0.0
```

- [ ] **Step 2: 创建 websocket_server.gd**

```gdscript
extends Node

const BASE_PORT := 9090
const MAX_PORT := 9094

var _server: TCPServer
var _peers: Array[WebSocketPeer] = []
var _heartbeat: Node
var _command_handler: Node
var _current_port: int = 0
var _request_counter: int = 0
var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func _ready() -> void:
	_heartbeat = preload("heartbeat.gd").new()
	add_child(_heartbeat)
	_heartbeat.timeout_detected.connect(_on_heartbeat_timeout)

	_command_handler = preload("command_handler.gd").new()
	_command_handler.setup(_plugin)
	add_child(_command_handler)

	_start_server()

func _start_server() -> void:
	_server = TCPServer.new()
	for port in range(BASE_PORT, MAX_PORT + 1):
		if _server.listen(port) == OK:
			_current_port = port
			print("[MCP] Listening on port %d" % port)
			_update_panel("MCP: Listening on port %d" % port)
			return
	push_error("[MCP] All ports (%d-%d) occupied" % [BASE_PORT, MAX_PORT])

func _process(delta: float) -> void:
	if not _server: return

	if _server.is_connection_available():
		var tcp_peer = _server.take_connection()
		var ws_peer = WebSocketPeer.new()
		ws_peer.accept_stream(tcp_peer)
		_peers.append(ws_peer)
		print("[MCP] Client connected (total: %d)" % _peers.size())
		_update_panel("MCP: %d client(s) connected" % _peers.size())
		_send_session_sync(ws_peer)

	var to_remove: Array[int] = []
	for i in range(_peers.size()):
		var peer = _peers[i]
		peer.poll()
		match peer.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				_heartbeat.tick(delta, peer)
				while peer.get_available_packet_count() > 0:
					var text = peer.get_packet().get_string_from_utf8()
					_handle_message(text, peer)
					_heartbeat.reset_activity()
			WebSocketPeer.STATE_CLOSED:
				to_remove.append(i)

	for i in to_remove:
		_peers.remove_at(i)
		print("[MCP] Client disconnected")

func _handle_message(text: String, peer: WebSocketPeer) -> void:
	var parsed = JSON.parse_string(text)
	if not parsed or not parsed.has("jsonrpc"):
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid JSON-RPC"}}))
		return

	if parsed.get("method") == "operation_start":
		var timeout = parsed.get("params", {}).get("timeout", 300)
		_heartbeat.pause_for_operation(timeout)
		_update_panel("MCP: Operation in progress...")
		_get_panel().set_operation_active(true)
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {}}))
		return

	if parsed.get("method") == "operation_end":
		_heartbeat.resume()
		_update_panel("MCP: %d client(s) connected" % _peers.size())
		_get_panel().set_operation_active(false)
		peer.send_text(JSON.stringify({"jsonrpc": "2.0", "id": parsed.get("id"), "result": {}}))
		return

	if parsed.get("method") == "request_sync":
		_send_session_sync(peer)
		return

	if parsed.get("method") == "ping":
		_heartbeat.reset_activity()
		return

	_request_counter += 1
	var response = _command_handler.handle(parsed.get("method", ""), parsed.get("params", {}), _request_counter)
	var reply = {"jsonrpc": "2.0", "id": parsed.get("id")}
	if response.has("error"):
		reply["error"] = response.error
	else:
		reply["result"] = response.result
	peer.send_text(JSON.stringify(reply))

func _send_session_sync(peer: WebSocketPeer) -> void:
	var open_scenes: Array = []
	if _plugin:
		var ei = _plugin.get_editor_interface()
		open_scenes = ei.get_open_scenes()
	peer.send_text(JSON.stringify({"method": "session_resync", "params": {"open_scenes": open_scenes}}))

func _on_heartbeat_timeout() -> void:
	push_warning("[MCP] Heartbeat timeout")
	_update_panel("MCP: Connection timeout!")

func cancel_current_operation() -> void:
	_heartbeat.resume()
	_update_panel("MCP: Operation cancelled")
	for peer in _peers:
		peer.send_text(JSON.stringify({"method": "operation_cancelled", "params": {}}))

func _update_panel(text: String) -> void:
	var panel = _get_panel()
	if panel: panel.update_status(text)

func _get_panel() -> Node:
	return get_node_or_null("../../../../../MCP")

func _exit_tree() -> void:
	if _server: _server.stop()
	for peer in _peers: peer.close()
	_peers.clear()
```

- [ ] **Step 3: 在 Godot 编辑器中验证**

重新加载插件，确认控制台输出 `[MCP] Listening on port 9090`，状态面板正确更新。

- [ ] **Step 4: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add addons/godot_mcp_server/websocket_server.gd addons/godot_mcp_server/heartbeat.gd
git commit -m "feat: add WebSocket server with heartbeat, multi-port, operation control"
```

---

## Task 10: 编辑器插件 — CommandHandler + UndoRedo

**Files:**
- Create: `addons/godot_mcp_server/command_handler.gd`
- Create: `addons/godot_mcp_server/undo_manager.gd`
- Create: `addons/godot_mcp_server/commands/scene_commands.gd`
- Create: `addons/godot_mcp_server/commands/node_commands.gd`

- [ ] **Step 1: 创建 undo_manager.gd**

```gdscript
extends Node

var _plugin: EditorPlugin

func setup(plugin: EditorPlugin) -> void:
	_plugin = plugin

func create_action(request_id: int, do_methods: Array, undo_methods: Array) -> void:
	var undo_redo = _plugin.get_undo_redo()
	undo_redo.create_action("MCP: op_%d" % request_id)
	for m in do_methods:
		undo_redo.add_do_method(m.target, m.method, m.args)
	for m in undo_methods:
		undo_redo.add_undo_method(m.target, m.method, m.args)
	undo_redo.commit_action()
```

- [ ] **Step 2: 创建 scene_commands.gd**

```gdscript
extends Node

func handle_open_scene(params: Dictionary) -> Dictionary:
	var path: String = params.get("scene_path", "")
	if path.is_empty():
		return {"error": {"code": -32004, "message": "scene_path is required"}}
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	ei.open_scene_from_path(path)
	return {"result": {"status": "opened", "path": path}}

func handle_save_scene(_params: Dictionary) -> Dictionary:
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	ei.save_scene()
	return {"result": {"status": "saved"}}
```

- [ ] **Step 3: 创建 node_commands.gd**

```gdscript
extends Node

var _undo_manager: Node

func setup(undo_manager: Node) -> void:
	_undo_manager = undo_manager

func handle_add_node(params: Dictionary, request_id: int) -> Dictionary:
	var ei = Engine.get_singleton("EditorInterface") as EditorInterface
	var root = ei.get_edited_scene_root()
	if not root:
		return {"error": {"code": -32003, "message": "No scene loaded"}}

	var node_type: String = params.get("node_type", "Node")
	var node_name: String = params.get("node_name", "NewNode")
	var parent_path: String = params.get("parent_node_path", "")

	var parent_node: Node = root
	if not parent_path.is_empty():
		parent_node = root.get_node(parent_path)
		if not parent_node:
			return {"error": {"code": -32002, "message": "Parent not found: %s" % parent_path}}

	var cls = ClassDB.instantiate(node_type)
	if not cls:
		return {"error": {"code": -32000, "message": "Cannot instantiate: %s" % node_type}}
	cls.name = node_name

	_undo_manager.create_action(request_id,
		[{"target": parent_node, "method": "add_child", "args": [cls]},
		 {"target": cls, "method": "set_owner", "args": [root]}],
		[{"target": parent_node, "method": "remove_child", "args": [cls]}]
	)
	return {"result": {"node_path": str(cls.get_path()), "status": "created"}}
```

- [ ] **Step 4: 创建 command_handler.gd**

```gdscript
extends Node

var _scene_commands: Node
var _node_commands: Node
var _undo_manager: Node

func setup(plugin: EditorPlugin) -> void:
	_undo_manager = preload("undo_manager.gd").new()
	_undo_manager.setup(plugin)
	add_child(_undo_manager)

	_scene_commands = preload("commands/scene_commands.gd").new()
	add_child(_scene_commands)

	_node_commands = preload("commands/node_commands.gd").new()
	_node_commands.setup(_undo_manager)
	add_child(_node_commands)

func handle(method: String, params: Dictionary, request_id: int) -> Dictionary:
	match method:
		"open_scene":
			return _scene_commands.handle_open_scene(params)
		"save_scene":
			return _scene_commands.handle_save_scene(params)
		"add_node":
			return _node_commands.handle_add_node(params, request_id)
		_:
			return {"error": {"code": -32601, "message": "Unknown method: %s" % method}}
```

- [ ] **Step 5: 在 Godot 编辑器中验证**

1. 重新加载插件
2. 通过 Node.js EditorConnection 发送 `add_node` 请求
3. 验证节点出现在场景树中，Ctrl+Z 可撤销

- [ ] **Step 6: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add addons/godot_mcp_server/command_handler.gd addons/godot_mcp_server/undo_manager.gd addons/godot_mcp_server/commands/
git commit -m "feat: add CommandHandler, UndoManager, scene/node commands"
```

---

## Task 11: install 命令

**Files:**
- Create: `scripts/install-plugin.js`
- Modify: `package.json`

- [ ] **Step 1: 添加脚本到 package.json**

在 `scripts` 中添加：

```json
"install-plugin": "node scripts/install-plugin.js"
```

- [ ] **Step 2: 创建 scripts/install-plugin.js**

```javascript
#!/usr/bin/env node
import { cpSync, existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const projectIndex = args.indexOf('--project');
const isVerify = args.includes('--verify');

if (projectIndex === -1 || !args[projectIndex + 1]) {
  console.error('Usage: npx godot-mcp-enhanced install-plugin --project /path/to/godot/project');
  console.error('       npx godot-mcp-enhanced install-plugin --verify --project /path/to/godot/project');
  process.exit(1);
}

const projectPath = resolve(args[projectIndex + 1]);
const addonSource = join(__dirname, '..', 'addons', 'godot_mcp_server');
const addonDest = join(projectPath, 'addons', 'godot_mcp_server');

if (isVerify) {
  const cfgPath = join(addonDest, 'plugin.cfg');
  if (!existsSync(cfgPath)) {
    console.error('FAIL: plugin.cfg not found at', cfgPath);
    console.error('Run: npx godot-mcp-enhanced install-plugin --project', projectPath);
    process.exit(1);
  }
  const content = readFileSync(cfgPath, 'utf-8');
  if (!content.includes('[plugin]') || !content.includes('script="plugin.gd"')) {
    console.error('FAIL: plugin.cfg is malformed');
    process.exit(1);
  }
  console.log('OK: Plugin installed and valid at', addonDest);
  process.exit(0);
}

if (!existsSync(projectPath)) {
  console.error('ERROR: Project directory does not exist:', projectPath);
  process.exit(1);
}

if (!existsSync(join(projectPath, 'project.godot'))) {
  console.error('ERROR: Not a Godot project (no project.godot):', projectPath);
  process.exit(1);
}

try {
  cpSync(addonSource, addonDest, { recursive: true });
  console.log('OK: Plugin installed to', addonDest);
  console.log('Next: Open Godot Editor > Project Settings > Plugins > Enable "MCP Server"');
} catch (err) {
  console.error('ERROR:', err.message);
  console.error('Manual: Copy addons/godot_mcp_server/ to your project addons/ directory');
  process.exit(1);
}
```

- [ ] **Step 3: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add package.json scripts/install-plugin.js
git commit -m "feat: add install-plugin script with --verify support"
```

---

## Task 12: 集成测试

**Files:**
- Create: `test/integration/editor-mode.test.js`

- [ ] **Step 1: 编写集成测试**

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { EditorConnection } from '../build/core/EditorConnection.js';
import { EditorToolExecutor } from '../build/core/EditorToolExecutor.js';
import { ReadOnlyGuard } from '../build/core/ReadOnlyGuard.js';
import { registerTools } from '../build/core/tool-registry.js';

describe('Editor mode integration', () => {
  let wss;
  let port;

  beforeEach(() => {
    registerTools([
      { name: 'read_scene', readonly: true, long_running: false },
      { name: 'add_node', readonly: false, long_running: false },
    ]);
    wss = new WebSocketServer({ port: 0 });
    port = wss.address().port;
  });

  afterEach(() => { wss.close(); });

  it('full flow: connect, call tool, guard readonly, disconnect', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { node_path: 'root/Player' } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    assert.ok(conn.isConnected());

    const executor = new EditorToolExecutor(conn);
    const result = await executor.execute('add_node', { project_path: '/test', node_type: 'Sprite2D', node_name: 'Player' });
    assert.ok(!result.isError);

    const guard = new ReadOnlyGuard(true);
    assert.equal(guard.check('add_node').blocked, true);
    assert.equal(guard.check('read_scene').blocked, false);

    conn.disconnect();
    assert.ok(!conn.isConnected());
  });

  it('handles concurrent requests with unique IDs', async () => {
    const received = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        received.push(msg.id);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }));
      });
    });

    const conn = new EditorConnection({ port, reconnect: false });
    await conn.connect();
    const executor = new EditorToolExecutor(conn);
    const results = await Promise.all([
      executor.execute('read_scene', {}),
      executor.execute('add_node', {}),
    ]);
    assert.equal(results.length, 2);
    assert.equal(new Set(received).size, 2);
    conn.disconnect();
  });
});
```

- [ ] **Step 2: 运行全部测试**

Run: `cd D:/GitHub/godot-mcp-enhanced && npm run build && node --test test/*.test.js test/integration/*.test.js`
Expected: 全部通过

- [ ] **Step 3: 提交**

```bash
cd D:/GitHub/godot-mcp-enhanced
git add test/integration/editor-mode.test.js
git commit -m "test: add editor mode integration tests"
```

---

## 自审清单

### Spec 覆盖检查

| Spec 章节 | 对应 Task | 状态 |
|-----------|----------|------|
| 2.1 模式定义 + 降级策略 + NO_FALLBACK | Task 7 | ✅ |
| 2.2 编辑器插件结构 + 多端口 | Task 8, 9 | ✅ |
| 2.3 WebSocket 协议 + 会话恢复（双向同步） | Task 5, 9 | ✅ |
| 2.4 心跳 + operation 暂停 + 600s 上限 + 取消按钮 | Task 5, 9 | ✅ |
| 2.5 UndoRedo（按请求合并 + op_{id} 脱敏 + 节点快照） | Task 10 | ✅ |
| 2.6 只读模式（工具标签化 + 白/黑名单） | Task 1, 2, 3, 4 | ✅ |
| 2.7 命令转发策略（实现分离） | Task 6, 10 | ✅ |
| 3.4 install 命令（项目级 + --verify） | Task 11 | ✅ |
| 9 测试策略 | Task 12 | ✅ |

### 占位符扫描

无 TBD/TODO/placeholder。

### 类型一致性

- `EditorConnection.request()` → `Promise<unknown>` ← `EditorToolExecutor` 正确消费 ✅
- `ReadOnlyGuard.check()` → `GuardResult` ← `GodotServer` 检查 `blocked` 属性 ✅
- `tool-registry.registerTools()` → `ToolMeta[]` ← 所有调用方一致 ✅
- `undo_manager.create_action(request_id, do_methods, undo_methods)` ← `node_commands` 调用一致 ✅
