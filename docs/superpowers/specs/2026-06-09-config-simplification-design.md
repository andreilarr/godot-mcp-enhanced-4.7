# MCP 配置简化设计

> **日期**：2026-06-09
> **状态**：已批准，待实施
> **范围**：文档 + 代码改进 + Smithery 分发准备

---

## 1. 背景与问题

用户反馈 godot-mcp-enhanced 配置过于复杂：

1. **必须 git clone + npm install** — README 引导用户手动克隆、安装、build
2. **绝对路径硬编码** — 配置 JSON 中必须写死 `D:/GitHub/godot-mcp-enhanced/build/index.js`
3. **每个 tool call 必须传 project_path** — 忘传或传错就报错
4. **GODOT_PATH 必须手动设置** — 用户不知道已有自动发现机制
5. **只支持手动配置** — 没有 Smithery 等平台分发

**关键发现：** 项目已具备 90% 的简化基础设施（npm 发布、godot-finder 自动发现、setup CLI、bin 入口），但 README 和文档未反映这些能力。

---

## 2. 设计概要

三部分改进：

| 部分 | 目标 | 工作量 |
|------|------|--------|
| A. 默认项目路径 | tool call 的 project_path 变为可选 | 1-2 小时 |
| B. README 重写 | 配置从 4 步降到 1 行 | 2-3 小时 |
| C. Smithery 配置 | 添加 smithery.yaml/json，准备平台分发 | 30 分钟 |

---

## 3. 详细设计

### 3A. 默认项目路径机制

**已有基础设施（复用）：**

| 已有代码 | 复用方式 |
|----------|---------|
| `GodotServer.detectProjectPath()` (L184-217) | 提取为独立函数 `resolveProjectPath()` 到 `path-utils.ts`，GodotServer 和 ToolDispatcher 共用 |
| `validateProjectRoot()` (path-utils.ts) | `resolveProjectPath()` 内部使用 |
| `requireProjectPath()` (helpers.ts) | 无需修改 — Dispatcher 层保证值存在 |
| `validateCommonArgs()` (ToolDispatcher.ts) | 无需修改 — 注入点在其之前，保证 project_path 存在 |

**新增文件/函数：**

从 GodotServer.detectProjectPath() 提取 `src/core/path-utils.ts` 中的 `resolveProjectPath()`：

```
resolveProjectPath(explicitPath?: string): string

优先级链：
1. explicitPath（tool call 传入）→ 直接使用
2. process.env.GODOT_PROJECT_PATH   → 使用环境变量
3. cwd 自动检测 → 如果 process.cwd() 包含 project.godot → 使用 cwd
4. 都没有 → 抛错："请设置 GODOT_PROJECT_PATH 环境变量或在 tool call 中传 project_path"
```

**改动文件：**

| 文件 | 改动 |
|------|------|
| `src/core/path-utils.ts` | 新增 `resolveProjectPath()` 函数 |
| `src/GodotServer.ts` | tool dispatch 中调用 `resolveProjectPath`，使 project_path 参数可选 |
| `src/helpers.ts` | 统一使用新函数，移除分散的 project_path 校验 |

**tool schema 变更：**

所有带 `project_path` 的 tool，该参数从 `required` 变为 `optional`。schema 描述更新为：

```
"project_path": {
  "type": "string",
  "description": "Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）"
}
```

**注入位置（精确）：**

`ToolDispatcher.executeToolCall()` 中，`normalizeArgs()` 之后、`validateCommonArgs()` 之前：

```
executeToolCall(name, args, startTime)
  ├── args = normalizeArgs(rawArgs)       // 已有
  ├── ★ if (!args.project_path)           // 新增
  │     args.project_path = resolveProjectPath()
  │     if (!args.project_path) throw Error(...)
  ├── validateCommonArgs(args)            // 已有 — 此时 project_path 一定存在
  ├── validatePathArgs(args)              // 已有
  └── dispatchTool(name, args)            // 已有 — 37 个 handler 零改动
```

为什么在 validateCommonArgs 之前？因为 `validateCommonArgs` 只在 `'project_path' in args` 时校验类型（缺失时静默跳过），但下游 `requireProjectPath()` 会 throw。Dispatcher 层注入保证了 project_path 存在，validateCommonArgs 校验通过，下游 handler 正常工作。

**.mcp.json 项目模板：**

在 Godot 项目根目录放置 `.mcp.json`（可 git 提交）：

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "godot-mcp-enhanced"],
      "env": {
        "GODOT_PROJECT_PATH": "${workspaceFolder}"
      }
    }
  }
}
```

### 3B. README 重写

**新配置章节结构（从简到难排列）：**

```markdown
## 快速开始

### 1 分钟配置（推荐）

#### Claude Code
claude mcp add godot -- npx -y godot-mcp-enhanced

#### Cursor
在项目 .cursor/mcp.json 中添加：
{ "mcpServers": { "godot": { "command": "npx", "args": ["-y", "godot-mcp-enhanced"] } } }

#### Cline / 其他
同上 JSON 格式

### 一键配置（setup 命令）
npx godot-mcp-enhanced setup
# 自动检测：Godot 路径 + AI 客户端 + 写入配置

### 项目级配置（团队共享）
在 Godot 项目中放 .mcp.json 模板（见上文）

### 手动配置（高级用户）
git clone + npm install + 绝对路径（保留旧文档，折叠显示）

### 环境变量
| 变量 | 说明 | 默认 |
|------|------|------|
| GODOT_PATH | Godot 可执行文件路径 | 自动搜索（PATH/注册表/Scoop/Downloads） |
| GODOT_PROJECT_PATH | 默认项目路径 | 自动检测 cwd |
| GODOT_MCP_SEARCH_PATHS | 额外 Godot 搜索目录（分号分隔） | 无 |
```

**关键变化：**
- `npx` 一行配置作为第一选择
- `GODOT_PATH` 标注为「自动搜索，不设也行」
- `setup` 命令作为备选一键方案
- 手动配置折叠到高级用户部分
- 保留英文 README 的同步更新

### 3C. Smithery 配置文件

**smithery.yaml：**

```yaml
startCommand:
  type: stdio
  configSchema:
    type: object
    properties:
      GODOT_PATH:
        type: string
        title: "Godot Path"
        description: "Path to Godot executable (auto-detected if omitted)"
      GODOT_PROJECT_PATH:
        type: string
        title: "Project Path"
        description: "Default Godot project path (auto-detected from cwd if omitted)"
  commandFunction: |
    (config) => ({
      command: 'npx',
      args: ['-y', 'godot-mcp-enhanced'],
      env: {
        ...(config.GODOT_PATH ? { GODOT_PATH: config.GODOT_PATH } : {}),
        ...(config.GODOT_PROJECT_PATH ? { GODOT_PROJECT_PATH: config.GODOT_PROJECT_PATH } : {})
      }
    })
```

**smithery.json：**

```json
{
  "id": "wgt19861219/godot-mcp-enhanced",
  "name": "Godot MCP Enhanced",
  "description": "Enhanced MCP server for Godot game engine — closed-loop AI-assisted development with scene reading, script R/W, screenshots, dynamic GDScript execution, and more.",
  "tags": ["godot", "game-dev", "mcp", "ai", "claude", "godot-engine"],
  "deployment": {
    "localOnly": true,
    "requirements": [
      {
        "name": "Godot Engine",
        "description": "Godot 4.x engine must be installed (auto-detected)",
        "required": true
      },
      {
        "name": "Node.js",
        "description": "Node.js >= 18",
        "required": true
      }
    ]
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/wgt19861219/godot-mcp-enhanced"
  }
}
```

> **注意：** Smithery 发布操作在实施阶段手动执行，不在代码改动范围内。

### 3D. 测试规划

#### 新增测试文件

`test/core/resolve-project-path.test.ts` — 7 项测试覆盖 `resolveProjectPath()` 的所有路径：

| # | 测试场景 | 覆盖路径 | 优先级 |
|---|---------|---------|--------|
| T1 | explicitPath 传入 → 直接使用 | 显式参数 | 已有覆盖 |
| T2 | GODOT_PROJECT_PATH 环境变量 → 使用 env 值 | 环境变量 | CRITICAL |
| T3 | 从嵌套子目录 cwd 向上搜索 → 找到 project.godot | cwd 搜索 | CRITICAL |
| T4 | 无环境变量 + cwd 无 project.godot → 抛错 | 全部失败 | CRITICAL |
| T5 | 30s TTL 缓存命中/失效 | 缓存行为 | IMPORTANT |
| T6 | ToolDispatcher 注入后下游 handler 正常执行 | 端到端注入 | IMPORTANT |
| T7 | Schema required 不包含 project_path | 批量验证 | IMPORTANT |
| T8 | 缓存有效期内切换项目 → 文档警告 | ADVISORY（文档说明） |

#### 测试策略

- T2-T5：单元测试 `resolveProjectPath()`，mock `existsSync` 和 `process.cwd()`
- T6：在 `test/core/ToolDispatcher.test.ts` 中添加集成测试
- T7：扫描所有 tool schema，断言 required 数组不含 `project_path`

---

## 4. 不在范围内

| 项 | 原因 |
|----|------|
| 远程 HTTP transport 模式 | Godot MCP 核心操作需要本地 Godot 进程，远程模式价值有限 |
| Docker 化部署 | 同上，Godot 需要 GPU 上下文，Docker 化收益低 |
| setup 命令代码改动 | 已有功能工作正常，只改文档展示 |
| .mcp.json 生成到 Godot 项目 | 提供 `init` 命令或手动复制模板即可 |

---

## 5. 验收标准

1. **零配置测试**：`claude mcp add godot -- npx -y godot-mcp-enhanced` 后，tool call 不传 project_path 也能工作（通过 cwd 自动检测）
2. **环境变量测试**：设 `GODOT_PROJECT_PATH` 后，在任意目录调用 tool 都能正确路由
3. **README 测试**：按照 README 的「1 分钟配置」步骤，全新用户能在 1 分钟内完成配置
4. **Smithery 文件就绪**：`smithery.yaml` + `smithery.json` 文件存在且格式正确
5. **向后兼容**：已有的绝对路径配置方式继续工作
