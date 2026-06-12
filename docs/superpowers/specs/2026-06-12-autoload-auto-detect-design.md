# Autoload 智能检测设计

## 问题

用户使用 `execute_gdscript` 测试引用 autoload 单例的代码时，默认 `load_autoloads=false`，导致：
- 报错 `"Class X hides an autoload singleton"`
- 报错 `"Cannot find member X in base Y"`
- 报错 `"Cannot call non-static function X on class Y"`

用户不知道需要手动传 `load_autoloads: true`，认为是 MCP 功能缺陷。

## 目标

当用户代码引用了项目 autoload 单例时，自动启用 `load_autoloads`，无需手动传参。

## 方案：执行前扫描

在 `executeGdscript()` 沙箱扫描之后、脚本包装之前，插入 autoload 检测步骤。

### 检测流程

```
用户代码 → 沙箱扫描 → autoload 检测 → 脚本包装 → 执行
```

1. 解析 `project.godot` 的 `[autoload]` 段，提取 autoload 名列表
2. 扫描代码是否引用这些 autoload 名
3. 如果匹配且用户未显式禁用，自动设为 `true`
4. 在执行结果中附加结构化提示

### 新增函数

```typescript
// gdscript-executor.ts

/**
 * 从 project.godot 解析 autoload 单例名列表。
 * [autoload] 段格式：SingletonName="*res://path/to/singleton.gd"
 * 全面 try-catch：任何错误返回空数组（静默降级）。
 */
function parseAutoloadNames(projectPath: string): string[]

/**
 * 检测代码中是否引用了 autoload 单例。
 * 匹配规则：\bAutoloadName\b（词边界，正则元字符已转义）。
 * 不排除注释/字符串——误触发代价仅为多加载 autoload，可接受。
 * 返回匹配到的 autoload 名列表。
 */
function detectAutoloadUsage(code: string, autoloadNames: string[]): string[]
```

### 匹配规则

- 词边界匹配：`\bGameManager\b`、`\bDataTables\b`
- **CRITICAL：autoload 名可能含正则元字符**（如 `My-Singleton`、`UI.Manager`），必须用 `escapeRegExp()` 转义后再构建正则
- 大小写敏感（autoload 名精确匹配）
- **不排除注释和字符串**：误触发代价仅为多加载 autoload（+3-5 秒启动时间），简化逻辑更可靠

### 调用点

`gdscript-executor.ts` 的 `executeGdscript()` 函数，约 line 636（`loadAutoloads` 变量初始化之后）：

```typescript
// 新增：autoload 智能检测
// IMPORTANT: 用 === undefined 区分「用户未传」和「用户显式传 false」
if (options.loadAutoloads === undefined) {
  const autoloadNames = parseAutoloadNames(projectPath);
  const matched = detectAutoloadUsage(code, autoloadNames);
  if (matched.length > 0) {
    loadAutoloads = true;
    getLogger().info('gdscript', `Auto-detected autoload usage: ${matched.join(', ')}. Enabled load_autoloads.`);
  }
}
```

**注意**：原来用 `(args.load_autoloads as boolean) || false`，需改为 `args.load_autoloads === undefined ? undefined : (args.load_autoloads as boolean)`，让 `executeGdscript` 内部能区分。

### 缓存优化

`parseAutoloadNames` 内部调用 `parseGodotConfig`。添加内存缓存（TTL 30 秒），避免同一会话重复读文件。

```typescript
let _autoloadCache: { projectPath: string; names: string[]; ts: number } | null = null;
const AUTOLOAD_CACHE_TTL = 30_000; // 30 seconds

function parseAutoloadNames(projectPath: string): string[] {
  const now = Date.now();
  if (_autoloadCache && _autoloadCache.projectPath === projectPath && now - _autoloadCache.ts < AUTOLOAD_CACHE_TTL) {
    return _autoloadCache.names;
  }
  try {
    // ... parse project.godot ...
    _autoloadCache = { projectPath, names, ts: now };
    return names;
  } catch {
    return []; // 静默降级：任何错误返回空数组
  }
}
```

### 执行结果提示

在 `ExecuteGdscriptResult` 接口中新增结构化字段：

```typescript
export interface ExecuteGdscriptResult {
  // ... 现有字段 ...
  /** 自动检测到的 autoload 引用列表（仅当自动启用时非空） */
  autoload_detected?: string[];
}
```

当自动启用 autoload 时，`autoload_detected` 设为匹配到的名称列表。调用方（`handleTool`）据此拼接提示文本，不修改 `raw_output`。

### 边界情况

- **autoload 名与局部变量同名**：极少见，误触发仅多加载 autoload（+3-5 秒）
- **project.godot 不存在或无 `[autoload]` 段**：全面 try-catch，返回空数组
- **autoload 名含正则元字符**：`escapeRegExp()` 转义后构建正则
- **用户显式传 `load_autoloads=false`**：`options.loadAutoloads === false`，不触发自动检测
- **空代码**：`detectAutoloadUsage('', names)` 返回空数组，无影响

### 不包含的内容

- 错误后分析（后续增强）
- 自动重试机制
- 修改 `wrapSnippet` 的行为

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/gdscript-executor.ts` | 修改 | 新增 `parseAutoloadNames`、`detectAutoloadUsage`，修改 `executeGdscript`，新增 `autoload_detected` 字段 |
| `src/tools/script.ts` | 修改 | `handleTool` 中区分 undefined/false，拼接 autoload_detected 提示 |
| `test/gdscript-executor.test.js` | 新增 | 覆盖智能检测逻辑（用 .js 格式匹配项目惯例） |

## 测试计划

1. `parseAutoloadNames` — 有效 project.godot / 无 autoload 段 / 文件不存在 / 缓存命中 / 缓存过期
2. `detectAutoloadUsage` — 匹配 / 不匹配 / 空代码 / autoload 名含正则元字符
3. 集成测试 — 代码引用 autoload 时自动启用，未引用时不启用
4. 缓存测试 — TTL 过期后重新读取，同一项目命中缓存
5. 用户显式传 `load_autoloads=false` 时不自动启用
6. 用户显式传 `load_autoloads=true` 时正常启用（不依赖检测）
7. `autoload_detected` 字段验证 — 自动启用时有值、手动传参时无值

## 审查修正记录

Eng Review 通过（2026-06-12），8 项修正全部纳入：

| 优先级 | 修正项 | 状态 |
|--------|--------|------|
| CRITICAL | autoload 名 escapeRegExp() 转义 | ✅ 已纳入匹配规则 |
| IMPORTANT | === undefined 区分未传/显式 false | ✅ 已纳入调用点 |
| IMPORTANT | 移除注释/字符串排除逻辑 | ✅ 已纳入匹配规则 |
| IMPORTANT | parseAutoloadNames 全面 try-catch | ✅ 已纳入缓存优化 |
| IMPORTANT | autoload_detected 结构化字段 | ✅ 已纳入结果提示 |
| ADVISORY | 测试文件用 .js 格式 | ✅ 已更新涉及文件 |
| ADVISORY | 补全测试场景（空代码+字段验证） | ✅ 已更新测试计划 |
