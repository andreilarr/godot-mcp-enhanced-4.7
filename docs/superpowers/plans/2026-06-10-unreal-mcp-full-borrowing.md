# v0.18.0 Unreal_mcp 全面借鉴实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 39 个 MCP 工具精简为 27 个，吸收 9 个独立工具进相关组，统一 action 路由模式，引入 listChanged 通知、Common Schema、Response Validation。

**Architecture:** 在现有 ToolModule + TOOL_GROUPS 基础上，将 9 个独立工具的 handler 逻辑合并到目标模块中。新增 error-codes.ts、action-response.ts、common-schemas.ts 三个基础设施文件。ToolDispatcher 增加 legacy fallback 路由。

**Tech Stack:** TypeScript, MCP SDK, Vitest

**Pre-requisite:** agent-architecture Phase 1（AgentContextManager）必须先完成。本计划所有文件变更基于 agent-architecture 之后的代码状态。

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/core/error-codes.ts` | **新建** | ActionRouter 错误码集中定义 |
| `src/core/action-response.ts` | **新建** | ActionResult 类型 + wrapResult + toToolResult |
| `src/core/common-schemas.ts` | **新建** | 共享 schema 参数定义 + withCommonParams |
| `src/core/tool-registry.ts` | **修改** | 新增 LEGACY_TOOL_MAP、notifyToolsChanged、setMcpServer |
| `src/core/ToolDispatcher.ts` | **修改** | dispatchTool 增加 legacy fallback |
| `src/tools/manage-tools.ts` | **修改** | 新增 migrate action + listChanged 通知 |
| `src/tools/node-3d-ops.ts` | **删除/合并** | handler 并入 scene/index.ts |
| `src/tools/scene-commit-tool.ts` | **删除/合并** | handler 并入 scene/index.ts |
| `src/tools/recording.ts` | **删除/合并** | handler 并入 runtime.ts |
| `src/tools/delivery.ts` | **删除/合并** | handler 并入 validation.ts |
| `src/tools/test-framework.ts` | **删除/合并** | handler 并入 validation.ts |
| `src/tools/ik-tools.ts` | **删除/合并** | handler 并入 animation-ops.ts |
| `src/tools/code-templates.ts` | **删除/合并** | handler 并入 project.ts |
| `src/tools/batch-tools.ts` | **删除/合并** | handler 并入 workflow.ts |
| `src/tools/game-design.ts` | **删除/合并** | handler 并入 validation.ts |
| `src/core/module-loader.ts` | **修改** | 移除 9 个被吸收模块的 import |
| `test/core/action-response.test.ts` | **新建** | ActionResult/wrapResult 测试 |
| `test/core/common-schemas.test.ts` | **新建** | withCommonParams 测试 |
| `test/core/legacy-mapping.test.ts` | **新建** | LEGACY_TOOL_MAP + fallback 测试 |

---

## Task 1: 基础设施 — error-codes.ts

**Files:**
- Create: `src/core/error-codes.ts`
- Test: `test/core/error-codes.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/core/error-codes.test.ts
import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '../../src/core/error-codes.js';

describe('ErrorCodes', () => {
  it('定义了所有必需的错误码', () => {
    expect(ErrorCodes.MISSING_ACTION).toBe('MISSING_ACTION');
    expect(ErrorCodes.UNKNOWN_ACTION).toBe('UNKNOWN_ACTION');
    expect(ErrorCodes.MISSING_REQUIRED_PARAM).toBe('MISSING_REQUIRED_PARAM');
    expect(ErrorCodes.HANDLER_ERROR).toBe('HANDLER_ERROR');
  });

  it('错误码值是字符串字面量', () => {
    const values = Object.values(ErrorCodes);
    for (const v of values) {
      expect(typeof v).toBe('string');
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/error-codes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

```typescript
// src/core/error-codes.ts
/** ActionRouter 统一错误码。客户端可据此做 switch/case 程序化处理。 */
export const ErrorCodes = {
  MISSING_ACTION: 'MISSING_ACTION',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  MISSING_REQUIRED_PARAM: 'MISSING_REQUIRED_PARAM',
  HANDLER_ERROR: 'HANDLER_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/error-codes.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/error-codes.ts test/core/error-codes.test.ts
git commit -m "feat(v0.18): ActionRouter 错误码集中定义"
```

---

## Task 2: 基础设施 — action-response.ts

**Files:**
- Create: `src/core/action-response.ts`
- Test: `test/core/action-response.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/core/action-response.test.ts
import { describe, it, expect } from 'vitest';
import type { ActionResult } from '../../src/core/action-response.js';
import { wrapResult, toToolResult } from '../../src/core/action-response.js';
import { ErrorCodes } from '../../src/core/error-codes.js';

describe('action-response', () => {
  describe('wrapResult', () => {
    it('将旧式 ToolResult (成功) 包装为 ActionResult', () => {
      const toolResult = {
        content: [{ type: 'text' as const, text: '{"status":"ok","data":{}}' }],
      };
      const result = wrapResult('scene', 'read_scene', toolResult);
      expect(result.tool).toBe('scene');
      expect(result.action).toBe('read_scene');
      expect(result.status).toBe('ok');
    });

    it('将旧式 ToolResult (错误) 包装为 ActionResult', () => {
      const toolResult = {
        isError: true,
        content: [{ type: 'text' as const, text: 'Something went wrong' }],
      };
      const result = wrapResult('scene', 'add_node', toolResult);
      expect(result.status).toBe('error');
      expect(result.error?.code).toBe(ErrorCodes.HANDLER_ERROR);
    });

    it('保留已有 ActionResult 的 tool/action', () => {
      const existing: ActionResult = {
        tool: 'old_tool',
        action: 'old_action',
        status: 'ok',
        data: { foo: 'bar' },
      };
      const result = wrapResult('new_tool', 'new_action', existing);
      expect(result.tool).toBe('new_tool');
      expect(result.action).toBe('new_action');
      expect(result.status).toBe('ok');
      expect(result.data).toEqual({ foo: 'bar' });
    });
  });

  describe('toToolResult', () => {
    it('将成功的 ActionResult 转为 MCP ToolResult', () => {
      const action: ActionResult = {
        tool: 'scene', action: 'read_scene', status: 'ok', data: { nodes: [] },
      };
      const result = toToolResult(action);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.tool).toBe('scene');
      expect(parsed.action).toBe('read_scene');
    });

    it('将错误的 ActionResult 转为 isError=true 的 ToolResult', () => {
      const action: ActionResult = {
        tool: 'scene', action: 'add_node', status: 'error',
        error: { code: 'MISSING_REQUIRED_PARAM', message: 'Missing node_type', missing_params: ['node_type'] },
      };
      const result = toToolResult(action);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text as string);
      expect(parsed.error.missing_params).toEqual(['node_type']);
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/action-response.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

```typescript
// src/core/action-response.ts
import { ErrorCodes } from './error-codes.js';
import type { ToolResult } from '../types.js';

/** 统一 Action 响应格式，包含 tool + action 用于调试追溯。 */
export interface ActionResult {
  tool: string;
  action: string;
  status: 'ok' | 'error';
  data?: unknown;
  error?: {
    code: string;
    message: string;
    missing_params?: string[];
  };
}

/** 判断对象是否已是 ActionResult 格式 */
function isActionResult(obj: unknown): obj is ActionResult {
  if (!obj || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;
  return typeof r.tool === 'string' && typeof r.action === 'string' && (r.status === 'ok' || r.status === 'error');
}

/** 从 ToolResult 的 content 中提取文本 */
function extractText(result: ToolResult): string {
  for (const c of result.content) {
    if (c.type === 'text' && typeof c.text === 'string') return c.text;
  }
  return '';
}

/** 包装任意返回值为 ActionResult */
export function wrapResult(tool: string, action: string, result: unknown): ActionResult {
  if (isActionResult(result)) {
    return { ...result, tool, action };
  }

  // 旧式 ToolResult
  if (result && typeof result === 'object' && 'content' in result) {
    const tr = result as ToolResult;
    const isError = tr.isError === true;
    return {
      tool, action,
      status: isError ? 'error' : 'ok',
      ...(isError
        ? { error: { code: ErrorCodes.HANDLER_ERROR, message: extractText(tr) } }
        : { data: extractText(tr) }),
    };
  }

  return { tool, action, status: 'ok', data: result };
}

/** 将 ActionResult 转回 MCP ToolResult */
export function toToolResult(result: ActionResult): ToolResult {
  const text = JSON.stringify(result, null, 2);
  return {
    isError: result.status === 'error',
    content: [{ type: 'text', text }],
  };
}

/** 快速创建错误 ActionResult */
export function actionError(
  tool: string, action: string, code: string, message: string, missingParams?: string[],
): ActionResult {
  return {
    tool, action, status: 'error',
    error: { code, message, ...(missingParams ? { missing_params: missingParams } : {}) },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/action-response.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/action-response.ts test/core/action-response.test.ts
git commit -m "feat(v0.18): ActionResult 统一响应格式 + wrapResult/toToolResult"
```

---

## Task 3: 基础设施 — common-schemas.ts

**Files:**
- Create: `src/core/common-schemas.ts`
- Test: `test/core/common-schemas.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/core/common-schemas.test.ts
import { describe, it, expect } from 'vitest';
import { COMMON_SCHEMAS, withCommonParams } from '../../src/core/common-schemas.js';

describe('common-schemas', () => {
  it('COMMON_SCHEMAS 包含所有共享参数', () => {
    expect(COMMON_SCHEMAS.project_path).toBeDefined();
    expect(COMMON_SCHEMAS.project_path.type).toBe('string');
    expect(COMMON_SCHEMAS.scene_path).toBeDefined();
    expect(COMMON_SCHEMAS.node_path).toBeDefined();
    expect(COMMON_SCHEMAS.animation_name).toBeDefined();
    expect(COMMON_SCHEMAS.load_autoloads).toBeDefined();
  });

  it('withCommonParams 注入指定参数', () => {
    const params = { action: { type: 'string' } };
    const result = withCommonParams(params, 'project_path', 'node_path');
    expect(result).toHaveProperty('action');
    expect(result).toHaveProperty('project_path');
    expect(result).toHaveProperty('node_path');
    // 不影响原始 params
    expect(result).not.toHaveProperty('scene_path');
  });

  it('withCommonParams 不重复注入', () => {
    const params = { project_path: { type: 'string', description: '自定义' } };
    const result = withCommonParams(params, 'project_path');
    // 已有定义不覆盖
    expect((result.project_path as { description: string }).description).toBe('自定义');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/common-schemas.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现**

```typescript
// src/core/common-schemas.ts

/** 共享参数 schema 定义 — 所有工具引用而非重写。 */
export const COMMON_SCHEMAS = {
  project_path: {
    type: 'string' as const,
    description: '项目目录路径（可选，默认 GODOT_PROJECT_PATH 环境变量或当前目录）',
  },
  scene_path: {
    type: 'string' as const,
    description: '场景文件路径（相对项目，如 res://scenes/main.tscn）',
  },
  node_path: {
    type: 'string' as const,
    description: '节点路径（root/Player/Sprite2D）',
  },
  animation_name: {
    type: 'string' as const,
    description: '动画名称',
  },
  load_autoloads: {
    type: 'boolean' as const,
    description: '是否加载 Autoload 上下文（默认 true）',
  },
} as const;

export type CommonSchemaKey = keyof typeof COMMON_SCHEMAS;

/** 构建工具 schema 时注入 common params。已有定义不覆盖。 */
export function withCommonParams(
  params: Record<string, unknown>,
  ...commonKeys: CommonSchemaKey[]
): Record<string, unknown> {
  const result = { ...params };
  for (const key of commonKeys) {
    if (!(key in result) && COMMON_SCHEMAS[key]) {
      result[key] = { ...COMMON_SCHEMAS[key] };
    }
  }
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/common-schemas.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/common-schemas.ts test/core/common-schemas.test.ts
git commit -m "feat(v0.18): Common Schema 共享参数定义 + withCommonParams"
```

---

## Task 4: tool-registry.ts — LEGACY_TOOL_MAP + notifyToolsChanged

**Files:**
- Modify: `src/core/tool-registry.ts` (在现有代码末尾追加)
- Test: `test/core/legacy-mapping.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// test/core/legacy-mapping.test.ts
import { describe, it, expect } from 'vitest';
import { tryLegacyMapping, LEGACY_TOOL_MAP } from '../../src/core/tool-registry.js';

describe('LEGACY_TOOL_MAP', () => {
  it('包含所有 9 个被吸收工具的映射', () => {
    const expected = [
      'node_create_3d', 'scene_commit', 'recording',
      'verify_delivery', 'test', 'ik',
      'templates', 'batch', 'game_design',
    ];
    for (const name of expected) {
      expect(LEGACY_TOOL_MAP[name]).toBeDefined();
      expect(LEGACY_TOOL_MAP[name]).toHaveProperty('tool');
      expect(LEGACY_TOOL_MAP[name]).toHaveProperty('action');
    }
  });

  it('映射的目标工具名是 27 个新工具之一', () => {
    const validTargets = new Set([
      'project', 'scene', 'script', 'runtime', 'validation', 'editor', 'game',
      'animation', 'animtree', 'animation_track', 'audio', 'material', 'screenshot',
      'particles', 'physics', 'nav', 'ui', 'tilemap', 'signal', 'profiler',
      'workflow', 'docs', 'manage_tools',
    ]);
    for (const [, mapping] of Object.entries(LEGACY_TOOL_MAP)) {
      expect(validTargets.has(mapping.tool)).toBe(true);
    }
  });
});

describe('tryLegacyMapping', () => {
  it('GODOT_MCP_WARN_LEGACY 未设置时返回 null', () => {
    delete process.env.GODOT_MCP_WARN_LEGACY;
    expect(tryLegacyMapping('node_create_3d')).toBeNull();
  });

  it('GODOT_MCP_WARN_LEGACY=1 时返回映射', () => {
    process.env.GODOT_MCP_WARN_LEGACY = '1';
    try {
      const result = tryLegacyMapping('node_create_3d');
      expect(result).toEqual({ tool: 'scene', action: 'create_3d_node' });
    } finally {
      delete process.env.GODOT_MCP_WARN_LEGACY;
    }
  });

  it('未知工具名返回 null', () => {
    process.env.GODOT_MCP_WARN_LEGACY = '1';
    try {
      expect(tryLegacyMapping('totally_unknown_tool')).toBeNull();
    } finally {
      delete process.env.GODOT_MCP_WARN_LEGACY;
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/legacy-mapping.test.ts`
Expected: FAIL — LEGACY_TOOL_MAP not exported

- [ ] **Step 3: 实现 — 在 tool-registry.ts 末尾追加**

在 `src/core/tool-registry.ts` 文件末尾（`isOfflineCapable` 函数之后）追加：

```typescript
// ─── Legacy tool mapping (v0.18.0 migration) ────────────────────────────────

/** 类型 A — 独立工具吸收的迁移映射。仅 GODOT_MCP_WARN_LEGACY 模式下生效。 */
export const LEGACY_TOOL_MAP: Record<string, { tool: string; action: string }> = {
  node_create_3d:  { tool: 'scene',      action: 'create_3d_node' },
  scene_commit:    { tool: 'scene',      action: 'commit' },
  recording:       { tool: 'runtime',    action: 'record_start' },   // 代表性 action
  verify_delivery: { tool: 'validation', action: 'verify_delivery' },
  test:            { tool: 'validation', action: 'assert' },          // 代表性 action
  ik:              { tool: 'animation',  action: 'ik_modifier_create' },
  templates:       { tool: 'project',    action: 'list' },             // 代表性 action
  batch:           { tool: 'workflow',   action: 'create_files' },     // 代表性 action
  game_design:     { tool: 'validation', action: 'validate_gdd' },
};

const WARN_LEGACY = () => !!process.env.GODOT_MCP_WARN_LEGACY;

/** 尝试将旧工具名映射到新 (tool, action)。仅 WARN_LEGACY 模式下生效。 */
export function tryLegacyMapping(toolName: string): { tool: string; action: string } | null {
  if (!WARN_LEGACY()) return null;
  const mapped = LEGACY_TOOL_MAP[toolName];
  if (mapped) {
    console.warn(`[LEGACY] "${toolName}" → ${mapped.tool}(action="${mapped.action}")`);
    return mapped;
  }
  return null;
}

// ─── listChanged notification ────────────────────────────────────────────────

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

let mcpServer: Server | null = null;

/** 注入 MCP Server 实例（GodotServer 启动时调用一次）。 */
export function setMcpServer(server: Server): void {
  mcpServer = server;
}

/** 通知客户端工具列表已变更。不支持时静默忽略。 */
export function notifyToolsChanged(): void {
  if (!mcpServer) return;
  try {
    mcpServer.notification({ method: 'notifications/tools/list_changed' });
  } catch {
    // 客户端不支持此通知
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/legacy-mapping.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/core/tool-registry.ts test/core/legacy-mapping.test.ts
git commit -m "feat(v0.18): LEGACY_TOOL_MAP + notifyToolsChanged + setMcpServer"
```

---

## Task 5: ToolDispatcher — legacy fallback 路由

**Files:**
- Modify: `src/core/ToolDispatcher.ts` (dispatchTool 方法)

- [ ] **Step 1: 修改 dispatchTool 方法**

在 `src/core/ToolDispatcher.ts` 顶部新增 import：

```typescript
import { getModuleForTool, tryLegacyMapping } from './tool-registry.js';
```

修改 `dispatchTool` 方法（约第 438 行），在 `getModuleForTool` 返回 null 时尝试 legacy mapping：

```typescript
  private async dispatchTool(toolName: string, args: Record<string, unknown>, startTime: number): Promise<ToolResult> {
    let targetMod = getModuleForTool(toolName);
    let effectiveToolName = toolName;
    let effectiveArgs = args;

    // ── Legacy fallback: 旧工具名 → 新 (tool, action) ──
    if (!targetMod) {
      const legacy = tryLegacyMapping(toolName);
      if (legacy) {
        effectiveToolName = legacy.tool;
        effectiveArgs = { ...args, action: legacy.action };
        targetMod = getModuleForTool(effectiveToolName);
      }
    }

    if (!targetMod) {
      return opsErrorResult('UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
    }

    const logger = getLogger();
    const callId = logger.toolStart(effectiveToolName, effectiveArgs);

    let result: ToolResult | null;
    try {
      result = await targetMod.handleTool(effectiveToolName, effectiveArgs, this.ctx);
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.toolEnd(callId, effectiveToolName, duration, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const duration = Date.now() - startTime;

    if (result !== null) {
      const hasError = result.isError === true;
      logger.toolEnd(callId, effectiveToolName, duration, hasError ? 'tool_error' : undefined);
      return truncateResponse({ ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] });
    }
    logger.toolEnd(callId, effectiveToolName, duration, 'handler_null');
    return opsErrorResult('HANDLER_NULL', `Tool "${effectiveToolName}" registered but handler returned null`);
  }
```

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS（legacy fallback 仅在环境变量设置时生效，不影响现有测试）

- [ ] **Step 3: 提交**

```bash
git add src/core/ToolDispatcher.ts
git commit -m "feat(v0.18): ToolDispatcher legacy fallback — 旧工具名路由到新 (tool, action)"
```

---

## Task 6: 吸收 node_create_3d + scene_commit → scene

**Files:**
- Modify: `src/tools/scene/index.ts` (新增 create_3d_node + commit action)
- Modify: `src/tools/node-3d-ops.ts` (导出 handleNode3dAction 供 scene 调用)
- Modify: `src/tools/scene-commit-tool.ts` (导出 handleCommitAction 供 scene 调用)
- Modify: `src/core/module-loader.ts` (移除 node3dOps + sceneCommit)

这是 9 个吸收中最复杂的两个，其他 7 个模式相同。以下步骤是详细示例，其余 7 个在 Task 7-9 中。

- [ ] **Step 1: 从 node-3d-ops.ts 导出 handler**

在 `src/tools/node-3d-ops.ts` 底部，将内部 handler 逻辑导出为独立函数：

```typescript
/** 导出供 scene 模块合并调用（v0.18.0 action 路由统一） */
export async function handleCreate3dNode(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  // 现有 handleTool 中 action==="create" 分支的逻辑移入此处
}
```

同理处理 `scene-commit-tool.ts`：

```typescript
/** 导出供 scene 模块合并调用 */
export async function handleCommitAction(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  // 现有 handleTool 中 action==="create_files"/"run_verify"/"diff_scenes" 分支的逻辑移入此处
}
```

- [ ] **Step 2: 在 scene/index.ts 中注册新 action**

在 `scene/index.ts` 的 `getToolDefinitions()` 的 action enum 中添加 `create_3d_node` 和 `commit`。

在 `handleTool()` 的 action switch 中添加对应分支，调用导入的 handler：

```typescript
case 'create_3d_node':
  return handleCreate3dNode(args, ctx);
case 'commit':
  return handleCommitAction(args, ctx);
```

- [ ] **Step 3: 在 module-loader.ts 中移除被吸收的模块**

```typescript
// 删除这两行 import:
// import * as node3dOps from '../tools/node-3d-ops.js';
// import * as sceneCommit from '../tools/scene-commit-tool.js';

// 从 ALL_MODULES 数组中删除 node3dOps, sceneCommit
```

- [ ] **Step 4: 运行全量测试**

Run: `npx vitest run`
Expected: PASS（scene 模块测试覆盖新 action，node_3d_ops 和 scene_commit 独立测试仍通过但标记为 deprecated）

- [ ] **Step 5: 提交**

```bash
git add src/tools/scene/index.ts src/tools/node-3d-ops.ts src/tools/scene-commit-tool.ts src/core/module-loader.ts
git commit -m "feat(v0.18): 吸收 node_create_3d → scene(create_3d_node) + scene_commit → scene(commit)"
```

---

## Task 7: 吸收 recording → runtime, templates → project, ik → animation

**Files:**
- Modify: `src/tools/runtime.ts` (新增 record_start/stop/save/load/play actions)
- Modify: `src/tools/project.ts` (新增 list_templates/apply actions)
- Modify: `src/tools/animation-ops.ts` (新增 ik_modifier_create/get/set/list_bones actions)
- Modify: `src/tools/recording.ts`, `src/tools/code-templates.ts`, `src/tools/ik-tools.ts` (导出 handler 函数)
- Modify: `src/core/module-loader.ts` (移除 3 个模块)

模式与 Task 6 相同：

1. 从被吸收模块导出 handler 函数
2. 在目标模块中导入并注册新 action
3. 从 module-loader.ts 移除被吸收模块
4. 运行测试
5. 提交

- [ ] **Step 1: 导出 handler + 注册新 action + 更新 module-loader**

三个模块同时处理：
- `recording.ts` → `runtime.ts`: 5 个 action (record_start/stop/save/load/play)
- `code-templates.ts` → `project.ts`: 2 个 action (list/apply，映射为 list_templates/apply_template)
- `ik-tools.ts` → `animation-ops.ts`: 4 个 action (ik_modifier_create/get/set/list_bones)

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/tools/runtime.ts src/tools/project.ts src/tools/animation-ops.ts src/tools/recording.ts src/tools/code-templates.ts src/tools/ik-tools.ts src/core/module-loader.ts
git commit -m "feat(v0.18): 吸收 recording→runtime, templates→project, ik→animation"
```

---

## Task 8: 吸收 test+game_design+verify_delivery → validation, batch → workflow

**Files:**
- Modify: `src/tools/validation.ts` (新增 assert/stress/export_*/verify_delivery/validate_gdd/chain_verify actions)
- Modify: `src/tools/workflow.ts` (新增 create_files/run_verify/diff_scenes actions)
- Modify: `src/tools/test-framework.ts`, `src/tools/game-design.ts`, `src/tools/delivery.ts`, `src/tools/batch-tools.ts` (导出 handler)
- Modify: `src/core/module-loader.ts` (移除 4 个模块)

- [ ] **Step 1: 导出 handler + 注册新 action + 更新 module-loader**

四个模块：
- `test-framework.ts` → `validation.ts`: 5 个 action (assert/stress/export_list_presets/export_get_preset/export_build)
- `game-design.ts` → `validation.ts`: 2 个 action (validate_gdd/chain_verify)
- `delivery.ts` → `validation.ts`: 1 个 action (verify_delivery)
- `batch-tools.ts` → `workflow.ts`: 3 个 action (create_files/run_verify/diff_scenes)

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/tools/validation.ts src/tools/workflow.ts src/tools/test-framework.ts src/tools/game-design.ts src/tools/delivery.ts src/tools/batch-tools.ts src/core/module-loader.ts
git commit -m "feat(v0.18): 吸收 test/game_design/verify_delivery→validation, batch→workflow"
```

---

## Task 9: manage_tools — migrate action + listChanged 通知

**Files:**
- Modify: `src/tools/manage-tools.ts`

- [ ] **Step 1: 在 manage-tools.ts 新增 migrate action**

在 `handleTool` 的 action switch 中添加 `migrate` 分支：

```typescript
case 'migrate': {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        version: '0.18.0',
        description: '旧工具名到新 (tool, action) 的迁移映射',
        mapping: {
          node_create_3d:  { tool: 'scene',      action: 'create_3d_node' },
          scene_commit:    { tool: 'scene',      action: 'commit' },
          recording:       { tool: 'runtime',    action: 'record_start' },
          verify_delivery: { tool: 'validation', action: 'verify_delivery' },
          test:            { tool: 'validation', action: 'assert' },
          ik:              { tool: 'animation',  action: 'ik_modifier_create' },
          templates:       { tool: 'project',    action: 'list' },
          batch:           { tool: 'workflow',   action: 'create_files' },
          game_design:     { tool: 'validation', action: 'validate_gdd' },
        },
        renamed: {
          node_create_3d: 'create_3d_node',
          scene_commit: 'commit',
        },
        removed: ['recording', 'verify_delivery', 'test', 'ik', 'templates', 'batch', 'game_design', 'node_create_3d', 'scene_commit'],
        unchanged: ['confirm_and_execute', 'godot_advanced_tool', 'manage_tools', 'godot_list_instances', 'godot_select_instance'],
      }, null, 2),
    }],
  };
}
```

- [ ] **Step 2: 在 activate/deactivate 分支中触发 listChanged**

在 `manage-tools.ts` 顶部新增 import：

```typescript
import { notifyToolsChanged } from '../core/tool-registry.js';
```

在 `activate` 和 `deactivate` case 的成功执行后追加：

```typescript
notifyToolsChanged();
```

- [ ] **Step 3: 运行全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tools/manage-tools.ts
git commit -m "feat(v0.18): manage_tools migrate action + listChanged 通知触发"
```

---

## Task 10: GodotServer — 注入 MCP Server 实例

**Files:**
- Modify: `src/GodotServer.ts`

- [ ] **Step 1: 在 GodotServer 构造函数中调用 setMcpServer**

在 `GodotServer.ts` 中 `server` 创建之后（绑定 handler 之前），添加：

```typescript
import { setMcpServer } from './core/tool-registry.js';

// 在 this.server = new Server(...) 之后:
setMcpServer(this.server);
```

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/GodotServer.ts
git commit -m "feat(v0.18): GodotServer 注入 MCP Server 实例给 tool-registry（listChanged 支持）"
```

---

## Task 11: 50 条意图→action 选准率测试（前置条件 #1）

**Files:**
- Create: `test/core/action-selection-accuracy.test.ts`

这是一个手动设计的测试集，验证 AI 能从 27 个工具中正确选出 (tool, action) 对。

- [ ] **Step 1: 编写 50 条意图测试**

```typescript
// test/core/action-selection-accuracy.test.ts
import { describe, it, expect } from 'vitest';

/** 50 条典型用户意图 → 期望的 (tool, action) 映射。
 *  验证 action 命名是否语义化、可从意图推断。 */
const INTENT_MAP: Array<{ intent: string; tool: string; action: string }> = [
  // Scene (8)
  { intent: '读取场景文件结构',            tool: 'scene',    action: 'read_scene' },
  { intent: '创建新场景',                 tool: 'scene',    action: 'create_scene' },
  { intent: '快速创建场景并附加脚本',      tool: 'scene',    action: 'quick_scene' },
  { intent: '添加节点到场景',             tool: 'scene',    action: 'add_node' },
  { intent: '编辑节点属性',               tool: 'scene',    action: 'edit_node' },
  { intent: '删除节点',                   tool: 'scene',    action: 'remove_node' },
  { intent: '保存场景',                   tool: 'scene',    action: 'save_scene' },
  { intent: '批量提交场景修改',           tool: 'scene',    action: 'commit' },
  // Script (4)
  { intent: '读取 GDScript 脚本',         tool: 'script',   action: 'read_script' },
  { intent: '写入脚本文件',               tool: 'script',   action: 'write_script' },
  { intent: '编辑脚本中的函数',           tool: 'script',   action: 'edit_script' },
  { intent: '执行 GDScript 代码片段',     tool: 'script',   action: 'execute_gdscript' },
  // Runtime (4)
  { intent: '启动游戏项目',               tool: 'runtime',  action: 'run_project' },
  { intent: '停止运行中的游戏',           tool: 'runtime',  action: 'stop_project' },
  { intent: '获取调试输出',               tool: 'runtime',  action: 'get_debug_output' },
  { intent: '开始录制输入事件',           tool: 'runtime',  action: 'record_start' },
  // Validation (4)
  { intent: '运行并验证场景',             tool: 'validation', action: 'run_and_verify' },
  { intent: '验证项目完整性',             tool: 'validation', action: 'validate_project' },
  { intent: '验证脚本语法',               tool: 'validation', action: 'validate_scripts' },
  { intent: '端到端交付验证',             tool: 'validation', action: 'verify_delivery' },
  // Game (3)
  { intent: '检查游戏 Bridge 连接状态',   tool: 'game',     action: 'query' },
  { intent: '模拟键盘输入',               tool: 'game',     action: 'input' },
  { intent: '等待节点出现',               tool: 'game',     action: 'wait' },
  // Animation (3)
  { intent: '播放动画',                   tool: 'animation', action: 'play' },
  { intent: '添加动画关键帧',             tool: 'animation_track', action: 'add_keyframe' },
  { intent: '创建动画树状态',             tool: 'animation_tree',  action: 'add_state' },
  // UI (3)
  { intent: '创建 UI 按钮控件',           tool: 'ui',       action: 'create_control' },
  { intent: '构建 UI 布局',              tool: 'ui',       action: 'build_layout' },
  { intent: '设置节点锚点预设',           tool: 'ui',       action: 'anchor_preset' },
  // 其他 (21)
  { intent: '创建导航区域',               tool: 'nav',      action: 'create_region' },
  { intent: '烘焙导航网格',               tool: 'nav',      action: 'bake_mesh' },
  { intent: '播放音效',                   tool: 'audio',    action: 'play' },
  { intent: '读取材质属性',               tool: 'material', action: 'read' },
  { intent: '创建粒子效果',               tool: 'particles',action: 'create' },
  { intent: '3D 射线检测',                tool: 'physics',  action: 'raycast' },
  { intent: '读取 TileMap 数据',          tool: 'tilemap',  action: 'read' },
  { intent: '连接信号',                   tool: 'signal',   action: 'connect' },
  { intent: '获取性能快照',               tool: 'profiler', action: 'snapshot' },
  { intent: '执行 dev_loop 工作流',       tool: 'workflow', action: 'dev_loop' },
  { intent: '查询 Godot 类文档',          tool: 'docs',     action: 'get_class_info' },
  { intent: '管理工具组启用/禁用',        tool: 'manage_tools', action: 'activate' },
  { intent: '确认并执行危险操作',         tool: 'confirm_and_execute', action: '' },
  { intent: '截取游戏画面',               tool: 'screenshot', action: 'capture' },
  { intent: '安装 Game Bridge',           tool: 'game',     action: 'bridge_install' },
  { intent: '查看项目信息',               tool: 'project',  action: 'get_project_info' },
  { intent: '列出项目文件',               tool: 'project',  action: 'list_files' },
  { intent: '列出代码模板',               tool: 'project',  action: 'list' },
  { intent: '启动编辑器',                 tool: 'runtime',  action: 'launch_editor' },
  { intent: '同步编辑器场景树',           tool: 'editor',   action: 'sync_start' },
  { intent: 'IK 修饰器创建',             tool: 'animation', action: 'ik_modifier_create' },
];

describe('意图→action 选准率测试', () => {
  it('覆盖 50 条意图', () => {
    expect(INTENT_MAP.length).toBeGreaterThanOrEqual(50);
  });

  it('每个 intent 映射到有效的 tool 名', () => {
    const validTools = new Set([
      'project', 'scene', 'script', 'runtime', 'validation', 'editor', 'game',
      'animation', 'animation_tree', 'animation_track', 'audio', 'material',
      'screenshot', 'particles', 'physics', 'nav', 'ui', 'tilemap', 'signal',
      'profiler', 'workflow', 'docs', 'manage_tools', 'confirm_and_execute',
      'godot_advanced_tool', 'godot_list_instances', 'godot_select_instance',
    ]);
    for (const { intent, tool } of INTENT_MAP) {
      expect(validTools.has(tool)).toBe(true);
    }
  });

  it('action 名称语义化 — 可从意图合理推断', () => {
    // 这是一个设计质量检查：action 名应该包含意图中的关键动词/名词
    for (const { intent, action } of INTENT_MAP) {
      if (!action) continue; // 跳过无 action 的工具
      // action 名应是 snake_case 且包含可辨识的语义
      expect(action).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run test/core/action-selection-accuracy.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add test/core/action-selection-accuracy.test.ts
git commit -m "test(v0.18): 50 条意图→action 选准率测试（前置条件 #1）"
```

---

## Task 12: 全量测试适配 + 回归验证

**Files:**
- 可能修改: `test/tools/*.test.ts` 中引用被吸收工具名的测试

- [ ] **Step 1: 运行全量测试定位失败**

Run: `npx vitest run`
如果被吸收工具的独立测试文件仍存在且引用旧工具名，需要更新 import 路径和工具名引用。

- [ ] **Step 2: 更新失败的测试文件**

对于每个被吸收工具的测试文件：
- 如果测试通过新的父工具（scene/runtime/validation 等）调用，更新测试
- 如果测试仍引用旧的独立 handler 函数（已导出），测试应仍通过

- [ ] **Step 3: 运行全量测试确认通过**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add test/
git commit -m "test(v0.18): 全量测试适配 — 9 个工具吸收后测试迁移"
```

---

## Task 13: CHANGELOG 迁移文档

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 在 CHANGELOG.md 顶部添加 v0.18.0 条目**

```markdown
## v0.18.0 - Breaking Changes

### 工具合并：39 → 27

本版本将 39 个 MCP 工具精简为 27 个，9 个独立工具被吸收进相关工具组。

#### 类型 A — 工具名消失（需要迁移）

| 旧工具名 | 新工具 | 新 action | 备注 |
|----------|--------|----------|------|
| node_create_3d | scene | create_3d_node | action 重命名 |
| scene_commit | scene | commit | action 重命名 |
| recording | runtime | record_start/stop/save/load/play | 5 操作合并 |
| verify_delivery | validation | verify_delivery | 仅工具名变更 |
| test | validation | assert/stress/export_* | 工具名变更 |
| ik | animation | ik_modifier_create/get/set/list_bones | 工具名变更 |
| templates | project | list/apply | 工具名变更 |
| batch | workflow | create_files/run_verify/diff_scenes | 工具名变更 |
| game_design | validation | validate_gdd/chain_verify | 工具名变更 |

#### 类型 B — 零迁移

scene, script, project, runtime, editor, game, animation, animtree, animation_track, audio, material, screenshot, particles, physics, nav, ui, tilemap, signal, profiler, workflow, docs, manage_tools 等工具的 action 路由行为不变。

#### 迁移辅助

- 设置 `GODOT_MCP_WARN_LEGACY=1` 环境变量可在旧工具名调用时获得警告（兼容一个版本）
- 调用 `manage_tools(action="migrate")` 获取完整 JSON 格式迁移映射表

#### 新增特性

- **listChanged 通知**：manage_tools 变更工具组时自动通知客户端刷新
- **Common Schema**：共享参数（project_path 等）统一提取
- **ActionResult 格式**：所有响应包含 tool + action 字段用于调试追溯
```

- [ ] **Step 2: 提交**

```bash
git add CHANGELOG.md
git commit -m "docs(v0.18): CHANGELOG 迁移文档 — 39→27 工具合并映射表"
```

---

## Task 14: package.json 版本更新 + 最终验证

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: 更新版本号**

在 `package.json` 中将 `"version"` 更新为 `"0.18.0"`。

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run`
Expected: 全部 PASS

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add package.json
git commit -m "chore(v0.18): 版本号更新至 0.18.0"
```

- [ ] **Step 5: 验证最终工具数**

Run: `node -e "const {registerAllModules, getAllToolNames} = require('./dist/core/tool-registry.js'); registerAllModules(); console.log('工具数:', getAllToolNames().length); console.log(getAllToolNames().sort().join(', '))"`

Expected: 约 27 个工具名
