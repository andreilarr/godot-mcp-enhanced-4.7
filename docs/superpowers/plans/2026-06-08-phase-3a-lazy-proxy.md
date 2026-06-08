# Phase 3a: 懒加载代理 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 godot_advanced_tool 代理，让 `slim` Profile 下高级工具通过代理访问，减少客户端工具列表噪音。

**Architecture:** 单一代理工具 `godot_advanced_tool`，归属 `core` 组（始终可见），通过 TOOL_GROUPS 反向映射路由到目标工具模块。动态 description 列出当前可代理的工具。无效 tool_name 返回模糊匹配建议。

**Tech Stack:** TypeScript, Vitest, MCP SDK

**设计文档:** `docs/superpowers/specs/2026-06-08-competitive-borrowing-design.md` §3a

**前置:** Phase 1（Tag 过滤 + ALWAYS_ALLOWED 已含 godot_advanced_tool）

---

## 文件结构

### 新建（1 个）

| 文件 | 职责 |
|------|------|
| `src/tools/advanced-proxy.ts` | godot_advanced_tool 代理：动态 description、模糊建议、调用委托 |

### 改动（3 个）

| 文件 | 改动 |
|------|------|
| `src/core/tool-registry.ts` | PROFILES 新增 `slim`；新增 `getDeactivatedToolNames()` 辅助函数 |
| `src/core/module-loader.ts` | 导入并注册 advancedProxy 模块 |
| `src/core/ToolDispatcher.ts` | `slim` 模式：保留核心工具 + 代理，隐藏高级工具 |

### 测试（1 个）

| 文件 | 测试内容 |
|------|---------|
| `test/tools/advanced-proxy.test.ts` | 动态 description、模糊建议、代理调用 |

---

## Task 0: advanced-proxy.ts 代理工具

**Files:**
- Create: `src/tools/advanced-proxy.ts`
- Test: `test/tools/advanced-proxy.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// test/tools/advanced-proxy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getToolDefinitions,
  handleTool,
  setToolCallDelegate,
} from '../../src/tools/advanced-proxy.js';
import {
  TOOL_GROUPS,
  setActiveGroups,
  getActiveGroups,
} from '../../src/core/tool-registry.js';
import type { ToolContext, ToolResult } from '../../src/types.js';

const mockCtx = {} as ToolContext;

describe('advanced-proxy', () => {
  describe('getToolDefinitions', () => {
    it('returns single godot_advanced_tool definition', () => {
      const defs = getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('godot_advanced_tool');
    });

    it('has tool_name and arguments in inputSchema', () => {
      const defs = getToolDefinitions();
      const schema = defs[0].inputSchema as any;
      expect(schema.properties.tool_name).toBeDefined();
      expect(schema.properties.arguments).toBeDefined();
      expect(schema.required).toContain('tool_name');
    });

    it('belongs to core group', () => {
      const defs = getToolDefinitions();
      expect(defs[0].annotations?.tags).toContain('group:core');
    });

    it('description mentions proxy functionality', () => {
      const defs = getToolDefinitions();
      expect(defs[0].description).toContain('proxy');
    });
  });

  describe('handleTool', () => {
    it('returns null for unknown tool name', async () => {
      const result = await handleTool('unknown', {}, mockCtx);
      expect(result).toBeNull();
    });

    it('delegates call to toolCallDelegate', async () => {
      const mockDelegate = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      setToolCallDelegate(mockDelegate);

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animation',
        arguments: { action: 'list_players' },
      }, mockCtx);

      expect(mockDelegate).toHaveBeenCalledWith('animation', { action: 'list_players' });
      const text = (result?.content?.[0] as any)?.text;
      expect(text).toContain('ok');
    });

    it('returns fuzzy suggestions for invalid tool_name', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'animaton_play',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      expect(text).toContain('Unknown tool');
      expect(text).toContain('suggestions');
    });

    it('returns error when tool_name is missing', async () => {
      setToolCallDelegate(vi.fn());

      const result = await handleTool('godot_advanced_tool', {
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('MISSING_TOOL_NAME');
    });

    it('returns error when tool_name is already directly available', async () => {
      setToolCallDelegate(vi.fn());

      // core tools like 'project' are in the active core group — should be directly called
      const result = await handleTool('godot_advanced_tool', {
        tool_name: 'manage_tools',
        arguments: {},
      }, mockCtx);

      const text = (result?.content?.[0] as any)?.text;
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(false);
      expect(parsed.error_code).toBe('TOOL_ALREADY_AVAILABLE');
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/advanced-proxy.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 advanced-proxy.ts**

```typescript
// src/tools/advanced-proxy.ts
/**
 * Advanced proxy — godot_advanced_tool (Phase 3a)
 *
 * Proxy tool that allows calling deactivated/advanced tools in slim mode.
 * Belongs to the 'core' group (always visible, cannot be deactivated).
 * Provides fuzzy matching suggestions for invalid tool names.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsSuccess, opsError } from './shared.js';
import {
  getAllToolDefinitions,
  isToolAllowed,
  getAllToolNames,
} from '../core/tool-registry.js';

// ─── Delegate (set by ToolDispatcher to enable re-dispatch) ─────────────────

type ToolCallDelegate = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
let _delegate: ToolCallDelegate | null = null;

export function setToolCallDelegate(fn: ToolCallDelegate | null): void {
  _delegate = fn;
}

// ─── Fuzzy matching ─────────────────────────────────────────────────────────

/** Levenshtein distance for fuzzy matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/** Get up to N closest tool names by edit distance. */
function suggestTools(input: string, candidates: string[], maxResults = 3): string[] {
  const scored = candidates.map(name => ({ name, dist: levenshtein(input.toLowerCase(), name.toLowerCase()) }));
  scored.sort((a, b) => a.dist - b.dist);
  return scored.slice(0, maxResults).filter(s => s.dist <= Math.max(3, Math.floor(input.length / 2))).map(s => s.name);
}

// ─── Tool definitions ───────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  // Build dynamic description listing currently deactivated tools
  const allNames = getAllToolNames();
  const deactivated = allNames.filter(name => !isToolAllowed(name) && name !== 'godot_advanced_tool');

  let desc = 'Proxy tool for calling advanced/deactivated Godot tools. ' +
    'Call with { tool_name: "<name>", arguments: {...} }.';

  if (deactivated.length > 0) {
    desc += `\n\nCurrently proxyable tools: ${deactivated.join(', ')}`;
  } else {
    desc += '\n\nAll tools are currently directly available — no proxy needed.';
  }

  return [
    {
      name: 'godot_advanced_tool',
      description: desc,
      inputSchema: {
        type: 'object' as const,
        properties: {
          tool_name: {
            type: 'string',
            description: '要调用的目标工具名',
          },
          arguments: {
            type: 'object',
            description: '传给目标工具的参数',
          },
        },
        required: ['tool_name'],
      },
      annotations: { tags: ['group:core'] },
    },
  ];
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleTool(
  toolName: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  if (toolName !== 'godot_advanced_tool') return null;

  const targetTool = args.tool_name as string | undefined;
  if (!targetTool || typeof targetTool !== 'string') {
    return textResult(JSON.stringify(opsError('MISSING_TOOL_NAME', 'tool_name is required')));
  }

  // Reject if the tool is already directly available
  if (isToolAllowed(targetTool)) {
    return textResult(JSON.stringify(opsError('TOOL_ALREADY_AVAILABLE',
      `Tool "${targetTool}" is already directly available. Call it directly instead of through the proxy.`)));
  }

  // Check if tool exists at all
  const allNames = getAllToolNames();
  if (!allNames.includes(targetTool)) {
    const suggestions = suggestTools(targetTool, allNames);
    return textResult(JSON.stringify({
      success: false,
      error_code: 'UNKNOWN_TOOL',
      message: `Unknown tool '${targetTool}'.`,
      suggestions,
      available_tools: allNames,
    }));
  }

  // Delegate the call
  if (!_delegate) {
    return textResult(JSON.stringify(opsError('NO_DELEGATE', 'Proxy delegate not configured')));
  }

  const toolArgs = (args.arguments as Record<string, unknown>) ?? {};
  try {
    return await _delegate(targetTool, toolArgs);
  } catch (err) {
    return textResult(JSON.stringify(opsError('PROXY_ERROR', (err as Error).message)));
  }
}

export const TOOL_META = {
  godot_advanced_tool: { readonly: false, long_running: true },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/advanced-proxy.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/advanced-proxy.ts test/tools/advanced-proxy.test.ts
git commit -m "feat(proxy): add godot_advanced_tool lazy proxy with fuzzy suggestions"
```

---

## Task 1: slim Profile + 注册 + 集成

**Files:**
- Modify: `src/core/tool-registry.ts` — 新增 `slim` Profile
- Modify: `src/core/module-loader.ts` — 注册 advancedProxy
- Modify: `src/core/ToolDispatcher.ts` — slim 模式过滤 + 代理委托

- [ ] **Step 1: tool-registry.ts — 新增 slim Profile**

在 PROFILES 中添加 slim（仅核心组）：

```typescript
  slim:       ['core'],
```

- [ ] **Step 2: module-loader.ts — 注册 advancedProxy**

添加 import 和注册：
- `import * as advancedProxy from '../tools/advanced-proxy.js';`
- 在 ALL_MODULES 末尾添加 `advancedProxy`

- [ ] **Step 3: ToolDispatcher.ts — slim 模式 + 代理委托**

在 `getFilteredTools()` 中 slim 模式分支：

在 import 区添加：
```typescript
import { setToolCallDelegate } from '../tools/advanced-proxy.js';
```

在构造函数末尾添加代理委托设置：
```typescript
    // Phase 3a: Wire proxy delegate to re-dispatch through handleCall
    setToolCallDelegate(async (targetTool, toolArgs) => {
      return this.dispatchTool(targetTool, toolArgs, Date.now());
    });
```

在 `getFilteredTools()` 的 profile 分支中（`else if (this.options.mode !== 'full')` 块内），在 resolveProfile 过滤后确保 `godot_advanced_tool` 始终包含：

```typescript
      // slim: ensure proxy tool is always present
      if (this.options.mode === 'slim') {
        const hasProxy = allTools.some(t => t.name === 'godot_advanced_tool');
        if (!hasProxy) {
          allTools.push(...getAllToolDefinitions().filter(t => t.name === 'godot_advanced_tool'));
        }
      }
```

注意：`slim` profile 已经包含 `core` 组，而 `godot_advanced_tool` 属于 `core` 组，所以它在 `resolveProfile('slim')` 的结果中。但为了保险，加这个检查。

- [ ] **Step 4: 运行全量测试**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-registry.ts src/core/module-loader.ts src/core/ToolDispatcher.ts
git commit -m "feat(proxy): add slim profile and wire proxy delegate in ToolDispatcher"
```

---

## 验收标准

- [ ] `godot_advanced_tool` 代理能调用停用组的工具
- [ ] 代理 description 动态列出可用工具名
- [ ] 无效 tool_name 返回模糊匹配建议
- [ ] 代理调用经过 ToolDispatcher.dispatch（完整中间件链）
- [ ] 新增 `slim` Profile
- [ ] 全量测试通过
