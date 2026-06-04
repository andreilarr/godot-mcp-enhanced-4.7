# setup_project_rules CLAUDE.md 重构设计

## 目标

重构 `setup_project_rules` 的 CLAUDE.md 生成逻辑，遵循用户的 CLAUDE.md 配置规范：
- 主文件控制在 50-100 行，超出拆到 `.claude/rules/`
- 引擎版本约束第一条写明
- 框架模块用映射表指向 rules 文件

## 生成物

```
{project}/
├── CLAUDE.md                        # ~80 行，全局规则（智能合并）
└── .claude/
    ├── settings.json                # PostToolUse hook（不变）
    └── rules/
        └── godot-mcp.md             # 固定模板，详细规则（仅新建，不覆盖）
```

## CLAUDE.md 章节结构

每个章节由独立 builder 函数生成，全部从 `project.godot` 提取数据：

```
# {项目名}

## 引擎版本                           ← buildEngineVersion(config)
- Godot {从 config/features 提取版本号}

## 渲染器                             ← buildRenderer(config)
- {forward_plus / mobile / gl_compatibility}

## 项目关键路径                        ← buildKeyPaths(projectDir)
（扫描实际目录，只列出存在的）
├── scenes/ — 场景文件
├── scripts/ — GDScript 脚本
├── assets/ — 资源文件

## 主场景                             ← buildMainScene(config)
- {run/main_scene}

## Autoload                          ← buildAutoloads(config)
| 名称 | 路径 |
|------|------|
（无 autoload 则省略整个章节）

## Input Map                          ← buildInputMap(config)
（从 [input] 段提取动作名，压缩为一行摘要）
（无 [input] 段则省略）

## 物理设置                           ← buildPhysics(config)
- 重力: {physics/3d/default_gravity}
（默认值则省略整个章节）

## 层级名称                           ← buildLayerNames(config)
- 2D 物理: layer_1=Player, ...
- 3D 物理: ...
（无自定义名称则省略）

## MCP 规则映射                       ← buildMcpMapping()
| 领域 | rules 文件 |
|------|-----------|
| 脚本开发 | .claude/rules/godot-mcp.md |
```

## 章节省略规则

| 章节 | 省略条件 |
|------|---------|
| Autoload | 配置中无 autoload 条目 |
| Physics | 所有值均为引擎默认 |
| Layer Names | 无自定义层级名称 |
| Input Map | 无 [input] 段 |
| 渲染器 | 值为空或不存在 |

省略逻辑确保简单项目不会出现空章节。

### Builder 数据提取规则

| Builder | config 路径 | 提取逻辑 | 输出示例 |
|---------|-----------|---------|---------|
| `buildEngineVersion` | `config.application.config_features` 或 `config.features` | 取 `PackedStringArray("4.6")` 中的版本号；提取不到则返回 `"- Godot 4.x（版本未知）\n"` | `- Godot 4.6` |
| `buildRenderer` | `config.rendering.renderer` | 直接读取字符串值 | `- forward_plus` |
| `buildKeyPaths` | 文件系统扫描 | 候选目录：`scenes/`, `scripts/`, `assets/`, `addons/`, `shaders/`, `resources/`, `sounds/`, `music/`, `data/`。扫描项目根目录下的直接子目录，只列出存在的 | `├── scenes/ — 场景文件` |
| `buildMainScene` | `config.application.run/main_scene` | 直接读取路径 | `- res://scenes/main.tscn` |
| `buildAutoloads` | `config.autoload` | 遍历所有 autoload 条目。路径超 40 字符时截断加 `…` | `\| GlobalManager \| res://core/global.gd \|` |
| `buildInputMap` | `config.input` | 提取所有 action 名称，每行最多 5 个逗号分隔；超过 15 个只显示前 15 + `等 N 项` | `- actions: move_up, move_down, attack, jump, interact` |
| `buildPhysics` | `config.physics` | 检查 `3d/default_gravity`（默认 9.8）、`2d/default_gravity`（默认 980）、`common/physics_fps`（默认 60）。全为默认值则返回 null | `- 3D 重力: 20.0\n- 2D 重力: 980` |
| `buildLayerNames` | `config.layer_names` | 提取 `2d_physics`, `2d_render`, `3d_physics`, `3d_render` 下非空的层级名 | `- 2D 物理: 1=Player, 2=Enemy, 3=Bullet` |

所有 builder 当输入 config 为 null/undefined 或对应字段缺失时返回 null（章节省略），不抛异常。

## `.claude/rules/godot-mcp.md` 固定模板

```markdown
# Godot MCP 开发规则

## 脚本编辑
- edit_script / write_script 后必须立即调用 validate_scripts 验证
- 验证失败时回滚修改

## 发版门禁
- 提交版本号变更前必须运行 verify_delivery(scope="full")
- 所有维度必须无错误

## 场景操作
- 修改 .tscn 后用 read_scene 验证结构完整性
- 节点路径变更后检查所有 signal 连接是否失效

## GDScript 规范
- 使用静态类型（var x: int = 0）
- 函数必须标注返回类型
- 信号回调以 _on_ 前缀命名
```

仅在文件不存在时创建，不覆盖已有文件。

> 这是最小规则集。项目可根据需要扩展此文件。

## 智能合并逻辑

当目标项目已有 CLAUDE.md 时，执行智能合并而非暴力追加或覆盖。

### 算法

1. 按行扫描已有文件，用 `/^## /` 分割为有序章节列表
   → `[{header: "## 引擎版本", body: "..."}, {header: "## 自定义", body: "..."}]`

2. 定义 MCP 管理的章节标识集合：
   ```
   SECTION_IDS = {
     "## 引擎版本", "## 渲染器", "## 项目关键路径", "## 主场景",
     "## Autoload", "## Input Map", "## 物理设置", "## 层级名称",
     "## MCP 规则映射", "## Godot MCP Rules"  // 旧格式兼容
   }
   ```

3. 遍历已有章节：
   - `header ∈ SECTION_IDS` → 标记为"需替换"
   - `header ∉ SECTION_IDS` → 标记为"用户自定义"，保留原样

4. 构建新内容：
   - 在第一个 MCP 管理章节的位置，按顺序插入新生成的全部章节
   - 用户自定义章节保持在原位
   - 如果没有旧的 MCP 章节，追加到文件末尾（在用户自定义章节之前）

5. 写入文件

### 排序规则

**MCP 管理章节按固定顺序排列在 `# 标题` 之后，用户自定义章节全部排在 MCP 章节之后。**

具体步骤：
1. `# 项目标题` 保持在第一行
2. MCP 管理章节按规范顺序（引擎版本 → 渲染器 → ... → MCP 映射）连续排列
3. 用户自定义章节按在原文件中的相对顺序，排在最后一个 MCP 章节之后

### 边界情况

| 情况 | 处理方式 |
|------|---------|
| 无二级标题的文件（只有 `# Title` + 文本） | 在 `# ` 标题行后插入全部新章节，已有文本移到新章节之后 |
| 空文件或仅 `# Title\n` | 等同新建，追加全部章节 |
| 标题含额外空白（如 `##  引擎版本 `） | 标准化后匹配：`trim()` + 去多余空格 |
| 重复 MCP 章节标题 | 全部移除，替换为一份新版本 |
| 旧格式 `## Godot MCP Rules` | 纳入 SECTION_IDS，整体替换为新多章节结构 |
| 章节体为空（`## Autoload\n\n## 主场景`） | 正常处理，视为空内容章节，替换为新内容 |

### 示例

已有文件：
```markdown
# My Game
## 我的团队规范
- 提交前跑测试
## Godot MCP Rules           ← 旧格式
- validate_scripts...
```

合并后（MCP 章节在前，用户章节在后）：
```markdown
# My Game
## 引擎版本                    ← 新生成
- Godot 4.6
## 渲染器                      ← 新生成
- forward_plus
## 项目关键路径                 ← 新生成
...
## MCP 规则映射                 ← 新生成
| 领域 | rules 文件 |
...
## 我的团队规范                 ← 保留原样，排在 MCP 章节之后
- 提交前跑测试
```

## 错误处理

| 错误场景 | 处理方式 |
|---------|---------|
| project.godot 不存在 | 返回错误文本（已有，保持不变） |
| project.godot 解析失败 | 跳过元数据章节，仅生成 KeyPaths + MCP 映射（不依赖 config 的 builder） |
| config 中某字段缺失 | 对应 builder 返回 null，章节省略 |
| CLAUDE.md 读取失败 | 返回错误，不写入 |
| CLAUDE.md 写入失败 | 返回错误，报告具体原因（权限/磁盘） |
| .claude/rules/ 写入失败 | 返回错误，但 CLAUDE.md 如已写入则保留 |
| 编码非 UTF-8 | 按二进制读取检测 BOM，有 BOM 则剥离后处理，写回时不加 BOM |
| 并发写入 | 不处理 — setup_project_rules 设计为一次性工具，非并发场景 |

## 代码结构

Builder 函数拆分到独立文件，避免 `project.ts` 进一步膨胀。

### 新文件：`src/tools/claudemd-builder.ts`

```typescript
// Builder 函数（纯函数，无副作用）
// 所有函数 config 为 null/undefined 时返回 null
export function buildEngineVersion(config: GodotConfig | null): string | null
export function buildRenderer(config: GodotConfig | null): string | null
export function buildKeyPaths(projectDir: string): string | null
export function buildMainScene(config: GodotConfig | null): string | null
export function buildAutoloads(config: GodotConfig | null): string | null
export function buildInputMap(config: GodotConfig | null): string | null
export function buildPhysics(config: GodotConfig | null): string | null
export function buildLayerNames(config: GodotConfig | null): string | null
export function buildMcpMapping(): string

// 合并引擎
export function mergeSections(existing: string, newSections: Array<[string, string]>): string
```

使用 `Array<[string, string]>` 而非 `Map`，保证插入顺序且序列化友好。

### `src/tools/project.ts` 修改

- import builder 函数和 mergeSections
- `setup_project_rules` handler 调用 builder 收集章节，走合并或新建逻辑

### Handler 调用流程

1. 解析 `project.godot` → config 对象（复用已有 `ctx.parseGodotConfig`）
2. 调用各 builder，收集非 null 结果为 `Map<header, content>`
3. 检测已有 CLAUDE.md → 存在则走 `mergeSections`，否则新建
4. 检测 `.claude/rules/godot-mcp.md` → 不存在则创建
5. 返回 actions 报告

## 向后兼容

- `## Godot MCP Rules` 旧格式纳入 SECTION_IDS，合并时自动替换为新结构
- `hooks` 参数行为不变
- `claude_md` 参数控制整个 CLAUDE.md + rules 文件的生成
- **`force` 参数语义**：跳过幂等检查（"已存在则跳过"），但仍然执行智能合并保留用户自定义章节。不会破坏性覆盖整个文件
- 仅依赖 `## Godot MCP Rules` 标题存在性判断的外部工具：合并后旧标题被移除，新结构下可用 `## MCP 规则映射` 替代检测

## 测试计划

新增测试用例：
1. 新建项目 — 验证 CLAUDE.md 包含所有非省略章节
2. 无 autoload/input/physics 的简单项目 — 验证对应章节省略
3. 已有旧格式 CLAUDE.md — 验证智能合并替换旧章节
4. 已有新格式 CLAUDE.md — 验证合并更新版本等章节
5. 已有用户自定义章节 — 验证保留原样且排在 MCP 章节之后
6. `.claude/rules/godot-mcp.md` 已存在 — 验证不覆盖
7. `force=true` — 验证跳过幂等检查但保留用户自定义章节
8. project.godot 仅 `[application]` 段 — 验证只生成引擎版本 + 主场景 + KeyPaths + MCP 映射
9. 合并时目标文件无二级标题 — 验证在 `# ` 标题后正确插入
10. 合并时多个旧格式 `## Godot MCP Rules` — 验证只保留一份新结构
