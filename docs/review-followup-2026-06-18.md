# 2026-06-18 增量复审 — 后续 issue 清单

**来源**：`D:\workspace\review\.claude\reviews\2026-06-18-godot-mcp-enhanced-deep-review.md`（6 子代理 + 主审）
**截至**：commit `35afe1b`（HEAD）
**总计**：约 30 IMPORTANT — 已处理 4 / push back 4 / 待办 22

---

## ✅ 已处理（本会话）

| # | 标题 | 提交 |
|---|---|---|
| S1 | verifyApiToken 接收端零接线 → MULTI_INSTANCE 启动警告 | 2321feb |
| E2 | command_handler 未设 `.name` 致 plugin.gd cleanup 死代码 | 35afe1b |
| F1 | generate-doc-db.js execSync 命令注入 → execFileSync 数组参数 | 35afe1b |
| F2 | `.cursor/mcp.json` 本地路径 git 跟踪 → example 化 + gitignore | 35afe1b |

---

## ⏸ push back（报告自述 / 技术理由，非阻断）

| # | 标题 | 理由 |
|---|---|---|
| D1 | launch_editor detached+unref 进程脱离 | 报告第六节自降级：编辑器独立生命周期是**有意设计**（独立于 MCP server，否则打断用户工作），非静默泄漏 |
| G1 | 并发派发场景零测试覆盖 | 报告自降级：测试盲区非生产 bug；C-CONC-1 并发重构本身正确（子代理 D 验证） |
| G2 | test/setup.js 全局禁白名单覆盖薄弱 | 报告自降级：测试可行性取舍，生产 deny-by-default 正确 |
| E1 | plugin.gd `_enter_tree`/`_exit_tree` 未调 super() | **疑似误判**（同 f7cab67 教训）：plugin.gd `extends EditorPlugin`（原生类），其虚函数调 super() 在 Godot 4.6.2 触发 Parse error。清单 §2.2 "调 super()" convention 仅适用 extends 自定义基类。需 GUI 实测确认，但大概率应保持不调 |

---

## 📋 待办（22 项，按维度分组）

### 维度 S — 安全核心
- [ ] **S2** guard.ts `wasTruncated` 消费点检查 + 测试
  - 文件：`src/guard.ts:120,140` + ToolDispatcher confirm 路径
  - 问题：截断(>10KB)的 execute_gdscript 代码块是否在 confirm_and_execute 拒绝执行？子代理 B/G 确认该分支无专门验证 + 无测试(CR-T3)
  - 建议：confirm 消费点显式检查 `wasTruncated`，拒绝执行 + 补测试

### 维度 B — MCP 协议/分发
- [ ] **B1** editor 模式完全绕过 response-limiter
  - 文件：`src/core/ToolDispatcher.ts:310-323,275-288`
  - 问题：`truncateResponse` 全仓库仅 headless 调用一次；editor 两处返回点不调，`GODOT_MCP_RESPONSE_LIMIT` 对 editor 完全无效（read_scene/query_scene_tree 大响应原样回传）
  - 建议：editor 返回点也调 truncateResponse
- [ ] **B2** inputSchema.required 未服务端强制
  - 文件：`src/core/ToolDispatcher.ts:433-453` + `middleware.ts:111`
  - 问题：`createElicitationMiddleware` 实现了完整 required 校验但**从未接线** buildMiddleware；新工具若忘内部校验暴露未校验参数
  - 建议：接线 createElicitationMiddleware 或 validateCommonArgs 加 required 检查

### 维度 C — 文件系统/TSCN 解析
- [ ] **C1** tscn-parser parseTscn 不校验 `[gd_scene]` 头
  - 文件：`src/tscn-parser.ts:335-349`
  - 问题：畸形输入静默返回空 header 无警告
  - 建议：校验 `[gd_scene]` 头，无效则警告/报错
- [ ] **C2** SubResource.id vs ExtResource.id 类型不一致
  - 文件：`src/tscn-parser.ts:401 vs 373`
  - 问题：SubResource.id 强制 string，ExtResource.id 支持 string|number
  - 建议：统一类型
- [ ] **C3** scene-merge parseSub regex CRLF 不健壮
  - 文件：`src/tools/scene-merge.ts:26`
  - 问题：lookahead 假设 LF，CRLF 输入出错
  - 建议：regex 兼容 CRLF
- [ ] **C4** mergeTscn 不校验合并后引用完整性
  - 文件：`src/tools/scene-merge.ts:199-216`
  - 问题：C-BUG-2 防新增悬空，但不检测已有悬空 ext/sub 引用
  - 建议：合并后校验引用完整性

### 维度 D — 进程/实例网络
- [ ] **D2** EditorConnection scheduleReconnect 无 jitter
  - 文件：`src/EditorConnection.ts:451-470`
  - 问题：对比 reconnection-manager 无 jitter，多实例重连风暴；catch 分支未检查 reconnectEnabled
  - 建议：加 jitter + catch 检查 reconnectEnabled
- [ ] **D3** EditorToolExecutor `_disconnectHandler` 清 syncActive
  - 文件：`src/core/EditorToolExecutor.ts:15-25`
  - 问题：清 syncActive 致重连后 sync 语义错乱、handleSyncStop 报错
  - 建议：不清 syncActive 或重连后重置
- [ ] **D4** killOrphanGodotProcesses PowerShell `-like` 通配符
  - 文件：`src/core/process-state.ts:321-328`
  - 问题：Windows PowerShell `-like` 通配符，路径含 `[`/`]` 误判
  - 建议：转义通配符或用精确匹配
- [ ] **D5** run_project acquireProcessSlot 与 setProjectDir 竞态
  - 文件：`src/tools/runtime.ts:140-148`
  - 问题：acquireProcessSlot 与 setProjectDir 间竞态窗口，stop_project 可能用旧 projectDir
  - 建议：原子化或加锁

### 维度 E — GDScript 插件
- [ ] **E3** recording_commands `_recorded_events` 无限增长
  - 文件：`addons/godot_mcp_server/commands/recording_commands.gd:13-42`
  - 问题：录制时 mouse_motion 每帧多次触发，长录制 OOM
  - 建议：环形缓冲或上限
- [ ] **E4** particle/nav/animtree/ui_commands 绕过 UndoRedo
  - 文件：`addons/godot_mcp_server/commands/{particle,nav,animtree,ui}_commands.gd`
  - 问题：与 node/scene 不一致，用户 Ctrl+Z 无法撤销
  - 建议：接入 UndoRedo（对齐 node_commands）
- [ ] **E5** heartbeat.gd resume() 重置所有 peer 计时
  - 文件：`addons/godot_mcp_server/heartbeat.gd:65-69`
  - 问题：resume() 重置所有 peer 计时，违背 per-peer 设计
  - 建议：仅重置目标 peer

### 维度 F — CLI 客户端/配置
- [ ] **F3** adapter 损坏 JSON 静默吞 + 覆盖无备份
  - 文件：`src/cli/clients/{claude-code,cursor,opencode}.ts`
  - 问题：损坏 JSON 静默吞异常并覆盖用户配置
  - 建议：备份原配置 + 报错而非覆盖
- [ ] **F4** codex.ts `--args` 多值展开语义未验证
  - 文件：`src/cli/clients/codex.ts`
  - 问题：多值展开语义未验证
  - 建议：验证 + 补测试
- [ ] **F5** config-parser 边界保护
  - 文件：`src/core/config-parser.ts`
  - 问题：超大输入、`0x` 前缀数字、未闭合引号缺乏边界保护
  - 建议：加长度上限 + 边界处理
- [ ] **F6** doctor OpenCode 检测误报
  - 文件：`src/cli/doctor.ts`（或相关）
  - 问题：二进制名可能是 `opencode-ai`，且用 stdout 长度而非退出码判断
  - 建议：检查 opencode-ai + 用退出码

### 维度 G — 测试覆盖（长期加固）
- [ ] **G1-补充** 并发派发（CR-1/CR-2 同构）专门测试
- [ ] **G2-补充** deny-by-default/path-utils 专门覆盖加强

---

## 建议优先级

1. **安全/正确性（P1）**：S2（截断代码执行）、B2（required 未强制）、C1（gd_scene 头）、C4（引用完整性）、D4（通配符误判）、F3（配置覆盖）
2. **资源/一致性（P2）**：E3（OOM）、E4（UndoRedo 一致）、B1（response-limiter editor）、D2/D3/D5（连接/竞态）
3. **健壮性（P3）**：C2、C3、E5、F4、F5、F6
4. **测试加固（P4）**：G1/G2 补充

---

## 备注

- 本清单基于报告（:95-228）+ 本会话验证。E1 经分析疑似误判（同 f7cab67 教训），建议 GUI 实测确认前保持不调 super()。
- D1/G1/G2 报告自述降级，push back。
- 所有项均为 IMPORTANT（非 CRITICAL），报告 APPROVED 可合并。
