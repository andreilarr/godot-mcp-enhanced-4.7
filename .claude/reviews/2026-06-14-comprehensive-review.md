# 综合审查报告：feat/agent-architecture 分支（基于 5e32a1a 的未提交改动）

**审查日期**: 2026-06-14
**审查范围**: `git diff HEAD` 全部 11 个改动文件 + 关联源码逻辑深度审查
**审查方法**: 静态代码分析 + 测试套件全量运行（2573/2573 passed）+ 数据流追踪
**决策**: ❌ **REQUEST CHANGES**（2 项 CRITICAL 阻塞合并）

> **更新（同日）**: CR-1、CR-2、M-1、M-2 已全部修复并经红/绿验证。
> 修复后全量测试 **150 files, 2577 passed, 0 failed**（2573 + 4 新增回归覆盖用例）。
> 详见文末"修复落实"章节。

## 执行摘要

本轮改动是"C 前缀安全/正确性审查修复"批次，包含 7 项修复：
- **1 个关键安全漏洞修复**（C-SEC-1 路径遍历）— ✅ 正确且必须保留
- **1 个沙箱加固**（C-SEC-3 OS 索引访问）— ✅ 正确
- **2 个正确性 bug 修复**（C-BUG-1 shader 语义、C-BUG-2 悬空引用）— ✅ 正确
- **1 个并发重构**（C-CONC-1 findGodot 参数化）— ⚠️ **方向正确但引入 2 个 CRITICAL 回归**
- **fixture/配置/测试**改动 — ✅ 合理

**核心问题**: C-CONC-1 把 `_perCallFindGodot` 实例字段改为局部变量 `findGodotOverride` 沿调用链传递（正确方向，因为 MCP SDK 异步并发派发），但实现有两处缺陷，导致 `godot_path` 参数和多版本 Godot 支持在**所有路径**失效。2573 测试全过是因为该路径完全没有测试覆盖（盲区）。

## 测试验证结果

| 检查项 | 结果 |
|--------|------|
| TypeScript (`tsc`) | ✅ 零错误 |
| 全量测试 (`vitest run`) | ✅ **150 files, 2573 passed, 0 failed**（29.12s）|
| C-SEC-1 测试（4 用例）| ✅ 全过 — 反斜杠/正斜杠遍历被拒，合法路径放行 |
| C-SEC-3 测试（1 用例）| ✅ `OS["execute"]` 被拦截 |
| C-BUG-2 测试（1 用例）| ✅ 悬空引用被重写，所有 ExtResource 引用都有定义 |

> ⚠️ **关键说明**: 2573 测试全过**不能证明无回归**。CR-1/CR-2 的失效路径完全没有测试覆盖，正是它们漏过 CI 的根因。

---

## CRITICAL

### CR-1: 普通调用路径漏传 `findGodotOverride` — `godot_path` 参数全线失效

**文件**: `src/core/ToolDispatcher.ts:336`

C-CONC-1 重构把实例字段改为参数传递，但普通 headless dispatch 调用点遗漏了参数：

```typescript
// 第 299 行 — confirm_and_execute 分支（传了，但有 CR-2 问题）
return this.attachFallbackWarning(
  await this.dispatchTool(pending.toolName, pending.args, startTime, findGodotOverride));

// 第 336 行 — 普通 headless 分支 ❌ 漏传 findGodotOverride
return this.attachFallbackWarning(await this.dispatchTool(name, args, startTime));
```

`dispatchTool`（第 494 行）回退到默认 ctx：
```typescript
const perCallCtx = { ...this.ctx, findGodot: findGodotOverride ?? this.ctx.findGodot };
```

当 `findGodotOverride` 为 `undefined`（普通调用路径），perCallCtx 永远用 `this.ctx.findGodot`，用户传入的 `godot_path` 和基于 `project_path` 的项目感知 findGodot 全部被忽略。

**影响面**（极广）:
- 10 个核心工具的 `godot_path` 参数失效：`run_project`、`execute_gdscript`、`capture_screenshot`、`launch_editor`、`run_tests`、`run_and_verify`、`validate_scripts`、`query_scene_tree`、`inspect_node`、`batch_add_nodes`
- 项目级 Godot 路径配置（`.godot/mcp-godot.json`、`project.godot [godot_mcp]`、`.godot-version` + godots）失效
- v0.18.0 主打的"多版本 Godot 支持"功能形同虚设
- **唯一幸存路径是 `confirm_and_execute`**（删除节点等需确认操作），但它也有 CR-2 问题

**修复**（一行）:
```typescript
// 第 336 行
return this.attachFallbackWarning(
  await this.dispatchTool(name, args, startTime, findGodotOverride));
```

---

### CR-2（新发现，审查报告未覆盖）: confirm_and_execute 路径的 `findGodotOverride` 基于错误的 args

**文件**: `src/core/ToolDispatcher.ts:218-238` + `:299`

**问题**: `findGodotOverride` 在 `executeToolCall` 入口（第 218-238 行）基于 `args` 计算，而 `args` 是**当前调用**的参数。对于 confirm_and_execute 调用，`args` 只包含 `token`（schema 第 122-128 行只声明 `token` 字段）：

```typescript
// confirm_and_execute schema（ToolDispatcher.ts:122-128）
inputSchema: {
  type: 'object',
  properties: { token: { type: 'string', ... } },
  required: ['token'],
}
```

但第 299 行用这个 findGodotOverride 去 dispatch `pending.toolName` + `pending.args`（**原始**工具调用的 args，包含真正的 `godot_path`/`project_path`）：

```typescript
// 第 299 行 — findGodotOverride 基于 confirm_and_execute 的 args（只有 token），
// 但 dispatch 的是 pending.toolName + pending.args（原始工具 args）
return this.attachFallbackWarning(
  await this.dispatchTool(pending.toolName, pending.args, startTime, findGodotOverride));
```

**数据流**:
- 第 218 行 `args.godot_path` → confirm_and_execute 不接受此参数 → **永远 undefined** → 走 else 分支
- 第 219 行 `args.project_path` → confirm_and_execute 的 project_path（由 0.5 默认注入，通常是 cwd 或 env，**非原始工具的 project_path**）
- 第 238 行 `findGodotOverride = () => this.options.findGodot(projectPathForGodot)` — 用错误的 project_path 查找 Godot

**结果**: 即使补上 CR-1 的修复，confirm_and_execute 路径的 `godot_path` 和项目感知 findGodot 仍然失效，因为它们从未基于原始工具的 args 计算。

**影响**: 所有需确认操作（`remove_node`、`save_scene`、`merge_scene`、`write_script`、`execute_gdscript` 等 14 个 guarded action）在多版本 Godot 环境下会调错 Godot 二进制。

**正确修复**: confirm_and_execute 分支应基于 `pending.args` 重新计算 findGodotOverride：
```typescript
// 第 256-299 行 confirm_and_execute 分支内
if (name === 'confirm_and_execute') {
  const token = args.token as string;
  // ... token 校验 ...
  const pending = consumeToken(token);
  // ... pending 校验 ...

  // 基于 pending.args（原始工具 args）重新计算 findGodotOverride
  const pendingGodotOverride = typeof pending.args.godot_path === 'string'
    ? pending.args.godot_path.trim() : undefined;
  const pendingProjectPath = typeof pending.args.project_path === 'string'
    ? pending.args.project_path : undefined;
  let pendingFindGodotOverride: ((p?: string) => Promise<string>) | undefined;
  if (pendingGodotOverride) {
    // 注意：原始调用时已验证过 godot_path（第 229-234 行），token 内 args 可信
    pendingFindGodotOverride = () => Promise.resolve(pendingGodotOverride);
  } else {
    pendingFindGodotOverride = () => this.options.findGodot(pendingProjectPath);
  }

  // ... 二次 guard / path 校验 ...
  return this.attachFallbackWarning(
    await this.dispatchTool(pending.toolName, pending.args, startTime, pendingFindGodotOverride));
}
```

> **安全考量**: 上述修复信任 `pending.args.godot_path` 而不重新执行 `validateGodotBinary`。这是可接受的——原始调用（产生 token 那次）已经过完整验证（第 222-234 行），token 有 3 分钟 TTL 且单次消费（guard.ts:14,139），且 token 生成在服务端（客户端无法伪造）。若追求纵深防御，可在 confirm 分支重新校验，但会增加延迟。

---

## HIGH — 无

## MEDIUM

### M-1: ToolDispatcher 测试盲区（CR-1/CR-2 漏过 CI 的根因）

**文件**: `test/core/ToolDispatcher.test.ts`

`findGodot` override 路径完全没有测试覆盖。56 个用例 mock 掉 `getModuleForTool` 后只断言 `handleTool` 被调用，**从未断言传入工具模块的 `ctx.findGodot`（第 3 个参数）是 override 实现还是默认实现**。

**建议补充 4 个用例**:
1. 普通 headless 调用 + `godot_path` 参数 → 断言 `perCallCtx.findGodot()` 返回 override 值（覆盖 CR-1）
2. `confirm_and_execute` + 原始调用带 `godot_path` → 断言 confirmed dispatch 用 override 值（覆盖 CR-2）
3. 无 `godot_path` 但有 `project_path` → 断言 `findGodot` 被以 project_path 调用（而非无参）
4. 无 `godot_path` 无 `project_path` → 断言 `findGodot` 被以 undefined 调用，回退默认

断言模式示例：
```typescript
const spy = vi.fn().mockResolvedValue('/override/godot');
const ctx = mockModule.handleTool.mock.calls[0][2];
await ctx.findGodot();  // 应触发 override
expect(spy).toHaveBeenCalledWith(/* 预期的 project_path 或 undefined */);
```

### M-2: e2e fixture 缺 `.gitignore` 覆盖

**文件**: `.gitignore`

`test/fixtures/e2e-project/` 当前 untracked，但已包含 Godot 运行时产物（`.godot/imported/`、`.godot/editor/`、`.godot/uid_cache.bin`、`screenshot.png`、`screenshot.png.import`）。现有规则只忽略 `test/e2e-scene/.godot/` 和 `test/e2e-scene/*.png`。一旦执行 `git add test/fixtures/`，这些二进制产物会被全量提交。

**建议**:
```gitignore
# E2E fixture runtime artifacts
test/fixtures/**/.godot/
test/fixtures/**/*.png
test/fixtures/**/*.png.import
```
保留 `project.godot`、`scenes/*.tscn`、`scripts/*.gd` 等源文件。

---

## LOW

### L-1: `.claude/settings.json` 收紧后的开发体验

**文件**: `.claude/settings.json`

移除 `GODOT_MCP_UNRESTRICTED=true` + `ALLOWED_PROJECT_PATHS` 让仓库默认进入 deny-by-default 模式（C-07 设计意图），对其他贡献者更安全 — **合理**。但作者本人的开发工作流需把这两个变量迁移到 `.claude/settings.local.json`（gitignored），否则每次切换 Godot 项目都会因路径不在 cwd 子树被拦截。当前 `.claude/settings.local.json` 只剩 permissions，未含 env — 配置而非代码问题，记录备忘。

### L-2: e2e 测试的 Windows EPERM 清理噪声

**现象**: 测试日志含大量 `[gdscript] retryRm attempt N failed ... EPERM` 重试，最终 `cleanup stale dirs (retryable)`。

**根因**: Windows 上 Godot 进程退出后文件句柄释放有延迟，staging 目录清理在重试 3 次后放弃但记为 "retryable"（非致命）。

**影响**: 测试仍全部通过（不影响结果），但日志噪声大，且 `%TEMP%\godot-mcp-exec\` 会残留 staging 目录。非本次改动引入，记录为既有 Windows 平台限制。

---

## 修复逐项审查

| 编号 | 修复 | 验证结果 |
|------|------|---------|
| **C-SEC-1** | `path-utils.ts:235` `normalize(resolvePath(...))` 消除绝对路径中的 `..` 段 | ✅ **关键安全修复**。修复前 `resolvePath` 对绝对路径原样返回，`root\..\..\Windows\...` 经 `startsWith(ensureSep(root))` 前缀匹配被错误放行。修复后 `normalize` 消除 `..` 与混合分隔符，路径落回 root 外被拒绝。4 个新测试覆盖 Windows 反斜杠/正斜杠变体 + 合法路径 + root 本身。注释明确说明 normalize 不解析符号链接，纵深防御由 `resolveWithinRoot` 的 `realpath` 兜底。|
| **C-SEC-3** | `gdscript-executor.ts:50` 新增 `/\bOS\s*\[/` 拦截索引访问绕过 | ✅ 拦截 `OS["execute"]`、`OS ["execute"]` 等把句点换方括号的简单绕过。沙箱头部注释已诚实声明"非安全边界"。仍可经变量赋值（`var s = OS; s.execute(...)`）绕过，属已记录限制。|
| **C-BUG-1** | `material-ops.ts:448,557` shader 编译语义修正 | ✅ 原代码用 `get_rid().is_valid()` 检查 shader 编译，但这只能确认资源已分配（Godot 4.x headless 无可靠编译验证 API）。修复把误导性的 `"Shader compilation failed"` 改为 `"Shader resource allocation failed"` 并加 `verification_note` 字段提醒 AI 必须经截图/Godot 错误输出人工确认。诚实且有用，下游 `errors.ts`/`delivery.ts` 字段语义未变。|
| **C-BUG-2** | `scene-merge.ts:60-93,129-145` 悬空 ExtResource/SubResource 重写 | ✅ 同 path 不同 id 的 ext_resource 合并时，被丢弃的 theirs 资源对应节点体 `ExtResource("5")` 现正确重写到 ours 最终 id（经 `extIdMap` 解析碰撞后）。还顺手修了原 HEAD 中 theirs sub 入栈时 `seenSubSigs.add()` 缺失的 bug（两个不同新 sub 会被误判重复）。新增测试覆盖悬空引用场景，断言所有 `ExtResource(...)` 引用都有对应 `[ext_resource ...]` 定义。**实现正确，逻辑闭合**。|
| **C-CONC-1** | `ToolDispatcher.ts` findGodot 实例字段改局部变量 | ⚠️ **方向正确但实现有 2 处遗漏** — 见 CR-1（第 336 行）和 CR-2（第 218-299 行）。`_perCallFindGodot` 字段已完全删除无遗留引用；`finally` 清理也一并移除（合理，不再需要）。|
| **fixture 改造** | `e2e-full-tool-verification.test.ts` 默认 fixture 切到仓库内 | ✅ 合理。原默认指向外部 RPG demo，autoload 链会编译失败导致 e2e 不可运行。新 fixture 极简无 autoload，可经 `GODOT_TEST_PROJECT` 覆盖。e2e-full 45 个测试全过。|
| **配置收紧** | `.claude/settings.json` 移除 UNRESTRICTED/ALLOWED | ✅ 见 L-1。|

---

## 修复优先级

**阻塞合并（CRITICAL，必须修复）**:
1. **CR-1** — `ToolDispatcher.ts:336` 补传 `findGodotOverride`（一行改动）
2. **CR-2** — `ToolDispatcher.ts` confirm_and_execute 分支基于 `pending.args` 重算 `findGodotOverride`

**建议同时处理（非阻塞）**:
3. **M-1** — 补充 ToolDispatcher findGodot override 测试覆盖（4 用例，防止未来回归）
4. **M-2** — 更新 `.gitignore`，避免 fixture 运行时产物被误提交

---

## 审查结论

本轮修复包含 **1 个真实的严重安全漏洞修复**（C-SEC-1 路径遍历，**合并前必须保留**）和 **3 个正确的 bug/语义修复**（C-SEC-3、C-BUG-1、C-BUG-2），质量高。

但 C-CONC-1 的并发重构本身引入了 **2 个 CRITICAL 回归**（CR-1 + CR-2），会让 `godot_path` 参数和多版本 Godot 支持在**所有调用路径**失效——普通调用（CR-1）和确认调用（CR-2）无一幸免。讽刺的是，重构本意是修复并发 bug，结果让单线程场景都坏了。

**这两个 bug 未被 2573 个测试发现，因为该路径完全没有测试覆盖（M-1 盲区）。** 建议先修 CR-1/CR-2（共约 15 行改动），再补 M-1 测试，最后方可合并。

**决策: ❌ REQUEST CHANGES**

---

## Files Reviewed

| File | Change Type | 判定 |
|------|------------|------|
| `src/core/ToolDispatcher.ts` | C-CONC-1 findGodot 参数化 | ❌ 含 CR-1 + CR-2 |
| `src/core/path-utils.ts` | C-SEC-1 normalize 前置 | ✅ 正确 |
| `src/gdscript-executor.ts` | C-SEC-3 OS 索引访问拦截 | ✅ 正确 |
| `src/tools/material-ops.ts` | C-BUG-1 shader 编译语义 | ✅ 正确 |
| `src/tools/scene/scene-merge.ts` | C-BUG-2 悬空资源引用重写 | ✅ 正确 |
| `test/security-paths.test.js` | C-SEC-1 测试（4 用例）| ✅ 充分 |
| `test/gdscript-executor.test.js` | C-SEC-3 测试（1 用例）| ✅ 充分 |
| `test/tools/merge-scene.test.ts` | C-BUG-2 测试（1 用例）| ✅ 充分 |
| `test/e2e-full-tool-verification.test.ts` | 默认 fixture 切换 | ✅ 合理 |
| `test/fixtures/e2e-project/` | 极简 e2e fixture（untracked）| ⚠️ 见 M-2 |
| `.claude/settings.json` | 移除 UNRESTRICTED/ALLOWED | ✅ 见 L-1 |
| `.claude/settings.local.json` | 移除 sequential-thinking 权限 | ✅ 无影响 |

---

## 修复落实（2026-06-14 同日执行）

### CR-1 ✅ 已修复并红/绿验证

**文件**: `src/core/ToolDispatcher.ts:328`

```typescript
// ── 5. headless dispatch ──
// CR-1: 必须传入 findGodotOverride,否则 perCallCtx 回退到 this.ctx.findGodot,
// 导致 godot_path 参数和项目感知 findGodot 在最常用路径失效。
return this.attachFallbackWarning(await this.dispatchTool(name, args, startTime, findGodotOverride));
```

**红/绿验证**: 临时回退修复 → FG1 测试失败（`expected '/fake/godot' to be '/custom/godot.exe'`）→ 恢复修复 → 测试通过。

### CR-2 ✅ 已修复并红/绿验证

**文件**: `src/core/ToolDispatcher.ts:265-289`

把 findGodotOverride 计算抽取为独立方法 `resolveFindGodotOverride(args)`，在 confirm_and_execute 分支内基于 `pending.args`（原始工具 args）重新调用：

```typescript
// CR-2: 基于 pending.args(原始工具 args)重新计算 findGodotOverride,而非复用入口处
// 基于 confirm_and_execute 自身 args(只有 token)算出的 override。
const { override: confirmedFindGodotOverride, error: confirmedFindGodotErr } =
  await this.resolveFindGodotOverride(pending.args);
if (confirmedFindGodotErr) return confirmedFindGodotErr;
// ...
return this.attachFallbackWarning(await this.dispatchTool(pending.toolName, pending.args, startTime, confirmedFindGodotOverride));
```

**红/绿验证**: 临时回退为入口处 findGodotOverride → FG3 测试失败（`expected '/fake/godot' to be '/pending/godot.exe'`）→ 恢复修复 → 测试通过。

**安全考量**: confirm 分支不重新执行 `validateGodotBinary`。这是可接受的——产生 token 的那次调用已完整验证 godot_path（第 229-234 行），token 有 3min TTL + 单次消费 + 服务端生成，客户端无法伪造。

### M-1 ✅ 已补充 4 个回归覆盖测试

**文件**: `test/core/ToolDispatcher.test.ts`（新增 describe 块 `findGodot override propagation (CR-1/CR-2)`）

| 用例 | 覆盖 | 断言 |
|------|------|------|
| FG1 | CR-1 普通 headless + godot_path | `ctx.findGodot()` 返回 `/custom/godot.exe` |
| FG2 | CR-1 普通 headless + project_path | `findGodot` 以 `/explicit/project` 调用 |
| FG3 | CR-2 confirm_and_execute + pending.args.godot_path | `ctx.findGodot()` 返回 `/pending/godot.exe` |
| FG4 | 无 godot_path 无 project_path | `findGodot` 以 `undefined` 调用 |

新增 `godot-finder` mock（`mockValidateGodotBinary`），支持 godot_path 校验路径测试。

### M-2 ✅ 已更新 .gitignore

**文件**: `.gitignore`

```gitignore
# M-2: E2E fixture 运行时产物(Godot 编辑器/导入缓存/截图)—— 保留 project.godot 等源文件
test/fixtures/**/.godot/
test/fixtures/**/*.png
test/fixtures/**/*.png.import
```

经 `git check-ignore` 验证：`.godot/imported/`、`screenshot.png`、`screenshot.png.import` 被正确忽略；`project.godot`、`scenes/*.tscn`、`scripts/*.gd` 等源文件不被忽略。

### 最终验证结果

| 检查项 | 结果 |
|--------|------|
| TypeScript (`tsc --noEmit`) | ✅ 零错误 |
| 全量测试 (`vitest run`) | ✅ **150 files, 2577 passed, 0 failed**（原 2573 + 新增 4）|
| CR-1 红/绿验证 | ✅ 回退→FG1/FG2/FG4 失败；恢复→全过 |
| CR-2 红/绿验证 | ✅ 回退→FG3 失败；恢复→全过 |
| M-2 git check-ignore | ✅ 运行时产物被忽略，源文件保留 |

**决策: ✅ APPROVED**（所有 CRITICAL + MEDIUM 项已修复并验证）
