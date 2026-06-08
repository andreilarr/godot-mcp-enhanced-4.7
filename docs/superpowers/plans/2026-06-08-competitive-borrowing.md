# 竞品借鉴改进实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实施竞品分析中识别的 11 项改进，为 godot-mcp-enhanced 添加 Tag 过滤、路径安全、多实例、懒代理、响应控制、健康监控和 Prompt 系统。

**Architecture:** 渐进增强策略，复用已有 16 组 + 5 Profile 架构。新增中间件层（管道 + 后置钩子模型）拦截所有工具调用。新建 17 个文件、改动 ~10 个现有文件、37 个工具模块零改动。

**Tech Stack:** TypeScript, MCP SDK ^1.29.0, Vitest, Node.js

**设计文档:** `docs/superpowers/specs/2026-06-08-competitive-borrowing-design.md`

---

## 文件结构映射

### 新建文件（17 个）

| Phase | 文件 | 职责 |
|-------|------|------|
| 1 | `src/tools/manage-tools.ts` | manage_tools 元工具（list_groups/activate/deactivate/sync/reconnect） |
| 2a | `src/core/path-security.ts` | sanitizePath() 路径安全校验 |
| 2a | `src/core/command-validator.ts` | validateGdscriptCommand() 危险 API 拦截 |
| 2b | `src/core/instance-manager.ts` | InstanceManager 实例发现与注册表管理 |
| 2b | `src/core/instance-router.ts` | InstanceRouter 请求路由与切换锁 |
| 2b | `src/tools/instance-tools.ts` | godot_list_instances + godot_select_instance |
| 3a | `src/tools/advanced-proxy.ts` | godot_advanced_tool 懒加载代理 |
| 3b | `src/core/middleware/response-limiter.ts` | truncateResponse + 分页处理 |
| 4a | `src/core/health-monitor.ts` | HealthMonitor 心跳与健康状态 |
| 4b | `src/core/reconnection-manager.ts` | ReconnectionManager 指数退避重连 |
| 5 | `src/prompts.ts` | 4 个 MCP Prompt 模板 |
| 5 | `src/core/middleware/elicitation.ts` | 缺参数询问中间件 |
| 5 | `src/core/middleware/context-notify.ts` | 启动 Project Context 通知 |
| 5 | `src/core/middleware/group-filter.ts` | 组过滤中间件（从 Dispatcher 提取） |
| 5 | `src/core/middleware/path-security.ts` | 路径安全中间件（从 Dispatcher 提取） |
| 5 | `src/core/middleware/connection-check.ts` | 连接检查中间件 |
| 5 | `src/core/middleware/health-sample.ts` | 健康采样 after 钩子 |

### 改动文件（~10 个）

| 文件 | 改动内容 |
|------|---------|
| `src/core/tool-registry.ts` | TOOL_GROUPS 增加 requires/description/protected 字段；新增 activeGroups 管理、toolToGroup 反向映射 |
| `src/core/ToolDispatcher.ts` | getFilteredTools() 改为按 activeGroups 实时过滤；handleCall() 加入中间件链 |
| `src/core/module-loader.ts` | 注册时自动注入 annotations.tags |
| `src/GodotServer.ts` | 监听组变更发通知、注册 Prompt handler、启动通知 |
| `src/gdscript-executor.ts` | 沙箱链串联 CommandValidator |
| `src/resources.ts` | 新增 6 个 Resource URI |
| `src/index.ts` | 新增 Feature Flag 环境变量警告 |
| `src/types.ts` | 新增 DispatchContext、Middleware 接口 |
| `scripts/mcp_bridge.gd` | Bridge autoload 增加注册表心跳 |

### 测试文件

每个新建文件对应一个测试文件，放在 `test/` 对应子目录。

---

## Task 0: SDK 前置条件验证

**Files:**
- Create: `test/sdk-prerequisites.test.ts`

- [ ] **Step 1: 验证 MCP SDK 的 annotations.tags 支持**

```typescript
// test/sdk-prerequisites.test.ts
import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

describe('SDK Prerequisites', () => {
  it('supports annotations.tags on Tool definitions', () => {
    const tool: Tool = {
      name: 'test_tool',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      annotations: { tags: ['group:core'] },
    };
    expect(tool.annotations?.tags).toEqual(['group:core']);
  });

  it('Server type has capabilities.tools for list_changed', () => {
    // Server 构造时传入 capabilities: { tools: {} } 即支持 list_changed
    // 验证类型定义存在
    const caps = { tools: {} };
    expect(caps.tools).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx vitest run test/sdk-prerequisites.test.ts`
Expected: PASS

- [ ] **Step 3: 验证 server.notification() 和 Prompt handler 类型**

在 `test/sdk-prerequisites.test.ts` 中追加：

```typescript
it('Server.notification method exists in type', async () => {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const server = new Server(
    { name: 'test', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  expect(typeof server.notification).toBe('function');
});

it('ListPromptsRequestSchema is importable', async () => {
  const schemas = await import('@modelcontextprotocol/sdk/types.js');
  expect(schemas.ListPromptsRequestSchema).toBeDefined();
  expect(schemas.GetPromptRequestSchema).toBeDefined();
});
```

- [ ] **Step 4: 运行完整测试验证**

Run: `npx vitest run test/sdk-prerequisites.test.ts`
Expected: PASS（4 个测试全通过）

- [ ] **Step 5: Commit**

```bash
git add test/sdk-prerequisites.test.ts
git commit -m "test: SDK prerequisites for competitive borrowing features"
```

---

## Task 1: 类型定义扩展

**Files:**
- Modify: `src/types.ts`
- Create: `test/types-middleware.test.ts`

- [ ] **Step 1: 写失败测试 — Middleware 和 DispatchContext 接口**

```typescript
// test/types-middleware.test.ts
import { describe, it, expect } from 'vitest';
import type { DispatchContext, Middleware, MiddlewareResult, ConnectionState } from '../src/types.js';

describe('Middleware types', () => {
  it('DispatchContext has required fields', () => {
    const ctx: DispatchContext = {
      toolName: 'scene',
      args: { action: 'read_scene' },
      startTime: Date.now(),
      phase: 'before',
    };
    expect(ctx.toolName).toBe('scene');
    expect(ctx.phase).toBe('before');
  });

  it('MiddlewareResult passed type is valid', () => {
    const result: MiddlewareResult = { passed: true };
    expect(result.passed).toBe(true);
  });

  it('MiddlewareResult rejected type is valid', () => {
    const result: MiddlewareResult = {
      rejected: true,
      error: { content: [{ type: 'text', text: 'blocked' }] },
    };
    expect(result.rejected).toBe(true);
  });

  it('Middleware interface accepts before and optional after', () => {
    const mw: Middleware = {
      name: 'test',
      before: async () => ({ passed: true }),
      after: async (_ctx, result) => result,
    };
    expect(mw.name).toBe('test');
    expect(mw.after).toBeDefined();
  });

  it('Middleware without after is valid', () => {
    const mw: Middleware = {
      name: 'test-no-after',
      before: async () => ({ passed: true }),
    };
    expect(mw.after).toBeUndefined();
  });

  it('ConnectionState has 4 states', () => {
    const states: ConnectionState[] = ['disconnected', 'connected', 'degraded', 'reconnecting'];
    expect(states).toHaveLength(4);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/types-middleware.test.ts`
Expected: FAIL — 模块找不到导出

- [ ] **Step 3: 在 src/types.ts 中添加接口定义**

在 `src/types.ts` 末尾追加：

```typescript
// ─── Middleware types (competitive borrowing Phase 5) ──────────────────────────

export type ConnectionState = 'disconnected' | 'connected' | 'degraded' | 'reconnecting';

export interface DispatchContext {
  toolName: string;
  args: Record<string, unknown>;
  startTime: number;
  phase: 'before' | 'after';
}

export type MiddlewareResult =
  | { passed: true }
  | { rejected: true; error: ToolResult };

export interface Middleware {
  name: string;
  before(ctx: DispatchContext): Promise<MiddlewareResult>;
  after?(ctx: DispatchContext, result: ToolResult): Promise<ToolResult>;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/types-middleware.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/types-middleware.test.ts
git commit -m "feat(types): add Middleware, DispatchContext, ConnectionState interfaces"
```

---

## Task 2: TOOL_GROUPS 扩展 — requires/description/protected 字段

**Files:**
- Modify: `src/core/tool-registry.ts`
- Create: `test/core/tool-registry-groups.test.ts`

- [ ] **Step 1: 写失败测试 — TOOL_GROUPS 新字段**

```typescript
// test/core/tool-registry-groups.test.ts
import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  PROFILES,
  expandGroups,
  resolveProfile,
  getGroupForTool,
  setActiveGroups,
  getActiveGroups,
  isToolAllowed,
} from '../../src/core/tool-registry.js';

describe('TOOL_GROUPS enhanced', () => {
  it('each group has description, tools, requires, protected fields', () => {
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      expect(group).toHaveProperty('description');
      expect(group).toHaveProperty('tools');
      expect(group).toHaveProperty('requires');
      expect(Array.isArray(group.requires)).toBe(true);
      if (name === 'core') {
        expect(group.protected).toBe(true);
      }
    }
  });

  it('core group is protected', () => {
    expect(TOOL_GROUPS.core.protected).toBe(true);
  });

  it('bridge group requires bridge connection', () => {
    expect(TOOL_GROUPS.bridge.requires).toContain('bridge');
  });

  it('recording group requires bridge connection', () => {
    expect(TOOL_GROUPS.recording.requires).toContain('bridge');
  });

  it('editor group requires editor connection', () => {
    expect(TOOL_GROUPS.editor.requires).toContain('editor');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/tool-registry-groups.test.ts`
Expected: FAIL — TOOL_GROUPS 结构不匹配（当前是 `string[]`，需要改为对象）

- [ ] **Step 3: 改造 TOOL_GROUPS 定义**

将 `src/core/tool-registry.ts` 中的 `TOOL_GROUPS` 从 `Record<string, string[]>` 改为增强结构：

```typescript
/** Tool group definition with connection requirements and protection. */
export interface ToolGroupDef {
  description: string;
  tools: string[];
  requires: ('bridge' | 'editor' | 'headless')[];
  protected?: boolean;
}

/** 16 tool groups for fine-grained profile configuration. */
export const TOOL_GROUPS: Record<string, ToolGroupDef> = {
  core:       { description: '核心工具', tools: ['project', 'scene', 'script', 'runtime', 'validation', 'confirm_and_execute'], requires: [], protected: true },
  editor:     { description: '编辑器', tools: ['editor'], requires: ['editor'] },
  bridge:     { description: 'Game Bridge', tools: ['game'], requires: ['bridge'] },
  animation:  { description: '动画系统', tools: ['animation', 'animtree', 'animation_track'], requires: [] },
  audio:      { description: '音频', tools: ['audio'], requires: [] },
  visual:     { description: '视觉', tools: ['material', 'screenshot', 'particles'], requires: [] },
  physics:    { description: '物理/导航', tools: ['physics', 'node_create_3d'], requires: [] },
  navigation: { description: '导航', tools: ['nav'], requires: [] },
  ui:         { description: 'UI', tools: ['ui'], requires: [] },
  tilemap:    { description: 'TileMap', tools: ['tilemap', 'scene_commit'], requires: [] },
  signal:     { description: '信号', tools: ['signal'], requires: [] },
  profiler:   { description: '性能分析', tools: ['profiler', 'workflow'], requires: [] },
  test:       { description: '测试', tools: ['test', 'verify_delivery'], requires: [] },
  code:       { description: '代码工具', tools: ['docs', 'templates', 'batch', 'game_design'], requires: [] },
  ik:         { description: 'IK', tools: ['ik'], requires: [] },
  recording:  { description: '录制', tools: ['recording'], requires: ['bridge'] },
};
```

同时更新 `expandGroups()` 函数，因为 `TOOL_GROUPS[g]` 现在返回 `ToolGroupDef` 而非 `string[]`：

```typescript
export function expandGroups(groups: string[]): Set<string> {
  const tools = new Set<string>();
  for (const g of groups) {
    const groupDef = TOOL_GROUPS[g];
    if (groupDef) {
      for (const t of groupDef.tools) tools.add(t);
    }
  }
  return tools;
}
```

更新 `PROFILES` — 因为现在 `Object.keys(TOOL_GROUPS)` 仍然返回组名数组，`PROFILES.full` 不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/tool-registry-groups.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过（expandGroups 内部变化不影响外部行为）

- [ ] **Step 6: Commit**

```bash
git add src/core/tool-registry.ts test/core/tool-registry-groups.test.ts
git commit -m "feat(registry): add requires/description/protected to TOOL_GROUPS"
```

---

## Task 3: activeGroups 管理和 toolToGroup 反向映射

**Files:**
- Modify: `src/core/tool-registry.ts`
- Modify: `test/core/tool-registry-groups.test.ts`

- [ ] **Step 1: 写失败测试 — activeGroups 和反向映射**

在 `test/core/tool-registry-groups.test.ts` 追加：

```typescript
describe('activeGroups management', () => {
  beforeEach(() => {
    // 重置为 full profile
    setActiveGroups(new Set(Object.keys(TOOL_GROUPS)));
  });

  it('getActiveGroups returns current active groups', () => {
    const groups = getActiveGroups();
    expect(groups.size).toBe(Object.keys(TOOL_GROUPS).length);
  });

  it('setActiveGroups updates active groups', () => {
    setActiveGroups(new Set(['core', 'animation']));
    const groups = getActiveGroups();
    expect(groups.has('core')).toBe(true);
    expect(groups.has('animation')).toBe(true);
    expect(groups.has('bridge')).toBe(false);
  });

  it('isToolAllowed returns true for tools in active groups', () => {
    setActiveGroups(new Set(['core', 'animation']));
    // animation 组包含 'animation', 'animtree', 'animation_track'
    expect(isToolAllowed('animation')).toBe(true);
    expect(isToolAllowed('animtree')).toBe(true);
  });

  it('isToolAllowed returns false for tools in inactive groups', () => {
    setActiveGroups(new Set(['core']));
    expect(isToolAllowed('game')).toBe(false);
  });

  it('isToolAllowed always returns true for manage_tools', () => {
    setActiveGroups(new Set());  // 即使全部停用
    expect(isToolAllowed('manage_tools')).toBe(true);
  });

  it('isToolAllowed always returns true for confirm_and_execute', () => {
    setActiveGroups(new Set());
    expect(isToolAllowed('confirm_and_execute')).toBe(true);
  });
});

describe('toolToGroup reverse mapping', () => {
  it('getGroupForTool returns group name for a tool', () => {
    expect(getGroupForTool('animation')).toBe('animation');
    expect(getGroupForTool('game')).toBe('bridge');
    expect(getGroupForTool('project')).toBe('core');
  });

  it('getGroupForTool returns undefined for unknown tool', () => {
    expect(getGroupForTool('nonexistent_tool')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/tool-registry-groups.test.ts`
Expected: FAIL — setActiveGroups/getActiveGroups/isToolAllowed/getGroupForTool 未定义

- [ ] **Step 3: 实现 activeGroups 管理和反向映射**

在 `src/core/tool-registry.ts` 的 `// ─── Tool groups ──` 部分追加：

```typescript
// ─── Active groups (connection-level, not persisted) ──────────────────────────

/** Currently active tool groups. Copy-on-write for read consistency. */
let activeGroups: Set<string> = new Set(Object.keys(TOOL_GROUPS));

/** Reverse mapping: tool name → group name. Built once from TOOL_GROUPS. */
const toolToGroup = new Map<string, string>();
for (const [group, def] of Object.entries(TOOL_GROUPS)) {
  for (const tool of def.tools) {
    toolToGroup.set(tool, group);
  }
}

/** Tools that are always allowed regardless of group state. */
const ALWAYS_ALLOWED = new Set(['manage_tools', 'confirm_and_execute', 'godot_advanced_tool']);

/** Set active groups (copy-on-write). Returns previous set for comparison. */
export function setActiveGroups(groups: Set<string>): Set<string> {
  const prev = activeGroups;
  activeGroups = new Set(groups); // Copy-on-write
  return prev;
}

/** Get current active groups (read-only snapshot). */
export function getActiveGroups(): ReadonlySet<string> {
  return activeGroups;
}

/** Initialize active groups from a profile name. */
export function initActiveGroupsFromProfile(profile: string): void {
  const groups = PROFILES[profile];
  if (groups) {
    activeGroups = new Set(groups);
  } else {
    // comma-separated groups or unknown profile
    const parsed = profile.split(',').map(g => g.trim()).filter(Boolean);
    activeGroups = new Set(parsed.length > 0 ? parsed : Object.keys(TOOL_GROUPS));
  }
}

/** Check if a tool is allowed under current active groups. */
export function isToolAllowed(toolName: string): boolean {
  if (ALWAYS_ALLOWED.has(toolName)) return true;
  const group = toolToGroup.get(toolName);
  if (!group) return false; // Unknown tool
  return activeGroups.has(group);
}

/** Get the group name for a tool. Returns undefined if tool not in any group. */
export function getGroupForTool(toolName: string): string | undefined {
  return toolToGroup.get(toolName);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/tool-registry-groups.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/core/tool-registry.ts test/core/tool-registry-groups.test.ts
git commit -m "feat(registry): add activeGroups management and toolToGroup reverse mapping"
```

---

## Task 4: manage_tools 元工具

**Files:**
- Create: `src/tools/manage-tools.ts`
- Create: `test/tools/manage-tools.test.ts`
- Modify: `src/core/module-loader.ts`

- [ ] **Step 1: 写失败测试 — manage_tools 5 个操作**

```typescript
// test/tools/manage-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tool-registry
const mockSetActiveGroups = vi.fn();
const mockGetActiveGroups = vi.fn();
const mockGetGroupForTool = vi.fn();

vi.mock('../../src/core/tool-registry.js', () => ({
  TOOL_GROUPS: {
    core: { description: '核心工具', tools: ['project', 'scene'], requires: [], protected: true },
    animation: { description: '动画', tools: ['animation'], requires: [] },
    bridge: { description: 'Bridge', tools: ['game'], requires: ['bridge'] },
  },
  setActiveGroups: mockSetActiveGroups,
  getActiveGroups: mockGetActiveGroups,
  getGroupForTool: mockGetGroupForTool,
}));

vi.mock('../../src/tools/shared.js', () => ({
  opsSuccess: (data: unknown) => ({ success: true, data, warnings: [] }),
  opsError: (code: string, msg: string) => ({ success: false, error: msg, error_code: code, warnings: [] }),
  opsErrorResult: (code: string, msg: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg, error_code: code }) }],
    isError: true,
  }),
}));
vi.mock('../../src/helpers.js', () => ({
  isPathInAllowedRoots: vi.fn().mockReturnValue(true),
}));
vi.mock('../../src/core/process-state.js', () => ({
  getRunningProcess: vi.fn().mockReturnValue(null),
  setRunningProcess: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue([]),
  setOutputBuffer: vi.fn(),
  getProcessStartTime: vi.fn().mockReturnValue(0),
  setProcessStartTime: vi.fn(),
  getProjectDir: vi.fn().mockReturnValue(''),
  setProjectDir: vi.fn(),
}));
vi.mock('../../src/guard.js', () => ({
  requiresConfirmation: vi.fn().mockReturnValue(false),
}));

import { handleTool, getToolDefinitions } from '../../src/tools/manage-tools.js';

describe('manage_tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveGroups.mockReturnValue(new Set(['core', 'animation', 'bridge']));
  });

  it('getToolDefinitions returns single tool with action enum', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('manage_tools');
    const schema = defs[0].inputSchema as Record<string, unknown>;
    expect(schema.properties).toHaveProperty('action');
  });

  it('list_groups returns all groups with status', async () => {
    const result = await handleTool('manage_tools', { action: 'list_groups' }, {} as any);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
    expect(data.data.groups).toBeDefined();
    expect(data.data.groups.length).toBeGreaterThan(0);
    // core group should be in the list
    const coreGroup = data.data.groups.find((g: any) => g.name === 'core');
    expect(coreGroup).toBeDefined();
    expect(coreGroup.protected).toBe(true);
  });

  it('activate adds groups to active set', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', {
      action: 'activate',
      groups: ['animation'],
    }, {} as any);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
    expect(mockSetActiveGroups).toHaveBeenCalled();
  });

  it('deactivate rejects protected groups', async () => {
    const result = await handleTool('manage_tools', {
      action: 'deactivate',
      groups: ['core'],
    }, {} as any);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toContain('protected');
  });

  it('deactivate removes non-protected groups', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', {
      action: 'deactivate',
      groups: ['animation'],
    }, {} as any);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
  });

  it('sync returns updated status', async () => {
    mockSetActiveGroups.mockImplementation((groups: Set<string>) => groups);
    const result = await handleTool('manage_tools', { action: 'sync' }, {} as any);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
  });

  it('reconnect returns placeholder for Phase 4', async () => {
    const result = await handleTool('manage_tools', { action: 'reconnect' }, {} as any);
    const data = JSON.parse((result.content as any)[0].text);
    expect(data.success).toBe(true);
    // Phase 4 会扩展 reconnect 为实际重连
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/manage-tools.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 manage-tools.ts**

```typescript
// src/tools/manage-tools.ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import {
  TOOL_GROUPS,
  setActiveGroups,
  getActiveGroups,
} from '../core/tool-registry.js';
import { opsSuccess, opsError } from './shared.js';

type ManageAction = 'list_groups' | 'activate' | 'deactivate' | 'sync' | 'reconnect';

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'manage_tools',
    description:
      '动态管理工具组的启用/停用状态。始终可用，不可被禁用。' +
      '支持 list_groups（列出所有组）、activate（启用组）、deactivate（停用组）、sync（同步连接状态）、reconnect（手动重连）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list_groups', 'activate', 'deactivate', 'sync', 'reconnect'],
          description: '操作类型',
        },
        groups: {
          type: 'array',
          items: { type: 'string' },
          description: '目标组名数组（activate/deactivate 时使用）',
        },
      },
      required: ['action'],
    },
    annotations: { tags: ['group:core'] },
  }];
}

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'manage_tools') return null;

  const action = args.action as ManageAction;

  switch (action) {
    case 'list_groups': return handleListGroups();
    case 'activate': return handleActivate(args);
    case 'deactivate': return handleDeactivate(args);
    case 'sync': return handleSync();
    case 'reconnect': return handleReconnect();
    default:
      return textResult(JSON.stringify(opsError('INVALID_ACTION', `Unknown action: ${action}`)));
  }
}

function handleListGroups(): ToolResult {
  const active = getActiveGroups();
  const groups = Object.entries(TOOL_GROUPS).map(([name, def]) => ({
    name,
    description: def.description,
    active: active.has(name),
    protected: def.protected ?? false,
    requires: def.requires,
    toolCount: def.tools.length,
  }));
  return textResult(JSON.stringify(opsSuccess({ groups })));
}

function handleActivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for activate')));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) {
    if (TOOL_GROUPS[g]) updated.add(g);
  }
  setActiveGroups(updated);
  return textResult(JSON.stringify(opsSuccess({
    activated: targetGroups,
    activeGroups: [...updated],
  })));
}

function handleDeactivate(args: Record<string, unknown>): ToolResult {
  const targetGroups = (args.groups as string[]) ?? [];
  if (targetGroups.length === 0) {
    return textResult(JSON.stringify(opsError('MISSING_GROUPS', 'groups array is required for deactivate')));
  }
  // 检查保护组
  const protectedGroups = targetGroups.filter(g => TOOL_GROUPS[g]?.protected);
  if (protectedGroups.length > 0) {
    return textResult(JSON.stringify(opsError(
      'PROTECTED_GROUP',
      `Cannot deactivate protected groups: ${protectedGroups.join(', ')}`,
    )));
  }
  const current = getActiveGroups();
  const updated = new Set(current);
  for (const g of targetGroups) updated.delete(g);
  setActiveGroups(updated);
  return textResult(JSON.stringify(opsSuccess({
    deactivated: targetGroups,
    activeGroups: [...updated],
  })));
}

function handleSync(): ToolResult {
  // Phase 1: 基础版 — 检查 requires 条件与连接状态
  // Phase 4 会扩展为检查实际连接状态
  const active = getActiveGroups();
  return textResult(JSON.stringify(opsSuccess({
    synced: true,
    activeGroups: [...active],
    note: 'Basic sync — Phase 4 will add connection-aware sync',
  })));
}

function handleReconnect(): ToolResult {
  // Phase 4 会实现实际重连逻辑
  return textResult(JSON.stringify(opsSuccess({
    reconnected: false,
    note: 'Reconnect will be implemented in Phase 4',
  })));
}

// ─── Auto-register metadata ──────────────────────────────────────────────────
export const TOOL_META = {
  manage_tools: { readonly: true, long_running: false },
};
```

- [ ] **Step 4: 注册 manage-tools 到 module-loader**

在 `src/core/module-loader.ts` 中追加导入和注册：

```typescript
// 在 import 区追加
import * as manageTools from '../tools/manage-tools.js';

// 在 ALL_MODULES 数组末尾追加
manageTools,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/tools/manage-tools.test.ts`
Expected: PASS

- [ ] **Step 6: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add src/tools/manage-tools.ts test/tools/manage-tools.test.ts src/core/module-loader.ts
git commit -m "feat(manage-tools): add manage_tools meta-tool with 5 operations"
```

---

## Task 5: annotations.tags 自动注入

**Files:**
- Modify: `src/core/module-loader.ts`
- Modify: `src/core/tool-registry.ts`
- Create: `test/core/module-loader-tags.test.ts`

- [ ] **Step 1: 写失败测试 — tags 自动注入**

```typescript
// test/core/module-loader-tags.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Mock tool-registry to capture registered definitions
const capturedTools: Tool[] = [];
vi.mock('../../src/core/tool-registry.js', () => ({
  registerModule: vi.fn((mod: any) => {
    capturedTools.push(...mod.getToolDefinitions());
  }),
}));

import { registerAllModules } from '../../src/core/module-loader.js';

describe('Module loader tag injection', () => {
  it('all registered tools have annotations.tags', () => {
    capturedTools.length = 0;
    registerAllModules();
    const toolsWithoutTags = capturedTools.filter(
      t => !t.annotations?.tags || !Array.isArray(t.annotations.tags) || t.annotations.tags.length === 0
    );
    // 只列出缺少 tags 的工具名（不截断）
    const missingNames = toolsWithoutTags.map(t => t.name);
    expect(missingNames, `Tools missing annotations.tags: ${missingNames.join(', ')}`).toEqual([]);
  });

  it('tags follow group:xxx format', () => {
    capturedTools.length = 0;
    registerAllModules();
    for (const tool of capturedTools) {
      const tags = tool.annotations?.tags as string[];
      if (tags) {
        for (const tag of tags) {
          expect(tag).toMatch(/^group:\w+$/);
        }
      }
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/module-loader-tags.test.ts`
Expected: FAIL — 工具没有 annotations.tags

- [ ] **Step 3: 在 module-loader 中注入 tags**

修改 `src/core/module-loader.ts`，在 `registerAllModules()` 中为每个模块的工具定义注入 tags：

```typescript
// 在文件顶部添加
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_GROUPS, registerModule } from './tool-registry.js';

// ... 保留原有的 import ...

/** Build tool→group mapping for tag injection. */
function buildToolGroupMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [group, def] of Object.entries(TOOL_GROUPS)) {
    for (const tool of def.tools) {
      map.set(tool, group);
    }
  }
  return map;
}

const toolGroupMap = buildToolGroupMap();

/** Inject annotations.tags into tool definitions based on TOOL_GROUPS mapping. */
function injectTags(defs: Tool[]): Tool[] {
  return defs.map(def => ({
    ...def,
    annotations: {
      ...def.annotations,
      tags: [`group:${toolGroupMap.get(def.name) ?? 'unknown'}`],
    },
  }));
}

/** Register all tool modules into the global registry with tag injection. */
export function registerAllModules(): void {
  for (const mod of ALL_MODULES) {
    // Wrap the module to inject tags on every getToolDefinitions call
    const originalGetDefs = mod.getToolDefinitions;
    const wrappedMod = {
      ...mod,
      TOOL_META: mod.TOOL_META,
      getToolDefinitions: () => injectTags(originalGetDefs.call(mod)),
    };
    registerModule(wrappedMod);
  }
}
```

**注意**：不再直接修改 `mod` 对象（避免副作用），而是创建包装后的 `wrappedMod` 传给 `registerModule`。原有的 `import { registerModule } from './tool-registry.js'` 需要移除顶部的旧导入（如果存在），改从本文件统一注册。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/module-loader-tags.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/core/module-loader.ts test/core/module-loader-tags.test.ts
git commit -m "feat(loader): auto-inject annotations.tags from TOOL_GROUPS mapping"
```

---

## Task 6: ToolDispatcher 集成 activeGroups 过滤

**Files:**
- Modify: `src/core/ToolDispatcher.ts`
- Modify: `test/core/ToolDispatcher.test.ts`

- [ ] **Step 1: 写失败测试 — getFilteredTools 按 activeGroups 过滤**

在 `test/core/ToolDispatcher.test.ts` 末尾追加测试块：

```typescript
describe('getFilteredTools with activeGroups', () => {
  it('returns only tools from active groups', async () => {
    const { setActiveGroups } = await import('../../src/core/tool-registry.js');
    setActiveGroups(new Set(['core', 'animation']));
    const tools = dispatcher.getFilteredTools();
    const toolNames = tools.map(t => t.name);
    // core tools should be present
    expect(toolNames).toContain('scene');
    // animation tools should be present
    expect(toolNames).toContain('animation');
    // bridge tools should NOT be present
    expect(toolNames).not.toContain('game');
  });

  it('manage_tools always appears regardless of active groups', async () => {
    const { setActiveGroups } = await import('../../src/core/tool-registry.js');
    setActiveGroups(new Set(['core'])); // minimal
    const tools = dispatcher.getFilteredTools();
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('manage_tools');
    expect(toolNames).toContain('confirm_and_execute');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/ToolDispatcher.test.ts`
Expected: FAIL — getFilteredTools 尚未使用 activeGroups

- [ ] **Step 3: 修改 ToolDispatcher.getFilteredTools() 集成 activeGroups**

在 `src/core/ToolDispatcher.ts` 的 `getFilteredTools()` 方法中，在 Profile 模式过滤之后追加 activeGroups 过滤：

```typescript
import {
  getAllToolDefinitions,
  getModuleForTool,
  LITE_TOOLS,
  MINIMAL_TOOLS,
  registerInlineTool,
  resolveProfile,
  getActiveGroups,   // 新增
  isToolAllowed,     // 新增
} from './tool-registry.js';
```

在 `getFilteredTools()` 末尾（return 之前）追加：

```typescript
    // activeGroups 过滤（Phase 1 动态管理）
    if (process.env.GODOT_MCP_TOOL_GROUPS !== 'false') {
      allTools = allTools.filter(t => isToolAllowed(t.name));
      log('activeGroups filter: %d tools available', allTools.length);
    }

    return allTools;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/ToolDispatcher.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/core/ToolDispatcher.ts test/core/ToolDispatcher.test.ts
git commit -m "feat(dispatcher): integrate activeGroups filtering in getFilteredTools"
```

---

## Task 7: notifications/tools/list_changed 集成

**Files:**
- Modify: `src/GodotServer.ts`
- Modify: `src/tools/manage-tools.ts`
- Create: `test/GodotServer-notifications.test.ts`

- [ ] **Step 1: 写失败测试 — 组变更触发通知**

```typescript
// test/GodotServer-notifications.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Group change notifications', () => {
  it('manage_tools activates groups and triggers notification callback', async () => {
    const notificationFn = vi.fn();
    // 模拟激活组后的通知行为
    const { setActiveGroups } = await import('../../src/core/tool-registry.js');
    const prev = setActiveGroups(new Set(['core', 'animation', 'bridge']));

    // 验证 setActiveGroups 返回 previous set
    expect(prev).toBeDefined();
    // 验证当前 activeGroups 已更新
    const { getActiveGroups } = await import('../../src/core/tool-registry.js');
    expect(getActiveGroups().has('animation')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认通过（简单验证，通知机制依赖 Server 实例）**

Run: `npx vitest run test/GodotServer-notifications.test.ts`
Expected: PASS

- [ ] **Step 3: 在 GodotServer 中添加通知发送能力**

修改 `src/GodotServer.ts`，在 setupHandlers 中保存 server 实例引用，并提供 `sendToolListChanged()` 方法：

在 `GodotServer` 类中添加：

```typescript
  /** Send tools/list_changed notification to client. Called when active groups change. */
  sendToolListChanged(): void {
    this.server.notification({
      method: 'notifications/tools/list_changed',
    });
  }
```

- [ ] **Step 4: 修改 manage-tools 使用通知回调**

修改 `src/tools/manage-tools.ts`，添加可选的通知回调参数。handleTool 接收额外的 `onGroupsChanged` 回调：

在 `handleActivate` 和 `handleDeactivate` 成功后调用通知：

```typescript
// 在文件顶部添加
let _onGroupsChanged: (() => void) | null = null;

/** Set notification callback (called by GodotServer). */
export function setOnGroupsChanged(fn: (() => void) | null): void {
  _onGroupsChanged = fn;
}
```

在 `handleActivate` 和 `handleDeactivate` 的 `setActiveGroups(updated)` 后调用：

```typescript
  _onGroupsChanged?.();
```

- [ ] **Step 5: 在 GodotServer.setupHandlers() 中连接通知**

在 `src/GodotServer.ts` 的 `setupHandlers()` 方法中：

```typescript
import { setOnGroupsChanged } from './tools/manage-tools.js';

// 在 setupHandlers 末尾
setOnGroupsChanged(() => this.sendToolListChanged());
```

并在 `close()` 中清理：

```typescript
setOnGroupsChanged(null);
```

- [ ] **Step 6: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add src/GodotServer.ts src/tools/manage-tools.ts test/GodotServer-notifications.test.ts
git commit -m "feat(notifications): send tools/list_changed on group activation/deactivation"
```

---

## Task 8: Feature Flag 环境变量

**Files:**
- Modify: `src/index.ts`
- Create: `test/feature-flags.test.ts`

- [ ] **Step 1: 写失败测试 — Feature Flag 验证**

```typescript
// test/feature-flags.test.ts
import { describe, it, expect } from 'vitest';

describe('Feature flags', () => {
  it('all Phase 1-5 flags have correct defaults', () => {
    // 默认值测试
    const defaults: Record<string, string | undefined> = {
      GODOT_MCP_TOOL_GROUPS: undefined,       // true by default (flag controls disable)
      GODOT_MCP_PATH_SECURITY: undefined,     // true by default
      GODOT_MCP_MULTI_INSTANCE: undefined,    // false by default
      GODOT_MCP_ADVANCED_PROXY: undefined,    // false by default
      GODOT_MCP_RESPONSE_LIMIT: undefined,    // true by default
      GODOT_MCP_HEALTH_MONITOR: undefined,    // true by default
      GODOT_MCP_OFFLINE_MODE: undefined,      // true by default
      GODOT_MCP_ELICITATION: undefined,       // true by default
    };
    // 验证环境变量名存在于文档中
    for (const key of Object.keys(defaults)) {
      expect(key).toMatch(/^GODOT_MCP_[A-Z_]+$/);
    }
  });

  it('isFeatureEnabled helper returns correct values', async () => {
    const { isFeatureEnabled } = await import('../../src/core/feature-flags.js');
    // 默认 true 的 feature
    expect(isFeatureEnabled('TOOL_GROUPS')).toBe(true);
    // 设置为 false
    process.env.GODOT_MCP_TOOL_GROUPS = 'false';
    expect(isFeatureEnabled('TOOL_GROUPS')).toBe(false);
    delete process.env.GODOT_MCP_TOOL_GROUPS;
    // 默认 false 的 feature
    expect(isFeatureEnabled('MULTI_INSTANCE')).toBe(false);
    process.env.GODOT_MCP_MULTI_INSTANCE = 'true';
    expect(isFeatureEnabled('MULTI_INSTANCE')).toBe(true);
    delete process.env.GODOT_MCP_MULTI_INSTANCE;
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/feature-flags.test.ts`
Expected: FAIL — feature-flags 模块不存在

- [ ] **Step 3: 创建 feature-flags.ts**

```typescript
// src/core/feature-flags.ts

/** Feature flag definitions: key → { env var, default value } */
const FEATURES = {
  TOOL_GROUPS:     { env: 'GODOT_MCP_TOOL_GROUPS',     default: true },
  PATH_SECURITY:   { env: 'GODOT_MCP_PATH_SECURITY',   default: true },
  MULTI_INSTANCE:  { env: 'GODOT_MCP_MULTI_INSTANCE',   default: false },
  ADVANCED_PROXY:  { env: 'GODOT_MCP_ADVANCED_PROXY',   default: false },
  RESPONSE_LIMIT:  { env: 'GODOT_MCP_RESPONSE_LIMIT',   default: true },
  HEALTH_MONITOR:  { env: 'GODOT_MCP_HEALTH_MONITOR',   default: true },
  OFFLINE_MODE:    { env: 'GODOT_MCP_OFFLINE_MODE',     default: true },
  ELICITATION:     { env: 'GODOT_MCP_ELICITATION',      default: true },
} as const;

export type FeatureKey = keyof typeof FEATURES;

/** Check if a feature is enabled. Reads from env var, falls back to default. */
export function isFeatureEnabled(key: FeatureKey): boolean {
  const feature = FEATURES[key];
  const envVal = process.env[feature.env];
  if (envVal === undefined) return feature.default;
  return envVal.toLowerCase() === 'true';
}

/** Get all feature flags with their current values. */
export function getAllFeatureFlags(): Record<FeatureKey, boolean> {
  const result = {} as Record<FeatureKey, boolean>;
  for (const key of Object.keys(FEATURES) as FeatureKey[]) {
    result[key] = isFeatureEnabled(key);
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/feature-flags.test.ts`
Expected: PASS

- [ ] **Step 5: 在 index.ts 中添加 feature flag 启动警告**

在 `src/index.ts` 的 `startMcpServer()` 函数中，在 security bypass 警告之后追加：

```typescript
  // Feature flags info
  const { getAllFeatureFlags } = await import('./core/feature-flags.js');
  const flags = getAllFeatureFlags();
  const disabledFeatures = Object.entries(flags).filter(([, v]) => !v).map(([k]) => k);
  if (disabledFeatures.length > 0) {
    logger.info('godot-mcp', `Features disabled: ${disabledFeatures.join(', ')}`);
  }
```

- [ ] **Step 6: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add src/core/feature-flags.ts src/index.ts test/feature-flags.test.ts
git commit -m "feat(flags): add Feature Flag system with env var controls"
```

---

## Task 9: Phase 2a — sanitizePath 路径安全

**Files:**
- Create: `src/core/path-security.ts`
- Create: `test/core/path-security.test.ts`

- [ ] **Step 1: 写失败测试 — sanitizePath 校验**

```typescript
// test/core/path-security.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizePath } from '../../src/core/path-security.js';

describe('sanitizePath', () => {
  it('normalizes backslashes to forward slashes', () => {
    expect(sanitizePath('res://scenes\\main.tscn')).toBe('res://scenes/main.tscn');
  });

  it('merges double slashes', () => {
    expect(sanitizePath('res://scenes//main.tscn')).toBe('res://scenes/main.tscn');
  });

  it('rejects path traversal with ..', () => {
    expect(() => sanitizePath('res://../etc/passwd')).toThrow(/traversal/i);
  });

  it('allows res:// prefix', () => {
    expect(sanitizePath('res://scenes/main.tscn')).toBe('res://scenes/main.tscn');
  });

  it('allows user:// prefix', () => {
    expect(sanitizePath('user://save/game.dat')).toBe('user://save/game.dat');
  });

  it('rejects non-whitelisted prefix', () => {
    expect(() => sanitizePath('/etc/passwd')).toThrow(/prefix/i);
  });

  it('rejects illegal characters', () => {
    expect(() => sanitizePath('res://scenes/<script>.tscn')).toThrow(/illegal/i);
  });

  it('rejects control characters', () => {
    expect(() => sanitizePath('res://\x00evil')).toThrow(/illegal/i);
  });

  it('allows custom roots via opts.allowedRoots', () => {
    expect(sanitizePath('D:/custom/file.txt', {
      allowedRoots: ['D:/custom'],
    })).toBe('D:/custom/file.txt');
  });

  it('cannot remove default whitelist with opts', () => {
    // allowedRoots 是追加，不可移除默认
    expect(sanitizePath('res://scenes/main.tscn', {
      allowedRoots: ['D:/custom'],
    })).toBe('res://scenes/main.tscn');
  });

  it('accepts allowedRoots from env var', () => {
    process.env.GODOT_MCP_ALLOWED_ROOTS = 'D:/env-custom';
    try {
      expect(sanitizePath('D:/env-custom/file.txt')).toBe('D:/env-custom/file.txt');
    } finally {
      delete process.env.GODOT_MCP_ALLOWED_ROOTS;
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/path-security.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 sanitizePath**

```typescript
// src/core/path-security.ts

const DEFAULT_ALLOWED_ROOTS = ['res://', 'user://'];

const ILLEGAL_CHARS = /[<>:"|?*\x00-\x1f]/;
const TRAVERSAL_PATTERN = /\.\./;

/** Get combined allowed roots: defaults + env var + opts */
function getAllowedRoots(opts?: { allowedRoots?: string[] }): string[] {
  const roots = [...DEFAULT_ALLOWED_ROOTS];
  // 环境变量追加
  const envRoots = process.env.GODOT_MCP_ALLOWED_ROOTS;
  if (envRoots) {
    for (const r of envRoots.split(',').map(s => s.trim()).filter(Boolean)) {
      roots.push(r);
    }
  }
  // 调用级追加
  if (opts?.allowedRoots) {
    roots.push(...opts.allowedRoots);
  }
  return roots;
}

/**
 * Sanitize and validate a path string.
 * @throws Error if path contains traversal, illegal chars, or non-whitelisted prefix.
 */
export function sanitizePath(path: string, opts?: { allowedRoots?: string[] }): string {
  if (!path || typeof path !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  // 1. 标准化
  let normalized = path.replace(/\\/g, '/').replace(/\/\//g, '/');

  // 2. 遍历检测
  if (TRAVERSAL_PATTERN.test(normalized)) {
    throw new Error(`Path traversal detected: ${path}`);
  }

  // 3. 非法字符检测
  if (ILLEGAL_CHARS.test(normalized)) {
    throw new Error(`Illegal characters in path: ${path}`);
  }

  // 4. 前缀白名单
  const allowedRoots = getAllowedRoots(opts);
  const isAllowed = allowedRoots.some(root => {
    const normalizedRoot = root.replace(/\\/g, '/');
    return normalized.startsWith(normalizedRoot);
  });

  if (!isAllowed) {
    throw new Error(`Path prefix not in whitelist: ${path}. Allowed: ${allowedRoots.join(', ')}`);
  }

  return normalized;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/path-security.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/path-security.ts test/core/path-security.test.ts
git commit -m "feat(security): add sanitizePath with traversal/char/prefix validation"
```

---

## Task 10: Phase 2a — CommandValidator

**Files:**
- Create: `src/core/command-validator.ts`
- Create: `test/core/command-validator.test.ts`

- [ ] **Step 1: 写失败测试 — CommandValidator 校验**

```typescript
// test/core/command-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateGdscriptCommand } from '../../src/core/command-validator.js';

describe('validateGdscriptCommand', () => {
  it('allows safe code', () => {
    const result = validateGdscriptCommand('var x = 10');
    expect(result.safe).toBe(true);
  });

  it('blocks OS.crash', () => {
    const result = validateGdscriptCommand('OS.crash("msg")');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('OS.crash');
  });

  it('blocks Engine.quit', () => {
    const result = validateGdscriptCommand('Engine.quit()');
    expect(result.safe).toBe(false);
  });

  it('blocks OS.execute (shell injection)', () => {
    const result = validateGdscriptCommand('OS.execute("rm", ["-rf", "/"])');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('OS.execute');
  });

  it('blocks get_tree().quit()', () => {
    const result = validateGdscriptCommand('get_tree().quit()');
    expect(result.safe).toBe(false);
  });

  it('allows FileAccess.open for sandbox-scoped operations', () => {
    // FileAccess.open 已在 DANGEROUS_PATTERNS 中拦截
    // CommandValidator 提供优先级分类
    const result = validateGdscriptCommand('FileAccess.open("res://save.dat", FileAccess.READ)');
    expect(result.safe).toBe(false);
    expect(result.priority).toBeDefined();
  });

  it('assigns priority levels', () => {
    const crash = validateGdscriptCommand('OS.crash("msg")');
    expect(crash.priority).toBe(1); // 重操作

    const fileAccess = validateGdscriptCommand('FileAccess.open("test", FileAccess.READ)');
    expect(fileAccess.priority).toBeLessThanOrEqual(5); // 中等
  });

  it('returns safe=true for empty code', () => {
    const result = validateGdscriptCommand('');
    expect(result.safe).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/command-validator.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 CommandValidator**

```typescript
// src/core/command-validator.ts

interface ValidationResult {
  safe: boolean;
  reason?: string;
  priority?: number;
}

/** Dangerous API patterns with priority classification.
 *  Priority: 1=重操作(crash/quit), 5=中等(file/shell), 9=轻操作(warning)
 */
const DANGEROUS_APIS: Array<{ pattern: RegExp; label: string; priority: number }> = [
  // Priority 1: 重操作
  { pattern: /OS\.crash\b/,                           label: 'OS.crash (engine crash)',          priority: 1 },
  { pattern: /Engine\.quit\b/,                        label: 'Engine.quit (engine shutdown)',    priority: 1 },
  { pattern: /OS\.exit\b/,                            label: 'OS.exit (process exit)',           priority: 1 },
  { pattern: /get_tree\(\)\.quit\(\)/,                label: 'get_tree().quit (scene tree quit)',priority: 1 },

  // Priority 5: 中等操作
  { pattern: /OS\.execute\b/,                         label: 'OS.execute (shell command)',       priority: 5 },
  { pattern: /OS\.shell_open\b/,                      label: 'OS.shell_open (shell open)',       priority: 5 },
  { pattern: /FileAccess\.open\b/,                    label: 'FileAccess.open (file access)',    priority: 5 },
  { pattern: /DirAccess\.open\b/,                     label: 'DirAccess.open (dir access)',      priority: 5 },
  { pattern: /DirAccess\.remove\b/,                   label: 'DirAccess.remove (dir removal)',   priority: 5 },
];

/**
 * Validate GDScript code for dangerous API usage.
 * Provides structured validation with priority classification.
 * This is a best-effort defense — dynamic calls (call()/funcref()) may bypass detection.
 */
export function validateGdscriptCommand(code: string): ValidationResult {
  if (!code || code.trim().length === 0) {
    return { safe: true };
  }

  // Find highest-priority (lowest number) match
  let matched: { label: string; priority: number } | null = null;
  for (const api of DANGEROUS_APIS) {
    if (api.pattern.test(code)) {
      if (!matched || api.priority < matched.priority) {
        matched = { label: api.label, priority: api.priority };
      }
    }
  }

  if (matched) {
    return {
      safe: false,
      reason: `Blocked: ${matched.label}`,
      priority: matched.priority,
    };
  }

  return { safe: true };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/command-validator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/command-validator.ts test/core/command-validator.test.ts
git commit -m "feat(security): add CommandValidator with priority-classified API blocking"
```

---

## Task 11: Phase 1 验收 + 全量回归

**Files:** 无新文件

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 2: 验证 Phase 1 验收标准**

逐项检查：
- [ ] 所有工具定义包含 `annotations.tags: ['group:xxx']` — Task 5
- [ ] `manage_tools list_groups` 返回所有组及其启用状态 — Task 4
- [ ] `manage_tools activate/deactivate` 动态更新工具列表 — Task 4
- [ ] `notifications/tools/list_changed` 在组变更后发送 — Task 7
- [ ] 被停用组的工具调用返回明确错误 — Task 6
- [ ] `core` 组不可被停用 — Task 4
- [ ] 不调用 `manage_tools` 时行为与当前完全一致 — Task 6
- [ ] 全量现有测试通过 — 当前步骤

- [ ] **Step 3: 修复 ADVISORY：Feature Flag 命名一致性**

修改 `docs/superpowers/specs/2026-06-08-competitive-borrowing-design.md` L59:
`GODOT_MCP_Elicitation` → `GODOT_MCP_ELICITATION`

- [ ] **Step 4: Phase 1 完成提交**

```bash
git add -A
git commit -m "milestone: Phase 1 complete — Tag filtering + manage_tools + notifications"
```

---

## 后续 Phase 计划摘要

> 以下 Phase 的详细 Task 在 Phase 1 完成并验证后展开。此处仅列出文件和关键步骤。

### Phase 2b: 多实例发现与路由（4 个新文件）
- `src/core/instance-manager.ts` — 注册表读写、端口扫描、僵尸检测
- `src/core/instance-router.ts` — 请求路由、切换锁、InstanceRouter
- `src/tools/instance-tools.ts` — godot_list_instances + godot_select_instance
- `scripts/mcp_bridge.gd` — Bridge autoload 增加注册表心跳

### Phase 3a: 懒加载代理（1 个新文件）
- `src/tools/advanced-proxy.ts` — godot_advanced_tool 代理、TOOL_GROUPS 反查、模糊建议

### Phase 3b: 响应控制（1 个新文件）
- `src/core/middleware/response-limiter.ts` — 双阈值截断（2MB/4MB）+ 分页 page_size/cursor

### Phase 4: 健康监控 + 重连 + 离线模式（2 个新文件）
- `src/core/health-monitor.ts` — 30s 心跳、4 态状态机、100 采样窗口
- `src/core/reconnection-manager.ts` — 指数退避（800ms→30s）、耗尽通知

### Phase 5: Resources + Prompts + Elicitation + 中间件重构（7 个新文件）
- 6 个中间件文件从 ToolDispatcher 提取
- `src/prompts.ts` — 4 个 Prompt 模板
- `src/resources.ts` — 新增 6 个 Resource URI
- ToolDispatcher 重构为中间件数组模式

### Phase 2b~5 每个需要独立的 Task 文档

遵循相同的 TDD 模式：写测试 → 确认失败 → 实现 → 确认通过 → 全量回归 → Commit。
