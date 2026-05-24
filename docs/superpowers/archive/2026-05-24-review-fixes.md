# 审查修复：8 CRITICAL + 6 IMPORTANT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复代码审查发现的 8 个 CRITICAL 和 6 个高优先 IMPORTANT 问题，确保下次发布前质量达标。

**Architecture:** 逐文件修复，每个 Task 修改 1-2 个文件，每个 Task 完成后运行测试验证不引入回归。

**Tech Stack:** TypeScript (strict), Vitest, GDScript (生成代码)

---

## File Impact Map

| 文件 | 修改类型 | 涉及 Task |
|------|---------|-----------|
| `src/core/EditorConnection.ts` | 修改 | Task 1 |
| `src/gdscript-executor.ts` | 修改 | Task 2 |
| `src/core/process-state.ts` | 修改 | Task 3 |
| `src/tools/test-framework.ts` | 修改 | Task 4 |
| `src/tools/validation.ts` | 修改 | Task 4 |
| `src/tools/physics-ops.ts` | 修改 | Task 5 |
| `src/tools/ik-tools.ts` | 修改 | Task 5 |
| `src/GodotServer.ts` | 修改 | Task 6 |
| `src/tools/ui-tools.ts` | 修改 | Task 7 |
| `src/helpers.ts` | 修改 | Task 8 |
| 测试文件 (多个) | 新增/修改 | 各 Task |

---

## Task 1: C-01 — EditorConnection 认证超时防重连

**Files:**
- Modify: `src/core/EditorConnection.ts:227-230`
- Test: `tests/core/editor-connection.test.js`（如不存在则新建）

**问题:** `performAuth` 超时时 `this.ws?.close()` 触发 `ws.on('close')` 回调，此时 `connectAttempt` 为 false（被 open 回调设为 false），导致 close 处理器认为"已连接后断开"并调度重连。

- [ ] **Step 1: 修复 auth 超时 handler**

在 `performAuth` 方法的 authTimeout 回调中，`this.ws?.close()` 前添加 `this.connectAttempt = true` 阻止 close handler 调度重连：

```typescript
// src/core/EditorConnection.ts:227-230 — 修改前:
const authTimeout = setTimeout(() => {
    this.pending.delete(AUTH_REQUEST_ID);
    reject(new Error('Auth handshake timeout'));
    this.ws?.close();
}, 10000);

// 修改后:
const authTimeout = setTimeout(() => {
    this.pending.delete(AUTH_REQUEST_ID);
    this.connectAttempt = true; // Prevent close handler from scheduling reconnect
    reject(new Error('Auth handshake timeout'));
    this.ws?.close();
}, 10000);
```

- [ ] **Step 2: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/core/EditorConnection.ts
git commit -m "fix(connection): prevent reconnect on auth timeout (C-01)"
```

---

## Task 2: C-02 — Loader 脚本 marker 随机化

**Files:**
- Modify: `src/gdscript-executor.ts:452`

**问题:** `createAutoloadLoaderScript` 中 `___MCP_ERROR___` 硬编码。用户代码 `print("___MCP_ERROR___...")` 可伪造错误输出。用户脚本的 marker 已通过 `randomizeMarkers` 随机化，但 loader 脚本没有。

- [ ] **Step 1: 将 randomizeMarkers 应用到 loader 脚本**

```typescript
// src/gdscript-executor.ts:452 — 修改前:
const loaderScriptPath = writeSessionFile(createAutoloadLoaderScript(tempFile), '.gd', sessionDir);

// 修改后:
const loaderScriptPath = writeSessionFile(randomizeMarkers(createAutoloadLoaderScript(tempFile)), '.gd', sessionDir);
```

- [ ] **Step 2: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/gdscript-executor.ts
git commit -m "fix(executor): randomize loader script markers to prevent forgery (C-02)"
```

---

## Task 3: C-03 — process-state 进程替换保护

**Files:**
- Modify: `src/core/process-state.ts`
- Test: `tests/core/process-state.test.js`

**问题:** `setRunningProcess` 不检查当前进程是否正被其他工具使用。一个工具正在读取输出时，另一个工具调用 `setRunningProcess` 会 kill 当前进程并清空缓冲区。

- [ ] **Step 1: 添加 busy 标志和守卫**

在 `src/core/process-state.ts` 中添加 `_processBusy` 标志：

```typescript
// 在 let _projectDir = ''; 之后添加:
let _processBusy = false;

// 添加 getter/setter:
export function isProcessBusy(): boolean {
  return _processBusy;
}

export function setProcessBusy(busy: boolean): void {
  _processBusy = busy;
}

// 修改 setRunningProcess，添加 busy 守卫:
export function setRunningProcess(proc: ChildProcess | null): void {
  if (_processBusy) {
    throw new Error('Cannot replace process while another operation is using it');
  }
  if (_runningProcess && !_runningProcess.killed && proc !== _runningProcess) {
    forceKillTree(_runningProcess);
  }
  _runningProcess = proc;
  if (!proc) {
    _outputBuffer = [];
    _processStartTime = 0;
  }
}

// 在 resetState 中添加:
export function resetState(): void {
  _runningProcess = null;
  _outputBuffer = [];
  _processStartTime = 0;
  _projectDir = '';
  _processBusy = false;  // 新增
}
```

- [ ] **Step 2: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过（如有 process-state 测试需要更新以适配 busy 检查）

- [ ] **Step 4: Commit**

```bash
git add src/core/process-state.ts
git commit -m "fix(process): add busy guard to prevent process replacement during use (C-03)"
```

---

## Task 4: T-01/T-02/T-03 — `_init()` 改 `_initialize()` + 缩进修复

**Files:**
- Modify: `src/tools/test-framework.ts:141-143, 213, 238`
- Modify: `src/tools/validation.ts:198`

**问题 A (T-01):** test-framework 的 `genAssertScript` 和 `genStressTestScript` 使用 `_init()` 而非 `_initialize()`。SceneTree 模式下 `_init()` 在节点树未就绪时调用，所有节点查找失败。

**问题 B (T-02):** test-framework 的 `genStressTestScript` 中 `await process_frame` 用空格缩进（应改为 tab）。

**问题 C (T-03):** validation.ts 的 `batchValidateScripts` 也用了 `_init()`。

- [ ] **Step 1: 修复 test-framework.ts — genAssertScript**

将 `_init()` 改为 `_initialize()`，并在方法开头添加 `_mcp_load_main_scene()` 调用：

```typescript
// src/tools/test-framework.ts:141-145 — 修改前:
const script = `${SCENE_TREE_HEADER}

func _init():
\tvar _root = _mcp_get_root()

// 修改后:
const script = `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _root = _mcp_get_root()
```

- [ ] **Step 2: 修复 test-framework.ts — genStressTestScript 的 `_init()` → `_initialize()`**

找到 `genStressTestScript` 函数中的 `func _init():` 替换为 `func _initialize():`，并在之后添加 `_mcp_load_main_scene()` 调用。

- [ ] **Step 3: 修复 test-framework.ts — 缩进错误**

```typescript
// src/tools/test-framework.ts — genStressTestScript 中的 await 行 — 修改前:
\tfor _f in range(3):
        await process_frame

// 修改后:
\tfor _f in range(3):
\t\tawait process_frame
```

将空格缩进改为 tab 缩进（`\t\t` = 2 个 tab，与 for 循环体层级一致）。

- [ ] **Step 4: 修复 validation.ts — batchValidateScripts**

```typescript
// src/tools/validation.ts:198 — 修改前:
'func _init():',

// 修改后:
'func _initialize():',
```

注意：validation.ts 的代码是 `extends SceneTree` + 直接用 `quit()`，不需要 `_mcp_load_main_scene()`（它不需要访问场景节点）。

- [ ] **Step 5: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add src/tools/test-framework.ts src/tools/validation.ts
git commit -m "fix(tools): use _initialize() instead of _init() + fix indentation (T-01/T-02/T-03)"
```

---

## Task 5: T-04/T-05 — 生成的 GDScript 空指针检查

**Files:**
- Modify: `src/tools/physics-ops.ts:51`
- Modify: `src/tools/ik-tools.ts:67`

**问题 A (T-04):** physics-ops 的 `genRaycastScript` 中 `root.get_world_3d()` 未检查返回值是否为 null。在 headless 无 3D 场景时 `.direct_space_state` 崩溃。`genBodyInfoScript` 有类似问题。

**问题 B (T-05):** ik-tools 的 `genIkCreateScript` 中 `ik_node.owner = root` 未对 root 做空检查（理论上 `_initialize()` 时 root 应存在，但防御性编程应加检查）。

- [ ] **Step 1: 修复 physics-ops.ts — genRaycastScript 空指针**

```typescript
// src/tools/physics-ops.ts — genRaycastScript 中的 GDScript 模板 — 修改前:
func _initialize():
\t_mcp_load_main_scene()
\tvar space_state = root.get_world_3d().direct_space_state

// 修改后:
func _initialize():
\t_mcp_load_main_scene()
\tvar _world = root.get_world_3d()
\tif _world == null:
\t\t_mcp_output("error", "No World3D available (scene may not have 3D content)")
\t\t_mcp_done()
\t\treturn
\tvar space_state = _world.direct_space_state
```

- [ ] **Step 2: 修复 physics-ops.ts — genBodyInfoScript 空指针**

找到 `genBodyInfoScript` 中 `root.get_world_3d()` 的使用，添加同样的 null 检查。

- [ ] **Step 3: 修复 ik-tools.ts — owner 设置前 root 检查**

```typescript
// src/tools/ik-tools.ts — genIkCreateScript 中 — 修改前:
\tparent_node.add_child(ik_node)
\tik_node.owner = root

// 修改后:
\tparent_node.add_child(ik_node)
\tvar _root_node = _mcp_get_root()
\tif _root_node != null:
\t\tik_node.owner = _root_node
```

- [ ] **Step 4: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/tools/physics-ops.ts src/tools/ik-tools.ts
git commit -m "fix(tools): add null checks for root/World3D in generated GDScript (T-04/T-05)"
```

---

## Task 6: S-02 + I-03 — 确认令牌完整显示 + 参数键冲突

**Files:**
- Modify: `src/GodotServer.ts:199-205, 228-231`

**问题 A (S-02):** 确认令牌中代码超过 200 字符被截断，用户无法审查将执行的全部内容。

**问题 B (I-03):** 当用户传入 `projectPath` 和 `project_path` 两个不同值时，行为取决于 `Object.entries` 迭代顺序。

- [ ] **Step 1: 移除代码截断**

```typescript
// src/GodotServer.ts:228-231 — 修改前:
const summaryArgs = { ...pending.args };
// Redact potentially large code payloads
if (typeof summaryArgs.code === 'string' && summaryArgs.code.length > 200) {
    summaryArgs.code = summaryArgs.code.substring(0, 200) + '... [truncated]';
}

// 修改后:
const summaryArgs = { ...pending.args };
```

删除截断逻辑的 3 行代码。用户需要看到完整的确认内容。

- [ ] **Step 2: 修复参数键冲突**

```typescript
// src/GodotServer.ts:199-205 — 修改前:
const args: Record<string, unknown> = {};
if (rawArgs) {
    for (const [key, value] of Object.entries(rawArgs)) {
        const snake = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
        args[snake] = value;
        if (snake !== key) args[key] = value;
    }
}

// 修改后:
const args: Record<string, unknown> = {};
if (rawArgs) {
    for (const [key, value] of Object.entries(rawArgs)) {
        const snake = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
        // snake_case takes priority; if both forms exist, camelCase is overwritten
        args[snake] = value;
    }
}
```

只保留 snake_case 版本，避免同一参数两个值不确定行为。

- [ ] **Step 3: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/GodotServer.ts
git commit -m "fix(server): show full code in confirmation + fix param key conflict (S-02, I-03)"
```

---

## Task 7: T-09/T-10 — ui-tools 缩进一致性 + draw_arc 参数

**Files:**
- Modify: `src/tools/ui-tools.ts:119-122, 385-388, 429`

**问题 A (T-09):** ui-tools 混用 tab 和 space 缩进，生成的 GDScript 可能解析失败。

**问题 B (T-10):** Godot 的 `draw_arc` 需要 `point_count` 参数，当前生成的代码缺少该参数。

- [ ] **Step 1: 修复 genUiCreateControlScript 缩进**

```typescript
// src/tools/ui-tools.ts — genUiCreateControlScript 中的 null 检查 — 修改前:
\tvar node = ClassDB.instantiate("${gdEscape(nodeType)}")
        if node == null:
            _mcp_output("error", "Failed to instantiate: ${gdEscape(nodeType)}")
            _mcp_done()
            return

// 修改后:
\tvar node = ClassDB.instantiate("${gdEscape(nodeType)}")
\tif node == null:
\t\t_mcp_output("error", "Failed to instantiate: ${gdEscape(nodeType)}")
\t\t_mcp_done()
\t\treturn
```

将空格替换为 tab 缩进。搜索文件中所有 `\n        if` 模式并替换为 `\n\tif`，以及 `\n            _mcp_` 替换为 `\n\t\t_mcp_`。

- [ ] **Step 2: 修复 genUiContainerAddChildScript 缩进**

同上，在 `genUiContainerAddChildScript` 函数中找到同样的空格缩进并替换为 tab。

- [ ] **Step 3: 修复 draw_arc 缺少 point_count**

```typescript
// src/tools/ui-tools.ts:429 — 修改前:
return `\tdraw_arc(Vector2(${ctr[0]}, ${ctr[1]}), ${r}, ${sa}, ${ea}, ${col(op.color)}${w != null ? `, ${w}` : ''})`;

// 修改后:
const pointCount = op.point_count ?? 32;
return `\tdraw_arc(Vector2(${ctr[0]}, ${ctr[1]}), ${r}, ${sa}, ${ea}, ${pointCount}, ${col(op.color)}${w != null ? `, ${w}` : ''})`;
```

Godot 4.x 的 `draw_arc()` 签名为 `draw_arc(center, radius, start_angle, end_angle, point_count, color, width=-1.0, antialiased=false)`。

- [ ] **Step 4: 在 draw_recipe 的 op 类型定义中添加 point_count**

找到 draw_recipe 操作的参数类型定义（如 interface 或 type），添加 `point_count?: number` 字段。

- [ ] **Step 5: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add src/tools/ui-tools.ts
git commit -m "fix(ui-tools): tab-only indentation + add point_count to draw_arc (T-09/T-10)"
```

---

## Task 8: I-06 — parseConfigValue 空白字符串解析为 0

**Files:**
- Modify: `src/helpers.ts:154-155`

**问题:** `Number(' ')` 返回 0，导致空白字符串配置值被错误解析为数字。

- [ ] **Step 1: 修复空白字符串误判**

```typescript
// src/helpers.ts:154-155 — 修改前:
const num = Number(raw);
if (!isNaN(num) && raw !== '') return num;

// 修改后:
const num = Number(raw);
if (!isNaN(num) && raw.trim() !== '') return num;
```

改用 `raw.trim() !== ''` 确保空白字符串不被解析为数字。

- [ ] **Step 2: 验证构建通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 运行现有测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/helpers.ts
git commit -m "fix(helpers): prevent whitespace strings from parsing as 0 (I-06)"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** 8 CRITICAL (C-01~C-03, T-01~T-05) + 4 IMPORTANT (S-02, I-03, I-06, T-09/T-10) 全部覆盖
- [x] **Placeholder scan:** 无 TBD/TODO/placeholder
- [x] **Type consistency:** 所有修改沿用现有类型签名

## Execution Notes

- 每个 Task 独立可提交，无跨 Task 依赖
- 建议按 Task 1→8 顺序执行（按优先级排列）
- 每个 Task 完成后运行 `npx vitest run` 验证无回归
- 全部完成后运行 `npx tsc --noEmit && npx vitest run` 做最终验证
