# Godot MCP Enhanced 项目配置

## MCP 工具验证规则

编辑 `.gd` 文件后，必须运行 `validate_scripts` 验证语法。
使用 `edit_script` 时优先选择 `search_and_replace` 模式（CRLF 安全、行号偏移鲁棒）。

## 发版门禁

每次发版前必须运行 `verify_delivery`，确保场景树完整性 + 脚本健康 + 性能正常 + 自定义断言通过。

## MCP 子系统速查（详细指南见 .claude/rules/godot-mcp-*.md）

| 子系统 | 入口工具 | 核心能力 | 前提 | rule 文件 |
|--------|---------|---------|------|----------|
| **模式选择** | — | Headless/Editor/Bridge 决策树 | — | core |
| Editor | launch_editor | 实时场景树同步、undo | 编辑器运行中 | editor |
| Bridge | game_bridge_install | 查询/输入/写入/等待/监控/信号/UI发现 | 游戏运行中 | bridge |
| UI 布局 | ui_build_layout | CSS Flexbox/Grid 翻译 | headless | ui |
| 录制回放 | recording_start | 捕获→保存→回放 | Bridge 连接 | recording |
| 粒子 | particles_create | GPU 粒子 + 6 种预设 | headless | particles |
| TileMap | tilemap_read | 读写/填充/复制/变换 | headless | tilemap |
| 动画 | animation | 播放/编辑/AnimationTree | headless | animation |
| 导航 | nav_create_region | Region/Agent/Link | headless | navigation |
| 材质 | material_read | 材质读写/着色器 | headless | material |
| 信号 | signal_connect | 连接/断开/发射/列出 | headless | signal |
| 音频 | audio_play | 播放/停止/参数/状态 | headless | audio |
| 工作流 | dev_loop | 执行→验证→截图一体化 | headless | workflow |
