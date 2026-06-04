# v0.15.1 审查高优先级修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 v0.15.1 审查报告中的 4 个高优先级问题：环境变量安全绕过标注、readOnly 默认拒绝、输出上限缺失、进程终止/并发控制。

**Architecture:** 最小侵入式修复——不改变现有 API 契约，只在关键点增加防护和标注。每个 Task 独立可测，互不依赖。

**Tech Stack:** TypeScript, Vitest, Node.js child_process

---

## Task 1: [C-01/C-02] 环境变量安全绕过 — 日志标注 + 文档化

**Files:**
- Modify: `src/helpers.ts:178`
- Modify: `src/gdscript-executor.ts:46, 469`
- Test: `test/helpers.test.js`（已有，需添加新用例）

**背景:** `GODOT_MCP_UNRESTRICTED` 和 `GODOT_MCP_SANDBOX` 是已承认的设计权衡。不做移除（会破坏用户），但需在运行时留下明确审计痕迹。

- [ ] **Step 1: 在 `isPathInAllowedRoots` 中添加 console.warn**

```typescript
// src/helpers.ts:178 — 替换原行
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') {
    console.warn('[SECURITY] GODOT_MCP_UNRESTRICTED=true — all path restrictions bypassed');
    return true;
  }
```

- [ ] **Step 2: 在 `scanGdscriptSandbox` 中添加 console.warn**

```typescript
// src/gdscript-executor.ts:46 — 替换原行
export function scanGdscriptSandbox(code: string): string[] {
  if (process.env.GODOT_MCP_SANDBOX === 'disabled') {
    console.warn('[SECURITY] GODOT_MCP_SANDBOX=disabled — sandbox scanning skipped');
    return [];
  }
```

- [ ] **Step 3: 在沙箱阻断处添加 bypassed 标记到返回值**

```typescript
// src/gdscript-executor.ts:468-475 — 替换 sandboxWarnings 检查块
  const sandboxWarnings = options._skipSandbox ? [] : scanGdscriptSandbox(code);
  if (sandboxWarnings.length > 0 && process.env.GODOT_MCP_ALLOW_UNSAFE !== 'true') {
    return {
      success: false, compile_success: false,
      compile_error: `Sandbox violation: code contains dangerous patterns. Set GODOT_MCP_ALLOW_UNSAFE=true to override.\n${sandboxWarnings.join('\n')}`,
      errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0,
      sandbox_warnings: sandboxWarnings,
    };
  }
```

注意：`sandbox_warnings` 字段需添加到 `ExecutionResult` 接口定义中（约第 58-82 行），添加 `sandbox_warnings?: string[]`。

同时在 `executeGdscript` 函数中，当 `sandboxWarnings.length > 0 && GODOT_MCP_ALLOW_UNSAFE === 'true'` 时（即被绕过但继续执行），也添加 console.warn：

```typescript
  if (sandboxWarnings.length > 0 && process.env.GODOT_MCP_ALLOW_UNSAFE === 'true') {
    console.warn('[SECURITY] GODOT_MCP_ALLOW_UNSAFE=true — executing despite sandbox warnings:', sandboxWarnings);
  }
```

- [ ] **Step 4: 运行相关测试确认通过**

```bash
npx vitest run test/helpers.test.js test/gdscript-executor.test.js test/gdscript-executor-mock.test.js
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/helpers.ts src/gdscript-executor.ts
git commit -m "fix: 添加环境变量安全绕过的审计日志和 sandbox_warnings 字段 (C-01/C-02)"
```

---

## Task 2: [I-08] readOnly 模式对未注册工具默认拒绝

**Files:**
- Modify: `src/core/tool-registry.ts:51-53`
- Test: `test/core/tool-registry.test.js`（需确认已有或新建）

- [ ] **Step 1: 确认 tool-registry 测试文件存在**

```bash
ls test/core/tool-registry.test.* test/tool-registry.test.* 2>nul
```

如果不存在，跳到 Step 2 创建。如果存在，查看当前测试覆盖。

- [ ] **Step 2: 写测试 — 未注册工具在 readOnly 模式下应返回 true（只读=被阻止）**

```javascript
// test/core/tool-registry.test.js — 如果文件已存在则追加 describe 块
import { describe, it, expect, beforeEach } from 'vitest';
import { registerToolModule, isReadOnly, clearRegistry } from '../../src/core/tool-registry.js';

describe('tool-registry isReadOnly', () => {
  beforeEach(() => { clearRegistry(); });

  it('已注册的 readonly 工具返回 true', () => {
    registerToolModule({
      getToolDefinitions: () => [{ name: 'readonly_tool', description: 'test', inputSchema: {} }],
      handleTool: async () => null,
      TOOL_META: { readonly: true, long_running: false },
    });
    expect(isReadOnly('readonly_tool')).toBe(true);
  });

  it('已注册的 writable 工具返回 false', () => {
    registerToolModule({
      getToolDefinitions: () => [{ name: 'write_tool', description: 'test', inputSchema: {} }],
      handleTool: async () => null,
      TOOL_META: { readonly: false, long_running: false },
    });
    expect(isReadOnly('write_tool')).toBe(false);
  });

  it('未注册工具默认返回 true（安全默认拒绝）', () => {
    expect(isReadOnly('unknown_tool_xyz')).toBe(true);
  });
});
```

注意：需要确认 `clearRegistry` 是否已导出。如果没有，需要添加：

```typescript
// src/core/tool-registry.ts — 添加导出函数
export function clearRegistry(): void {
  metaRegistry.clear();
}
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run test/core/tool-registry.test.js
```

Expected: `未注册工具默认返回 true` 用例 FAIL（当前返回 false）

- [ ] **Step 4: 修改 isReadOnly 默认返回值为 true**

```typescript
// src/core/tool-registry.ts:52 — 替换
export function isReadOnly(name: string): boolean {
  return metaRegistry.get(name)?.readonly ?? true;
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run test/core/tool-registry.test.js
```

Expected: 全部 PASS

- [ ] **Step 6: 运行全量测试确认无回归**

```bash
npx vitest run
```

Expected: 全部 PASS（1486+ 用例）

- [ ] **Step 7: Commit**

```bash
git add src/core/tool-registry.ts test/core/tool-registry.test.js
git commit -m "fix: readOnly 模式对未注册工具默认拒绝 — 安全默认值改为 true (I-08)"
```

---

## Task 3: [I-04] query_scene_tree / inspect_node 添加输出上限

**Files:**
- Modify: `src/tools/scene.ts:305-306, 365-366`
- Test: `test/tools/scene.test.js`（已有，需确认）

- [ ] **Step 1: 为 query_scene_tree 添加 MAX_OUTPUT 限制**

当前代码（第 297-306 行）：
```typescript
let out = '';
// ...
proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
```

替换为：
```typescript
let out = '';
const MAX_OUTPUT = 100_000;
// ...
proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
```

这与文件中 `create_scene`（第 165-167 行）和 `read_scene`（第 446-448 行）的模式完全一致。

- [ ] **Step 2: 为 inspect_node 添加同样的 MAX_OUTPUT 限制**

找到 inspect_node 的 stdout/stderr 处理（约第 365-366 行），应用相同模式：

```typescript
let out = '';
const MAX_OUTPUT = 100_000;
// ...
proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
```

- [ ] **Step 3: 运行场景相关测试确认无回归**

```bash
npx vitest run test/tools/scene.test.js
```

Expected: 全部 PASS

- [ ] **Step 4: 运行全量测试**

```bash
npx vitest run
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/scene.ts
git commit -m "fix: 为 query_scene_tree 和 inspect_node 添加 100KB 输出上限 (I-04)"
```

---

## Task 4: [I-05] run_tests 进程终止和并发控制 + [I-06] get_godot_version 超时

**Files:**
- Modify: `src/tools/runtime.ts:1-8`（imports）
- Modify: `src/tools/runtime.ts:198-260`（run_tests + get_godot_version）
- Test: `test/tools/runtime.test.js`（已有）

- [ ] **Step 1: 更新 imports — 添加 forceKillTree、acquireShortRunningSlot、releaseShortRunningSlot**

当前第 5 行：
```typescript
import { appendOutput, clearOutputBuffer, killProcess, setProcessBusy, acquireProcessSlot, buildBusyErrorMessage } from '../core/process-state.js';
```

替换为：
```typescript
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, setProcessBusy, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage } from '../core/process-state.js';
```

- [ ] **Step 2: 修复 run_tests — 使用 forceKillTree + acquireShortRunningSlot**

当前代码（第 198-244 行）：
```typescript
case 'run_tests': {
  const p = requireProjectPath(args);
  if (!existsSync(join(p, 'project.godot'))) {
    return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
  }
  const testScript = (args.test_script as string) || 'res://test/';
  const godot = await ctx.findGodot();

  return new Promise((resolve) => {
    const proc = spawn(godot, [
      '--headless', '--path', p,
      '--script', 'addons/gut/gut_cmdln.gd',
      '-gdir', testScript,
      '-gquit',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

    let out = '';
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      if (!proc.killed) void killProcess(proc);
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      // ...
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
    });
  });
}
```

替换为：
```typescript
case 'run_tests': {
  const p = requireProjectPath(args);
  if (!existsSync(join(p, 'project.godot'))) {
    return textResult(`Error: Not a Godot project (no project.godot found): ${p}`);
  }
  if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  const testScript = (args.test_script as string) || 'res://test/';
  const godot = await ctx.findGodot();

  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn(godot, [
      '--headless', '--path', p,
      '--script', 'addons/gut/gut_cmdln.gd',
      '-gdir', testScript,
      '-gquit',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });

    let out = '';
    const MAX_OUTPUT = 500_000;
    proc.stdout?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        forceKillTree(proc);
        releaseShortRunningSlot();
        resolve(textResult('run_tests timed out after 120s'));
      }
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      releaseShortRunningSlot();
      const passed = (out.match(/Tests: (\d+)/g) || []).map(m => m.replace('Tests: ', ''));
      const failed = (out.match(/Failed: (\d+)/g) || []).map(m => m.replace('Failed: ', ''));
      resolve({
        content: [{
          type: 'text',
          text: JSON.stringify({
            exit_code: code,
            passed: passed.join(', '),
            failed: failed.join(', '),
            raw_output: out,
          }, null, 2),
        }],
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      releaseShortRunningSlot();
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
    });
  });
}
```

- [ ] **Step 3: 修复 get_godot_version — 添加 10 秒超时 + acquireShortRunningSlot**

当前代码（第 246-260 行）：
```typescript
case 'get_godot_version': {
  const godot = await ctx.findGodot();
  return new Promise((resolve) => {
    const proc = spawn(godot, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => {
      resolve({ content: [{ type: 'text', text: out.trim() }] });
    });
    proc.on('error', (err) => {
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
    });
  });
}
```

替换为：
```typescript
case 'get_godot_version': {
  if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  const godot = await ctx.findGodot();
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn(godot, ['--version'], { stdio: ['pipe', 'pipe', 'pipe'], env: buildSafeEnv() });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled && !proc.killed) {
        settled = true;
        forceKillTree(proc);
        releaseShortRunningSlot();
        resolve(textResult('get_godot_version timed out after 10s'));
      }
    }, 10000);

    proc.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      releaseShortRunningSlot();
      resolve({ content: [{ type: 'text', text: out.trim() }] });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      releaseShortRunningSlot();
      resolve({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
    });
  });
}
```

- [ ] **Step 4: 确认 `opsErrorResult` 已导入**

检查文件顶部是否已导入 `opsErrorResult`。如果没有，添加：

```typescript
import { opsErrorResult } from '../types.js';
```

检查 `types.ts` 中是否有此导出：
```bash
grep "opsErrorResult" src/types.ts
```

如果不存在但 `textResult` 存在，用 `textResult` 替代或添加 `opsErrorResult` 到 `types.ts`。

- [ ] **Step 5: 运行 runtime 测试**

```bash
npx vitest run test/tools/runtime.test.js
```

Expected: 全部 PASS

- [ ] **Step 6: 运行全量测试**

```bash
npx vitest run
```

Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src/tools/runtime.ts
git commit -m "fix: run_tests 使用 forceKillTree + 并发控制，get_godot_version 添加 10s 超时 (I-05/I-06)"
```

---

## 验证清单

全部 Task 完成后执行：

- [ ] **运行全量测试**
```bash
npx vitest run
```
Expected: 全部 PASS，无回归

- [ ] **ESLint 检查**
```bash
npx eslint src/
```
Expected: 零错误

- [ ] **TypeScript 编译检查**
```bash
npx tsc --noEmit
```
Expected: 零错误
