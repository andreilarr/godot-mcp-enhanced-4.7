# godot-mcp-enhanced 发展路线图

> 历史里程碑记录。**当前版本与完整变更历史以 [CHANGELOG.md](CHANGELOG.md) 和 `package.json` 为准**
> (本文件编写于 v0.18.1)。IMPORTANT-16: 不再在此标记"当前版本",避免与 package.json 漂移。

## v0.14.0（2026-05-24）

7 轴全维度审查修复 + IK 框架 MVP + 测试基础设施升级。

- [x] IK 框架 MVP（4 工具）：ik_modifier_create / ik_modifier_get / ik_modifier_set / ik_list_bones
- [x] 7 轴审查：8 CRITICAL + 20 IMPORTANT + 14 ADVISORY 发现，全部 CRITICAL 已修复
- [x] C-01: EditorConnection 认证超时重连保护
- [x] C-02: Loader 脚本错误标记随机化防伪造
- [x] C-03: 进程替换 busy guard 守卫
- [x] T-01~T-10: GDScript _initialize() 修复 + null 检查 + 缩进统一 + draw_arc point_count
- [x] 测试迁移 node:test → Vitest，1257 测试通过，47% 覆盖率
- [x] 属性测试（fast-check）+ 快照测试
- [x] CI/CD GitHub Actions（Node 20/22 矩阵）

---

## v0.13.0（2026-05-23）

Bridge 安全加固 + 功能增强。

- [x] Bridge 安全加固 20 项审计发现
- [x] requestId 取模保护（防溢出）
- [x] EditorConnection 重连上限（maxReconnectAttempts）
- [x] CSS Grid 翻译层（ui_build_layout layout.direction="grid"）
- [x] edit_node / trySetHelper 属性名自动 camelCase→snake_case 转换
- [x] L015 lint 规则改为逐行扫描 + isInCommentOrString 过滤

---

## v0.12.0（2026-05-23）

安全修复 + 验证交付 + dev_loop 增强。

- [x] 迭代 URL 解码防路径遍历（最多 5 轮）
- [x] Bridge 密钥文件生命周期管理
- [x] 认证锁定断开连接
- [x] 编辑器 WebSocket 限速（暴力破解防护）
- [x] verify_delivery 4 维度验证（场景树/脚本/性能/断言）
- [x] dev_loop acceptance 验收标准参数
- [x] L1 quickVerify 轻量验证嵌入 write 工具

---

## v0.11.0~v0.11.1（2026-05-22）

安全修复 + CSS Flexbox + Lint 引擎。

- [x] CSS Flexbox 布局翻译层（ui_build_layout）
- [x] GDScript Lint 规则引擎（validate_scripts）
- [x] Bridge TCP 绑定 127.0.0.1
- [x] Bridge 密钥文件读后即删
- [x] 临时目录符号链接防护
- [x] 多字节字符绕过 1MB 消息大小限制修复
- [x] TCP Bridge 缓冲区限制
- [x] opsErrorResult() 返回 isError: true

---

## v0.10.0（2026-05-19）

CSS Flexbox + Lint + 安全加固。

- [x] 路径遍历防护增强
- [x] GDScript 转义顺序修复
- [x] confirm_and_execute 只读守卫绕过修复
- [x] Windows 进程终止统一
- [x] 认证锁定绕过修复
- [x] 模取偏差修复
- [x] GDScript 字符串字面量修复
- [x] 定时器泄漏修复

---

## v0.9.0（2026-05-16）

审查反馈 + 架构优化（118 工具，463 测试）。

- [x] 批量工具：batch_add_nodes / batch_create_files / batch_run_verify / batch_validate
- [x] UI 工具：ui_create_control / ui_set_layout / ui_get_layout / ui_anchor_preset 等
- [x] 录制系统：recording_start / stop / save / load / play（5 工具）
- [x] 编辑器同步：editor_sync 初始版本
- [x] 确认令牌机制
- [x] Read-Only 模式（--read-only）
- [x] Lite 模式（--mode lite）
- [x] 性能分析增强

---

## v0.8.0（2026-05-13）

架构升级（96 工具）。

- [x] P1 — 双模式架构：Editor WebSocket JSON-RPC 2.0 + GDScript 编辑器插件 + UndoManager
- [x] P2 — 测试框架 + 导出管理：test_assert / test_stress / export_*（5 工具）
- [x] P3 — 高级工具集：粒子系统(5) + 导航系统(5) + AnimationTree(5)
- [x] 同步 GDScript 编辑器命令模块

---

## v0.7.0 及更早

| 版本 | 日期 | 要点 |
|------|------|------|
| v0.7.0 | 2026-05-08 | 安全加固：输入转义、超时泄漏、类型安全、crypto.randomUUID |
| v0.6.0 | 2026-05-03 | 音频播放控制(4) + TileMap 编辑(8) |
| v0.5.0 | 2026-05-02 | 信号控制(4) + 物理查询(2) + 3D 创建(1) + 导航寻路(1) |
| v0.4.0 | 2026-05-01 | 版本检测 + validate_scripts + search_and_replace |
| v0.3.0 | — | edit_script + batch_add_nodes + validate_project + import_resources |
| v0.2.0 | — | read_scene + read/write_script + query_scene_tree + MCP Resources |
| v0.1.0 | — | 基础功能：项目/场景/执行控制/截图/API 文档 |
