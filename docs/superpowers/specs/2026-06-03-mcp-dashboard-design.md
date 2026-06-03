# Godot MCP Dashboard — TUI 实时监控面板设计

> **目标：** 为 godot-mcp-enhanced 创建独立 CLI 终端面板，实时显示 MCP 服务端日志、工具调用统计、服务状态和性能趋势，不占用 Claude Code 对话上下文。
> **版本：** v2（经工程审查修订，纳入 16 项建议）

---

## 交付拆分

| PR | 范围 | 新文件 | 修改文件 | 依赖 |
|----|------|--------|----------|------|
| PR1: Logger + JSONL | 核心日志层 | 1 (`logger.ts`) | ~13 (console 迁移) | 无新依赖 |
| PR2: Dashboard TUI | 展示层 | 6 (dashboard 目录) | 0 (仅新增) | ink |

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  MCP Server (现有)                                      │
│  console.error() → 替换为 Logger                        │
│       │                                                 │
│       ├──→ stderr (不变，Claude Code 仍可看到)           │
│       └──→ XDG_DATA/godot-mcp/logs/2026-06-03.jsonl    │
└─────────────────────────────────────────────────────────┘
                          │
                          │ fs.watch + 2s 轮询 fallback
                          │ byte offset 去重
                          ▼
┌─────────────────────────────────────────────────────────┐
│  godot-mcp-dashboard (独立 CLI 进程)                     │
│  ink (React for CLI) 四面板布局                          │
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
  v: 1;                  // 格式版本号（未来格式变更时旧文件仍可解析）
  ts: string;            // ISO 8601
  level: LogLevel;
  module: string;        // 来源模块：dispatcher / gdscript / runtime / bridge / security
  msg: string;
  tool?: string;         // 关联的工具名（如 read_scene）
  duration_ms?: number;  // 工具调用耗时
  error?: string;        // 错误信息
  type?: 'tool_start' | 'tool_end' | 'rotation'; // 结构化事件类型
  call_id?: string;      // toolStart/toolEnd 配对 ID
  meta?: Record<string, unknown>; // 额外数据（经 sanitizer 处理）
}

interface Logger {
  debug(module: string, msg: string, meta?: Record<string, unknown>): void;
  info(module: string, msg: string, meta?: Record<string, unknown>): void;
  warn(module: string, msg: string, meta?: Record<string, unknown>): void;
  error(module: string, msg: string, meta?: Record<string, unknown>): void;
  toolStart(tool: string, args?: Record<string, unknown>): string; // 返回调用 ID
  toolEnd(callId: string, tool: string, durationMs: number, error?: string): void;
  flush(): void;          // 刷新缓冲区到文件
  pendingCount(): number; // 当前缓冲区待刷盘条目数（监控用）
  close(): void;          // flush + 清理资源
}
```

### 2.2 行为

- **双写：** 同时写 `stderr`（格式与现有 console.error 兼容）和 JSONL 文件
- **stderr 格式不变：** `[godot-mcp] message` — 确保 Claude Code 端无感知
- **JSONL 格式：** 每行一个 JSON 对象（LogEntry），每行以 `\n` 结尾
- **缓冲写入：** 100ms 或 50 条批量刷盘，避免频繁 I/O
- **日志切割：** 按日期自动切割，保留 7 天
- **日志目录：** 统一使用 XDG 标准路径（见 3.3 节）

#### Sanitizer — 敏感数据保护

写入 JSONL 前，Logger 对 `meta` 和 `msg` 做以下处理：

1. **字符串截断：** 超过 200 字符的字符串值截断为 `前197字符...`
2. **敏感 key 过滤：** 匹配 `password`、`secret`、`token`、`key`、`auth`（不区分大小写）的 key，值替换为 `***`
3. **toolStart args：** 只记录 key 名列表（`["project_path","scene_path"]`），不记录具体值

```typescript
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = /password|secret|token|key|auth/i;
  const MAX_STRING_LEN = 200;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.test(k)) { result[k] = '***'; continue; }
    if (typeof v === 'string' && v.length > MAX_STRING_LEN) {
      result[k] = v.slice(0, MAX_STRING_LEN - 3) + '...';
    } else {
      result[k] = v;
    }
  }
  return result;
}
```

#### toolStart/toolEnd 超时配对

Logger 维护 `Map<string, { tool: string; startTime: number }>` 追踪活跃调用：

1. `toolStart()` 生成 `callId`（`tool:nanoid8`），记录到 Map
2. `toolEnd()` 从 Map 取出配对，写入 `tool_end` 条目
3. **60s 超时：** 每次 `flush()` 时检查 Map，超过 60s 未配对的 `toolStart` 自动写入一条 `level: 'warn'` + `type: 'tool_end'` + `error: 'timeout'` 的条目并从 Map 移除
4. 未知 `callId` 的 `toolEnd` 记录为 `level: 'warn'`（孤儿结束）

#### 优雅关闭

在 `index.ts` 的 `gracefulShutdown()` 中调用 `logger.close()`：

```typescript
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[godot-mcp] Received ${signal}, shutting down...`);
  try {
    logger.close(); // flush 缓冲区 + 关闭文件句柄
    await server.close();
  } catch (err) {
    console.error('[godot-mcp] Error during shutdown:', err);
  }
  process.exit(0);
}
```

### 2.3 迁移策略

渐进式迁移，不一次性改全部文件：

1. 创建 Logger 模块
2. 在 `GodotServer.ts`、`ToolDispatcher.ts`、`gdscript-executor.ts` 等核心文件引入
3. 保留原有的 `console.error` 调用作为 fallback（Logger 内部会调用 console.error）
4. 新代码一律用 Logger

---

## 3. JSONL 存储

### 3.1 文件格式

每行一个完整 JSON 对象，以 `\n` 结尾。Logger 使用 `writeSync` 原子写入（每行一个 writeSync 调用），确保不会出现半截行。

```jsonl
{"v":1,"ts":"2026-06-03T20:45:12.123Z","level":"info","module":"dispatcher","msg":"Tool call: read_scene","tool":"read_scene","duration_ms":120,"type":"tool_end","call_id":"read_scene:a1b2c3d4"}
{"v":1,"ts":"2026-06-03T20:45:12.456Z","level":"info","module":"gdscript","msg":"Executing snippet..."}
{"v":1,"ts":"2026-06-03T20:45:14.789Z","level":"warn","module":"security","msg":"Path outside allowed roots","meta":{"path":"/etc/p***"}}
{"v":1,"ts":"2026-06-03T20:45:15.012Z","level":"error","module":"gdscript","msg":"Failed to parse script","error":"SyntaxError at line 5"}
{"v":1,"ts":"2026-06-03T23:59:59.999Z","level":"info","module":"logger","msg":"Rotating log file","type":"rotation","meta":{"new_file":"2026-06-04.jsonl"}}
```

**Reader 端容错：** 解析失败的行跳过，维护 `skippedLines` 计数，在 Dashboard 状态栏显示。

### 3.2 轮转策略

- 每天一个文件：`YYYY-MM-DD.jsonl`
- 保留 7 天，自动清理
- 单文件上限 50MB（超出截断最旧的条目）
- **轮转信号：** Logger 写入新文件时，在旧文件末尾追加一条 `type: 'rotation'` 条目，Dashboard 检测后切换追踪目标

### 3.3 目录位置

统一使用 XDG 标准路径：

```typescript
import { getAppDataDir } from './helpers.js';

function getLogDir(): string {
  const base = getAppDataDir(); // 复用现有 helper
  return join(base, 'godot-mcp', 'logs');
}
// Windows: %APPDATA%/godot-mcp/logs/
// macOS:   ~/Library/Application Support/godot-mcp/logs/
// Linux:   ~/.local/share/godot-mcp/logs/
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
| **日志流（左下）** | 实时滚动日志，按级别着色，支持过滤/暂停/滚动 | 实时 |
| **工具统计（右上）** | 调用次数 Top 10、平均耗时、成功率 | 每 5s |
| **性能趋势（右下）** | 调用频率 sparkline、错误率 sparkline、平均耗时 sparkline（最近 30 分钟） | 每 10s |

### 4.4 日志着色方案

所有颜色定义集中在 `themes.ts` 中，日志级别和模块着色统一管理。

**级别着色：**

| 级别 | 颜色 | 前缀 |
|------|------|------|
| DEBUG | gray | `[dbg]` |
| INFO | white（默认） | 无 |
| WARN | yellow | `WARN` |
| ERROR | red (bold) | `ERROR` |

**模块着色：**

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

### 4.6 数据读取 — LogReader

LogReader 是 JSONL 文件与 Dashboard 之间的桥梁。

#### byte offset 追踪

LogReader 维护当前文件的 byte offset，每次只读取 offset 之后的新内容。fs.watch 和轮询共享同一个 offset，天然去重——即使两个触发源同时报告，第二个读取到 offset 无新内容，跳过。

```typescript
class LogReader {
  private byteOffset = 0;
  private currentFile = '';
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timer | null = null;

  async start(): Promise<void> {
    this.currentFile = this.getTodayFile();
    // 读取尾部初始化（最近 500 条）
    this.byteOffset = await this.readTail(this.currentFile, 500);
    // 启动 fs.watch
    this.startWatch();
    // 启动 2s 轮询 fallback
    this.startPolling();
  }

  private startWatch(): void {
    this.watcher = fs.watch(this.logDir, (event, filename) => {
      if (event === 'rename' || event === 'change') {
        this.checkForNewData();
      }
    });
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.checkForNewData(), 2000);
  }

  private async checkForNewData(): Promise<void> {
    const todayFile = this.getTodayFile();
    if (todayFile !== this.currentFile) {
      // 日志轮转：检测 rotation 条目或直接切换
      this.currentFile = todayFile;
      this.byteOffset = 0;
    }
    const newEntries = await this.readFromOffset(this.currentFile, this.byteOffset);
    if (newEntries.length > 0) {
      this.byteOffset += newEntries.rawBytesRead;
      this.emit('entries', newEntries.parsed);
    }
  }
}
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
  minute: string; // 'HH:MM'
  calls: number;
  errors: number;
  totalDurationMs: number;
  count: number;  // 用于计算平均值
}

// 环形缓冲区 — O(1) 插入，固定容量
class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - this.size + i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  get length(): number { return this.size; }
}

interface DashboardState {
  startTime: string;
  mode: string;           // headless / editor / bridge
  projectPath: string;
  totalCalls: number;
  totalErrors: number;
  toolStats: Map<string, ToolStats>;
  timeSeries: TimeSeriesBucket[]; // 最近 30 分钟（30 个桶）
  recentLogs: RingBuffer<LogEntry>; // 环形缓冲区，容量 500
}
```

### 5.2 聚合逻辑

- 每个 `type: 'tool_end'` 类型的日志条目更新 `toolStats` 和 `timeSeries`
- `toolEnd` 中 `error` 非空时计入 `errors`
- 每分钟自动合并统计桶（超过 30 个桶时移除最旧的）
- `recentLogs` 使用 `RingBuffer`（容量 500），O(1) 插入替代 O(n) 的 Array.shift

---

## 6. 文件结构

```
src/
├── core/
│   └── logger.ts          # Logger 模块（新增 — PR1）
├── dashboard/             # Dashboard 独立模块（新增目录 — PR2）
│   ├── index.ts           # CLI 入口
│   ├── log-reader.ts      # JSONL 文件读取 + fs.watch + 轮询 fallback
│   ├── aggregator.ts      # 统计聚合器 + RingBuffer
│   ├── ui.tsx             # ink 面板布局（React JSX）
│   ├── themes.ts          # 颜色主题定义（集中管理所有颜色常量）
│   └── sparkline.ts       # sparkline 图表渲染（纯函数，无依赖）
```

---

## 7. 依赖

| 包 | 用途 | 安装方式 |
|---|---|---|
| `ink` | React for CLI — TUI 框架（Sindre Sorhus 维护，活跃开发） | `optionalDependencies` |
| `react` | ink 的 peer dependency | `optionalDependencies` |
| `chalk` | 终端颜色 | `optionalDependencies`（ink 通常自带） |

所有新依赖放在 `optionalDependencies` 中，安装失败不影响 MCP 服务主功能。

**为什么选 ink 而非 blessed：**
- blessed 最后实质性更新 ~2020 年，200+ open issues，维护停滞
- ink 由 Sindre Sorhus 维护，活跃开发，npm 周下载量 > 500K
- React 声明式模式，组件化更容易维护
- 缺点：无开箱即用的表格/sparkline，需用 `<Box>` + `<Text>` 组装（约 50 行自定义组件）

---

## 8. 启动流程

1. 用户在独立终端运行 `godot-mcp-dashboard`
2. 检测日志目录是否存在（如不存在，提示先启动 MCP 服务）
3. LogReader 读取当天 JSONL 文件尾部（最近 500 条）初始化
4. 启动 fs.watch 监听 + 2s 轮询 fallback
5. ink 渲染面板，进入事件循环
6. MCP 服务端写入新日志 → LogReader 增量读取 → Aggregator 更新 → UI 重渲染

---

## 9. 测试策略

| 层 | 测试内容 | 测试方式 |
|---|---|---|
| Logger | 双写、JSONL 格式、缓冲刷新、轮转 | 单元测试 |
| Logger | **sanitizer 截断逻辑、敏感 key 过滤** | 单元测试 |
| Logger | **toolStart/toolEnd 正常配对** | 单元测试 |
| Logger | **toolStart 60s 超时自动配对** | 单元测试（用 fake timer） |
| Logger | **未知 callId 的 toolEnd 记录 warn** | 单元测试 |
| Logger | **JSONL 原子写入（每行完整）** | 单元测试 |
| Logger | **优雅关闭 flush（SIGTERM/SIGINT）** | 单元测试 |
| LogReader | 增量解析、byte offset | 单元测试（mock 文件） |
| LogReader | **fs.watch 失效时切换轮询** | 单元测试（mock fs.watch） |
| Aggregator | 统计计算正确性、时间桶合并 | 单元测试 |
| Aggregator | **超时自动配对统计** | 单元测试 |
| RingBuffer | O(1) 插入、toArray 顺序正确 | 单元测试 |
| Sparkline | 数据 → sparkline 字符转换 | 单元测试 |
| UI | 渲染正确性 | 手动测试（ink 需要 TTY） |

---

## 10. 不做什么

- **不做 Web UI** — 纯 TUI，不引入 HTTP server
- **不做远程监控** — 只读本地文件，无网络
- **不做历史回看 UI** — 只展示当前会话日志，历史用 `cat`/`jq` 查看
- **不改 MCP 通信协议** — 完全透明，不影响 Claude Code 对话
- **不做告警通知** — 仅展示，不发送邮件/通知
- **不做 p95/p99 sparkline** — v2 考虑
- **不做结构化 meta 类型** — v1 保持 `Record<string, unknown>`，v2 定义精确类型
