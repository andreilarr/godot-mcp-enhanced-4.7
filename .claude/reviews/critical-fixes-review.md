# CRITICAL 修复审查报告

**审查日期**: 2026-06-06
**分支**: master (未提交的修改)
**决策**: ✅ APPROVE（附 2 条 MEDIUM 建议）

## 概要

7 个 CRITICAL 修复全部正确实施，逻辑完备，无回归。1876 测试通过，TypeScript 类型检查通过。

## 修复逐项审查

### C-01: Promise 缓存失败后无法重试 ✅
**文件**: `src/gdscript-executor.ts:203-211`

`ensureBaseDir()` 的 `??=` 缓存了 rejected Promise，导致后续调用永久失败。修复在 `.catch()` 中清除 `baseDirPromise = null`，允许下次重试。

**评价**: 正确。`catch` 链在 `then` 之后，rejected Promise 的异常会被捕获并清除缓存，同时重新抛出以通知调用方。

---

### C-02: project_replace 原子写入无回滚 ✅
**文件**: `src/tools/script.ts:826-871`

三步式原子写入：(1) 写 .tmp (2) 备份原文件到 .bak (3) rename .tmp → 目标。失败时按 `renamedCount` 回滚已重命名的文件。

**评价**: 逻辑完备。三步失败场景全部覆盖：
- Step 1 失败：原文件未动，只需清理 .tmp
- Step 2 失败：无 rename 发生，原文件未动，清理 .tmp + 已创建的 .bak
- Step 3 失败：回滚已 rename 的文件从 .bak 恢复，清理残余

**建议 (MEDIUM)**: `.bak` / `.tmp` 文件在进程崩溃（如 OOM kill）时会残留。可考虑在 `project_replace` 入口处加一个 `cleanupStaleTempFiles()` 扫描清理上次的残留文件，或至少在文档中说明此行为。

---

### C-03: 沙箱遗漏 Engine.get_singleton ✅
**文件**: `src/gdscript-executor.ts`

将 `Engine.get_singleton` 加入 `DANGEROUS_PATTERNS` 和 `DANGEROUS_API_TOKENS`。

**评价**: 正确。`Engine.get_singleton` 可访问渲染、物理等核心单例，是有效的沙箱逃逸路径。

---

### C-04: 模块级可变状态的竞态条件 ✅
**文件**: `src/core/process-state.ts:79-96`

新增 `enqueue<T>`（同步）和 `enqueueAsync`（异步）序列化队列。`resetState()` 重置队列尾。

**评价**: 异步队列设计正确。`enqueueAsync` 通过 Promise 链确保异步操作串行执行。`resetState()` 在重置状态时同时重置队列。

**建议 (MEDIUM)**: `enqueue<T>` 的 JSDoc 说 "otherwise waits for prior operations"，但实现是直接执行（同步操作在 Node.js 事件循环中天然原子）。注释与实现不一致，建议改为 "Runs immediately — sync operations are atomic in Node.js single-threaded model"。

---

### C-05: GDScript 属性类型校验始终返回 true ✅
**文件**: `addons/godot_mcp_server/commands/command_helpers.gd:69`

将 `return true  # Godot is flexible with types` 改为 `return false  # type mismatch — reject`。

**评价**: 正确。函数在 float/int 互换和 string 强转后，对剩余类型不匹配应返回 false。原代码无条件返回 true 使整个类型检查形同虚设。

---

### C-06: recording_play 返回 events_played 而非 events_queued ✅
**文件**: `addons/godot_mcp_server/commands/recording_commands.gd:89,108`

编辑器插件的 `handle_recording_play` 返回时事件只是排入了 Timer 队列，尚未播放完毕。字段名从 `events_played` 改为 `events_queued`。

**评价**: 正确。语义准确性修复，避免调用方误认为事件已全部播放。TS 端 headless 路径的 `events_played` 在 `playback_complete` 事件中报告，此时确实已播放完毕，不需要修改。

---

### C-07: 多客户端连接时 monitor/watch 状态冲突 ✅
**文件**: `src/scripts/mcp_bridge.gd`（主要重构）

将 12 个全局变量替换为两个 per-peer 字典（`_monitor_states`、`_watch_states`）。信号回调通过 `Callable.bind(peer_id)` 传递客户端上下文。断连时 `_cleanup_peer_state(pid)` 清理状态。

**评价**: 重构完整且设计良好：
- `_handle_message` 签名正确增加了 `pid` 参数并贯穿所有命令
- `_get_watch_callable(peer_id)` 每次从字典读取状态，确保回调时上下文正确
- `_on_watched_signal_0..4` 使用 `.bind(peer_id)` 固定参数数量，避免 Godot 信号 arity 不匹配
- `_cleanup_peer_state` 在 peer 断连时同步清理 monitor 和 watch 状态
- `_process` 循环从遍历单变量改为遍历字典，dead monitor 自动清理

附带改进（合理打包在同一 diff 中）：
- Bridge 秘钥写入强制使用 `.godot/` 目录，不再回退 tmpdir（安全加固）
- headless 模式跳过 Bridge 启动（`DisplayServer.get_name() == "headless"` 检查）

## 验证结果

| 检查 | 结果 |
|------|------|
| TypeScript 类型检查 | ✅ Pass |
| 单元测试 (107 files) | ✅ 1876 passed |
| 构建错误 | ✅ None |

## 发现汇总

| 严重度 | 数量 |
|--------|------|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| LOW | 0 |

### MEDIUM 发现

1. **C-02 原子写入残留文件**: 进程崩溃时 `.bak`/`.tmp` 文件残留无自动清理机制。
2. **C-04 `enqueue` 注释不准确**: JSDoc 声称 "waits for prior operations" 但实现是直接执行。

## 审查结论

7 个 CRITICAL 修复逻辑正确、测试覆盖、无回归。2 条 MEDIUM 建议可在后续迭代中处理，不阻塞合并。

**决策: ✅ APPROVE**
