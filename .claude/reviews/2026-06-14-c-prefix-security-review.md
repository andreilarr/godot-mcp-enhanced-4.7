# Local Review: C 前缀安全/正确性审查修复

**Reviewed**: 2026-06-14
**Branch**: feat/agent-architecture (uncommitted on top of 5e32a1a)
**Decision**: ❌ REQUEST CHANGES（1 项 CRITICAL 阻塞合并）

## Summary

7 项 C 前缀修复（1 关键安全漏洞 + 2 正确性修复 + 1 沙箱加固 + 1 fixture 改造 + 2 测试补充）。审查中发现 C-CONC-1 重构本身引入了一个 P0 级功能回归：普通 headless 调用路径遗漏传入 `findGodotOverride`，导致 `godot_path` 参数和项目感知 findGodot 对绝大多数工具失效。其余修复质量高。2553 测试通过，但测试套件存在盲区未覆盖该回归。

## Findings

### CRITICAL

#### CR-1: C-CONC-1 重构导致 `godot_path` 在普通调用路径失效

**文件**: `src/core/ToolDispatcher.ts:336`

**问题**:
C-CONC-1 把实例字段 `_perCallFindGodot` 改为参数 `findGodotOverride` 沿调用链显式传递（正确方向 —— MCP SDK 经 `Promise.resolve().then(handler)` 异步派发多个 `tools/call`，请求并发执行，实例字段会被互相覆盖）。

但重构遗漏了普通 headless dispatch 调用点：

```typescript
// 第 299 行 — confirm_and_execute 分支 ✅ 正确传参
return this.attachFallbackWarning(
  await this.dispatchTool(pending.toolName, pending.args, startTime, findGodotOverride));

// 第 336 行 — 普通 headless 分支 ❌ 漏传 findGodotOverride！
return this.attachFallbackWarning(await this.dispatchTool(name, args, startTime));
```

`dispatchTool` 第 495 行回退到默认 ctx：
```typescript
const perCallCtx = { ...this.ctx, findGodot: findGodotOverride ?? this.ctx.findGodot };
```
当 `findGodotOverride` 为 `undefined` 时（普通调用路径），perCallCtx 总是用 `this.ctx.findGodot`，用户传入的 `godot_path` 和基于 `project_path` 的 findGodot 全部被忽略。

**影响面**（极广）:
- 10 个核心工具的 `godot_path` 参数失效：`run_project`、`execute_gdscript`、`capture_screenshot`、`launch_editor`、`run_tests`、`run_and_verify`、`validate_scripts`、`query_scene_tree`、`inspect_node`、`batch_add_nodes`
- 项目级 Godot 路径配置（`.godot/mcp-godot.json`、`project.godot [godot_mcp]`、`.godot-version` + godots）失效 —— 因为项目感知分支 `findGodotOverride = () => this.options.findGodot(projectPathForGodot)` 的计算结果在普通调用路径被丢弃
- 所有运行时工具的 40+ 处 `ctx.findGodot()` 调用退回到全局 `findGodot()`
- v0.18.0 主打的"多版本 Godot 支持"功能形同虚设
- 唯一幸存路径是 `confirm_and_execute`（删除节点等需确认操作），因为它正确传入了参数

**复现**:
临时测试（审查后已删除）断言普通调用路径的 `ctx.findGodot()` 应返回用户传入的 `/custom/godot.exe` —— FAIL，返回默认值 `/default/godot`。confirm_and_execute 路径 PASS。

**修复**（一行）:
```typescript
// 第 336 行
return this.attachFallbackWarning(
  await this.dispatchTool(name, args, startTime, findGodotOverride));
```

### HIGH — None

### MEDIUM

#### M-1: ToolDispatcher 测试盲区

**文件**: `test/core/ToolDispatcher.test.ts`

**问题**:
`findGodot` override 路径完全没有测试覆盖。`ToolDispatcher.test.ts` 共 56 个用例，mock 掉 `getModuleForTool` 后只断言 `handleTool` 被调用，**从未断言传入工具模块的 `ctx.findGodot` 是 override 实现还是默认实现**。这正是 CR-1 漏过 CI 的根因。

**建议**: 补充 3 个用例：
1. 普通 headless 调用 + `godot_path` 参数 → 断言 `perCallCtx.findGodot()` 返回 override 值
2. `confirm_and_execute` + `godot_path` 参数 → 同上
3. 无 `godot_path` 但有 `project_path` → 断言 `findGodot` 被以 project_path 调用（而非无参）

#### M-2: e2e fixture 缺 `.gitignore` 覆盖

**文件**: `.gitignore`

**问题**:
`test/fixtures/e2e-project/` 当前是 untracked，但 fixture 内已包含 Godot 运行时产物（`.godot/imported/`、`.godot/uid_cache.bin`、`.godot/editor/`）。现有规则只忽略 `test/e2e-scene/.godot/`。一旦执行 `git add test/fixtures/`，这些二进制产物会被全量提交。

**建议**:
```
test/fixtures/**/.godot/
test/fixtures/**/*.png.import
test/fixtures/**/*.uid
```
保留 `project.godot`、`scenes/*.tscn`、`scripts/*.gd` 等源文件。

### LOW

#### L-1: `.claude/settings.json` 收紧后的开发体验

**文件**: `.claude/settings.json`

移除 `GODOT_MCP_UNRESTRICTED=true` + `ALLOWED_PROJECT_PATHS` 让仓库默认进入 deny-by-default 模式（C-07 的设计意图），对其他贡献者更安全 —— **合理**。但作者本人的开发工作流需把这两个变量迁移到 `.claude/settings.local.json`（gitignored），否则每次切换 Godot 项目都会因路径不在 cwd 子树被拦截。这是配置而非代码问题，记录备忘。

## 修复逐项审查

| 编号 | 修复 | 验证结果 |
|------|------|---------|
| **C-SEC-1** | `path-utils.ts:235` `normalize(resolvePath(...))` 消除绝对路径中的 `..` 段 | ✅ **关键安全修复**。修复前 `resolvePath` 对绝对路径原样返回，`root\..\..\Windows\...` 经 `startsWith(ensureSep(root))` 前缀匹配被错误放行。修复后 `normalize` 消除 `..` 与混合分隔符，路径落回 root 外被拒绝。4 个新测试覆盖 Windows 反斜杠/正斜杠变体 + 合法路径 + root 本身。注释明确说明 normalize 不解析符号链接，符号链接纵深防御由 `resolveWithinRoot` 的 `realpath` 检查兜底。 |
| **C-SEC-3** | `gdscript-executor.ts:50` 新增 `/\bOS\s*\[/` 拦截索引访问绕过 | ✅ 拦截 `OS["execute"]`、`OS ["execute"]` 等把句点换方括号的简单绕过。沙箱头部已声明"不是安全边界"，此修复符合其声称范围。注意仍可经变量赋值（`var s = OS; s.execute(...)`）绕过 —— 但这属于已记录的限制，C-SEC-3 只堵最简单的字符串替换。 |
| **C-BUG-1** | `material-ops.ts` shader 编译语义修正 | ✅ 原代码用 `get_rid().is_valid()` 检查 shader 编译，但这只能确认 shader 资源已分配，与编译能否通过无关（Godot 4.x headless 无可靠编译验证 API）。修复把误导性的 `"Shader compilation failed"` 改为 `"Shader resource allocation failed"` 并加 `verification_note` 字段提醒 AI 必须经截图/Godot 错误输出人工确认。诚实且有用，下游消费方（`errors.ts`、`delivery.ts`）字段语义未变。 |
| **C-BUG-2** | `scene-merge.ts:60-93, 129-145` 悬空 ExtResource/SubResource 重写 | ✅ 同 path 不同 id 的 ext_resource 合并时，被丢弃的 theirs 资源对应的节点体 `ExtResource("5")` 现在能被正确重写到 ours 的最终 id（经 `extIdMap` 解析碰撞后）。还顺手修了原 HEAD 中 theirs sub 入栈时 `seenSubSigs.add()` 缺失的 bug（两个不同新 sub 会被误判重复）。新增测试覆盖悬空引用场景，断言所有 `ExtResource(...)` 引用都有对应 `[ext_resource ...]` 定义。 |
| **C-CONC-1** | `ToolDispatcher.ts` findGodot 实例字段改局部变量 | ⚠️ **方向正确但实现有遗漏** —— 见 CR-1。`_perCallFindGodot` 字段已完全删除，无遗留引用；`finally { this._perCallFindGodot = null }` 清理也一并移除（合理，因为不再需要）。但第 336 行普通 dispatch 调用点漏传参数，导致 `godot_path` 和项目感知 findGodot 全线失效。 |
| **fixture 改造** | `e2e-full-tool-verification.test.ts` 默认 fixture 切到仓库内 | ✅ 合理。原默认指向外部 RPG demo（`D:/workspace/projects/godot-test-project`），其 autoload 链会编译失败导致 e2e 不可运行。新 fixture 是极简无 autoload 项目，可经 `GODOT_TEST_PROJECT` 覆盖。e2e-full 45 个测试全过。 |
| **配置收紧** | `.claude/settings.json` 移除 UNRESTRICTED/ALLOWED | ✅ 见 L-1。 |

## Validation Results

| Check | Result |
|---|---|
| TypeScript (`tsc`) | ✅ Pass — 零错误 |
| ESLint (`eslint src/`) | ✅ Pass — 0 errors, 1 warning（`script.ts:201` no-useless-assignment，pre-existing，与本次修改无关） |
| Unit Tests | ✅ Pass — 147 files, 2497 tests, 0 failures（排除 e2e） |
| E2E (`e2e-full-tool-verification`) | ✅ Pass — 45 tests, 0 failures |
| E2E (`e2e-p1-p5`) | ✅ Pass — 11 tests, 0 failures |
| **总测试** | ✅ **2553 passed, 0 failed** |
| 复现测试（CR-1） | ❌ **1 failed** —— 普通调用路径 `ctx.findGodot()` 返回 `/default/godot` 而非用户传入的 `/custom/godot.exe`（审查后已删除临时测试） |

**关键说明**: 2553 测试全过并不能证明无回归 —— CR-1 的失效路径完全没有测试覆盖，这正是 M-1 的根因。

## 发现汇总

| 严重度 | 数量 |
|--------|------|
| CRITICAL | 1（CR-1） |
| HIGH | 0 |
| MEDIUM | 2（M-1 测试盲区、M-2 .gitignore） |
| LOW | 1（L-1 配置迁移备忘） |

## 审查结论

本轮修复包含 1 个真实的严重安全漏洞修复（C-SEC-1 路径遍历，**合并前必须保留**）和 3 个正确的 bug 修复，但 C-CONC-1 的并发重构本身又引入了一个会让 `godot_path` 参数和多版本 Godot 支持完全失效的 P0 回归。

**阻塞条件（须满足后方可合并）**:
1. 修复 `src/core/ToolDispatcher.ts:336` —— 补传 `findGodotOverride` 参数（一行改动）
2. 按 M-1 补充 ToolDispatcher 测试覆盖（防止未来再次回归）

**建议同时处理（非阻塞）**:
3. 按 M-2 更新 `.gitignore`，避免 fixture 运行时产物被误提交

**决策: ❌ REQUEST CHANGES**

## Files Reviewed

| File | Change Type |
|------|------------|
| `src/core/ToolDispatcher.ts` | Modified — C-CONC-1 findGodot 参数化（含 CR-1 遗漏） |
| `src/core/path-utils.ts` | Modified — C-SEC-1 normalize 前置 |
| `src/gdscript-executor.ts` | Modified — C-SEC-3 OS 索引访问拦截 + 沙箱头部注释重写 |
| `src/tools/material-ops.ts` | Modified — C-BUG-1 shader 编译语义 |
| `src/tools/scene/scene-merge.ts` | Modified — C-BUG-2 悬空资源引用重写 |
| `test/security-paths.test.js` | Modified — C-SEC-1 测试（4 用例） |
| `test/gdscript-executor.test.js` | Modified — C-SEC-3 测试（1 用例） |
| `test/tools/merge-scene.test.ts` | Modified — C-BUG-2 测试（1 用例） |
| `test/e2e-full-tool-verification.test.ts` | Modified — 默认 fixture 切换 |
| `test/fixtures/e2e-project/` | Added — 极简 e2e fixture（untracked） |
| `.claude/settings.json` | Modified — 移除 UNRESTRICTED/ALLOWED |
| `.claude/settings.local.json` | Modified — 移除 sequential-thinking 权限 |
