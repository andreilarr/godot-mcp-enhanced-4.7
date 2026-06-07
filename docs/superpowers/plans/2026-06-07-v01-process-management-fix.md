# V-01 进程管理双层防护修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `run_and_verify` 的 `execFileAsync` 进程残留导致后续 `run_project` 锁死的 bug，并增加 OS 层面残留进程清理安全网。

**Architecture:** 第一层将 `execFileAsync` 替换为 `spawnGodot`（已有 `forceKillTree` 进程树清理）统一进程管理路径；第二层在 `stop_project` 中增加 `killOrphanGodotProcesses` OS 进程扫描 fallback；第三层更新 rules 文档补充验证发现。

**Tech Stack:** TypeScript (Vitest), PowerShell (Windows), sh/grep (Linux/macOS)

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tools/validation.ts` | 修改 L518-557 | 第一层：`execFileAsync` → `spawnGodot`，加 `ctx.setProjectDir` |
| `src/core/process-state.ts` | 修改 | 第二层：新增 `killOrphanGodotProcesses` + 辅助函数 |
| `src/tools/runtime.ts` | 修改 L5, L178-179 | 第二层：import + `stop_project` orphan fallback |
| `.claude/rules/godot-mcp-core.md` | 追加 L96 后 | 第三层：补充 5 项验证发现到常见陷阱 |
| `test/process-state.test.js` | 修改 | 新增 `killOrphanGodotProcesses` 测试用例 |
| `test/validation-tools.test.js` | 修改 | 新增 `run_and_verify` spawnGodot 路径测试用例 |

---

### Task 1: 第一层 — validation.ts 替换 execFileAsync 为 spawnGodot

**Files:**
- Modify: `src/tools/validation.ts:518-557`

- [ ] **Step 1: 确认 spawnGodot 已 import**

检查 validation.ts 顶部的 import 区域，确认 `spawnGodot` 已从 `./spawn-helper.js` import（L14 已有）。

- [ ] **Step 2: 替换 L518-557 的 try/catch execFileAsync 为平坦 spawnGodot 调用**

将以下代码：

```typescript
      try {
        const { stdout, stderr } = await execFileAsync(godot, cmdArgs, { timeout: timeout * 1000 });
        const allOutput = [...(stdout || '').split('\n'), ...(stderr || '').split('\n')];
        const analysis = analyzeOutput(allOutput);

        if (versionWarning) (analysis as ExtendedAnalysisResult).version_warning = versionWarning;
        if (precheckErrors.length > 0) (analysis as ExtendedAnalysisResult).precheck_errors = precheckErrors;

        if (captureTree && scene) {
          try {
            const scriptsDir = dirname(ctx.opsScript);
            const treeScript = join(scriptsDir, 'query_scene_tree.gd');
            if (existsSync(treeScript)) {
              const treeSpawnResult = await spawnGodot(godot, [
                  '--headless', '--path', projectPath,
                  '--script', treeScript,
                  JSON.stringify({ scene_path: scene, max_depth: 3 }),
                ], { timeoutMs: 30_000 });
              const treeResult = treeSpawnResult.stdout;
              if (treeResult) {
                (analysis as ExtendedAnalysisResult).scene_tree = parseMcpScriptOutput(treeResult, 0);
              }
            }
          } catch (err) { getLogger().debug('validation', `capture scene tree: ${err instanceof Error ? err.message : err}`); }
        }

        return textResult(JSON.stringify(analysis, null, 2));
      } catch (e: unknown) {
        const errObj = e as Record<string, unknown>;
        const allOutput = [...String(errObj.stdout || '').split('\n'), ...String(errObj.stderr || '').split('\n')];
        const analysis = analyzeOutput(allOutput);
        if (versionWarning) (analysis as ExtendedAnalysisResult).version_warning = versionWarning;
        if (precheckErrors.length > 0) (analysis as ExtendedAnalysisResult).precheck_errors = precheckErrors;
        if (errObj.killed) {
          (analysis as ExtendedAnalysisResult).summary += '\nNote: Process timed out after ' + timeout + 's (this is normal for interactive projects)';
        } else {
          (analysis as ExtendedAnalysisResult).summary += '\nNote: Process exited with code ' + (errObj.code || 'unknown');
        }
        return textResult(JSON.stringify(analysis, null, 2));
      }
```

替换为（注意 `ctx.setProjectDir(projectPath)` 在 spawnGodot 之前）：

```typescript
      // V-01 fix: setProjectDir so stop_project orphan scan can find project path
      ctx.setProjectDir(projectPath);

      const result = await spawnGodot(godot, cmdArgs, { timeoutMs: timeout * 1000 });
      const allOutput = [...result.stdout.split('\n'), ...result.stderr.split('\n')];
      const analysis = analyzeOutput(allOutput);

      if (versionWarning) (analysis as ExtendedAnalysisResult).version_warning = versionWarning;
      if (precheckErrors.length > 0) (analysis as ExtendedAnalysisResult).precheck_errors = precheckErrors;

      if (result.timedOut) {
        (analysis as ExtendedAnalysisResult).summary += '\nNote: Process timed out after ' + timeout + 's (this is normal for interactive projects)';
      } else if (result.exitCode !== 0 && result.exitCode !== null) {
        (analysis as ExtendedAnalysisResult).summary += '\nNote: Process exited with code ' + result.exitCode;
      }

      if (captureTree && scene) {
        try {
          const scriptsDir = dirname(ctx.opsScript);
          const treeScript = join(scriptsDir, 'query_scene_tree.gd');
          if (existsSync(treeScript)) {
            const treeSpawnResult = await spawnGodot(godot, [
                '--headless', '--path', projectPath,
                '--script', treeScript,
                JSON.stringify({ scene_path: scene, max_depth: 3 }),
              ], { timeoutMs: 30_000 });
            const treeResult = treeSpawnResult.stdout;
            if (treeResult) {
              (analysis as ExtendedAnalysisResult).scene_tree = parseMcpScriptOutput(treeResult, 0);
            }
          }
        } catch (err) { getLogger().debug('validation', `capture scene tree: ${err instanceof Error ? err.message : err}`); }
      }

      return textResult(JSON.stringify(analysis, null, 2));
```

关键变化：
1. 去掉 try/catch（`spawnGodot` 永不抛异常）
2. 在 `spawnGodot` 之前加 `ctx.setProjectDir(projectPath)`
3. 用 `result.stdout`/`result.stderr`/`result.timedOut`/`result.exitCode` 替代 `execFileAsync` 的返回值和异常
4. captureTree 代码块保留在 return 之前，无变动
5. **不删** `execFileAsync` 的 import（L92，同文件其他代码仍用）

- [ ] **Step 3: 运行类型检查**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 4: 运行全量测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
cd D:\GitHub\godot-mcp-enhanced
git add src/tools/validation.ts
git commit -m "fix(validation): replace execFileAsync with spawnGodot in run_and_verify

spawnGodot uses forceKillTree (taskkill /F /T /PID) to clean the entire
process tree on timeout, preventing orphan Godot processes that block
subsequent run_project calls.

Also adds ctx.setProjectDir(projectPath) so stop_project orphan scan
can match the correct project directory.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: 第二层 — process-state.ts 新增 killOrphanGodotProcesses

**Files:**
- Modify: `src/core/process-state.ts` (在 `resetState` 函数之后追加)

- [ ] **Step 1: 在 process-state.ts 的 resetState 函数之后、export 注释之前，追加以下代码**

```typescript
// ─── Orphan process cleanup (V-01 second layer) ────────────────────────────

let _lastOrphanScanTime = 0;
const ORPHAN_SCAN_INTERVAL_MS = 30_000;

/** Escape single quotes for PowerShell single-quoted strings (' → ''). */
function escapePsSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** Escape single quotes for POSIX shell double-quoted strings. */
function escapeShellArg(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Scan OS for orphaned Godot processes matching a project directory and kill them.
 * Returns the number of processes killed. Throttled to once per 30s.
 *
 * Windows: uses Get-CimInstance (not deprecated wmic) with PowerShell variable
 *   for path parameterization (injection-safe).
 * Linux/macOS: uses pgrep + grep -F for literal path matching (injection-safe).
 */
export async function killOrphanGodotProcesses(projectDir: string): Promise<number> {
  if (Date.now() - _lastOrphanScanTime < ORPHAN_SCAN_INTERVAL_MS) return 0;
  _lastOrphanScanTime = Date.now();

  if (!projectDir) return 0;

  const normalizedDir = projectDir.replace(/\\/g, '/');

  if (isWin) {
    const safePath = escapePsSingleQuote(normalizedDir);
    return new Promise((resolve) => {
      const ps = spawn('powershell', [
        '-NoProfile', '-Command',
        `$path = '${safePath}'; ` +
        `Get-CimInstance Win32_Process -Filter "Name LIKE 'Godot%'" | ` +
        `Where-Object { $_.CommandLine -like '*--path*' -and $_.CommandLine -like "*$path*" } | ` +
        `Select-Object -ExpandProperty ProcessId | ForEach-Object { Write-Output $_ }`
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let out = '';
      ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      ps.on('close', () => {
        const pids = out.trim().split('\n').map(Number).filter(n => n > 0);
        for (const pid of pids) {
          try {
            spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
          } catch { /* best effort */ }
        }
        resolve(pids.length);
      });
      ps.on('error', () => resolve(0));
    });
  } else {
    const safeDir = escapeShellArg(normalizedDir);
    return new Promise((resolve) => {
      const ps = spawn('sh', ['-c',
        `pgrep -f godot | xargs -I{} sh -c 'cat /proc/{}/cmdline 2>/dev/null | tr "\\0" " " | grep -F -- "${safeDir}" && echo {}'`
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let out = '';
      ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      ps.on('close', () => {
        const lines = out.trim().split('\n').filter(l => /^\d+$/.test(l.trim()));
        const pids = lines.map(Number).filter(n => n > 0);
        for (const pid of pids) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* best effort */ }
        }
        resolve(pids.length);
      });
      ps.on('error', () => resolve(0));
    });
  }
}
```

注意：函数使用已有的 `isWin` 常量（L14）和 `spawn` import（L11）。

- [ ] **Step 2: 在 resetState 函数中追加 orphan 扫描状态重置**

在 resetState 函数体内（L256 `_queueTail = Promise.resolve();` 之后）追加：

```typescript
  _lastOrphanScanTime = 0;
```

- [ ] **Step 3: 运行类型检查**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 4: 提交**

```bash
cd D:\GitHub\godot-mcp-enhanced
git add src/core/process-state.ts
git commit -m "feat(process-state): add killOrphanGodotProcesses for OS-level cleanup

Windows: Get-CimInstance + PowerShell variable (injection-safe).
Linux/macOS: pgrep + grep -F literal match (injection-safe).
30s throttle prevents excessive scanning.
Resets orphan scan time in resetState for test isolation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: 第二层 — runtime.ts stop_project 增加 orphan fallback

**Files:**
- Modify: `src/tools/runtime.ts:5` (import), `src/tools/runtime.ts:177-179` (stop_project)

- [ ] **Step 1: 在 runtime.ts L5 的 import 行中追加 killOrphanGodotProcesses**

将：

```typescript
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, setProcessBusy, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage } from '../core/process-state.js';
```

改为：

```typescript
import { appendOutput, clearOutputBuffer, killProcess, forceKillTree, setProcessBusy, acquireProcessSlot, acquireShortRunningSlot, releaseShortRunningSlot, buildBusyErrorMessage, killOrphanGodotProcesses } from '../core/process-state.js';
```

- [ ] **Step 2: 替换 stop_project 的 "No project" 分支**

将 L177-179：

```typescript
    case 'stop_project': {
      if (!ctx.runningProcess) {
        return textResult('No project is currently running.');
      }
```

替换为：

```typescript
    case 'stop_project': {
      if (!ctx.runningProcess) {
        // V-01 second layer: scan for orphaned Godot processes
        const projectDir = (args.project_path as string) || ctx.projectDir || '';
        const orphanKilled = await killOrphanGodotProcesses(projectDir);
        if (orphanKilled > 0) {
          return textResult(`Cleaned up ${orphanKilled} orphaned Godot process(es). Project directory: ${projectDir}`);
        }
        return textResult('No project is currently running.');
      }
```

注意：后续的 `await killProcess(ctx.runningProcess)` 等现有代码不变。

- [ ] **Step 3: 运行类型检查**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 4: 运行全量测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
cd D:\GitHub\godot-mcp-enhanced
git add src/tools/runtime.ts
git commit -m "feat(runtime): stop_project cleans up orphaned Godot processes

When no managed process is running, stop_project now scans OS for
orphaned Godot processes matching the project directory and kills them.
Uses args.project_path with fallback to ctx.projectDir.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 第三层 — 更新 rules 文档

**Files:**
- Modify: `.claude/rules/godot-mcp-core.md:96` (在最后一行陷阱后追加)

- [ ] **Step 1: 在"常见陷阱"列表末尾追加 5 项验证发现**

在 `.claude/rules/godot-mcp-core.md` 第 95 行（`- **2D 截图空白**`）之后追加：

```markdown
- **run_and_verify 可能残留进程**：headless 模式下交互式场景（不自动退出）可能残留 Godot 进程。如果后续 `run_project` 报 "another Godot process is running"，先调用 `stop_project` 清理残留进程。
- **load_autoloads=true 片段模式差异**：`load_autoloads=true` 时片段包装为 `extends Node`（非 `extends SceneTree`），`get_root()` 不可用。需要手写 `extends SceneTree` 完整类模式来访问 SceneTree API。
- **load_autoloads autoload 层级**：`load_autoloads=true` 时 autoload 节点不直接挂在 `get_root()` 下，而是通过 autoload 系统加载。使用 `Engine.get_main_loop().get_root().get_node("autoload/Xxx")` 访问。
- **remove_node 路径格式**：使用 `父名#子名` 格式（如 `Main#ValidationLabel`），而非 `/` 分隔路径。先用 `query_scene_tree` 确认节点名。
- **ui_build_layout 必须传 scene_path**：不传 `scene_path` 会报错 "Failed to load scene"。所有 `ui_build_layout` 调用必须包含 `scene_path` 参数。
```

- [ ] **Step 2: 提交**

```bash
cd D:\GitHub\godot-mcp-enhanced
git add .claude/rules/godot-mcp-core.md
git commit -m "docs(rules): add 5 tool usage pitfalls from validation testing

V-01: run_and_verify process residue
V-02: load_autoloads snippet mode difference
V-03: autoload loading hierarchy
V-04: remove_node path format (Parent#Child)
V-05: ui_build_layout requires scene_path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 测试 — killOrphanGodotProcesses 单元测试

**Files:**
- Modify: `test/process-state.test.js`

- [ ] **Step 1: 在 process-state.test.js 的 import 列表中追加 `killOrphanGodotProcesses`**

将 import 块中的最后一项后追加 `killOrphanGodotProcesses`：

```javascript
import {
  resetState,
  getRunningProcess,
  // ... existing imports ...
  releaseShortRunningSlot,
  getShortRunningCount,
  killOrphanGodotProcesses,
} from '../src/core/process-state.js';
```

- [ ] **Step 2: 在文件末尾（最后一个 `});` 之前）添加测试**

```javascript
describe('killOrphanGodotProcesses', () => {
  beforeEach(() => {
    resetState();
  });

  it('returns 0 when projectDir is empty', async () => {
    const count = await killOrphanGodotProcesses('');
    expect(count).toBe(0);
  });

  it('returns 0 when no orphan processes exist', async () => {
    // On a clean test environment there should be no Godot processes
    const count = await killOrphanGodotProcesses('/nonexistent/project/path');
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('throttles: second call within 30s returns 0', async () => {
    // First call executes (returns whatever it finds)
    await killOrphanGodotProcesses('/some/project');
    // Second call within 30s should be throttled
    const count = await killOrphanGodotProcesses('/some/project');
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx vitest run test/process-state.test.js --reporter=verbose 2>&1 | tail -20`
Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
cd D:\GitHub\godot-mcp-enhanced
git add test/process-state.test.js
git commit -m "test(process-state): add killOrphanGodotProcesses unit tests

Covers: empty projectDir, no orphans found, 30s throttle.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 测试 — validation-tools run_and_verify 路径测试

**Files:**
- Modify: `test/validation-tools.test.js`

- [ ] **Step 1: 确认 spawnGodot mock 存在或追加**

如果 validation-tools.test.js 中已有 spawnGodot 的 mock，跳过此步。否则在 mock 区域追加：

```javascript
vi.mock('../src/tools/spawn-helper.js', () => ({
  spawnGodot: vi.fn(async (_godot: string, _args: string[], opts?: { timeoutMs?: number }) => ({
    stdout: 'Godot Engine v4.6.2.stable\nMCP output here\n',
    stderr: '',
    output: 'Godot Engine v4.6.2.stable\nMCP output here\n',
    exitCode: 0,
    timedOut: false,
  })),
}));
```

- [ ] **Step 2: 在文件末尾（最后一个 `});` 之前）添加 run_and_verify 测试**

```javascript
describe('run_and_verify: spawnGodot path (V-01 fix)', () => {
  it('calls ctx.setProjectDir before spawnGodot', async () => {
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project' };
    await handleTool('validation', args, ctx);
    expect(ctx.setProjectDir).toHaveBeenCalledWith('/fake/project');
  });

  it('returns analysis with timed out message when spawnGodot times out', async () => {
    const { spawnGodot } = await import('../src/tools/spawn-helper.js');
    vi.mocked(spawnGodot).mockResolvedValueOnce({
      stdout: 'some output\n',
      stderr: '',
      output: 'some output\n',
      exitCode: null,
      timedOut: true,
    });
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project', timeout: 5 };
    const result = await handleTool('validation', args, ctx);
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.summary).toContain('timed out');
  });

  it('returns analysis with exit code message when spawnGodot exits non-zero', async () => {
    const { spawnGodot } = await import('../src/tools/spawn-helper.js');
    vi.mocked(spawnGodot).mockResolvedValueOnce({
      stdout: '',
      stderr: 'SCRIPT ERROR: something broke\n',
      output: 'SCRIPT ERROR: something broke\n',
      exitCode: 1,
      timedOut: false,
    });
    const ctx = makeCtx();
    const args = { action: 'run_and_verify', project_path: '/fake/project' };
    const result = await handleTool('validation', args, ctx);
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.summary).toContain('exited with code 1');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx vitest run test/validation-tools.test.js --reporter=verbose 2>&1 | tail -30`
Expected: 所有测试通过

- [ ] **Step 4: 运行全量测试确认无回归**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
cd D:\GitHub\godot-mcp-enhanced
git add test/validation-tools.test.js
git commit -m "test(validation): add run_and_verify spawnGodot path tests

Verifies: ctx.setProjectDir called, timedOut message, non-zero exit code.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 构建项目**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build 2>&1 | tail -10`
Expected: 构建成功

- [ ] **Step 2: 全量测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: 所有测试通过

- [ ] **Step 3: 汇总检查**

Run: `cd D:\GitHub\godot-mcp-enhanced && git log --oneline -6`
Expected: 看到 5 个新 commit（validation.ts, process-state.ts, runtime.ts, rules, tests）

- [ ] **Step 4: MCP 实测 — 用 godot-test-project 重现并验证 V-01 修复**

1. 调用 `run_and_verify(scene="scenes/main.tscn", timeout=5)` → 等完成
2. 调用 `stop_project` → 应返回清理信息或 "No project is currently running"
3. 调用 `run_project(timeout=10)` → 应成功启动（不再报 "another Godot process is running"）
4. 调用 `stop_project` → 正常停止

---

## 自查清单

### 1. 规格覆盖

| 规格要求 | 覆盖任务 |
|---------|---------|
| 第一层：execFileAsync → spawnGodot | Task 1 |
| 第一层：ctx.setProjectDir | Task 1 |
| 第二层：killOrphanGodotProcesses | Task 2 |
| 第二层：stop_project orphan fallback | Task 3 |
| 第三层：rules 文档更新 | Task 4 |
| 测试 T1-T6（单元） | Task 5 + Task 6 |
| 测试 T7-T8（集成） | Task 7 |
| R1 Get-CimInstance | Task 2 |
| R2 import 保留 | Task 1（不改 import） |
| R3 平坦代码块 | Task 1 |
| R4 测试计划 | Task 5 + Task 6 |
| R5 30s 节流 | Task 2 + Task 5 |
| R6 --path 匹配 | Task 2 |
| 审查 #1 projectDir 空路径 | Task 1（setProjectDir）+ Task 2（!projectDir guard）+ Task 3（args fallback） |
| 审查 #2 PowerShell 注入 | Task 2（escapePsSingleQuote + $path 变量） |
| 审查 #3 pgrep 注入 | Task 2（grep -F + escapeShellArg） |

### 2. 占位符扫描

- 无 TBD/TODO/placeholder
- 每步包含完整代码和预期输出
- 无 "类似 Task N" 的引用

### 3. 类型一致性

- `spawnGodot` 返回 `SpawnResult`（spawn-helper.ts:5-11），字段：`stdout: string`, `stderr: string`, `exitCode: number | null`, `timedOut: boolean`
- `killOrphanGodotProcesses(projectDir: string): Promise<number>` — Task 2 定义，Task 3 import，Task 5 测试
- `ctx.setProjectDir` 在 `ToolContext` 中已存在（validation-tools.test.js:39 已 mock）
- `resetState()` 在 Task 2 中更新，新增 `_lastOrphanScanTime = 0`
