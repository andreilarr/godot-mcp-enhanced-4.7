# v0.16.0 审查报告修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审查报告中 1 CRITICAL + 14 IMPORTANT 发现中的 P0 和 P1 项（共 7 项），确保构建通过、测试不回归。

**Architecture:** 按优先级分批修复：P0 编译错误和运行时崩溃 → P1 安全校验缺失 → P2 代码质量改进。每个 Task 独立可验证。

**Tech Stack:** TypeScript (Node.js), GDScript (Godot 4.x), Vitest

---

## 文件变更清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/index.ts` | 修复 TS2322 编译错误 |
| 修改 | `src/scripts/godot_operations.gd` | cleanup_and_quit 后加 return + _sanitize_res_path 加固 + _is_safe_value 提取 |
| 创建 | `src/scripts/safe_values.gd` | 共享 _is_safe_value 函数 |
| 修改 | `src/scripts/mcp_bridge.gd` | 截图路径遍历加固 + 引用 safe_values.gd |
| 修改 | `src/core/ToolDispatcher.ts` | editor 分支增加路径校验 |
| 修改 | `src/helpers.ts` | requireProjectPath 增加白名单检查 |
| 修改 | `src/tools/batch-tools.ts` | timeout 统一 validateTimeout |
| 修改 | `src/tools/game-bridge.ts` | timeout 统一 validateTimeout |
| 修改 | `src/tools/workflow.ts` | timeout 统一 validateTimeout |
| 修改 | `src/tools/validation.ts` | timeout 统一 validateTimeout |
| 创建 | `test/review-fixes.test.ts` | 新增修复的回归测试 |

---

## Task 1: 修复 TS2322 编译错误 (IMPORTANT-01)

**Files:**
- 修改: `src/index.ts:16-21,28`

- [ ] **Step 1: 确认编译错误**

运行: `npx tsc --noEmit 2>&1 | head -5`
预期: 看到 `src/index.ts(28,3): error TS2322`

- [ ] **Step 2: 修复 mode 类型**

`toolMode` 推断为 `string`（因为 `activeProfile` 可以是任意字符串如 `bridge_dev`、`3d_dev`），但 `ServerOptions.mode` 声明为联合类型。将 `toolMode` 的类型显式标注为 `string`：

```typescript
// src/index.ts — 在 GodotServer 构造调用前添加类型断言
const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'), {
  mode: toolMode as 'full' | 'lite' | 'minimal' | string,
  connectionMode,
  readOnly,
  noFallback,
});
```

但更正确的做法是将 `ServerOptions.mode` 改为 `string`。检查 `GodotServer.ts` 中 `ServerOptions` 接口定义，将 `mode` 字段改为 `string`：

```typescript
// src/GodotServer.ts — ServerOptions 接口
export interface ServerOptions {
  mode: string;  // 'full' | 'lite' | 'minimal' | 自定义 profile 名
  connectionMode: 'headless' | 'editor';
  readOnly?: boolean;
  noFallback?: boolean;
}
```

- [ ] **Step 3: 验证编译通过**

运行: `npx tsc --noEmit`
预期: 0 errors

- [ ] **Step 4: 运行测试确认不回归**

运行: `npx vitest run --reporter=verbose 2>&1 | tail -5`
预期: Tests 全部 passed

- [ ] **Step 5: 提交**

```bash
git add src/index.ts src/GodotServer.ts
git commit -m "fix(I-01): widen ServerOptions.mode to string for custom profiles"
```

---

## Task 2: GDScript cleanup_and_quit 后添加 return (IMPORTANT-03)

**Files:**
- 修改: `src/scripts/godot_operations.gd` — 14 处 cleanup_and_quit 调用

- [ ] **Step 1: 确认所有需要添加 return 的位置**

`cleanup_and_quit` 调用 `quit()` 后函数继续执行，后续可能触发二次 `scene_root.free()` 导致崩溃。需要在所有 `cleanup_and_quit(...)` 后添加 `return`。

受影响的行号和函数：
1. `create_scene` L161, L171, L177 — 3 处
2. `add_node` L216, L221, L226 — 3 处
3. `load_sprite` L358, L362, L371 — 3 处
4. `export_mesh_library` L447, L454 — 2 处
5. `edit_node` 附近 — 检查确认
6. `remove_node` 附近 — 检查确认

- [ ] **Step 2: 使用 search_and_replace 批量修复**

对 godot_operations.gd 中所有 `cleanup_and_quit(...)\n` 后缺少 `return` 的位置，添加 `return`。

模式：每个 `cleanup_and_quit([...], 1)` 后面，如果下一行不是 `return` 也不是函数结束，则添加 `return`。

**create_scene 函数**（3 处）:

```gdscript
# L161 — cleanup_and_quit 后加 return
		cleanup_and_quit([scene_root], 1)
		return

# L171 — cleanup_and_quit 后加 return
					cleanup_and_quit([scene_root], 1)
					return

# L177 — cleanup_and_quit 后加 return
						cleanup_and_quit([scene_root], 1)
						return
```

**add_node 函数**（3 处）:

```gdscript
# L216
			cleanup_and_quit([scene_root], 1)
			return
# L221
			cleanup_and_quit([scene_root], 1)
			return
# L226
		cleanup_and_quit([scene_root], 1)
		return
```

**load_sprite 函数**（3 处）:

```gdscript
# L358
		cleanup_and_quit([scene_root], 1)
		return
# L362
		cleanup_and_quit([scene_root], 1)
		return
# L371
			cleanup_and_quit([scene_root], 1)
			return
```

**export_mesh_library 函数**（2 处）:

```gdscript
# L447
		cleanup_and_quit([scene_root], 1)
		return
# L454
			cleanup_and_quit([scene_root], 1)
			return
```

**其余函数** — 同样检查 `edit_node`、`remove_node` 等是否有遗漏。

- [ ] **Step 3: 用 MCP validate_scripts 验证**

调用 `mcp__godot__validation` 的 `validate_scripts` 检查 GDScript 语法。

- [ ] **Step 4: 提交**

```bash
git add src/scripts/godot_operations.gd
git commit -m "fix(I-03): add return after cleanup_and_quit to prevent double-free crash"
```

---

## Task 3: Editor 模式路径白名单校验 (IMPORTANT-02)

**Files:**
- 修改: `src/core/ToolDispatcher.ts:140-164,183-188`

- [ ] **Step 1: 编写失败测试**

```typescript
// test/review-fixes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolDispatcher } from '../src/core/ToolDispatcher.js';

describe('IMPORTANT-02: editor mode path validation', () => {
  it('should reject project_path outside allowed roots in editor mode', async () => {
    const dispatcher = new ToolDispatcher({
      mode: 'full',
      connectionMode: 'editor',
      readOnly: false,
      noFallback: false,
      godotPath: 'godot',
      scriptPath: '/dummy.gd',
    });
    // Force editor mode with mock executor
    const mockExecutor = { execute: vi.fn() };
    dispatcher.setEditorExecutor(mockExecutor);
    dispatcher.setConnectionMode('editor');

    const result = await dispatcher.handleCall({
      params: {
        name: 'read_scene',
        arguments: { project_path: '/etc/passwd', scene_path: 'res://main.tscn' },
      },
    });

    // Should NOT reach editor executor — path validation should block first
    expect(mockExecutor.execute).not.toHaveBeenCalled();
    const text = result.content[0].text;
    expect(text).toContain('PATH_NOT_ALLOWED');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行: `npx vitest run test/review-fixes.test.ts`
预期: FAIL — editor 分支未校验路径

- [ ] **Step 3: 提取路径校验到公共路径**

在 `handleCall` 中，将 `validatePathArgs` 调用从 `dispatchTool` 提升到 editor 分支之前。修改 `handleCall` 方法：

```typescript
// src/core/ToolDispatcher.ts — handleCall 方法
async handleCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> {
  const { name, arguments: rawArgs } = request.params;
  const startTime = Date.now();
  const args = this.normalizeArgs(rawArgs);

  try {
    // ── 0. Common arg type validation ──
    const typeErr = this.validateCommonArgs(args);
    if (typeErr) return typeErr;

    // ── 0.5. Path allowlist validation (all modes) ──  ← 新增
    const pathErr = this.validatePathArgs(args);
    if (pathErr) return pathErr;

    // ── 1. ReadOnlyGuard ──
    // ... 后续逻辑不变
```

同时从 `dispatchTool` 中移除重复的 `validatePathArgs` 调用：

```typescript
private async dispatchTool(toolName: string, args: Record<string, unknown>, startTime: number): Promise<ToolResult> {
  // 移除: const pathErr = this.validatePathArgs(args);
  // 移除: if (pathErr) return pathErr;
  const targetMod = getModuleForTool(toolName);
  // ... 后续不变
```

注意：`confirm_and_execute` 分支（L158-163）也需要同样处理，因为它也直接走 editor/headless 分支。由于 `validatePathArgs` 已提升到 `handleCall` 顶部，`confirm_and_execute` 分支中的 `pending.args` 已在原始调用时经过校验，所以不需要额外处理。

- [ ] **Step 4: 运行测试确认通过**

运行: `npx vitest run test/review-fixes.test.ts`
预期: PASS

- [ ] **Step 5: 运行全量测试**

运行: `npx vitest run`
预期: 全部 passed

- [ ] **Step 6: 提交**

```bash
git add src/core/ToolDispatcher.ts test/review-fixes.test.ts
git commit -m "fix(I-02): elevate path validation to handleCall for editor mode"
```

---

## Task 4: GDScript _sanitize_res_path 路径遍历加固 (IMPORTANT-04)

**Files:**
- 修改: `src/scripts/godot_operations.gd:572-583`

- [ ] **Step 1: 加固 _sanitize_res_path**

当前实现仅跳过 `.` 开头的段。加固方案：分割前做 percent_decode，显式拒绝 `..`，处理反斜杠。

```gdscript
func _sanitize_res_path(path: String) -> String:
	# Null byte check
	if path.find(char(0)) != -1:
		return "res://"
	# Normalize backslashes to forward slashes
	var normalized_path = path.replace("\\", "/")
	# Percent-decode (handles %2e%2e → ..)
	normalized_path = normalized_path.uri_decode()
	# Ensure res:// prefix
	var full = normalized_path if normalized_path.begins_with("res://") else "res://" + normalized_path
	var parts = full.substr(6).split("/")
	var result_parts = []
	for part in parts:
		if part == ".." or part == ".":
			continue
		if not part.is_empty():
			result_parts.append(part)
	return "res://" + "/".join(result_parts)
```

- [ ] **Step 2: 用 MCP validate_scripts 验证语法**

- [ ] **Step 3: 提交**

```bash
git add src/scripts/godot_operations.gd
git commit -m "fix(I-04): harden _sanitize_res_path against URL-encoded traversal"
```

---

## Task 5: requireProjectPath 增加白名单检查 + Bridge 截图路径加固 (IMPORTANT-11, IMPORTANT-12)

**Files:**
- 修改: `src/helpers.ts:140-142`
- 修改: `src/scripts/mcp_bridge.gd:749-751`

- [ ] **Step 5a: 编写失败测试**

```typescript
// test/review-fixes.test.ts — 追加到同一文件
describe('IMPORTANT-11: requireProjectPath whitelist check', () => {
  it('should throw when project_path is outside allowed roots', () => {
    const origEnv = process.env.GODOT_MCP_UNRESTRICTED;
    delete process.env.GODOT_MCP_UNRESTRICTED;
    delete process.env.ALLOWED_PROJECT_PATHS;
    try {
      // requireProjectPath resolves to absolute, then checks isPathInAllowedRoots
      expect(() => requireProjectPath({ project_path: '/etc/passwd' })).toThrow();
    } finally {
      if (origEnv !== undefined) process.env.GODOT_MCP_UNRESTRICTED = origEnv;
    }
  });
});
```

- [ ] **Step 5b: 修改 requireProjectPath**

```typescript
// src/helpers.ts — requireProjectPath
export function requireProjectPath(args: Record<string, unknown>): string {
  const resolved = validatePath(requireString(args, 'project_path'));
  if (!isPathInAllowedRoots(resolved)) {
    throw new Error(`project_path not in ALLOWED_PROJECT_PATHS: ${resolved}. Set ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED=true.`);
  }
  return resolved;
}
```

注意：ToolDispatcher 的 `validatePathArgs` 已在 handleCall 层拦截，但 game-bridge.ts 等模块直接调用 `requireProjectPath`，所以这个修复保护了绕过 ToolDispatcher 的路径。

- [ ] **Step 5c: 加固 mcp_bridge.gd 截图路径检查**

```gdscript
# src/scripts/mcp_bridge.gd — _cmd_take_screenshot
func _cmd_take_screenshot(params: Dictionary) -> Variant:
	var path: String = str(params.get("path", "user://mcp_screenshot.png"))
	# Normalize and check traversal
	var clean_path = path.replace("\\", "/").uri_decode()
	if not clean_path.begins_with("user://"):
		return {"error": {"code": -1, "message": "Screenshot path must start with user://"}}
	# Split and check each segment for traversal
	for segment in clean_path.substr(8).split("/"):
		if segment == ".." or segment == ".":
			return {"error": {"code": -1, "message": "Screenshot path contains directory traversal"}}
	var viewport := get_viewport()
	var img := viewport.get_texture().get_image()
	var err := img.save_png(clean_path)
	if err != OK:
		return {"error": {"code": -2, "message": "Failed to save screenshot: error %d" % err}}
	return {"success": true, "path": clean_path, "size": {"x": img.get_width(), "y": img.get_height()}}
```

- [ ] **Step 5d: 运行测试**

运行: `npx vitest run test/review-fixes.test.ts`
预期: PASS

- [ ] **Step 5e: 提交**

```bash
git add src/helpers.ts src/scripts/mcp_bridge.gd test/review-fixes.test.ts
git commit -m "fix(I-11,I-12): requireProjectPath whitelist + bridge screenshot path traversal hardening"
```

---

## Task 6: 统一 timeout 参数为 validateTimeout (IMPORTANT-10)

**Files:**
- 修改: `src/tools/batch-tools.ts:155`
- 修改: `src/tools/game-bridge.ts:493,518,521,523,535,538,540,547,557`
- 修改: `src/tools/workflow.ts:204`
- 修改: `src/tools/validation.ts:508,761`

- [ ] **Step 1: batch-tools.ts**

```typescript
// 添加 import
import { validateTimeout } from './shared.js';

// L155 替换
// 旧: const timeout = Math.min((args.timeout as number) || 10, 60);
// 新:
const timeout = validateTimeout(args.timeout, 5, 60, 10);
```

- [ ] **Step 2: game-bridge.ts**

```typescript
// 添加 import（如果还没有）
import { validateTimeout } from './shared.js';

// 所有 (args.timeout as number) || DEFAULT_TIMEOUT 替换为:
const DEFAULT_TIMEOUT = 10000; // ms — 保持原值不变
// 注意：game-bridge 的 timeout 单位是 ms，validateTimeout 的单位是秒
// 需要特殊处理：先转为秒再转回毫秒
// 或者直接用 validateTimeout(args.timeout, 1, 60, 10) * 1000
```

实际上查看代码，game-bridge.ts 的 DEFAULT_TIMEOUT 是 10000（毫秒），而 validateTimeout 输出是秒。需要做单位转换：

```typescript
// game-bridge.ts 中替换模式:
// 旧: (args.timeout as number) || DEFAULT_TIMEOUT
// 新: validateTimeout(args.timeout, 1, 60, 10) * 1000
// 但要注意：game-bridge 的 timeout 是给 TCP 连接用的毫秒值
// 最佳做法：保持 ms 为单位，写一个简单的 clamp
```

**决策：** game-bridge 的 timeout 是 ms，与 validateTimeout 的秒单位不兼容。对 game-bridge 做局部修复：

```typescript
// game-bridge.ts — 在文件顶部 helper 区域添加
function clampTimeout(value: unknown, min = 1000, max = 60000, def = 10000): number {
  if (value === undefined || value === null) return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}
```

然后替换所有 `(args.timeout as number) || DEFAULT_TIMEOUT` 为 `clampTimeout(args.timeout)`。

- [ ] **Step 3: workflow.ts**

```typescript
// 添加 import（如果还没有）
import { validateTimeout } from './shared.js';

// L204 替换
// 旧: const timeout = (args.timeout as number) || 30;
// 新:
const timeout = validateTimeout(args.timeout, 5, 120, 30);
```

- [ ] **Step 4: validation.ts**

```typescript
// 添加 import（如果还没有）
import { validateTimeout } from './shared.js';

// L508 替换
// 旧: const timeout = (args.timeout as number) || 20;
// 新:
const timeout = validateTimeout(args.timeout, 5, 120, 20);

// L761 替换
// 旧: const perScriptTimeout = (args.timeout as number) || 10;
// 新:
const perScriptTimeout = validateTimeout(args.timeout, 5, 60, 10);
```

- [ ] **Step 5: 运行全量测试**

运行: `npx vitest run`
预期: 全部 passed

- [ ] **Step 6: 提交**

```bash
git add src/tools/batch-tools.ts src/tools/game-bridge.ts src/tools/workflow.ts src/tools/validation.ts
git commit -m "fix(I-10): unify timeout handling with validateTimeout/clampTimeout"
```

---

## Task 7: GDScript _is_safe_value 去重 (IMPORTANT-13)

**Files:**
- 创建: `src/scripts/safe_values.gd`
- 修改: `src/scripts/godot_operations.gd:533-568`
- 修改: `src/scripts/mcp_bridge.gd:598-633`

- [ ] **Step 7a: 创建 safe_values.gd**

```gdscript
# src/scripts/safe_values.gd
## Shared safe-value whitelist for GDScript tool operations.
## Used by both godot_operations.gd and mcp_bridge.gd.

class_name SafeValues

const MAX_DEPTH := 10

## Check if a value is safe for use in tool operations.
## Whitelists basic types and recursively checks containers.
static func is_safe(val: Variant, depth: int = 0) -> bool:
	if depth > MAX_DEPTH:
		return false
	if val == null:
		return true
	if val is bool or val is int or val is float or val is String:
		return true
	if val is Vector2 or val is Vector2i or val is Vector3 or val is Vector3i:
		return true
	if val is Color or val is Rect2 or val is Rect2i:
		return true
	if val is Transform2D or val is Transform3D or val is Basis or val is Quaternion:
		return true
	if val is Plane or val is AABB:
		return true
	if val is PackedByteArray or val is PackedInt32Array or val is PackedInt64Array:
		return true
	if val is PackedFloat32Array or val is PackedFloat64Array or val is PackedStringArray:
		return true
	if val is PackedVector2Array or val is PackedVector3Array or val is PackedColorArray:
		return true
	if val is Array:
		for item in val:
			if not is_safe(item, depth + 1):
				return false
		return true
	if val is Dictionary:
		for key in val:
			if not is_safe(val[key], depth + 1):
				return false
		return true
	return false
```

- [ ] **Step 7b: 修改 godot_operations.gd**

删除 `_is_safe_value` 函数和 `MAX_SAFE_VALUE_DEPTH` 常量，替换为调用 `SafeValues.is_safe()`：

```gdscript
# 替换所有 _is_safe_value(...) 调用为 SafeValues.is_safe(...)
# 删除 L533-568 的函数定义和常量
```

- [ ] **Step 7c: 修改 mcp_bridge.gd**

同样删除 `_is_safe_value` 函数和 `MAX_SAFE_VALUE_DEPTH` 常量，替换为调用 `SafeValues.is_safe()`。

- [ ] **Step 7d: 验证**

用 MCP validate_scripts 检查三个 GDScript 文件的语法。

- [ ] **Step 7e: 提交**

```bash
git add src/scripts/safe_values.gd src/scripts/godot_operations.gd src/scripts/mcp_bridge.gd
git commit -m "fix(I-13): extract shared _is_safe_value to SafeValues class"
```

---

## Task 8: 最终验证

- [ ] **Step 1: TypeScript 编译检查**

运行: `npx tsc --noEmit`
预期: 0 errors

- [ ] **Step 2: ESLint 检查**

运行: `npx eslint src/`
预期: 0 errors

- [ ] **Step 3: 全量测试**

运行: `npx vitest run`
预期: 全部 passed（≥1761 tests）

- [ ] **Step 4: GDScript 语法验证**

通过 MCP `validate_scripts` 检查所有 GDScript 文件。

- [ ] **Step 5: 推送所有修复**

```bash
git log --oneline -7
# 确认 7 个修复 commit 都在
git push origin master
```

---

## 范围外说明（留作后续工作）

| 发现 | 原因 | 建议 |
|------|------|------|
| CRITICAL-01 沙箱绕过 | 已知限制，需文档化，长期方案需 Godot 引擎支持 | 单独 PR 添加安全文档 |
| IMPORTANT-05 spawn 模式去重 | 影响面大（scene/batch/runtime/validation 4 个文件） | 独立重构计划 |
| IMPORTANT-06 路径分隔符去重 | 同上 | 随 IMPORTANT-05 一起 |
| IMPORTANT-07 editor fallback 去重 | 结构改进 | 随代码结构调整 |
| IMPORTANT-08 normalizeArgs 转换 | 需要调试日志支持 | 独立小 PR |
| IMPORTANT-09 scene_path 空检查 | 需确认受影响 case | 独立小 PR |
| IMPORTANT-14 文件过大 | 结构改进 | 长期持续 |
| ADVISORY-01~12 | 风险较低，可择机修复 | 独立 PR 或随相关功能修复 |
