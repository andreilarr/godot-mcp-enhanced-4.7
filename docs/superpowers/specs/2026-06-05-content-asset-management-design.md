# Content & Asset Management 设计规格

**日期**: 2026-06-05
**版本**: v0.17.0 规划
**状态**: 已批准
**目标**: 支持自定义规则、模板 CRUD，以及 Godot Asset Library 深度集成

---

## 一、概述

当前 godot-mcp-enhanced 的规则（`.claude/rules/godot-mcp-*.md`）和代码模板（`T001-T011`、`A001-A005`）全部硬编码在 TypeScript 源码中，用户无法自定义。资源系统（`resources.ts`）仅提供只读的 `godot://` URI 列表，不支持下载或安装。

本设计新增两个工具组：
1. **Content 工具组** — 规则 + 模板的 CRUD、应用、验证
2. **Asset 工具组** — Godot Asset Library 的搜索、下载、安装、更新

---

## 二、双层存储架构

### 2.1 目录结构

```
GODOT_MCP_HOME（默认 os.homedir()/.godot-mcp/，可环境变量覆盖）
├── meta.json                     ← { "schema_version": 1 }
├── templates/
│   ├── manifest.json             ← 可选索引 ["my-state-machine.json", ...]
│   ├── my-state-machine.json
│   └── my-camera-rig.json
├── rules/
│   ├── manifest.json             ← 可选索引
│   ├── team-naming.md
│   └── no-os-access.md
└── assets/
    └── cache/                    ← 下载缓存（全局共享）

<project>/.godot-mcp/
├── meta.json                     ← { "schema_version": 1 }
├── templates/
│   └── project-specific.json
├── rules/
│   └── project-coding-style.md
└── installed-assets.json         ← 已安装资源清单（含 sha256）
```

### 2.2 查找优先级

**模板**：项目层 → 全局层 → 内置（同名 id 取项目版本）

**规则**：叠加（项目层 + 全局层 **都生效**），除非 frontmatter 显式声明 `overrides`。

### 2.3 跨平台路径

| 平台 | 默认路径 |
|------|---------|
| Windows | `C:\Users\<user>\.godot-mcp\` |
| macOS | `/Users/<user>/.godot-mcp/` |
| Linux | `/home/<user>/.godot-mcp/` |

环境变量 `GODOT_MCP_HOME` 可覆盖默认路径。

### 2.4 发现机制

有 `manifest.json` 走索引，没有则 fallback 到目录扫描。manifest 格式：

```json
["my-state-machine.json", "my-camera-rig.json"]
```

### 2.5 版本兼容策略

- 向后兼容：v2 server 可读 v1 数据，自动迁移
- 项目层版本 ≤ 全局层版本：正常工作
- 项目层版本 > 全局层版本：警告 `SCHEMA_VERSION_MISMATCH`，提示升级全局 MCP

---

## 三、模板 Schema

### 3.1 模板文件格式

```jsonc
// ~/.godot-mcp/templates/my-state-machine.json
{
  "schema_version": 1,
  "id": "my-state-machine",
  "name": "State Machine",
  "description": "可配置状态机模板",
  "applies_to": ["Node"],       // 可选，适用的 Godot 类
  "tags": ["architecture"],     // 可选
  "variables": {
    "states": { "type": "string[]", "default": ["Idle", "Walk", "Run"] },
    "initial_state": { "type": "string", "default": "Idle" }
  },
  "generates": [
    {
      "path": "{{snake_case name}}.gd",
      "content": "extends Node\n..."
    }
  ]
}
```

必填字段：`id`、`name`、`description`、`generates`（至少一个）。
可选字段：`schema_version`（默认 1）、`applies_to`、`tags`、`variables`。

### 3.2 规则文件格式

```markdown
---
schema_version: 1
id: no-os-access
overrides: []              // 空 = 纯叠加，不覆盖任何规则
---

## 禁止 OS 访问

所有代码禁止调用 `OS.execute()` 等系统命令...
```

`overrides` 字段：字符串数组，列出被此规则覆盖的全局规则 id。

---

## 四、模板引擎

选用 **Handlebars**（轻量、JS 生态成熟、零运行时依赖）。

### 4.1 内置 Helpers

| Helper | 输入 | 输出 |
|--------|------|------|
| `{{pascal_case name}}` | my-state-machine | MyStateMachine |
| `{{snake_case name}}` | MyStateMachine | my_state_machine |
| `{{camel_case name}}` | my-state-machine | myStateMachine |
| `{{upper name}}` | hello | HELLO |
| `{{lower name}}` | Hello | hello |

### 4.2 控制结构

支持 Handlebars 标准 `{{#if}}`、`{{#each}}`、`{{#unless}}`。
不启用 `{{#with}}` 和 partial。

### 4.3 变量 Fallback

1. 用户传入的变量优先
2. 未传 → 使用 `variables` 中定义的 `default` 值
3. 既没传又没 default → 报错 `MISSING_VARIABLE`

### 4.4 模板示例

```json
{
  "generates": [
    {
      "path": "{{snake_case name}}.gd",
      "content": "extends Node\n\nclass_name {{pascal_case name}}\n\n{{#each states}}\nconst STATE_{{upper this}} = \"{{this}}\"\n{{/each}}\n\nvar current_state: String = \"{{initial_state}}\"\n\nfunc transition_to(new_state: String) -> void:\n\tcurrent_state = new_state\n"
    }
  ]
}
```

---

## 五、Content 工具组

### 5.1 工具清单

| 工具 | 说明 |
|------|------|
| `content_list` | 列出内容（type=rule/template，scope=global/project/all，limit/offset） |
| `content_get` | 获取单个内容详情（id + type） |
| `content_create` | 创建自定义内容（按 type 校验不同必填字段） |
| `content_update` | 更新已有内容 |
| `content_delete` | 删除自定义内容（不能删内置） |
| `content_apply_rule` | 应用规则到项目 → `.claude/rules/`（冲突检测 + 来源标记） |
| `content_apply_template` | 模板渲染 → 代码生成 → 写入文件 |
| `content_validate` | 验证内容格式是否正确 |

### 5.2 content_list

```
content_list(type="template", scope="all", limit=20, offset=0)
// → { items: [
//     { id: "T001", name: "player-movement", source: "builtin" },
//     { id: "my-state-machine", name: "State Machine", source: "global" },
//     { id: "project-specific", name: "Proj Template", source: "project" }
//   ],
//   total: 61,
//   has_more: true
// }
```

### 5.3 content_create

**创建规则**：
```
content_create(type="rule", scope="global",
  rule={
    id: "no-autoload-direct",       // 必填，kebab-case
    description: "禁止直接 Autoload",
    overrides: [],                   // 可选
    body: "## 禁止直接 Autoload\n..." // Markdown 正文
  }
)
```

**创建模板**：
```
content_create(type="template", scope="global",
  template={
    id: "my-state-machine",          // 必填，kebab-case
    name: "State Machine",           // 必填
    description: "可配置状态机",      // 必填
    applies_to: ["Node"],            // 可选
    tags: ["architecture"],          // 可选
    variables: {
      "states": { "type": "string[]", "default": ["Idle", "Walk"] }
    },
    generates: [
      { "path": "{{snake_case name}}.gd", "content": "extends Node\n..." }
    ]
  }
)
```

### 5.4 content_apply_rule

```
content_apply_rule(project_path="D:/game", id="no-os-access")
```

行为：
1. 检查 `.claude/rules/no-os-access.md` 是否已存在
2. 已存在 → 返回 `{ error: "CONFLICT", existing_source: "godot-mcp" }`
3. 不存在 → 写入带来源标记的文件

写入格式：
```markdown
---
schema_version: 1
id: no-os-access
source: godot-mcp
applied_at: 2026-06-05
overrides: []
---

（规则正文）
```

**单向操作**：apply 是一次性写入，不维护双向同步。

### 5.5 content_apply_template

```
content_apply_template(
  project_path="D:/game",
  id="my-state-machine",
  variables={ name: "PlayerState", states: ["Idle", "Run", "Jump"] },
  output_dir="res://scripts/",
  overwrite=false                   // 默认 false
)
```

行为：
1. Handlebars 渲染模板
2. 检查目标文件是否存在
3. 已存在且 `overwrite=false` → 返回 `{ error: "FILE_EXISTS", path: "res://scripts/player_state.gd" }`
4. 写入文件
5. 返回 `{ generated: ["res://scripts/player_state.gd"] }`

### 5.6 Overrides 环形检测

`content_create` / `content_update` 时校验：
- overrides 指向不存在的 id → `VALIDATION_FAILED`
- overrides 形成环 → `VALIDATION_FAILED`

`content_list` 合并时防御性检查：遇到环则两条都标 `status: "override_conflict"`，两条都生效。

### 5.7 查找链路

```
content_get(id="my-state-machine", type="template")
  ├─ 1. 项目层 → 找到返回 { source: "project" }
  ├─ 2. 全局层 → 找到返回 { source: "global" }
  └─ 3. 内置   → 找到返回 { source: "builtin" }
  → 都没找到 → { error: "NOT_FOUND" }
```

### 5.8 规则合并链路

```
content_list(type="rule", scope="all")
  ├─ 收集内置规则（5 个 godot-mcp-*.md）
  ├─ 收集全局层规则
  ├─ 收集项目层规则
  ├─ 处理 overrides：项目规则 overrides=["team-naming"]
  │   → 全局 team-naming 标记 overridden_by
  │   → 其余规则保持 active
  └─ 返回列表，每条标注 source + status(active/overridden/override_conflict)
```

---

## 六、Asset 工具组

### 6.1 工具清单

| 工具 | 说明 |
|------|------|
| `asset_search` | 搜索 Asset Library（query/category/sort/limit/offset） |
| `asset_info` | 获取资源详情（版本、作者、依赖、下载 URL） |
| `asset_install` | 下载 + 安装到项目（完整安全校验链） |
| `asset_list` | 列出已安装资源 |
| `asset_check_updates` | 只读，检查可用更新 |
| `asset_update` | 写入，执行更新（可指定 asset_id 更新单个，不传则全部） |
| `asset_remove` | 卸载已安装资源 |

### 6.2 Asset Library API 集成

- 搜索：`GET https://godotengine.org/asset-library/api/asset?q={query}&category={cat}&sort={sort}&max={limit}&page={offset}`
- 详情：`GET https://godotengine.org/asset-library/api/asset/{id}`
- 下载：通过返回的 `download_url` 字段获取 zip 包

### 6.3 asset_install 完整流程

```
asset_install(asset_id=123, project_path="D:/game")
```

内部流程：
1. 调用 Asset Library API → 获取 download_url + 版本信息
2. 下载 zip 到全局缓存 `GODOT_MCP_HOME/assets/cache/`
3. sha256 校验（与 API 返回的 hash 比对）
4. 解压到临时目录
5. 安全校验：
   - 路径穿越扫描 — 拒绝含 `../` 的解压路径
   - 文件大小检查 — 单文件 ≤ 50MB，总解压 ≤ 200MB
   - 插件结构验证 — 至少含一个 `.gd` 或 `.tscn` 文件
6. 移入 `<project>/addons/<asset-slug>/`
7. 原子写入 `installed-assets.json`（write-then-rename）
8. 返回安装结果

**失败回滚**：任何步骤失败时，清理已解压的 addons 目录和临时文件，返回 `INSTALL_FAILED`。

### 6.4 installed-assets.json 格式

```json
{
  "schema_version": 1,
  "assets": [
    {
      "asset_id": 123,
      "slug": "gpu-particles",
      "title": "GPU Particles",
      "author": "kenney",
      "version": "1.2.0",
      "source_url": "https://godotengine.org/asset-library/asset/123",
      "download_url": "https://...",
      "sha256": "abc123...",
      "installed_at": "2026-06-05T10:30:00Z",
      "install_path": "addons/gpu-particles/"
    }
  ]
}
```

---

## 七、错误码体系

沿用现有 `COMMON_ERROR_CODES` 模式，新增：

| 错误码 | HTTP 类比 | 说明 |
|--------|----------|------|
| `NOT_FOUND` | 404 | 内容/资源不存在 |
| `ALREADY_EXISTS` | 409 | 创建时 id 已被占用 |
| `CONFLICT` | 409 | apply_rule 目标已存在 |
| `FILE_EXISTS` | 409 | apply_template 目标文件已存在 |
| `BUILTIN_IMMUTABLE` | 403 | 尝试删除/修改内置内容 |
| `VALIDATION_FAILED` | 400 | 内容格式校验失败 |
| `MISSING_VARIABLE` | 400 | 模板必需变量未提供且无默认值 |
| `SCHEMA_VERSION_MISMATCH` | 400 | 存储层 schema 版本不兼容 |
| `ASSET_DOWNLOAD_FAILED` | 502 | 下载失败（网络/服务器） |
| `ASSET_INTEGRITY_FAILED` | 409 | sha256 校验失败 |
| `ASSET_PATH_TRAVERSAL` | 403 | 解压路径含穿越 |
| `ASSET_SIZE_EXCEEDED` | 413 | 超过大小限制 |
| `ASSET_INVALID_STRUCTURE` | 400 | 无有效 .gd/.tscn 文件 |
| `ASSET_LIBRARY_UNREACHABLE` | 503 | Asset Library API 不可达 |
| `INSTALL_FAILED` | 500 | 安装中途失败，已回滚 |
| `CORRUPTED_STATE` | 500 | installed-assets.json 格式损坏 |

---

## 八、CLI 命令映射

CLI 与 MCP 工具共享同一业务逻辑层。CLI 是 MCP 工具的命令行包装。

```bash
# Content 管理
godot-mcp content list --type=template --scope=all --limit=20 --offset=0
godot-mcp content get --id=my-state-machine --type=template
godot-mcp content create --type=rule --scope=global --file=./my-rule.md
godot-mcp content create --type=template --scope=global --file=./my-template.json
godot-mcp content update --type=rule --id=my-rule --scope=global --file=./updated.md
godot-mcp content update --type=template --id=my-tpl --scope=global --file=./updated.json
godot-mcp content delete --type=template --id=old-template --scope=global
godot-mcp content validate --type=template --file=./new-template.json
godot-mcp content apply-rule --id=no-os-access --project=./my-game
godot-mcp content apply-template --id=my-sm --var name=PlayerState --output=res://scripts/
godot-mcp content apply-template --id=my-sm --var-file=./variables.json --output=res://scripts/

# Asset 管理
godot-mcp asset search --query=particles --category=3d --limit=10
godot-mcp asset info --id=123
godot-mcp asset install --id=123 --project=./my-game
godot-mcp asset list --project=./my-game
godot-mcp asset check-updates --project=./my-game
godot-mcp asset update --project=./my-game                  # 更新全部
godot-mcp asset update --id=123 --project=./my-game         # 更新单个
godot-mcp asset remove --id=123 --project=./my-game
```

### --var 传参方式

```bash
# 方式 1：重复 flag（适合短列表）
--var states=Idle --var states=Run --var states=Jump

# 方式 2：JSON 文件（适合复杂变量）
--var-file=./variables.json
```

---

## 九、架构决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 工具分组 | Content + Asset 两个独立工具组 | 规则/模板（本地内容）与 Asset Library（远程资源）是不同域 |
| 规则合并语义 | 叠加 + 显式 overrides | 安全规则通常需要全部生效，不是覆盖 |
| 模板引擎 | Handlebars | 轻量、JS 生态成熟、零运行时依赖 |
| 存储 | 双层（全局 + 项目） | 类似 .gitconfig 分层，开发者直觉友好 |
| Asset 安装 | 完整安全校验链 | zip 路径穿越、大小限制、结构验证、原子写入 |
| CLI/MCP 共享 | 统一业务逻辑层 | 避免行为分歧，维护一份代码 |
| 发现机制 | manifest 可选 + 目录扫描 fallback | 兼顾性能和零配置 |
