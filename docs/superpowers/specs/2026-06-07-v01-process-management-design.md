# V-01 进程管理 bug 修复设计文档

> **日期**: 2026-06-07
> **审查状态**: 已通过（R1-R6 + 审查二轮 3 处修订，已整合）
> **验证报告**: `docs/superpowers/specs/2026-06-07-tool-validation-report.md`

## 根因

`run_and_verify`（validation.ts L519）使用 `execFileAsync` 启动 headless Godot。
`execFileAsync` 超时后 Node.js 调用 `proc.kill()`，但 Windows 上 Godot 分裂出两个子进程
（`Godot_v4.6.2-stable_win64` + `_console`），`proc.kill()` 只杀父进程。

这些残留子进程不经过 `process-state.ts` 的 `_runningProcess` 管理。
后续 `run_project` 通过 `acquireProcessSlot` 检测到 `_processBusy` 仍为 true
（或检测到 OS 层面残留进程），拒绝启动。`stop_project` 只看 `ctx.runningProcess`，
看不到这些残留进程，返回 "No project is currently running"。

## 修复方案：双层防护 + rules 文档更新

---

### 第一层：统一进程管理（根因修复）

**文件**: `src/tools/validation.ts`

**改动**: 将 L518-555 的 `execFileAsync` + `try/catch` 替换为平坦的 `spawnGodot` 调用。

`spawnGodot`（spawn-helper.ts）已使用 `forceKillTree`（`taskkill /F /T /PID`）清理
整个进程树，且永不抛异常——错误通过 `exitCode` 和 `timedOut` 字段返回。

**修订 R3**: 去掉 try/catch，改为平坦代码块（spawnGodot 永不抛异常）：

```typescript
// ── 之前 (L518-555) ──
try {
  const { stdout, stderr } = await execFileAsync(godot, cmdArgs, { timeout: timeout * 1000 });
  const allOutput = [...(stdout || '').split('\n'), ...(stderr || '').split('\n')];
  const analysis = analyzeOutput(allOutput);
  // ... 成功路径 ...
  return textResult(JSON.stringify(analysis, null, 2));
} catch (e: unknown) {
  const errObj = e as Record<string, unknown>;
  const allOutput = [...String(errObj.stdout || '').split('\n'), ...String(errObj.stderr || '').split('\n')];
  const analysis = analyzeOutput(allOutput);
  // ... 错误路径 ...
  return textResult(JSON.stringify(analysis, null, 2));
}

// ── 之后 ──
// 审查修订 #1: run_and_verify 不走 runtime.ts，不会设置 ctx.projectDir。
// 必须在此设置，否则后续 stop_project 的 orphan 扫描拿不到项目路径。
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

// captureTree 逻辑保持不变（L526-541 已使用 spawnGodot）
if (captureTree && scene) { ... }

return textResult(JSON.stringify(analysis, null, 2));
```

**修订 R2**: `execFileAsync` 的 import（L92 `promisify(execFile)`）保留不删，
因为同文件中 dotnet build 相关逻辑仍使用 `execFileAsync`。

**改动范围**: `validation.ts` 约 30 行（L518-555 区域）

---

### 第二层：OS 进程扫描安全网

**文件**: `src/core/process-state.ts`（新增函数）、`src/tools/runtime.ts`（stop_project 增强）

**功能**: 当 `stop_project` 发现 `_runningProcess` 为 null 但 OS 层面仍有残留 Godot 进程时，
主动清理。

#### killOrphanGodotProcesses 实现

**修订 R1**: Windows 用 `Get-CimInstance`（非已弃用的 wmic）获取进程命令行。
**修订 R6**: 匹配命令行参数中的 `--path projectDir`，避免误杀其他项目的 Godot 进程。

```typescript
// process-state.ts 新增
let _lastOrphanScanTime = 0;
const ORPHAN_SCAN_INTERVAL_MS = 30_000; // R5: 30s 节流

/** 转义 PowerShell 单引号字符串中的单引号（' → ''） */
function escapePsSingleQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/** 转义 grep -F 的字面匹配不需要转义（-F 禁用正则），但需要确保参数完整性 */
function escapeShellArg(s: string): string {
  return s.replace(/'/g, "'\\''");
}

export async function killOrphanGodotProcesses(projectDir: string): Promise<number> {
  // R5: 节流 — 30s 内不重复扫描
  if (Date.now() - _lastOrphanScanTime < ORPHAN_SCAN_INTERVAL_MS) return 0;
  _lastOrphanScanTime = Date.now();

  if (!projectDir) return 0; // 审查修订 #1: 空路径直接返回

  // 标准化为正斜杠，用于命令行匹配
  const normalizedDir = projectDir.replace(/\\/g, '/');

  if (process.platform === 'win32') {
    // R1: Get-CimInstance 替代 wmic
    // 审查修订 #2: 用 PowerShell 变量传参，避免字符串插值注入
    const safePath = escapePsSingleQuote(normalizedDir);
    return new Promise((resolve) => {
      const ps = spawn('powershell', [
        '-NoProfile', '-Command',
        // 用 $path 变量传路径，不直接插值到 -like 字符串中
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
    // 审查修订 #3: 用 grep -F（字面匹配）替代 pgrep 正则，避免正则注入
    // 流程: 列出所有 Godot 进程 PID → 逐个读取 /proc/PID/cmdline → grep -F 字面匹配路径
    return new Promise((resolve) => {
      const safeDir = escapeShellArg(normalizedDir);
      // pgrep -l godot 获取 PID 列表，然后 grep -F 做字面匹配
      const ps = spawn('sh', ['-c',
        `pgrep -f godot | xargs -I{} sh -c 'cat /proc/{}/cmdline 2>/dev/null | tr "\\0" " " | grep -F -- "${safeDir}" && echo {}'`
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let out = '';
      ps.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      ps.on('close', () => {
        // 提取最后一行（PID），每对 cmdline+PID 两行
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

#### stop_project 增强

```typescript
// runtime.ts stop_project
case 'stop_project': {
  if (!ctx.runningProcess) {
    // 第二层：扫描残留 Godot 进程
    // 审查修订 #1: stop_project 接受可选 project_path 参数，
    // fallback 到 ctx.projectDir（run_and_verify 已通过第一层修订设置）
    const projectDir = (args.project_path as string) || ctx.projectDir || '';
    const orphanKilled = await killOrphanGodotProcesses(projectDir);
    if (orphanKilled > 0) {
      return textResult(`Cleaned up ${orphanKilled} orphaned Godot process(es). Project directory: ${projectDir}`);
    }
    return textResult('No project is currently running.');
  }
  // ... 现有 kill 逻辑不变 ...
}
```

#### acquireProcessSlot 增强

在现有 auto-release 死进程逻辑（L103-121）之后，增加 orphan 扫描 fallback：

```typescript
// process-state.ts acquireProcessSlot 内部
if (_processBusy) {
  // ... 现有检查 ...
  if (_processBusy) return false;
}
```

注意：`acquireProcessSlot` 是同步函数，不能直接调用 async 的 `killOrphanGodotProcesses`。
orphan 扫描仅在 `stop_project`（async）中执行。`acquireProcessSlot` 保持现有同步逻辑即可。

---

### 第三层：Rules 文档更新

**文件**: `.claude/rules/godot-mcp-core.md`

补充 5 项验证发现（V-01~V-05）到"常见陷阱"部分：

```markdown
## 常见陷阱（补充）

- **run_and_verify 可能残留进程**：headless 模式下 2D 交互式场景（不自动退出）可能残留
  Godot 进程。如果后续 `run_project` 报 "another Godot process is running"，先调用
  `stop_project` 清理残留进程。

- **load_autoloads=true 片段模式差异**：`load_autoloads=true` 时片段包装为 `extends Node`
  （非 `extends SceneTree`），`get_root()` 不可用。需要手写 `extends SceneTree`
  完整类模式来访问 SceneTree API。

- **load_autoloads autoload 层级**：`load_autoloads=true` 时 autoload 节点不直接挂在
  `get_root()` 下，而是通过 autoload 系统加载。使用
  `Engine.get_main_loop().get_root().get_node("autoload/Xxx")` 访问。

- **remove_node 路径格式**：使用 `父名#子名` 格式（如 `Main#ValidationLabel`），
  而非 `/` 分隔路径。先用 `query_scene_tree` 确认节点名。

- **ui_build_layout 必须传 scene_path**：不传 `scene_path` 会报错
  "Failed to load scene"。所有 ui_build_layout 调用必须包含 `scene_path` 参数。
```

---

## 测试计划（修订 R4）

### 单元测试（validation.ts 改动）

| # | 用例 | 验证点 |
|---|------|--------|
| T1 | `spawnGodot` 正常退出 | exitCode=0，stdout/stderr 正确收集 |
| T2 | `spawnGodot` 超时 | timedOut=true，进程树被 forceKillTree 清理 |
| T3 | `spawnGodot` spawn 失败 | exitCode=-1，stdout 包含 "SPAWN_FAILED:" |
| T4 | `run_and_verify` 正常场景 | 无 try/catch，analysis 正确生成 |
| T5 | `run_and_verify` 超时场景 | summary 包含 "timed out"，无异常抛出 |
| T6 | `killOrphanGodotProcesses` 节流 | 30s 内第二次调用返回 0 |

### 集成测试（process-state.ts 新增）

| # | 用例 | 验证点 |
|---|------|--------|
| T7 | `stop_project` 清理残留进程 | 当 _runningProcess=null 但 OS 有残留时，返回清理信息 |
| T8 | `stop_project` 无残留 | 正常返回 "No project is currently running" |

---

## 文件改动清单

| 文件 | 操作 | 改动量 |
|------|------|--------|
| `src/tools/validation.ts` | 修改 | ~30 行（L518-555 区域） |
| `src/tools/spawn-helper.ts` | 不动 | — |
| `src/core/process-state.ts` | 新增函数 | ~50 行（killOrphanGodotProcesses） |
| `src/tools/runtime.ts` | 修改 | ~5 行（stop_project fallback） |
| `.claude/rules/godot-mcp-core.md` | 追加 | ~15 行（常见陷阱补充） |
| `test/validation.test.ts` | 新增/修改 | 6+ 测试用例 |
| `test/process-state.test.ts` | 新增/修改 | 2+ 测试用例 |

## 自查清单

- [x] 无 TBD/TODO/placeholder
- [x] 每步包含完整代码或清晰描述
- [x] 所有 6 条审查建议已整合（R1-R6）
- [x] catch 重写为平坦代码块（R3）
- [x] Windows 用 Get-CimInstance（R1）
- [x] 进程匹配用命令行参数（R6）
- [x] 30s 节流（R5）
- [x] 测试计划 8 个用例（R4）
- [x] import 保留（R2）
- [x] 审查二轮修订 #1: run_and_verify 中加 ctx.setProjectDir + stop_project 用 args.project_path fallback
- [x] 审查二轮修订 #2: PowerShell 用 $path 变量 + escapePsSingleQuote 避免注入
- [x] 审查二轮修订 #3: Linux 用 grep -F 字面匹配替代 pgrep 正则
