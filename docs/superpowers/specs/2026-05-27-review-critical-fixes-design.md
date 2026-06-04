# 代码审查 CRITICAL 修复设计

**日期:** 2026-05-27
**基于:** 6 代理并行审查报告（95 项发现，14 项 CRITICAL）
**范围:** 全部 14 项 CRITICAL + 关联 IMPORTANT 修复

---

## 修复策略

分三批按优先级修复，每批完成后运行全量测试验证：

1. **P0 快速修复**（5 项）— 安全漏洞 + 竞争条件 + 功能损坏
2. **P1 功能修复**（5 项）— 沙箱 + 架构 + 测试覆盖 + 代码统一
3. **P2 代码质量**（4 项）— 重复代码重构 + 类型安全 + 测试增强

---

## P0 — 立即修复（5 项）

### 1. C-SEC-01: 路径白名单改为 deny-by-default

**文件:** `src/helpers.ts:105-114`

**现状:** `isPathInAllowedRoots()` 当 `ALLOWED_PROJECT_PATHS` 未设置时返回 `true`（允许所有路径）。

**修复:**
- 未设置白名单时，回退到当前工作目录 `process.cwd()` 作为唯一允许的根路径
- 添加 `GODOT_MCP_UNRESTRICTED` 环境变量显式启用无限制模式（默认关闭），替代废弃的 `ALLOW_OUTSIDE_PROJECT_PATHS`
- 在启动时打印明确的安全模式日志

```typescript
// helpers.ts 修改
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') return true;
  const allowed = getAllowedProjectPaths();
  if (allowed.length === 0) {
    // deny-by-default: 仅允许当前工作目录
    const cwd = resolvePath(process.cwd());
    const resolved = resolvePath(requestedPath);
    return resolved === cwd || resolved.startsWith(cwd + sep);
  }
  const resolved = resolvePath(requestedPath);
  return allowed.some(p => resolved === p || resolved.startsWith(p + sep));
}
```

**影响范围:** 所有使用 `isPathInAllowedRoots` 的工具路径验证。deny-by-default 可能影响未设置白名单的现有用户 — 需要在 CHANGELOG 和启动日志中明确说明。

**与 P1-9 合并：** P1-9 (I-SEC-01) 修复 `list_projects` 的 `search_dir` 白名单绕过。由于 `isPathInAllowedRoots` 的默认行为变更直接影响 `list_projects`，这两项必须在同一批次完成。

**`list_projects` 处理策略：** `list_projects` 是只读操作（扫描目录查找 project.godot），但搜索目录受白名单限制。修复方案：
- `project.ts:107` 的 `validatePath(searchDir)` 已有路径规范化
- 额外在 `GodotServer.ts` 的 dispatch 中对 `search_dir` 也走 `isPathInAllowedRoots` 检查（与 `project_path` 同等对待）
- 错误信息提示用户设置 `ALLOWED_PROJECT_PATHS` 或 `GODOT_MCP_UNRESTRICTED=true`

**废弃迁移时间线：**
- v0.15: `GODOT_MCP_UNRESTRICTED` + `ALLOW_OUTSIDE_PROJECT_PATHS` 同时支持，后者打印 deprecation warning
- v0.16: 移除 `ALLOW_OUTSIDE_PROJECT_PATHS`，仅保留 `GODOT_MCP_UNRESTRICTED`

---

### 2. C-CI-01: 添加 eslint 配置和 CI lint

**文件:** 新建 `eslint.config.js`，修改 `.github/workflows/ci.yml`、`package.json`

**现状:** 项目已有 CI（`.github/workflows/ci.yml`，含 tsc + build + vitest + codecov），但无 lint 步骤、无 eslint 配置文件、package.json 无 lint 脚本。

**修复:**
- 创建 `eslint.config.js`（使用 typescript-eslint flat config）
- `package.json` 添加 `"lint": "eslint src/"` 脚本（放在 build 之前）
- CI 在 tsc 步骤之前增加 `npm run lint`
- 初期配置宽松（warn-only），避免一次性修复所有 lint 问题

```javascript
// eslint.config.js
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
    }
  },
  { ignores: ['build/', 'coverage/', 'node_modules/'] }
);
```

---

### 3. C-Q-01: test_stress 缩进修复

**文件:** `src/tools/test-framework.ts:239-240`

**现状:** `\tfor _f in range(3):` 后的 `await get_tree().process_frame` 使用了空格缩进而非 tab。

**修复:** 一行改动，将空格缩进改为 tab。

```
// 修改前（第 240 行）
        await get_tree().process_frame
// 修改后
\t\t\tawait get_tree().process_frame
```

---

### 4. C-TYP-01: game-bridge 连接竞争条件

**文件:** `src/tools/game-bridge.ts`

**现状:** `_ensureConnection()` 无序列化保护，多个并发请求可能同时建立连接。

**修复:** 添加连接锁 Promise 链，将并发连接请求串行化。

```typescript
// game-bridge.ts 添加
let _connectionLock: Promise<Socket> | null = null;

function _ensureConnection(timeout: number): Promise<Socket> {
  if (_socket && _socketAuthenticated && !_socket.destroyed && _socket.writable) {
    return Promise.resolve(_socket);
  }
  // 如果已有正在进行的连接尝试，等待它而不是新建连接
  if (_connectionLock) return _connectionLock;

  _connectionLock = _doConnect(timeout)
    .then(sock => {
      // 双重检查：连接期间可能被 setBridgeProjectDir() 触发的 _invalidateSocket() 失效
      if (_socket !== sock || !_socketAuthenticated) {
        throw new Error('Connection invalidated during setup');
      }
      return sock;
    })
    .finally(() => { _connectionLock = null; });
  return _connectionLock;
}
```

将现有 `_ensureConnection` 的连接逻辑提取到 `_doConnect(timeout)`，`_ensureConnection` 负责锁和缓存检查。双重检查确保在等待锁期间被 `_invalidateSocket()` 的情况不会返回失效连接。

---

### 5. C-TYP-02: process-state TOCTOU 竞争

**文件:** `src/core/process-state.ts`、`src/tools/scene.ts`、`src/tools/runtime.ts`、`src/GodotServer.ts`

**现状:** `isProcessBusy()` 检查和 `setProcessBusy(true)` 之间存在时间窗口，两个并发请求可同时通过。

**全部调用点：**
| 文件 | 行号 | 当前模式 |
|------|------|----------|
| scene.ts | 456, 509 | `if (isProcessBusy()) return error;` → 调用 runtime 函数 |
| runtime.ts | 179 | `setProcessBusy(true)` — 在 spawn 后设置 |
| runtime.ts | 133,158,166,172,189 | `setProcessBusy(false)` — 在各错误/完成路径 |
| GodotServer.ts | 365 | `setProcessBusy(false)` — 外部清理 |

**修复:** 用 `acquireProcessSlot()` 原子操作替代 isBusy + spawn 两步模式。

```typescript
// process-state.ts 添加
export function acquireProcessSlot(): boolean {
  if (_processBusy) return false;
  _processBusy = true;
  return true;
}
```

**各文件修改：**
- `scene.ts:456,509` — `isProcessBusy()` → `acquireProcessSlot()`（同时删除后续 runtime 路径中的 `setProcessBusy(true)`，因为 acquire 已设置）
- `runtime.ts:179` — 删除 `setProcessBusy(true)`（已由 scene.ts 的 acquire 设置）
- `runtime.ts:133,158,166,172,189` — 保持 `setProcessBusy(false)` 不变（释放点不变）
- `GodotServer.ts:365` — 保持 `setProcessBusy(false)` 不变（外部清理释放点）
- ~~`gdscript-executor.ts`~~ — 该文件不调用 isProcessBusy/setProcessBusy，无需修改

**acquire/release 配对关系：**
- acquire: `acquireProcessSlot()` 在调用入口（scene.ts / gdscript-executor.ts）
- release: `setProcessBusy(false)` 在所有退出路径（runtime.ts / GodotServer.ts）

---

## P1 — 本迭代修复（5 项）

### 6. C-SEC-02: GDScript 沙箱（危险函数黑名单）

**文件:** `src/gdscript-executor.ts`

**修复:**
- 添加可选的 `GODOT_MCP_SANDBOX` 环境变量
- sandbox 模式下扫描 GDScript 代码中的危险函数调用（`OS.execute`、`OS.shell_open`、`DirAccess.remove`、`FileAccess.open(..., WRITE)` 等）
- 不阻断执行，但在执行前输出警告到 MCP 结果中
- 非默认启用，需显式设置 `GODOT_MCP_SANDBOX=strict`

**扫描规则:** 用正则匹配 `OS\.(execute|shell_open|kill|set_restart_on_exit)` 和 `DirAccess\.(remove|rename)` 等危险操作，警告但不阻断（因为合法脚本可能需要这些功能）。

---

### 7. C-Q-02: 录制功能重构为纯 Bridge 模式

**文件:** `src/tools/recording.ts`

**现状:** `recording_start` 在临时 SceneTree 脚本中注册 `_input` 回调并退出，`recording_stop` 从 Bridge meta 读取。两个独立进程无法共享状态。

**修复:**
- `recording_start` 改为通过 Bridge TCP 发送 `recording.start` 命令
- `recording_stop` 改为通过 Bridge TCP 发送 `recording.stop` 命令
- 录制状态和事件由 Bridge GDScript 脚本 (`mcp_bridge.gd`) 维护
- 无 Bridge 连接时返回明确错误

如果 Bridge 不可用（headless 模式），返回明确错误："录制功能需要 Game Bridge 连接，headless 模式不支持。"

**Bridge GDScript 端改动（`src/scripts/mcp_bridge.gd`）：**

新增状态变量和命令：

```gdscript
# 录制状态（在成员变量区添加）
var _recording: bool = false
var _recorded_events: Array = []
var _record_start_time: int = 0
```

在 `_handle_message` 的 match 语句中添加两个新方法：

```gdscript
"recording.start":
    result = _cmd_recording_start()
"recording.stop":
    result = _cmd_recording_stop()
```

新增命令实现：

```gdscript
func _cmd_recording_start() -> Dictionary:
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
```

在 `_process` 中添加输入事件捕获（录制开启时）：

```gdscript
# 在 _process 函数末尾、peer 清理之前
if _recording:
    # 注意：_process 不接收 InputEvent，需要用 _input 或 _unhandled_input
    # 改用 set_process_input 在录制开始时注册
```

由于 `Node._process` 无法接收输入事件，需要在 `_ready` 中添加 `_set_process_input(true)`，并实现 `_input` 回调：

```gdscript
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

**版本兼容：** 旧版 Bridge 不支持 `recording.start/stop`，会返回 `-32601 Method not found`。TypeScript 端应检测此错误码并返回友好提示："请更新项目中的 MCP Bridge 脚本以支持录制功能。运行 `install-plugin` 获取最新版本。"

**TypeScript 端 `recording.ts` 修改：**
- `recording_start` handler：检查 `loadAutoloads`，若有则调用 `sendToBridge('recording.start')`，否则返回错误
- `recording_stop` handler：调用 `sendToBridge('recording.stop')`，解析返回的 events
- 删除 `genRecordingStartScript()` 和 `genRecordingStopScript()` 中基于 SceneTree 的旧实现

---

### 8. C-CI-02: gdscript-executor 测试覆盖提升

**文件:** `test/gdscript-executor.test.ts`

**修复:** 为以下核心函数添加单元测试：
- `wrapSnippet()` — 片段包装、完整类透传、空代码处理
- `buildSafeEnv()` — 白名单变量传递、敏感变量过滤
- `createAutoloadLoaderScript()` — 路径转义、null 脚本处理
- `createProjectScript()` — .tscn 文件生成正确性

目标：将覆盖率从 7.53% 提升到至少 40%。

---

### 9. I-SEC-01: list_projects 的 search_dir 白名单绕过

**文件:** `src/GodotServer.ts:92-94`

**现状:** `list_projects` 的 `search_dir` 参数直接接受用户输入，未经过白名单检查。

**修复:** 在 `list_projects` 的 handler 中添加 `isPathInAllowedRoots(searchDir)` 检查。

---

### 10. I-Q-01/02: 重复代码统一到 shared.ts

**文件:** `src/tools/shared.ts` + 9 个模块

**修复:**
- 将 `ensureNumber`、`clampParam`、`validatePositiveInt` 统一到 `shared.ts`
- 将 `ERROR_CODES` 常量统一为 `shared.ts` 中的 `COMMON_ERROR_CODES`
- 各模块从 shared 导入，删除本地定义
- 保持模块特有的 ERROR_CODES 条目在各自文件中

---

## P2 — 下一迭代（4 项）

### 11. C-Q-03/04/05: 材质/tilemap/shader 重复代码重构

**修复:**
- `material-ops.ts`: 提取 `parseMaterialParam(value, targetType)` 共享函数
- `tilemap-ops.ts`: 提取 `getTileMapAPI(nodePath)` 工厂返回统一接口
- `material-ops.ts`: 合并 shader/材质写入为参数化 `buildWriteScript()`

### 12. C-CI-03: delivery.ts 测试覆盖提升

为 `verify_delivery` 的每个检查维度（scene_tree、script_health、performance、assertions）添加集成测试。

### 13. I-CI-01: 添加真实逻辑测试

选择 3-5 个最关键的工具模块，从 mock 测试过渡到验证实际 GDScript 生成代码的正确性（字符串匹配/AST 级别）。

### 14. I-Q-06/07/08: 类型断言和空 catch 块修复

- `ik-tools.ts` 两处 `as any` 改为正确的类型守卫
- 30 处 `as Record` 添加运行时验证
- 10 处空 catch 块添加错误日志或重新抛出

---

## 测试验证

每批修复完成后执行：
1. `npx tsc --noEmit` — 类型检查
2. `npx vitest run` — 全量测试
3. `npx eslint src/` — lint 检查（P0 第 2 项完成后）
4. 手动验证关键修复（白名单行为、并发连接）

## 回滚策略

P0 安全修复（deny-by-default）可能影响现有用户。部署后如有回归：
- 设置 `GODOT_MCP_UNRESTRICTED=true` 即可恢复旧行为（逃生阀）
- 该环境变量与 `ALLOW_OUTSIDE_PROJECT_PATHS=true` 功能等价
- 在 CHANGELOG 和启动日志中明确标注此变更和逃生方案
