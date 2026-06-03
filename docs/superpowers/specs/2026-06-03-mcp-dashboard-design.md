# Godot MCP Dashboard — TUI 实时监控面板设计

> **目标：** 为 godot-mcp-enhanced 创建独立 CLI 终端面板，实时显示 MCP 服务端日志、工具调用统计、服务状态和性能趋势，不占用 Claude Code 对话上下文。

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  MCP Server (现有)                                      │
│  console.error() → 替换为 Logger                        │
│       │                                                 │
│       ├──→ stderr (不变，Claude Code 仍可看到)           │
│       └──→ ~/.godot-mcp/logs/2026-06-03.jsonl (新增)    │
└─────────────────────────────────────────────────────────┘
                          │
                          │ fs.watch + tail
                          ▼
┌─────────────────────────────────────────────────────────┐
│  godot-mcp-dashboard (独立 CLI 进程)                     │
│  blessed TUI 四面板布局                                  │
│  ┌─ 状态栏 ──────────────────────────────────────────┐  │
│  ├─ 日志流 ─────────────┬─ 工具统计 ─────────────────┤  │
│  │                       │                            │  │
│  ├───────────────────────┴────────────────────────────┤  │
│  ├─ 性能趋势 ────────────────────────────────────────┤  │
│  ├─ 快捷键栏 ────────────────────────────────────────┤  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

两个进程完全独立，通过 JSONL 文件解耦。Dashboard 可随时启停，不影响 MCP 服务。

---

## 2. 日志层：Logger

### 2.1 接口设计

```typescript
// src/core/logger.ts

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;           // ISO 8601
  level: LogLevel;
  module: string;       // 来源模块：dispatcher / gdscript / runtime / bridge / security
  msg: string;
  tool?: string;        // 关联的工具名（如 read_scene）
  duration_ms?: number; // 工具调用耗时
  error?: string;       // 错误信息
  meta?: Record<string, unknown>; // 额外数据
}

interface Logger {
  debug(module: string, msg: string, meta?: Record<string, unknown>): void;
  info(module: string, msg: string, meta?: Record<string, unknown>): void;
  warn(module: string, msg: string, meta?: Record<string, unknown>): void;
  error(module: string, msg: string, meta?: Record<string, unknown>): void;
  toolStart(tool: string, args?: Record<string, unknown>): string; // 返回调用 ID
  toolEnd(callId: string, tool: string, durationMs: number, error?: string): void;
  flush(): void; // 刷新缓冲区到文件
}
```

### 2.2 行为

- **双写：** 同时写 `stderr`（格式与现有 console.error 兼容）和 JSONL 文件
- **stderr 格式不变：** `[godot-mcp] message` — 确保 Claude Code 端无感知
- **JSONL 格式：** 每行一个 JSON 对象（LogEntry）
- **缓冲写入：** 100ms 或 50 条批量刷盘，避免频繁 I/O
- **日志切割：** 按日期自动切割，保留 7 天
- **日志目录：** `%APPDATA%/godot-mcp/logs/`（Windows）或 `~/.godot-mcp/logs/`（macOS/Linux）

### 2.3 迁移策略

渐进式迁移，不一次性改全部文件：

1. 创建 Logger 模块
2. 在 `GodotServer.ts`、`ToolDispatcher.ts`、`gdscript-executor.ts` 等核心文件引入
3. 保留原有的 `console.error` 调用作为 fallback（Logger 内部会调用 console.error）
4. 新代码一律用 Logger

---

## 3. JSONL 存储

### 3.1 文件格式

```jsonl
{"ts":"2026-06-03T20:45:12.123Z","level":"info","module":"dispatcher","msg":"Tool call: read_scene","tool":"read_scene","duration_ms":120}
{"ts":"2026-06-03T20:45:13.456Z","level":"info","module":"gdscript","msg":"Executing snippet..."}
{"ts":"2026-06-03T20:45:14.789Z","level":"warn","module":"security","msg":"Path outside allowed roots","meta":{"path":"/etc/passwd"}}
{"ts":"2026-06-03T20:45:15.012Z","level":"error","module":"gdscript","msg":"Failed to parse script","error":"SyntaxError at line 5"}
```

### 3.2 轮转策略

- 每天一个文件：`YYYY-MM-DD.jsonl`
- 保留 7 天，自动清理
- 单文件上限 50MB（超出截断最旧的条目）

### 3.3 目录位置

```typescript
import { appDataDir } from './helpers.js';
// Windows: %APPDATA%/godot-mcp/logs/
// macOS: ~/Library/Application Support/godot-mcp/logs/
// Linux: ~/.local/share/godot-mcp/logs/
```

---

## 4. Dashboard CLI

### 4.1 入口

```bash
# 安装后自动注册的 bin
godot-mcp-dashboard           # 启动面板
godot-mcp-dashboard --help    # 帮助
godot-mcp-dashboard --filter bridge  # 只看 bridge 模块日志
```

在 `package.json` 中添加：
```json
{
  "bin": {
    "godot-mcp-enhanced": "./build/index.js",
    "godot-mcp-dashboard": "./build/dashboard/index.js"
  }
}
```

### 4.2 面板布局

```
┌─ Godot MCP Dashboard ──────────── v0.17.0 ─────────────────────────┐
│ ● Headless │ Project: D:\game │ Uptime: 2h 15m │ Tools: 47 total   │
├────────────────────────────────┬────────────────────────────────────┤
│                                │  Tool Statistics (Top 10)          │
│  Log Stream (live)             │  ┌──────────┬───────┬──────┐      │
│  20:45:12 [dispatcher] Tool:   │  │ Tool     │ Calls │ Avg  │      │
│    read_scene → 120ms ✓        │  ├──────────┼───────┼──────┤      │
│  20:45:13 [gdscript] Execut-   │  │ read_sc  │  12   │ 95ms │      │
│    ing snippet...               │  │ execute  │   8   │ 2.1s │      │
│  20:45:14 [runtime] Godot      │  │ screens  │   5   │ 1.5s │      │
│    exited (0)                   │  │ edit_sc  │   4   │ 0.8s │      │
│  20:45:15 [bridge] TCP conn    │  │ valida   │   3   │ 3.2s │      │
│    ected to :9081               │  │ write_s  │   3   │ 0.3s │      │
│  20:45:16 WARN [security]      │  │ add_no   │   2   │ 0.5s │      │
│    Path outside allowed...      │  │ run_and  │   2   │ 8.0s │      │
│  20:45:17 ERROR [gdscript]     │  │ query_s  │   2   │ 0.2s │      │
│    Failed to parse...           │  │ save_sc  │   2   │ 0.4s │      │
│  20:45:18 [dispatcher] Tool:   │  └──────────┴───────┴──────┘      │
│    edit_script → 350ms ✓        │                                    │
│                                  │  Performance (last 30 min)         │
│                                  │  Calls/min ▁▂▃▅▇█▆▃▂▁▁▂▃▅       │
│                                  │  Error rate ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁      │
│                                  │  Avg latency ▂▃▃▄▅▅▄▃▃▂▂▁▁       │
│                                  │                                    │
├────────────────────────────────┴────────────────────────────────────┤
│ ↑/↓:scroll  f:filter  l:level  c:clear  q:quit  Space:pause       │
└────────────────────────────────────────────────────────────────────┘
```

### 4.3 四个面板

| 面板 | 内容 | 刷新频率 |
|------|------|----------|
| **状态栏（顶部）** | 连接模式、项目路径、运行时长、工具总调用数、错误数 | 每 2s |
| **日志流（左下）** | 实时滚动日志，按级别着色，支持过滤/暂停/滚动 | 实时（fs.watch） |
| **工具统计（右上）** | 调用次数 Top 10、平均耗时、成功率 | 每 5s |
| **性能趋势（右下）** | 调用频率 sparkline、错误率 sparkline、平均耗时 sparkline（最近 30 分钟） | 每 10s |

### 4.4 日志着色方案

| 级别 | 颜色 | 前缀 |
|------|------|------|
| DEBUG | gray | `[dbg]` |
| INFO | white（默认） | 无 |
| WARN | yellow | `WARN` |
| ERROR | red (bold) | `ERROR` |

模块着色：

| 模块 | 颜色 |
|------|------|
| dispatcher | cyan |
| gdscript | green |
| runtime | blue |
| bridge | magenta |
| security | red |
| validation | yellow |

### 4.5 交互快捷键

| 按键 | 动作 |
|------|------|
| `↑` / `↓` | 滚动日志流 |
| `Space` | 暂停/恢复日志流 |
| `f` | 输入过滤关键词（模块名或工具名） |
| `l` | 切换日志级别过滤（ALL → INFO → WARN → ERROR → ALL） |
| `c` | 清空当前日志显示 |
| `q` | 退出面板 |
| `Tab` | 切换焦点面板 |

### 4.6 数据读取

```typescript
// 启动时：读取当前日期的 JSONL 文件尾部（最近 500 条）
// 运行中：fs.watch 监听文件变化，增量读取新行
// 解析每行 JSON，更新内存中的统计数据
```

---

## 5. 统计聚合器

### 5.1 数据结构

```typescript
interface ToolStats {
  tool: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  lastCalled: string; // ISO timestamp
}

interface TimeSeriesBucket {
  // 每分钟一个桶
  minute: string; // 'HH:MM'
  calls: number;
  errors: number;
  avgDurationMs: number;
}

interface DashboardState {
  startTime: string;
  mode: string;           // headless / editor / bridge
  projectPath: string;
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeries: TimeSeriesBucket[]; // 最近 30 分钟
  recentLogs: LogEntry[]; // 最近 500 条
}
```

### 5.2 聚合逻辑

- 每个 `toolEnd` 类型的日志条目更新 `toolStats` 和 `timeSeries`
- 每分钟自动合并统计桶
- 日志流保持最近 500 条滚动窗口

---

## 6. 文件结构

```
src/
├── core/
│   └── logger.ts          # Logger 模块（新增）
├── dashboard/             # Dashboard 独立模块（新增目录）
│   ├── index.ts           # CLI 入口
│   ├── log-reader.ts      # JSONL 文件读取 + fs.watch
│   ├── aggregator.ts      # 统计聚合器
│   ├── ui.ts              # blessed 面板布局
│   ├── themes.ts          # 颜色主题定义
│   └── sparkline.ts       # sparkline 图表渲染
```

---

## 7. 依赖

| 包 | 用途 | 大小 |
|---|---|---|
| `blessed` | TUI 框架（终端窗口/布局/事件） | ~300KB |
| `blessed-contrib` | blessed 扩展（表格、sparkline） | ~100KB |

这两个是仅有的新依赖，均为可选依赖（`optionalDependencies`），安装失败不影响 MCP 服务。

---

## 8. 启动流程

1. 用户在独立终端运行 `godot-mcp-dashboard`
2. 检测日志目录是否存在（如不存在，提示先启动 MCP 服务）
3. 读取当天 JSONL 文件尾部（最近 500 条）初始化面板
4. 启动 fs.watch 监听文件变化
5. 渲染 blessed 面板，进入事件循环
6. MCP 服务端写入新日志 → Dashboard 实时更新

---

## 9. 测试策略

| 层 | 测试方式 |
|---|---|
| Logger | 单元测试：验证双写、JSONL 格式、缓冲刷新、轮转 |
| LogReader | 单元测试：模拟 JSONL 文件读写、增量解析 |
| Aggregator | 单元测试：统计计算正确性、时间桶合并 |
| Sparkline | 单元测试：数据 → sparkline 字符转换 |
| UI | 手动测试（blessed 需要 TTY，不适合自动化测试） |

---

## 10. 不做什么

- **不做 Web UI** — 纯 TUI，不引入 HTTP server
- **不做远程监控** — 只读本地文件，无网络
- **不做历史回看 UI** — 只展示当前会话日志，历史用 `cat`/`jq` 查看
- **不改 MCP 通信协议** — 完全透明，不影响 Claude Code 对话
- **不做告警通知** — 仅展示，不发送邮件/通知
