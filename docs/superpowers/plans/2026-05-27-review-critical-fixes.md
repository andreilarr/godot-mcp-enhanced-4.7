# 代码审查 CRITICAL 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复代码审查发现的全部 14 项 CRITICAL 问题（安全/并发/功能/质量/测试）

**Architecture:** 按 P0→P1→P2 优先级分批修复，每批完成后全量测试验证。安全修复采用 deny-by-default + 环境变量逃生阀模式。并发修复采用原子 acquire/release 和 Promise 链连接锁。

**Tech Stack:** TypeScript (Node.js), GDScript, ESLint, Vitest, GitHub Actions

**设计文档:** `docs/superpowers/specs/2026-05-27-review-critical-fixes-design.md`

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/helpers.ts` | deny-by-default 白名单 + 废弃迁移 |
| 修改 | `src/GodotServer.ts` | search_dir 白名单检查 |
| 修改 | `src/core/process-state.ts` | acquireProcessSlot() 原子操作 |
| 修改 | `src/tools/scene.ts` | isProcessBusy → acquireProcessSlot |
| 修改 | `src/tools/runtime.ts` | 删除冗余 setProcessBusy(true) |
| 修改 | `src/tools/game-bridge.ts` | 连接锁 + 双重检查 |
| 修改 | `src/tools/test-framework.ts` | 缩进修复 |
| 修改 | `src/tools/recording.ts` | Bridge 模式重写 |
| 修改 | `src/scripts/mcp_bridge.gd` | 录制命令 |
| 修改 | `src/gdscript-executor.ts` | 沙箱警告 |
| 修改 | `src/tools/shared.ts` | 统一工具函数 |
| 修改 9+ | `src/tools/*.ts` | 导入统一函数 |
| 创建 | `eslint.config.js` | ESLint flat config |
| 修改 | `.github/workflows/ci.yml` | 添加 lint 步骤 |
| 修改 | `package.json` | 添加 lint 脚本 |

---

## Batch 1: P0 快速修复（5 项）

### Task 1: C-SEC-01 路径白名单 deny-by-default + I-SEC-01 search_dir 修复

**Files:**
- 修改: `src/helpers.ts:95-114`
- 修改: `src/GodotServer.ts:89-95`
- 测试: `test/helpers.test.ts`

- [ ] **Step 1: 写 isPathInAllowedRoots 的 deny-by-default 测试**

在 `test/helpers.test.ts` 中添加测试：

```typescript
describe('isPathInAllowedRoots deny-by-default', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ALLOWED_PROJECT_PATHS;
    delete process.env.GODOT_MCP_UNRESTRICTED;
    delete process.env.ALLOW_OUTSIDE_PROJECT_PATHS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should deny paths outside cwd when no whitelist set', () => {
    const cwd = process.cwd();
    expect(isPathInAllowedRoots(cwd)).toBe(true);
    expect(isPathInAllowedRoots('/definitely/outside/path')).toBe(false);
  });

  it('should allow GODOT_MCP_UNRESTRICTED to bypass', () => {
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    expect(isPathInAllowedRoots('/any/path')).toBe(true);
  });

  it('should respect ALLOWED_PROJECT_PATHS whitelist', () => {
    const tmpDir = tmpdir();
    process.env.ALLOWED_PROJECT_PATHS = tmpDir;
    expect(isPathInAllowedRoots(tmpDir)).toBe(true);
    expect(isPathInAllowedRoots('/not/in/whitelist')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

运行: `npx vitest run test/helpers.test.ts`
预期: FAIL — 当前 `isPathInAllowedRoots` 在无白名单时返回 `true`

- [ ] **Step 3: 修改 helpers.ts 实现 deny-by-default**

将 `src/helpers.ts` 中 `isPathInAllowedRoots` 函数替换为：

```typescript
/** Check if a requested path is within the ALLOWED_PROJECT_PATHS whitelist (deny-by-default). */
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') return true;
  if (allowOutsideProjectPaths()) return true;
  const allowed = getAllowedProjectPaths();
  const resolved = resolvePath(requestedPath);
  if (allowed.length === 0) {
    const cwd = resolvePath(process.cwd());
    const isAllowed = resolved === cwd || resolved.startsWith(cwd + sep);
    if (!isAllowed) {
      console.warn(`[SECURITY] Path "${requestedPath}" denied (not within cwd "${process.cwd()}"). Set ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED=true to allow.`);
    }
    return isAllowed;
  }
  return allowed.some(p => resolved === p || resolved.startsWith(p + sep));
}
```

- [ ] **Step 4: 运行测试确认通过**

运行: `npx vitest run test/helpers.test.ts`
预期: PASS

- [ ] **Step 5: 在 GodotServer.ts 中添加 search_dir 白名单检查**

修改 `src/GodotServer.ts` 中 `dispatchTool` 函数，在 `project_path` 检查之后添加 `search_dir` 检查：

```typescript
// 在 dispatchTool 函数中，project_path 检查之后添加：
if (typeof args.search_dir === 'string' && !isPathInAllowedRoots(args.search_dir)) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'PATH_NOT_ALLOWED', message: `Search directory not in ALLOWED_PROJECT_PATHS: ${args.search_dir}. Set ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED=true.` } }) }], isError: true };
}
```

- [ ] **Step 6: 运行全量测试确认无回归**

运行: `npx vitest run`
预期: 全部通过

- [ ] **Step 7: 提交**

```bash
git add src/helpers.ts src/GodotServer.ts test/helpers.test.ts
git commit -m "fix(security): deny-by-default path whitelist + search_dir check (C-SEC-01, I-SEC-01)"
```

---

### Task 2: C-CI-01 添加 ESLint 配置和 CI lint 步骤

**Files:**
- 创建: `eslint.config.js`
- 修改: `package.json` (添加 lint 脚本)
- 修改: `.github/workflows/ci.yml` (添加 lint 步骤)

- [ ] **Step 1: 创建 eslint.config.js**

```javascript
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    ignores: ['build/', 'coverage/', 'node_modules/', 'src/scripts/'],
  },
);
```

- [ ] **Step 2: 在 package.json 添加 lint 脚本**

在 `package.json` 的 `scripts` 中，在 `"build"` 之前添加：

```json
"lint": "eslint src/",
```

- [ ] **Step 3: 在 CI 中添加 lint 步骤**

修改 `.github/workflows/ci.yml`，在 `npx tsc --noEmit` 之前添加：

```yaml
      - run: npm run lint
```

- [ ] **Step 4: 运行 lint 检查无阻断错误**

运行: `npx eslint src/`
预期: 可能有 warn 但不应有 error（配置为 warn-only）

- [ ] **Step 5: 提交**

```bash
git add eslint.config.js package.json .github/workflows/ci.yml
git commit -m "ci: add ESLint config and CI lint step (C-CI-01)"
```

---

### Task 3: C-Q-01 test_stress 缩进修复

**Files:**
- 修改: `src/tools/test-framework.ts:240`

- [ ] **Step 1: 修复缩进**

在 `src/tools/test-framework.ts` 第 240 行，将空格缩进改为 tab 缩进。

找到：
```
\tfor _f in range(3):
			await get_tree().process_frame
```

替换为：
```
\tfor _f in range(3):
\t\t\tawait get_tree().process_frame
```

同时扫描文件中其他可能的空格/tab 混用（搜索 `^\t+ ` 模式中的非 tab 字符）。

- [ ] **Step 2: 运行全量测试**

运行: `npx vitest run`
预期: 全部通过

- [ ] **Step 3: 提交**

```bash
git add src/tools/test-framework.ts
git commit -m "fix: correct mixed indentation in test_stress GDScript (C-Q-01)"
```

---

### Task 4: C-TYP-01 game-bridge 连接竞争条件修复

**Files:**
- 修改: `src/tools/game-bridge.ts`
- 测试: `test/game-bridge.test.ts`（如有）或新文件

- [ ] **Step 1: 写连接锁测试**

添加测试验证并发连接请求被串行化：

```typescript
describe('_ensureConnection lock', () => {
  it('should serialize concurrent connection attempts', async () => {
    // Mock _doConnect to track call count
    let connectCalls = 0;
    // 模拟：两次并发调用 _ensureConnection 应只触发一次实际连接
    // 测试通过 mock 实现
  });
});
```

注意：由于 game-bridge 依赖 TCP socket，测试需要 mock `net.createConnection`。如果现有测试已覆盖此模块，在现有框架内添加测试。

- [ ] **Step 2: 将 _ensureConnection 拆分为锁 + _doConnect**

在 `src/tools/game-bridge.ts` 中：

1. 在模块级变量区添加：

```typescript
let _connectionLock: Promise<Socket> | null = null;
```

2. 将现有 `_ensureConnection` 的连接逻辑（从 `_invalidateSocket()` 开始到函数末尾）提取到新函数 `_doConnect`：

```typescript
async function _doConnect(timeout: number): Promise<Socket> {
  _invalidateSocket();
  const secret = readBridgeSecret();
  if (!secret) {
    throw new Error('Bridge secret not found. Ensure the game is running with the MCP Bridge autoload.');
  }
  return new Promise<Socket>((resolve, reject) => {
    // ... 现有连接逻辑（从 createConnection 开始）...
  });
}
```

3. 重写 `_ensureConnection` 使用锁：

```typescript
function _ensureConnection(timeout: number): Promise<Socket> {
  if (_socket && _socketAuthenticated && !_socket.destroyed && _socket.writable) {
    return Promise.resolve(_socket);
  }
  if (_connectionLock) return _connectionLock;
  _connectionLock = _doConnect(timeout)
    .then(sock => {
      if (_socket !== sock || !_socketAuthenticated) {
        throw new Error('Connection invalidated during setup');
      }
      return sock;
    })
    .finally(() => { _connectionLock = null; });
  return _connectionLock;
}
```

- [ ] **Step 3: 在 setBridgeProjectDir 中取消挂起连接锁**

在 `setBridgeProjectDir` 函数中添加锁清理：

```typescript
export function setBridgeProjectDir(projectDir: string): void {
  if (_projectDir === projectDir) return;
  _projectDir = projectDir;
  _cachedSecretPath = null;
  _cachedSecret = null;
  _connectionLock = null;  // 清除挂起的连接锁
  _invalidateSocket();
}
```

- [ ] **Step 4: 运行全量测试**

运行: `npx vitest run`
预期: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/tools/game-bridge.ts test/
git commit -m "fix: add connection lock to game-bridge to prevent race condition (C-TYP-01)"
```

---

### Task 5: C-TYP-02 process-state TOCTOU 竞争修复

**Files:**
- 修改: `src/core/process-state.ts`
- 修改: `src/tools/scene.ts:456,509`
- 修改: `src/tools/runtime.ts:179`

- [ ] **Step 1: 在 process-state.ts 添加 acquireProcessSlot**

在 `src/core/process-state.ts` 的 `isProcessBusy` 函数之后添加：

```typescript
/** Atomically acquire the process slot. Returns true if acquired, false if busy. */
export function acquireProcessSlot(): boolean {
  if (_processBusy) return false;
  _processBusy = true;
  return true;
}
```

- [ ] **Step 2: 修改 scene.ts 使用 acquireProcessSlot**

修改 `src/tools/scene.ts` 的导入：

```typescript
// 旧
import { forceKillTree, isProcessBusy } from '../core/process-state.js';
// 新
import { forceKillTree, acquireProcessSlot } from '../core/process-state.js';
```

将第 456 行和第 509 行：

```typescript
// 旧
if (isProcessBusy()) return textResult('Error: another Godot process is running. Wait for it to finish.');
// 新
if (!acquireProcessSlot()) return textResult('Error: another Godot process is running. Wait for it to finish.');
```

- [ ] **Step 3: 修改 runtime.ts 删除冗余 setProcessBusy(true)**

在 `src/tools/runtime.ts` 第 179 行，删除 `setProcessBusy(true)`：

```typescript
// 旧
ctx.setRunningProcess(proc);
setProcessBusy(true);

// 新
ctx.setRunningProcess(proc);
```

因为 scene.ts 中的 `acquireProcessSlot()` 已经设置了 `_processBusy = true`。

注意：`run_project` 路径（runtime.ts 的 `case 'run_project'`）是唯一不在 scene.ts 中 acquire 的路径。检查 `run_project` 是否也通过 scene.ts 分发。如果不是，需要在 runtime.ts 中也使用 `acquireProcessSlot()`。

验证：grep `run_project` 的调用来源 — 如果来自 scene.ts 的 handleTool dispatch，则已通过 scene.ts 的 acquire 覆盖。

- [ ] **Step 4: 运行全量测试**

运行: `npx vitest run`
预期: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/process-state.ts src/tools/scene.ts src/tools/runtime.ts
git commit -m "fix: atomic acquireProcessSlot to prevent TOCTOU race (C-TYP-02)"
```

---

## Batch 2: P1 功能修复（4 项）

### Task 6: C-SEC-02 GDScript 沙箱警告

**Files:**
- 修改: `src/gdscript-executor.ts`

- [ ] **Step 1: 添加沙箱检查函数**

在 `src/gdscript-executor.ts` 中添加沙箱扫描函数：

```typescript
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /OS\.(execute|shell_open|kill|set_restart_on_exit|crash)\b/, label: 'OS system command' },
  { pattern: /DirAccess\.(remove_absolute|remove)\b/, label: 'Directory removal' },
  { pattern: /FileAccess\.open\s*\([^)]*WRITE/, label: 'File write access' },
  { pattern: /Engine\.(set_singleton)\b/, label: 'Engine singleton modification' },
];

/** Best-effort scan for dangerous GDScript patterns. Returns warnings array. */
export function scanGdscriptSandbox(code: string): string[] {
  if (process.env.GODOT_MCP_SANDBOX !== 'strict') return [];
  const warnings: string[] = [];
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${label}`);
    }
  }
  return warnings;
}
```

- [ ] **Step 2: 在 executeGdscript 中集成沙箱扫描**

在 `executeGdscript` 函数中，在代码执行之前调用沙箱扫描：

```typescript
// 在 executeGdscript 函数中，执行代码之前添加：
const sandboxWarnings = scanGdscriptSandbox(code);
if (sandboxWarnings.length > 0) {
  console.warn('[SANDBOX] Warnings for GDScript execution:', sandboxWarnings);
  // 将警告注入到结果中（不阻断执行）
  // 在输出解析时附加 sandbox_warnings 字段
}
```

- [ ] **Step 3: 写沙箱扫描测试**

```typescript
describe('scanGdscriptSandbox', () => {
  const origEnv = process.env.GODOT_MCP_SANDBOX;

  beforeAll(() => { process.env.GODOT_MCP_SANDBOX = 'strict'; });
  afterAll(() => {
    if (origEnv === undefined) delete process.env.GODOT_MCP_SANDBOX;
    else process.env.GODOT_MCP_SANDBOX = origEnv;
  });

  it('should detect OS.execute', () => {
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });

  it('should return empty when sandbox is off', () => {
    delete process.env.GODOT_MCP_SANDBOX;
    const warnings = scanGdscriptSandbox('OS.execute("rm", ["-rf", "/"])');
    expect(warnings).toEqual([]);
  });

  it('should not flag safe code', () => {
    const warnings = scanGdscriptSandbox('var x = 1 + 2');
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 4: 运行测试**

运行: `npx vitest run`
预期: PASS

- [ ] **Step 5: 提交**

```bash
git add src/gdscript-executor.ts test/
git commit -m "feat: add optional GDScript sandbox warning scanner (C-SEC-02)"
```

---

### Task 7: C-Q-02 录制功能重构为 Bridge 模式

**Files:**
- 修改: `src/tools/recording.ts`
- 修改: `src/scripts/mcp_bridge.gd`

- [ ] **Step 1: 在 mcp_bridge.gd 中添加录制状态和命令**

在 `src/scripts/mcp_bridge.gd` 中：

1. 在成员变量区添加：

```gdscript
var _recording: bool = false
var _recorded_events: Array = []
var _record_start_time: int = 0
```

2. 在 `_handle_message` 的 match 语句中，在 `"get_viewport_info"` 之后、`_` 之前添加：

```gdscript
			"recording.start":
				result = _cmd_recording_start()
			"recording.stop":
				result = _cmd_recording_stop()
```

3. 在文件末尾（`_cmd_get_viewport_info` 之后）添加命令实现：

```gdscript


func _cmd_recording_start() -> Variant:
	if _recording:
		return {"error": {"code": -1, "message": "Recording already in progress"}}
	_recording = true
	_recorded_events = []
	_record_start_time = Time.get_ticks_msec()
	return {"status": "recording", "message": "Input events are being captured"}


func _cmd_recording_stop() -> Variant:
	if not _recording:
		return {"error": {"code": -1, "message": "No recording in progress"}}
	_recording = false
	var duration_ms: int = Time.get_ticks_msec() - _record_start_time
	var events: Array = _recorded_events.duplicate()
	_recorded_events = []
	return {
		"version": 1,
		"duration_ms": duration_ms,
		"events": events,
		"event_count": events.size()
	}


func _input(event: InputEvent) -> void:
	if not _recording:
		return
	var time_ms: int = Time.get_ticks_msec() - _record_start_time
	if event is InputEventKey:
		_recorded_events.append({
			"type": "key", "keycode": event.keycode,
			"pressed": event.pressed, "shift": event.shift_pressed,
			"ctrl": event.ctrl_pressed, "alt": event.alt_pressed,
			"time_ms": time_ms
		})
	elif event is InputEventMouseButton:
		_recorded_events.append({
			"type": "mouse_click", "position": [event.position.x, event.position.y],
			"button": event.button_index, "pressed": event.pressed,
			"time_ms": time_ms
		})
	elif event is InputEventMouseMotion:
		_recorded_events.append({
			"type": "mouse_move", "position": [event.position.x, event.position.y],
			"time_ms": time_ms
		})
```

- [ ] **Step 2: 重写 recording.ts 的 start/stop handler**

在 `src/tools/recording.ts` 中：

1. 添加 Bridge 导入：

```typescript
import { sendToBridge } from './game-bridge.js';
```

2. 修改 `recording_start` case：

```typescript
case 'recording_start': {
  if (!loadAutoloads) {
    return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED,
      '录制功能需要 Game Bridge 连接，headless 模式不支持。');
  }
  try {
    const resp = await sendToBridge('recording.start', {}, 5000);
    if (resp.error) {
      return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED,
        `Bridge 错误: ${resp.error.message}`);
    }
    return textResult(JSON.stringify(opsSuccess(resp.result)));
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Method not found')) {
      return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED,
        '请更新项目中的 MCP Bridge 脚本以支持录制功能。运行 install-plugin 获取最新版本。');
    }
    return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, msg);
  }
}
```

3. 修改 `recording_stop` case：

```typescript
case 'recording_stop': {
  if (!loadAutoloads) {
    return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED,
      '录制功能需要 Game Bridge 连接，headless 模式不支持。');
  }
  try {
    const resp = await sendToBridge('recording.stop', {}, 5000);
    if (resp.error) {
      if (resp.error.code === -32601) {
        return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED,
          '请更新项目中的 MCP Bridge 脚本以支持录制功能。运行 install-plugin 获取最新版本。');
      }
      return opsErrorResult(ERROR_CODES.RECORDING_IN_PROGRESS,
        `Bridge 错误: ${resp.error.message}`);
    }
    return textResult(JSON.stringify(opsSuccess(resp.result)));
  } catch (err) {
    return opsErrorResult(ERROR_CODES.BRIDGE_NOT_CONNECTED, (err as Error).message);
  }
}
```

4. 删除不再使用的 `genRecordingStartScript()` 和 `genRecordingStopScript()` 函数。

- [ ] **Step 3: 运行全量测试**

运行: `npx vitest run`
预期: 全部通过（可能需要更新 recording 相关的 mock 测试）

- [ ] **Step 4: 提交**

```bash
git add src/tools/recording.ts src/scripts/mcp_bridge.gd test/
git commit -m "refactor: rewrite recording to Bridge TCP mode (C-Q-02)"
```

---

### Task 8: C-CI-02 gdscript-executor 测试覆盖提升

**Files:**
- 修改: `test/gdscript-executor.test.ts`

- [ ] **Step 1: 写 wrapSnippet 测试**

```typescript
describe('wrapSnippet', () => {
  it('should wrap plain code snippet', () => {
    const code = 'var x = 1';
    const wrapped = wrapSnippet(code);
    expect(wrapped).toContain('extends SceneTree');
    expect(wrapped).toContain('var x = 1');
    expect(wrapped).toContain('_mcp_done()');
  });

  it('should pass through full class code unchanged', () => {
    const code = 'extends SceneTree\n\nfunc _initialize():\n\tprint("hello")';
    const result = wrapSnippet(code);
    expect(result).toBe(code);
  });

  it('should handle empty code', () => {
    const wrapped = wrapSnippet('');
    expect(wrapped).toContain('extends SceneTree');
  });

  it('should escape percent signs in code', () => {
    const code = 'var s = "100%"';
    const wrapped = wrapSnippet(code);
    expect(wrapped).toContain('100%%');
  });
});
```

注意：`wrapSnippet` 可能不是导出函数。如果它是私有的，通过导出的 `executeGdscript` 间接测试，或将其导出。

- [ ] **Step 2: 写 buildSafeEnv 测试**

```typescript
describe('buildSafeEnv', () => {
  it('should include PATH', () => {
    const env = buildSafeEnv();
    expect(env.PATH).toBeDefined();
  });

  it('should not leak GODOT_MCP_UNRESTRICTED', () => {
    process.env.GODOT_MCP_UNRESTRICTED = 'true';
    const env = buildSafeEnv();
    expect(env.GODOT_MCP_UNRESTRICTED).toBeUndefined();
    delete process.env.GODOT_MCP_UNRESTRICTED;
  });

  it('should include Windows paths on win32', () => {
    const env = buildSafeEnv();
    if (process.platform === 'win32') {
      expect(env.USERPROFILE).toBeDefined();
    }
  });
});
```

- [ ] **Step 3: 写 createAutoloadLoaderScript 测试**

```typescript
describe('createAutoloadLoaderScript', () => {
  it('should escape backslashes in Windows paths', () => {
    const script = createAutoloadLoaderScript('C:\\Users\\test\\script.gd');
    expect(script).toContain('C:/Users/test/script.gd');
  });

  it('should escape quotes in paths', () => {
    const script = createAutoloadLoaderScript('path/with"quote.gd');
    expect(script).toContain('path/with\\"quote.gd');
  });
});
```

- [ ] **Step 4: 运行测试并确认覆盖率提升**

运行: `npx vitest run --coverage src/gdscript-executor.ts`
预期: 覆盖率从 ~7.5% 提升到 ~40%

- [ ] **Step 5: 提交**

```bash
git add test/gdscript-executor.test.ts
git commit -m "test: add unit tests for gdscript-executor core functions (C-CI-02)"
```

---

### Task 9: I-Q-01/02 重复代码统一到 shared.ts

**Files:**
- 修改: `src/tools/shared.ts`
- 修改: `src/tools/animation-shared.ts`
- 修改: `src/tools/animtree.ts`
- 修改: `src/tools/particles.ts`
- 修改: `src/tools/audio-ops.ts`
- 修改: `src/tools/spatial-ops.ts`
- 修改: `src/tools/animation-ops.ts`
- 修改: `src/tools/animation-track.ts`

- [ ] **Step 1: 对比各模块 ensureNumber 实现差异**

读取各模块的 `ensureNumber` 实现并对比边界行为（NaN、Infinity、默认值处理）。如果行为一致，统一到 shared.ts。如果有差异，选择最宽松的实现作为共享版本。

- [ ] **Step 2: 在 shared.ts 中添加统一工具函数**

```typescript
/** Ensure a value is a finite number, returning default on failure. */
export function ensureNumber(val: unknown, fallback = 0): number {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp a number to [min, max]. */
export function clampParam(val: unknown, min: number, max: number, fallback = 0): number {
  const n = ensureNumber(val, fallback);
  return Math.min(max, Math.max(min, n));
}

/** Validate and return a positive integer. */
export function validatePositiveInt(val: unknown, fallback = 1): number {
  const n = ensureNumber(val, fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
```

- [ ] **Step 3: 在 shared.ts 中添加 COMMON_ERROR_CODES**

```typescript
export const COMMON_ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_VALUE: 'INVALID_VALUE',
} as const;
```

- [ ] **Step 4: 逐模块替换导入**

对每个模块：
1. 删除本地 `ensureNumber`/`clampParam`/`validatePositiveInt` 定义
2. 添加 `import { ensureNumber, clampParam, validatePositiveInt } from './shared.js';`
3. 如果模块 `ERROR_CODES` 包含与 `COMMON_ERROR_CODES` 重复的键，替换为导入

- [ ] **Step 5: 运行全量测试**

运行: `npx vitest run`
预期: 全部通过（纯重构，行为不变）

- [ ] **Step 6: 提交**

```bash
git add src/tools/shared.ts src/tools/animation-shared.ts src/tools/animtree.ts src/tools/particles.ts src/tools/audio-ops.ts src/tools/spatial-ops.ts src/tools/animation-ops.ts src/tools/animation-track.ts test/
git commit -m "refactor: unify ensureNumber/clampParam/validatePositiveInt to shared.ts (I-Q-01/02)"
```

---

## Batch 3: P2 代码质量（4 项）

### Task 10: C-Q-03/04/05 材质/tilemap/shader 重复代码重构

**Files:**
- 修改: `src/tools/material-ops.ts`
- 修改: `src/tools/tilemap-ops.ts`

- [ ] **Step 1: 在 material-ops.ts 提取 parseMaterialParam**

将 6 个函数中重复的材质参数解析逻辑提取为：

```typescript
function parseMaterialParam(value: unknown): string {
  if (typeof value === 'number') return `${value}`;
  if (typeof value === 'string') return `"${gdEscape(value)}"`;
  if (Array.isArray(value)) {
    if (value.length === 2) return `Vector2(${value[0]}, ${value[1]})`;
    if (value.length === 3) return `Vector3(${value[0]}, ${value[1]}, ${value[2]})`;
    if (value.length === 4) return `Color(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]})`;
  }
  return `${value}`;
}
```

- [ ] **Step 2: 替换 6 个函数中的重复代码**

在 `handleRead`、`handleSetParams`、`handleCreate`、`handleWrite` 等函数中，将重复的参数解析 if-else 替换为 `parseMaterialParam(value)` 调用。

- [ ] **Step 3: 在 tilemap-ops.ts 提取 getTileMapAPI 统一双 API**

创建辅助函数区分 TileMap（多层）和 TileMapLayer（单层）API 差异：

```typescript
function buildTileOpScript(nodePath: string, op: string, params: Record<string, unknown>): string {
  // 根据 node 类型（TileMap vs TileMapLayer）生成对应的 GDScript
}
```

- [ ] **Step 4: 运行全量测试**

运行: `npx vitest run`
预期: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/tools/material-ops.ts src/tools/tilemap-ops.ts
git commit -m "refactor: extract shared parsers in material-ops and tilemap-ops (C-Q-03/04/05)"
```

---

### Task 11: C-CI-03 delivery.ts 测试覆盖提升

**Files:**
- 修改: `test/delivery.test.ts`（或新建）

- [ ] **Step 1: 为 verify_delivery 各维度写测试**

覆盖 scene_tree、script_health、performance、assertions 四个检查维度。为每个维度写 2-3 个测试用例，使用 mock 的项目结构和文件。

- [ ] **Step 2: 运行测试确认覆盖率提升**

运行: `npx vitest run --coverage src/tools/delivery.ts`
预期: 覆盖率从 ~3% 提升到至少 25%

- [ ] **Step 3: 提交**

```bash
git add test/delivery.test.ts
git commit -m "test: add delivery verification dimension tests (C-CI-03)"
```

---

### Task 12: I-CI-01 添加真实逻辑测试

**Files:**
- 新建或修改测试文件

- [ ] **Step 1: 选择 3 个关键模块添加 GDScript 生成验证测试**

选择 `shared.ts`（gdEscape、SCENE_TREE_HEADER）、`test-framework.ts`（genStressTestScript）、`recording.ts`（genRecordingPlayScript）。

为每个模块验证生成的 GDScript 代码：
- 包含正确的缩进（无空格/tab 混用）
- 包含预期的函数调用
- 转义了特殊字符

```typescript
describe('GDScript generation correctness', () => {
  it('genStressTestScript should use consistent tab indentation', () => {
    const script = genStressTestScript({ node_type: 'Node', iterations: 10 });
    const lines = script.split('\n');
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const leadingSpaces = line.match(/^ +/);
      expect(leadingSpaces).toBeNull(); // 无空格前导
    }
  });
});
```

- [ ] **Step 2: 运行测试**

运行: `npx vitest run`
预期: PASS

- [ ] **Step 3: 提交**

```bash
git add test/
git commit -m "test: add GDScript generation correctness tests (I-CI-01)"
```

---

### Task 13: I-Q-06/07/08 类型断言和空 catch 块修复

**Files:**
- 修改: `src/tools/ik-tools.ts`（2 处 as any）
- 修改: 多文件（空 catch 块）
- 修改: 多文件（as Record 断言）

- [ ] **Step 1: 修复 ik-tools.ts 的 as any**

将两处 `as any` 替换为具体的类型守卫或正确的类型定义。

- [ ] **Step 2: 修复关键空 catch 块**

扫描所有空 catch 块，对以下 10 处关键位置添加错误日志：

```typescript
// 旧
} catch {
}
// 新
} catch (err) {
  console.debug('[module] operation context:', err);
}
```

优先级：涉及文件 I/O、子进程、网络操作的 catch 块。

- [ ] **Step 3: 为安全相关 as Record 添加验证**

在涉及用户输入的路径上，将 `as Record<string, unknown>` 替换为：

```typescript
if (typeof val !== 'object' || val === null) {
  return opsErrorResult('INVALID_PARAMS', 'Expected object');
}
const obj = val as Record<string, unknown>;
```

- [ ] **Step 4: 运行全量测试**

运行: `npx vitest run`
预期: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/tools/ik-tools.ts src/tools/
git commit -m "fix: replace unsafe type assertions and add catch logging (I-Q-06/07/08)"
```

---

## 验证检查清单

全部任务完成后：

- [ ] `npx tsc --noEmit` — 零错误
- [ ] `npx vitest run` — 全部通过
- [ ] `npx eslint src/` — 无 error（warn 可接受）
- [ ] 更新 CHANGELOG.md 添加 v0.15.0 变更说明
- [ ] 更新版本号 `package.json` → `0.15.0`
