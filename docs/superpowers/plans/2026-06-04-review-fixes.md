# 审查修复实施计划（CRITICAL + IMPORTANT + ESLint ADVISORY）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-06-04 审查报告中的 2 个 CRITICAL + 4 个 IMPORTANT + 2 个 ESLint ADVISORY 发现

**Architecture:** 每个修复独立、原子化，不涉及跨模块重构。按审查优先级排序，每个 Task 修复一个发现。

**Tech Stack:** TypeScript (strict), Vitest

---

## 文件变更映射

| 文件 | 变更类型 | 修复项 |
|------|---------|--------|
| `src/tools/shared.ts` | 修改 1 行 | C-01 GDScript 缩进 |
| `src/tools/scene.ts` | 修改 4 处 | C-02 spawn slot 泄漏 |
| `src/helpers.ts` | 修改 1 行 | I-01 re-throw cause |
| `src/core/ToolDispatcher.ts` | 修改 1 行 | I-02 冗余 duration2 |
| `src/tools/delivery.ts` | 修改 2 行 | I-03 路径白名单绕过 |
| `src/dashboard/ui.ts` | 修改 2 行 | A-01 unused import + A-02 control regex |

---

### Task 1: [CRITICAL] 修复 GDScript 模板缩进错误

**文件:**
- Modify: `src/tools/shared.ts:350`

`SCENE_TREE_HEADER` 中 `_mcp_get_scene_node` 函数的 `return _mcp_scene_instance` 缩进与 `if _p == "":` 同级，导致 return 始终执行（跳过子节点查找）。

- [ ] **Step 1: 修复缩进**

将第 350 行的 `'		return _mcp_scene_instance'`（2 个 tab）改为 3 个 tab：

```
src/tools/shared.ts:350
旧: '		return _mcp_scene_instance'
新: '			return _mcp_scene_instance'
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 3: 运行相关测试**

Run: `npx vitest run test/helpers.test.js test/godot-server.test.js`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/tools/shared.ts
git commit -m "fix(critical): GDScript _mcp_get_scene_node indentation — return was always executing

The return statement was at same indent level as the if guard, causing
_mcp_get_scene_node to always return the scene root instead of looking
up child nodes by path. Fixes headless scene tree queries."
```

---

### Task 2: [CRITICAL] 修复 spawn() 同步异常导致 slot 永久泄漏

**文件:**
- Modify: `src/tools/scene.ts` — 4 处 spawn 调用

`spawn()` 可能在同步阶段抛出（如 EMFILE），此时 `releaseShortRunningSlot()` 永远不会被调用。3 个 slot 全部泄漏后服务需要重启。

4 处需要修复的位置：
1. **~L179** — `create_scene`/`add_node`/`save_scene`/`load_sprite` 共享的 spawn
2. **~L327** — `query_scene_tree` 的 spawn
3. **~L394** — `inspect_node` 的 spawn
4. **~L477** — `batch_add_nodes` 的 spawn

- [ ] **Step 1: 修复第 1 处（~L178-219）**

将 `const proc = spawn(...)` 改为 try/catch 包裹：

```typescript
// 旧代码（~L178-183）:
return new Promise((resolve) => {
  const proc = spawn(godot, [
    '--headless', '--path', p,
    '--script', ctx.opsScript,
    action, JSON.stringify(params),
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

// 新代码:
return new Promise((resolve) => {
  let proc: ChildProcess;
  try {
    proc = spawn(godot, [
      '--headless', '--path', p,
      '--script', ctx.opsScript,
      action, JSON.stringify(params),
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
  } catch (spawnErr) {
    releaseShortRunningSlot();
    resolve(opsErrorResult('SPAWN_FAILED', `Failed to spawn Godot: ${(spawnErr as Error).message}`));
    return;
  }
```

注意：后续代码中 `proc` 已变为 `let`，所有 `proc.stdout?.on`、`proc.on` 等回调不变。

- [ ] **Step 2: 修复第 2 处（~L324-362 query_scene_tree）**

```typescript
// 旧代码（~L324-331）:
return new Promise((resolve) => {
  let out = '';
  let settled = false;
  const proc = spawn(godot, [
    '--headless', '--path', p,
    '--script', treeScript,
    JSON.stringify(params),
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

// 新代码:
return new Promise((resolve) => {
  let out = '';
  let settled = false;
  let proc: ChildProcess;
  try {
    proc = spawn(godot, [
      '--headless', '--path', p,
      '--script', treeScript,
      JSON.stringify(params),
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
  } catch (spawnErr) {
    releaseShortRunningSlot();
    resolve(textResult(`SPAWN_FAILED: ${(spawnErr as Error).message}`));
    return;
  }
```

- [ ] **Step 3: 修复第 3 处（~L391-429 inspect_node）**

```typescript
// 旧代码（~L391-398）:
return new Promise((resolve) => {
  let out = '';
  let settled = false;
  const proc = spawn(godot, [
    '--headless', '--path', p,
    '--script', inspectScript,
    JSON.stringify(params),
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

// 新代码:
return new Promise((resolve) => {
  let out = '';
  let settled = false;
  let proc: ChildProcess;
  try {
    proc = spawn(godot, [
      '--headless', '--path', p,
      '--script', inspectScript,
      JSON.stringify(params),
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
  } catch (spawnErr) {
    releaseShortRunningSlot();
    resolve(textResult(`SPAWN_FAILED: ${(spawnErr as Error).message}`));
    return;
  }
```

- [ ] **Step 4: 修复第 4 处（~L476-520 batch_add_nodes）**

```typescript
// 旧代码（~L476-484）:
return new Promise((resolve) => {
  const proc = spawn(godot, [
    '--headless', '--path', p,
    '--script', ctx.opsScript,
    'batch_add_nodes', JSON.stringify({
      scene_path: scenePath,
      nodes: nodes,
    }),
  ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

// 新代码:
return new Promise((resolve) => {
  let proc: ChildProcess;
  try {
    proc = spawn(godot, [
      '--headless', '--path', p,
      '--script', ctx.opsScript,
      'batch_add_nodes', JSON.stringify({
        scene_path: scenePath,
        nodes: nodes,
      }),
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
  } catch (spawnErr) {
    releaseShortRunningSlot();
    resolve(errorResult(`SPAWN_FAILED: ${(spawnErr as Error).message}`));
    return;
  }
```

- [ ] **Step 5: 确认 ChildProcess 类型已导入**

检查 `scene.ts` 顶部的 import，确保有：
```typescript
import { spawn, type ChildProcess } from 'node:child_process';
```

如果只有 `spawn`，需添加 `type ChildProcess`。

- [ ] **Step 6: 验证编译 + 测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 零编译错误，全部测试通过

- [ ] **Step 7: 提交**

```bash
git add src/tools/scene.ts
git commit -m "fix(critical): wrap spawn() in try/catch to prevent slot leak on EMFILE

spawn() can throw synchronously (e.g. EMFILE). Without try/catch,
releaseShortRunningSlot() is never called, permanently leaking the slot.
After 3 leaks, all headless operations return CONCURRENCY_LIMIT until
server restart. Apply to all 4 spawn sites in scene.ts."
```

---

### Task 3: [IMPORTANT] 修复 re-throw 未保留原始 cause

**文件:**
- Modify: `src/helpers.ts:52`

- [ ] **Step 1: 添加 cause 选项**

```typescript
// 旧代码（~L51-52）:
try { resolvedAncestor = realpathSync(current); } catch (err) {
  throw new Error(`Cannot resolve real path for "${current}" (component of "${p}"): ${err instanceof Error ? err.message : err}`);
}

// 新代码:
try { resolvedAncestor = realpathSync(current); } catch (err) {
  throw new Error(`Cannot resolve real path for "${current}" (component of "${p}"): ${err instanceof Error ? err.message : err}`, { cause: err });
}
```

- [ ] **Step 2: 验证编译 + ESLint**

Run: `npx tsc --noEmit && npx eslint src/helpers.ts`
Expected: `preserve-caught-error` 错误消失

- [ ] **Step 3: 提交**

```bash
git add src/helpers.ts
git commit -m "fix: attach cause to re-thrown error in safeRealPath fallback"
```

---

### Task 4: [IMPORTANT] 修复 ToolDispatcher 冗余 duration2

**文件:**
- Modify: `src/core/ToolDispatcher.ts:332-333`

- [ ] **Step 1: 复用 duration 变量**

```typescript
// 旧代码（~L326-333）:
const duration = Date.now() - startTime;

if (result !== null) {
  const hasError = result.isError === true;
  logger.toolEnd(callId, toolName, duration, hasError ? 'tool_error' : undefined);
  const duration2 = Date.now() - startTime;
  return { ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration2}` }] };
}

// 新代码:
const duration = Date.now() - startTime;

if (result !== null) {
  const hasError = result.isError === true;
  logger.toolEnd(callId, toolName, duration, hasError ? 'tool_error' : undefined);
  return { ...result, content: [...result.content, { type: 'text' as const, text: `_duration_ms: ${duration}` }] };
}
```

- [ ] **Step 2: 验证编译 + 测试**

Run: `npx tsc --noEmit && npx vitest run test/tool-dispatcher.test.js`
Expected: 零错误，测试通过

- [ ] **Step 3: 提交**

```bash
git add src/core/ToolDispatcher.ts
git commit -m "fix: reuse duration variable instead of recomputing duration2 in dispatchTool"
```

---

### Task 5: [IMPORTANT] delivery.ts 使用 requireProjectPath 替代 validatePath

**文件:**
- Modify: `src/tools/delivery.ts:5` (import)
- Modify: `src/tools/delivery.ts:203` (usage)

- [ ] **Step 1: 更新 import + 调用**

```typescript
// 旧代码 (line 5):
import { validatePath, resolveWithinRoot } from '../helpers.js';

// 新代码:
import { requireProjectPath, resolveWithinRoot } from '../helpers.js';
```

```typescript
// 旧代码 (line 203):
const projectPath = validatePath(args.project_path);

// 新代码:
const projectPath = requireProjectPath(args);
```

- [ ] **Step 2: 验证编译 + 测试**

Run: `npx tsc --noEmit && npx vitest run test/delivery.test.js`
Expected: 零错误，测试通过

- [ ] **Step 3: 提交**

```bash
git add src/tools/delivery.ts
git commit -m "fix: use requireProjectPath in delivery.ts for path whitelist validation"
```

---

### Task 6: [ADVISORY] 清理 ui.ts ESLint 错误

**文件:**
- Modify: `src/dashboard/ui.ts:5` (删除 unused import)
- Modify: `src/dashboard/ui.ts:55` (suppress control-regex)

- [ ] **Step 1: 删除 unused LogEntry import + suppress control-regex**

```typescript
// 旧代码 (line 5-6):
import type { LogEntry } from '../core/logger.js';
import type { DashboardState, ToolStats } from './aggregator.js';

// 新代码:
import type { DashboardState, ToolStats } from './aggregator.js';
```

```typescript
// 旧代码 (line 55):
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

// 新代码:
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
```

- [ ] **Step 2: 验证 ESLint 清零**

Run: `npx eslint src/dashboard/ui.ts src/helpers.ts`
Expected: 零错误

- [ ] **Step 3: 提交**

```bash
git add src/dashboard/ui.ts
git commit -m "fix(eslint): remove unused LogEntry import + suppress intentional control-regex in ui.ts"
```

---

### Task 7: 最终验证

- [ ] **Step 1: 全量编译 + ESLint + 测试**

Run: `npx tsc --noEmit && npx eslint src/ && npx vitest run`
Expected: 全部零错误，全部测试通过

- [ ] **Step 2: 确认 ESLint 清零**

Run: `npx eslint src/ 2>&1 | tail -5`
Expected: 无 error 行（仅可能有 warning）

- [ ] **Step 3: 汇总提交**

如果前面 6 个 Task 都已独立提交，此步骤仅验证无需额外提交。如果有未提交的变更，统一提交：

```bash
git add -A
git commit -m "chore: review fixes — 2 CRITICAL + 4 IMPORTANT + 2 ESLint ADVISORY"
```
