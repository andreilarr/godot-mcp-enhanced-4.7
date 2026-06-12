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
3. 如果匹配且 `loadAutoloads` 为 `false`，自动设为 `true`
4. 在执行结果中附加提示

### 新增函数

```typescript
// gdscript-executor.ts

/**
 * 从 project.godot 解析 autoload 单例名列表。
 * [autoload] 段格式：SingletonName="*res://path/to/singleton.gd"
 */
function parseAutoloadNames(projectPath: string): string[]

/**
 * 检测代码中是否引用了 autoload 单例。
 * 匹配规则：\bAutoloadName\b（词边界），排除注释和字符串。
 * 返回匹配到的 autoload 名列表。
 */
function detectAutoloadUsage(code: string, autoloadNames: string[]): string[]
```

### 匹配规则

- 词边界匹配：`\bGameManager\b`、`\bDataTables\b`
- 排除 `#` 开头的注释行
- 排除 `"..."` 和 `'...'` 内的引用（粗略排除）
- 大小写敏感（autoload 名精确匹配）

### 调用点

`gdscript-executor.ts` 的 `executeGdscript()` 函数，约 line 636（`loadAutoloads` 变量初始化之后）：

```typescript
// 新增：autoload 智能检测
if (!loadAutoloads) {
  const autoloadNames = parseAutoloadNames(projectPath);
  const matched = detectAutoloadUsage(code, autoloadNames);
  if (matched.length > 0) {
    loadAutoloads = true;
    getLogger().info('gdscript', `Auto-detected autoload usage: ${matched.join(', ')}. Enabled load_autoloads.`);
  }
}
```

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
  // ... parse project.godot ...
  _autoloadCache = { projectPath, names, ts: now };
  return names;
}
```

### 执行结果提示

当自动启用 autoload 时，在返回的 `raw_output` 前附加一行：

```
ℹ️ Auto-detected autoload usage (GameManager, DataTables). Enabled load_autoloads=true automatically.
```

### 边界情况

- **autoload 名与局部变量同名**：极少见，且即使误触发也只是多加载 autoload（性能影响可控）
- **project.godot 不存在或无 `[autoload]` 段**：返回空列表，跳过检测
- **代码在字符串中引用 autoload 名**：粗略排除后仍可能误触发，但影响仅为多加载 autoload
- **用户显式传 `load_autoloads=false`**：`false || false` 为 `false`，需要区分「用户未传」和「用户显式传 false」。解决方案：检查 `args.load_autoloads === undefined` 而非 falsy

### 不包含的内容

- 错误后分析（后续增强）
- 自动重试机制
- 修改 `wrapSnippet` 的行为

## 涉及文件

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/gdscript-executor.ts` | 修改 | 新增 `parseAutoloadNames`、`detectAutoloadUsage`，修改 `executeGdscript` |
| `test/gdscript-executor.test.ts` | 新增/修改 | 覆盖智能检测逻辑 |

## 测试计划

1. `parseAutoloadNames` — 解析有效/无效/缺失的 project.godot
2. `detectAutoloadUsage` — 匹配/不匹配/注释排除/字符串排除
3. 集成测试 — 代码引用 autoload 时自动启用，未引用时不启用
4. 缓存测试 — TTL 过期后重新读取，同一项目命中缓存
5. 用户显式传 `load_autoloads=false` 时不自动启用
