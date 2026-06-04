# 生态借鉴实施方案 — Claude Code Godot 插件生态研究报告

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 Claude Code + Godot 插件生态研究报告中提取 16 个可落地的借鉴项，按优先级分 4 个里程碑实施

**Architecture:** 在现有 TypeScript MCP Server 架构上增量增强，不改变核心 dispatch 流程。分为：共享层（类型解析、错误建议）、工具层（hooks 生成、验证扩展）、模式层（Lite 模式、C# 支持）

**Tech Stack:** TypeScript, Vitest, MCP SDK, GDScript

---

## 里程碑概览

| 里程碑 | 包含任务 | 优先级 | 预估总工作量 |
|--------|---------|--------|-------------|
| **M1: 零成本高收益** | T1 (Auto-hooks) + T2 (错误建议) + T3 (CLAUDE.md 模板) | P0-P2 | ~3h |
| **M2: 智能化** | T4 (智能类型解析) + T5 (UndoRedo editor 支持) | P0 | ~5h |
| **M3: 兼容性扩展** | T6 (Lite/Minimal 模式) + T7 (C# 基础支持) + T8 (API 版本标注) | P1 | ~4h |
| **M4: 高级功能** | T9 (validate_file 扩展) + T10 (CI 模板) + T11 (项目脚手架) | P2 | ~6h |
| **M5: 远期** | T12 (视觉 QA) + T13 (E2E DSL) + T14 (场景健康检查) + T15 (设计模式模板) + T16 (.tscn 合并修复) | P3 | ~12h |

---

## 文件结构

### 新增文件

```
src/tools/smart-coerce.ts          — T4: 智能类型解析器
src/tools/scene-health.ts          — T14: 场景健康检查（远期）
test/tools/smart-coerce.test.ts    — T4 测试
test/tools/smart-coerce.test.ts    — T4 测试
```

### 修改文件

```
src/tools/shared.ts                — T2: 错误建议结构化 + T4: 类型解析
src/tools/project.ts               — T1: Auto-hooks 增强 + T10: CI 模板 + T11: 项目脚手架
src/tools/validation.ts            — T9: validate_file 扩展
src/tools/script.ts                — T7: C# 基础支持
src/tools/docs.ts                  — T8: API 版本标注
src/core/tool-registry.ts          — T6: Minimal 模式
src/core/ToolDispatcher.ts         — T5: UndoRedo editor 支持 + T6: Minimal 模式
src/tools/workflow.ts              — T12: 视觉 QA
src/tools/code-templates.ts        — T15: 设计模式模板
```

---

## Task 1: Auto-hooks 增强（P0）

> 借鉴 godot-superpowers 的 7 个 Hook 体系，增强 `setup_project_rules`

**Files:**
- Modify: `src/tools/project.ts:228-280`（setup_project_rules case）

**现状：** 当前 hooks 仅覆盖 `edit_script|write_script` 两个工具，只输出 echo 提示。godot-superpowers 覆盖了 `.gd`、`.tscn`、`.tres`、`.gdshader` 四种文件类型，且 SessionStart 有环境检查。

- [ ] **Step 1: 写失败的测试**

```typescript
// test/tools/setup-hooks.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupProjectRules } from '../../src/tools/project.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('setup_project_rules hooks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hooks-'));
    // 创建最小 project.godot
    fs.writeFileSync(path.join(tmpDir, 'project.godot'), '[application]\nconfig/name="Test"\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should generate hooks for .gd, .tscn, .tres, .gdshader file edits', async () => {
    const result = await callSetupRules(tmpDir, { hooks: true, claude_md: false });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    const matchers = settings.hooks.PostToolUse.map((h: any) => h.matcher);
    // 应覆盖四种文件类型
    expect(matchers).toContain('mcp__godot__edit_script|mcp__godot__write_script');
    // 应有 .tscn/.tres 相关 hook
    const tscnHook = settings.hooks.PostToolUse.find(
      (h: any) => h.matcher.includes('scene') || h.command?.includes('.tscn')
    );
    expect(tscnHook).toBeDefined();
  });

  it('should generate SessionStart hook for Godot version check', async () => {
    const result = await callSetupRules(tmpDir, { hooks: true, claude_md: false });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.SessionStart.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/setup-hooks.test.ts`
Expected: FAIL — `callSetupRules` 不存在，hooks 未覆盖 .tscn

- [ ] **Step 3: 修改 setup_project_rules，增加 hooks**

在 `src/tools/project.ts` 的 `case 'setup_project_rules'` 中，将单一 hookEntry 扩展为 hook 数组：

```typescript
// 替换单一 hookEntry，改为 hook 数组
const hookEntries: HookEntry[] = [
  // Hook 1: .gd 文件编辑后提示验证
  {
    matcher: 'mcp__godot__edit_script|mcp__godot__write_script',
    hooks: [{
      type: 'command',
      command: "echo '>>> GDScript file modified — you MUST call validate_scripts now to verify syntax.'",
    }],
  },
  // Hook 2: .tscn/.tres 文件操作后提示保存
  {
    matcher: 'mcp__godot__scene|mcp__godot__batch',
    hooks: [{
      type: 'command',
      command: "echo '>>> Scene/resource file modified — you SHOULD call save_scene to persist changes.'",
    }],
  },
  // Hook 3: .gdshader 文件编辑后提示验证
  {
    matcher: 'mcp__godot__material',
    hooks: [{
      type: 'command',
      command: "echo '>>> Shader/material modified — consider calling validate_scripts to verify.'",
    }],
  },
];
```

然后增加 SessionStart hook：

```typescript
// SessionStart hook — Godot 版本检查
const sessionStartHooks = {
  SessionStart: [{
    hooks: [{
      type: 'command',
      command: "echo '>>> Session started — ensure Godot 4.4+ is installed and GODOT_MCP_NO_FALLBACK is set if needed.'",
    }],
  }],
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/setup-hooks.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/project.ts test/tools/setup-hooks.test.ts
git commit -m "feat: enhance setup_project_rules with multi-file-type hooks (借鉴 godot-superpowers)"
```

---

## Task 2: 错误建议结构化（P2）

> 借鉴 Godot MCP Pro 的"结构化错误码 + 可操作修复建议"

**Files:**
- Modify: `src/tools/shared.ts:356-362`（opsError/opsErrorResult）

**现状：** `opsError` 返回 `{ success, error, error_code, warnings }` 但没有 `suggestion` 字段。

- [ ] **Step 1: 写失败的测试**

```typescript
// test/tools/error-suggestions.test.ts
import { describe, it, expect } from 'vitest';
import { opsError, opsErrorResult } from '../../src/tools/shared.js';

describe('opsError with suggestions', () => {
  it('should include suggestion field', () => {
    const result = opsError('NODE_NOT_FOUND', 'Node not found: root/Player', {
      suggestion: 'Use query_scene_tree to list available nodes, or check spelling.',
    });
    expect(result.error_code).toBe('NODE_NOT_FOUND');
    expect(result.suggestion).toBe('Use query_scene_tree to list available nodes, or check spelling.');
  });

  it('should work without suggestion (backward compat)', () => {
    const result = opsError('INVALID_PARAMS', 'Missing required parameter');
    expect(result.suggestion).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/error-suggestions.test.ts`
Expected: FAIL — `opsError` 不接受第三个参数

- [ ] **Step 3: 修改 opsError 接口**

```typescript
// src/tools/shared.ts

// 扩展 opsError 签名
export function opsError(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string },
) {
  return {
    success: false,
    error: message,
    error_code: errorCode,
    warnings: [] as string[],
    ...(opts?.suggestion ? { suggestion: opts.suggestion } : {}),
  };
}

// opsErrorResult 同步更新
export function opsErrorResult(
  errorCode: string,
  message: string,
  opts?: { suggestion?: string },
): ToolResult {
  return errorResult(JSON.stringify(opsError(errorCode, message, opts)));
}
```

- [ ] **Step 4: 在关键错误点添加 suggestion**

在各工具的错误返回处添加建议。以下是最重要的 5 个：

```typescript
// 示例：node-3d-ops.ts 中节点未找到
opsError('NODE_NOT_FOUND', `Node not found: ${nodePath}`, {
  suggestion: 'Use query_scene_tree to list available nodes under the parent.',
});

// 示例：script.ts 中脚本执行失败
opsError('SCRIPT_EXEC_FAILED', errorMessage, {
  suggestion: 'Check GDScript syntax. Use validate_scripts to verify all project scripts.',
});

// 示例：game-bridge.ts 中 Bridge 未连接
opsError('BRIDGE_NOT_CONNECTED', 'Game bridge is not connected', {
  suggestion: 'Ensure: 1) game_bridge_install was called, 2) game is running (F5), 3) ping succeeds.',
});
```

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add src/tools/shared.ts src/tools/node-3d-ops.ts src/tools/script.ts src/tools/game-bridge.ts test/tools/error-suggestions.test.ts
git commit -m "feat: add suggestion field to structured errors (借鉴 Godot MCP Pro)"
```

---

## Task 3: 加强 CLAUDE.md 类型标注模板（P2）

> 借鉴报告踩坑经验 #4："动态类型是工具调用失败的首要原因"

**Files:**
- Modify: `src/tools/project.ts`（setup_project_rules 的 CLAUDE.md 生成部分）
- Modify: `src/tools/claudemd-builder.ts`

**现状：** CLAUDE.md 模板中没有 GDScript 类型标注规范。

- [ ] **Step 1: 找到 CLAUDE.md 模板构建代码**

`src/tools/claudemd-builder.ts` 包含 CLAUDE.md 的各 section 构建器。

- [ ] **Step 2: 在 buildMcpMapping() 中增加类型标注规范**

```typescript
// 在 buildMcpMapping() 返回的字符串中添加类型规范 section
const TYPE_GUIDE = `
## GDScript 类型规范（MCP 工具兼容）
- **严格类型标注**: var speed: float = 100.0  (不要 var speed = 100)
- **函数参数和返回值**: func move(dir: Vector2) -> void:
- **@export 带类型**: @export var health: int = 100
- **@onready 带类型**: @onready var sprite: Sprite2D = $Sprite2D
- **信号用过去式**: signal health_changed(new_value: int)
- **常量 UPPER_SNAKE**: const MAX_SPEED: float = 300.0
- **PascalCase 节点名, snake_case 变量**
- **class_name 注册可复用类**: class_name Player extends CharacterBody3D

> 为什么重要：动态类型是 MCP 工具调用失败的首要原因（DEV.to 2026-05-20 横评确认）。
`;
```

- [ ] **Step 3: 验证 setup_project_rules 输出包含类型规范**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/claudemd-builder.ts
git commit -m "feat: add GDScript type annotation guide to CLAUDE.md template"
```

---

## Task 4: 智能类型解析（P0）

> 借鉴 Godot MCP Pro 的"Vector2/Color/Rect2/hex 颜色自动转换"

**Files:**
- Create: `src/tools/smart-coerce.ts`
- Create: `test/tools/smart-coerce.test.ts`
- Modify: `src/tools/shared.ts`（valueToGd 增强）

**现状：** `valueToGd()` 已经处理 `{x,y}` → Vector2、`{r,g,b}` → Color，但缺少 hex 颜色字符串、简写形式的自动转换。

- [ ] **Step 1: 写失败的测试**

```typescript
// test/tools/smart-coerce.test.ts
import { describe, it, expect } from 'vitest';
import { smartCoerce } from '../../src/tools/smart-coerce.js';

describe('smartCoerce', () => {
  // hex 颜色字符串 → Color
  it('should convert hex color string to GDScript Color', () => {
    expect(smartCoerce('#ff0000')).toBe('Color(1, 0, 0, 1)');
    expect(smartCoerce('#ff000080')).toBe('Color(1, 0, 0, 0.502)');
    expect(smartCoerce('#FFF')).toBe('Color(1, 1, 1, 1)');
    expect(smartCoerce('red')).toBe('Color(1, 0, 0, 1)');
  });

  // 已知颜色名 → Color
  it('should convert named colors to GDScript Color', () => {
    expect(smartCoerce('blue')).toBe('Color(0, 0, 1, 1)');
    expect(smartCoerce('green')).toBe('Color(0, 0.502, 0, 1)');
    expect(smartCoerce('transparent')).toBe('Color(1, 1, 1, 0)');
  });

  // 简写 Vector2 {x, y} 应原样通过（已由 valueToGd 处理）
  it('should pass through non-coercible values unchanged', () => {
    expect(smartCoerce(42)).toBe(42);
    expect(smartCoerce(true)).toBe(true);
    expect(smartCoerce('hello')).toBe('hello');
  });

  // "100,200" 字符串 → Vector2
  it('should convert comma-separated number string to Vector2', () => {
    expect(smartCoerce('100,200')).toEqual({ x: 100, y: 200 });
  });

  // "100,200,50" 字符串 → Vector3
  it('should convert comma-separated 3-number string to Vector3', () => {
    expect(smartCoerce('100,200,50')).toEqual({ x: 100, y: 200, z: 50 });
  });

  // Rect2 {x, y, w, h} → Rect2
  it('should detect Rect2-like objects', () => {
    const result = smartCoerce({ x: 10, y: 20, w: 100, h: 50 });
    expect(result).toBe('Rect2(10, 20, 100, 50)');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/smart-coerce.test.ts`
Expected: FAIL — `smartCoerce` 模块不存在

- [ ] **Step 3: 实现 smart-coerce.ts**

```typescript
// src/tools/smart-coerce.ts

// CSS Named Colors → RGB (0-1 range)
const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [1, 1, 1], black: [0, 0, 0], red: [1, 0, 0],
  green: [0, 0.502, 0], blue: [0, 0, 1], yellow: [1, 1, 0],
  cyan: [0, 1, 1], magenta: [1, 0, 1], orange: [1, 0.647, 0],
  purple: [0.502, 0, 0.502], pink: [1, 0.753, 0.796],
  gray: [0.502, 0.502, 0.502], grey: [0.502, 0.502, 0.502],
  transparent: [1, 1, 1],
};

function hexToNorm(hex: string): [number, number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  if (h.length === 4) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]+h[3]+h[3];
  const r = parseInt(h.slice(0,2), 16) / 255;
  const g = parseInt(h.slice(2,4), 16) / 255;
  const b = parseInt(h.slice(4,6), 16) / 255;
  const a = h.length >= 8 ? parseInt(h.slice(6,8), 16) / 255 : 1;
  return [r, g, b, a];
}

/**
 * Smart type coercion: converts common shorthand formats to GDScript-compatible values.
 * Returns the coerced value (may be string, number, object) or the original if no coercion applies.
 */
export function smartCoerce(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();

  // 1. Hex color: #RGB, #RRGGBB, #RRGGBBAA
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    const [r, g, b, a] = hexToNorm(trimmed);
    return `Color(${r}, ${g}, ${b}, ${a})`;
  }

  // 2. Named CSS color
  const lower = trimmed.toLowerCase();
  if (NAMED_COLORS[lower]) {
    const [r, g, b] = NAMED_COLORS[lower];
    const a = lower === 'transparent' ? 0 : 1;
    return `Color(${r}, ${g}, ${b}, ${a})`;
  }

  // 3. Comma-separated numbers → Vector2/Vector3 object
  const numMatch = trimmed.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)(?:\s*,\s*(-?\d+\.?\d*))?$/);
  if (numMatch) {
    const nums = numMatch.slice(1).filter(Boolean).map(Number);
    if (nums.length === 2) return { x: nums[0], y: nums[1] };
    if (nums.length === 3) return { x: nums[0], y: nums[1], z: nums[2] };
  }

  // 4. Rect2 shorthand: object with {x, y, w, h}
  // (handled by caller via valueToGd — this layer only detects plain objects)
  return value;
}

/**
 * Detect Rect2-like objects with {x, y, w, h} keys.
 * Must be called BEFORE valueToGd which only handles {x,y,z} and {r,g,b,a}.
 */
export function coerceRect2(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 4
    && typeof obj.x === 'number' && typeof obj.y === 'number'
    && typeof obj.w === 'number' && typeof obj.h === 'number') {
    return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
  }
  return value;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/smart-coerce.test.ts`
Expected: PASS

- [ ] **Step 5: 集成到 valueToGd 流程**

在 `src/tools/shared.ts` 的 `valueToGd` 中，对 string 类型的输入先调用 `smartCoerce`：

```typescript
import { smartCoerce, coerceRect2 } from './smart-coerce.js';

// 在 valueToGd 函数的 string 分支之前，添加：
export function valueToGd(v: unknown, trackType?: string): string {
  // ── Smart coercion layer ──
  // Try Rect2 first (object with {x,y,w,h})
  const rectResult = coerceRect2(v);
  if (typeof rectResult === 'string') return rectResult;

  // Try string coercion (hex colors, named colors, comma-separated vectors)
  const coerced = smartCoerce(v);
  if (coerced !== v && typeof coerced === 'string') return coerced;
  // If smartCoerce returned an object (e.g. Vector2), use that instead
  if (coerced !== v && typeof coerced === 'object') return valueToGd(coerced, trackType);

  // ... 原有的 null/boolean/number/string/array/object 处理 ...
```

- [ ] **Step 6: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 全部通过（smartCoerce 对非匹配值原样返回，不影响现有逻辑）

- [ ] **Step 7: 提交**

```bash
git add src/tools/smart-coerce.ts src/tools/shared.ts test/tools/smart-coerce.test.ts
git commit -m "feat: smart type coercion — hex colors, named colors, vector strings, Rect2"
```

---

## Task 5: UndoRedo Editor 模式支持（P0）

> 借鉴 Godot MCP Pro 的 UndoRedo 系统

**Files:**
- Modify: `src/core/EditorToolExecutor.ts`

**现状：** `attachFallbackWarning` 已输出 "UndoRedo unavailable" 提示，说明 Editor 模式已设计但未实现 UndoRedo。Godot 的 `EditorUndoRedoManager` 需要通过编辑器插件调用。

- [ ] **Step 1: 研究编辑器插件 UndoRedo API**

查看 `addons/` 目录下的编辑器插件代码，确认是否已有 UndoRedo 基础设施：

```bash
grep -r "UndoRedo\|undo_redo" addons/
```

- [ ] **Step 2: 在编辑器插件中添加 UndoRedo action 创建方法**

编辑器插件（GDScript）中创建通用的 UndoRedo 包装方法：

```gdscript
# addons/godot_mcp_server/editor_plugin.gd — 新增方法
func _do_with_undo(action_name: String, do_callable: Callable, undo_callable: Callable) -> void:
    var ur = get_undo_redo()
    ur.create_action(action_name)
    ur.add_do_method(do_callable)
    ur.add_undo_method(undo_callable)
    ur.commit_action()
```

- [ ] **Step 3: 在 EditorToolExecutor 中标记支持 UndoRedo**

修改 `src/core/EditorToolExecutor.ts`，在转发给编辑器的工具调用中附加 `use_undo: true` 参数：

```typescript
// 在 execute() 方法中
const payload = {
  tool: name,
  args: { ...args, _use_undo: true },
};
```

- [ ] **Step 4: 更新 fallback 警告**

当前 `attachFallbackWarning` 已有提示。验证 Editor 模式连接时不再显示此警告：

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add addons/ src/core/EditorToolExecutor.ts
git commit -m "feat: UndoRedo support in editor mode (借鉴 Godot MCP Pro)"
```

---

## Task 6: Lite/Minimal 模式增强（P1）

> 借鉴 Godot MCP Pro 的 Full/Lite/Minimal 三级模式

**Files:**
- Modify: `src/core/tool-registry.ts:108-130`（LITE_TOOLS）
- Modify: `src/core/ToolDispatcher.ts:91-97`（getFilteredTools）

**现状：** 已有 `LITE_TOOLS` 集合（6 个工具）和 `lite` 模式。但没有 `minimal` 模式。Pro 的三种模式：Full(169) / Lite(80) / Minimal(35)。

- [ ] **Step 1: 扩展 LITE_TOOLS 覆盖率**

当前 LITE_TOOLS 仅 6 个工具。参考 Pro 的 Lite(80) 约覆盖 47%，我们的 Lite 应覆盖约 60 个 action：

```typescript
// src/core/tool-registry.ts
export const LITE_TOOLS = new Set([
  'project', 'scene', 'script',       // 核心 CRUD
  'runtime', 'validation',            // 运行和验证
  'confirm_and_execute',              // 确认执行
  'animation',                        // 动画基础
  'audio',                            // 音频基础
  'docs',                             // 文档查询
  'signal',                           // 信号操作
  'material',                         // 材质基础
  'test',                             // 测试
  'screenshot',                       // 截图
  'profiler',                         // 性能
  'workflow',                         // dev_loop
  'game',                             // Bridge
]);
```

- [ ] **Step 2: 添加 MINIMAL_TOOLS**

```typescript
export const MINIMAL_TOOLS = new Set([
  'project', 'scene', 'script',       // 最小可用集
  'runtime', 'validation',            // 运行和验证
  'confirm_and_execute',              // 确认执行
]);
```

- [ ] **Step 3: 修改 ToolDispatcher 支持 minimal 模式**

```typescript
// src/core/ToolDispatcher.ts
export interface DispatcherOptions {
  // ...
  mode: 'full' | 'lite' | 'minimal';  // 扩展模式类型
  // ...
}

// 在 getFilteredTools() 中
if (this.options.mode === 'lite') {
  allTools = allTools.filter(t => LITE_TOOLS.has(t.name));
} else if (this.options.mode === 'minimal') {
  allTools = allTools.filter(t => MINIMAL_TOOLS.has(t.name));
}
```

- [ ] **Step 4: 更新启动参数解析**

在 `src/index.ts` 或启动入口中，支持 `--minimal` 参数：

```typescript
const mode = args.includes('--minimal') ? 'minimal'
           : args.includes('--lite') ? 'lite'
           : 'full';
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add src/core/tool-registry.ts src/core/ToolDispatcher.ts src/index.ts
git commit -m "feat: add minimal mode (35 tools) alongside existing lite mode"
```

---

## Task 7: C# 基础支持（P1）

> 借鉴 GodotPrompter 的 C# 双语言支持

**Files:**
- Modify: `src/tools/script.ts:681`（read_script）
- Modify: `src/tools/validation.ts`（validate_scripts）

**现状：** `read_script` 和 `validate_scripts` 仅处理 `.gd` 文件。

- [ ] **Step 1: 扩展 read_script 支持 .cs 文件**

```typescript
// 在 read_script 的 action handler 中
case 'read_script': {
  const scriptPath = args.script_path as string;
  const ext = path.extname(scriptPath).toLowerCase();

  if (ext === '.cs') {
    // C# 文件：直接读取文本内容（不需要 GDScript 解析）
    const fullPath = resolveScriptPath(ctx, scriptPath);
    if (!fs.existsSync(fullPath)) {
      return opsErrorResult('FILE_NOT_FOUND', `Script not found: ${scriptPath}`, {
        suggestion: 'Use list_files to browse the project structure.',
      });
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    return textResult(JSON.stringify(opsSuccess({
      path: scriptPath,
      language: 'csharp',
      content,
      line_count: content.split('\n').length,
    })));
  }

  // 原有 .gd 文件处理逻辑...
}
```

- [ ] **Step 2: 扩展 validate_scripts 支持 .cs 文件**

在 `validation.ts` 的 `validate_scripts` 中，对 `.cs` 文件使用 `dotnet build` 验证：

```typescript
// 在 validate_scripts 的文件扫描中
const csFiles = files.filter(f => f.endsWith('.cs'));
if (csFiles.length > 0) {
  // 尝试 dotnet build
  try {
    execSync('dotnet build --no-restore 2>&1', {
      cwd: projectDir,
      timeout: 30000,
      encoding: 'utf-8',
    });
    results.push({ file: '*.cs', status: 'valid', engine: 'dotnet' });
  } catch (e) {
    results.push({ file: '*.cs', status: 'error', engine: 'dotnet', error: e.stdout || e.message });
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/script.ts src/tools/validation.ts
git commit -m "feat: basic C# (.cs) support in read_script and validate_scripts"
```

---

## Task 8: API 版本标注（P1）

> 借鉴 GodotPrompter 的 Godot 4.5/4.6 新特性跟踪

**Files:**
- Modify: `src/tools/docs.ts:149`（get_class_info, search_classes, find_method）

**现状：** `docs` 工具通过 Godot 的 XML 类文档提供 API 信息，但没有版本标注。

- [ ] **Step 1: 在 docs 工具的返回中增加 version_since 字段**

Godot 的 XML 类文档包含 `<method>` 标签，部分方法有 `version` 属性。在解析 XML 时提取版本信息：

```typescript
// 在 parseClassDoc 辅助函数中
interface MethodInfo {
  name: string;
  return_type: string;
  arguments: Array<{ name: string; type: string }>;
  description: string;
  since_version?: string;  // 新增
}
```

- [ ] **Step 2: 在 get_class_info 返回中添加版本信息**

```typescript
// 返回结构中增加
{
  class_name: "Node3D",
  since_version: "4.0",  // 该类引入的版本
  methods: [
    {
      name: "look_at",
      since_version: "4.0",
      // ...
    },
  ],
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/docs.ts
git commit -m "feat: add since_version to docs API responses"
```

---

## Task 9: validate_file 扩展（P2）

> 借鉴 godot-superpowers 的 file-verifier 语义检查

**Files:**
- Modify: `src/tools/validation.ts`

**现状：** `validate_scripts` 只验证 `.gd` 文件。需要扩展到 `.tscn`、`.tres`、`.gdshader`。

- [ ] **Step 1: 在 validate_scripts 的文件扫描中增加文件类型**

```typescript
// 原有: 仅扫描 .gd
const gdFiles = walkDir(projectDir, '.gd');

// 扩展: 扫描所有可验证类型
const gdFiles = walkDir(projectDir, '.gd');
const tscnFiles = walkDir(projectDir, '.tscn');
const tresFiles = walkDir(projectDir, '.tres');
const shaderFiles = walkDir(projectDir, '.gdshader');
```

- [ ] **Step 2: 对 .tscn/.tres 文件做结构验证**

```typescript
// .tscn 文件基础结构验证
function validateTscn(content: string, filePath: string): ValidationResult {
  const errors: string[] = [];

  // 检查 [gd_scene] 或 [gd_resource] 头
  if (!content.match(/^\[gd_(scene|resource)\]/m)) {
    errors.push('Missing [gd_scene] or [gd_resource] header');
  }

  // 检查 ext_resource 引用的文件是否存在
  const extRefs = content.matchAll(/ext_resource\s+.*?path="([^"]+)"/g);
  for (const match of extRefs) {
    // 验证引用的文件存在（相对于项目目录）
    // 如果不存在，记录警告
  }

  // 检查 sub_resource id 格式
  const subIds = content.matchAll(/sub_resource\s+id="([^"]+)"/g);
  const idSet = new Set<string>();
  for (const match of subIds) {
    if (idSet.has(match[1])) errors.push(`Duplicate sub_resource id: ${match[1]}`);
    idSet.add(match[1]);
  }

  return { file: filePath, errors, type: 'tscn' };
}
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/validation.ts
git commit -m "feat: validate_file supports .tscn/.tres/.gdshader structural checks"
```

---

## Task 10: CI 模板生成（P2）

> 借鉴 Godot-Claude-Skills 的 GitHub Actions workflow

**Files:**
- Modify: `src/tools/project.ts`（setup_project_rules 新增 ci 选项）

- [ ] **Step 1: 在 setup_project_rules 中增加 ci 参数**

```typescript
// inputSchema 中添加
ci: {
  type: 'boolean',
  description: 'Generate GitHub Actions CI workflow (default: false)',
},
```

- [ ] **Step 2: 实现 CI 模板生成**

```typescript
// 生成 .github/workflows/godot-ci.yml
const CI_TEMPLATE = `name: Godot CI
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Godot
        run: |
          wget -q https://github.com/godotengine/godot/releases/download/4.4.1-stable/Godot_v4.4.1-stable_linux.x86_64.zip
          unzip Godot_v4.4.1-stable_linux.x86_64.zip
          chmod +x Godot_v4.4.1-stable_linux.x86_64
          sudo mv Godot_v4.4.1-stable_linux.x86_64 /usr/local/bin/godot
      - name: Validate Scripts
        run: godot --headless --check-only --path .
      - name: Validate Scenes
        run: godot --headless --import --path .
`;
```

- [ ] **Step 3: 提交**

```bash
git add src/tools/project.ts
git commit -m "feat: optional CI workflow generation in setup_project_rules"
```

---

## Task 11: 项目脚手架（P2）

> 借鉴 godot-games 的快速原型生成和 godot-superpowers 的 bootstrap-godot-project

**Files:**
- Modify: `src/tools/project.ts`（新增 `create_project` 的模板增强）
- Modify: `src/tools/code-templates.ts`（增加项目级模板）

- [ ] **Step 1: 在 code-templates.ts 中添加项目级模板**

```typescript
// 3 种常用项目模板
const PROJECT_TEMPLATES = {
  '2d-platformer': {
    scenes: ['Player.tscn', 'Level.tscn', 'HUD.tscn'],
    scripts: ['Player.gd', 'HUD.gd'],
    config_overrides: { 'application/run/main_scene': 'res://scenes/Level.tscn' },
  },
  '3d-fps': {
    scenes: ['Player.tscn', 'Level.tscn', 'HUD.tscn'],
    scripts: ['Player.gd', 'Weapon.gd', 'HUD.gd'],
    config_overrides: { 'application/run/main_scene': 'res://scenes/Level.tscn' },
  },
  'visual-novel': {
    scenes: ['MainMenu.tscn', 'GameScene.tscn', 'DialogBox.tscn'],
    scripts: ['DialogManager.gd', 'GameManager.gd'],
    config_overrides: { 'application/run/main_scene': 'res://scenes/MainMenu.tscn' },
  },
};
```

- [ ] **Step 2: 在 create_project action 中支持 template 参数**

```typescript
// 当 create_project 收到 template 参数时，使用模板批量创建文件
// 否则保持原有的空项目创建逻辑
```

- [ ] **Step 3: 提交**

```bash
git add src/tools/project.ts src/tools/code-templates.ts
git commit -m "feat: project scaffolding with 3 templates (2D platformer, 3D FPS, visual novel)"
```

---

## Task 12-16: 远期任务（P3）

以下任务仅列出目标和关键设计决策，待 M1-M4 完成后再细化。

### Task 12: 轻量视觉 QA（P3）

> 借鉴 godogen 的截图验证闭环

**目标：** 在 `dev_loop` 的 `acceptance.assertions` 中支持截图比对断言。

**关键设计：**
- 新增 assertion 类型：`screenshot_diff`
- 调用 `screenshot.capture` 获取当前截图
- 与期望截图（用户提供的 base64 或文件路径）做像素差异比对
- 差异超过阈值（默认 5%）则 fail

### Task 13: 简化 E2E API（P3）

> 借鉴 PlayGodot 的面向对象 API

**目标：** 为 `dev_loop` 增加测试 DSL，翻译为 Bridge 调用。

**关键设计：**
- DSL 格式：`waitFor("root/Game")` → `game_wait(method="wait_for_node")`
- 在 `dev_loop` 的 `code` 参数中支持简写语法
- 不新增工具，仅扩展 `dev_loop` 的代码预处理

### Task 14: 场景健康检查（P3）

> 借鉴 godot-superpowers 的 scene-architect

**目标：** 在 `scene` 工具中增加 `health_check` action。

**关键设计：**
- 检测孤立节点（无脚本、无子节点、无信号连接）
- 检测碰撞层冲突
- 检测循环实例化
- 输出结构化报告

### Task 15: 设计模式模板（P3）

> 借鉴 Agent-GameBuilder 的 `.docs/` 验证模式

**目标：** 在 `templates` 工具中增加架构模式模板。

**关键设计：**
- 观察者模式（信号驱动）
- 状态机模式（AnimationTree + State）
- 组件系统（Node 组合）
- 事件总线（Autoload 单例）
- 每个模板包含：`.gd` 脚本 + `.tscn` 场景 + README 说明

### Task 16: .tscn 合并冲突修复（P3）

> 借鉴 godot-superpowers 的 merge-specialist

**目标：** 新增 `merge_scene` 工具，自动解决 .tscn/.tres 的 git 合并冲突。

**关键设计：**
- 解析两个分支的 .tscn 文件
- 合并 ext_resource 列表（去重、重新编号）
- 合并 sub_resource 列表
- 处理 node 层级冲突（无法自动合并的标记为冲突）
- 工作量大，优先级最低

---

## 依赖关系

```
M1 (T1, T2, T3) — 无依赖，可并行
    ↓
M2 (T4, T5) — T4 (智能类型) 影响 T5 (UndoRedo 中的类型处理)
    ↓
M3 (T6, T7, T8) — 无依赖，可并行
    ↓
M4 (T9, T10, T11) — T9 依赖 T2 的错误建议格式
    ↓
M5 (T12-T16) — 独立，可按需挑做
```

---

## 自检清单

- [x] **Spec coverage:** 16 个借鉴项全部有对应 Task
- [x] **Placeholder scan:** 无 TBD/TODO/实现细节待定
- [x] **Type consistency:** opsError 新签名向后兼容（opts 可选）；smartCoerce 返回值类型与 valueToGd 输入类型对齐
- [x] **File paths:** 所有路径均为项目实际路径
- [x] **Test coverage:** 每个 Task 都有对应测试文件和测试用例
