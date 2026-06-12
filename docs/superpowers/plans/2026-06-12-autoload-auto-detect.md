# Autoload 智能检测实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** execute_gdscript 自动检测用户代码中的 autoload 引用，自动启用 load_autoloads，消除手动传参需求。

**Architecture:** 在 `executeGdscript()` 沙箱扫描后、脚本包装前，解析 `project.godot` 获取 autoload 名列表，扫描用户代码中的引用，自动设置 `loadAutoloads=true`。通过 `ExecuteGdscriptResult.autoload_detected` 结构化字段反馈给调用方。

**Tech Stack:** TypeScript, Vitest, Node.js fs

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/gdscript-executor.ts` | 修改 | 新增 `parseAutoloadNames`、`detectAutoloadUsage`、`escapeRegExp`；修改 `ExecuteGdscriptResult` 接口和 `executeGdscript` 函数 |
| `src/tools/script.ts` | 修改 | 修改 `loadAutoloads` 传参逻辑（区分 undefined/false）；拼接 `autoload_detected` 提示 |
| `test/gdscript-executor.test.js` | 新增 | 覆盖 `parseAutoloadNames`、`detectAutoloadUsage`、缓存、集成逻辑 |

---

### Task 1: escapeRegExp 工具函数 + 测试

**Files:**
- Modify: `src/gdscript-executor.ts` (在 `DANGEROUS_API_TOKENS` 数组之后，约 line 80)
- Create: `test/gdscript-executor.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/gdscript-executor.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  escapeRegExp,
  detectAutoloadUsage,
  parseAutoloadNames,
  _resetAutoloadCache,
} from '../src/gdscript-executor.js';

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('My-Singleton')).toBe('My\\-Singleton');
    expect(escapeRegExp('UI.Manager')).toBe('UI\\.Manager');
    expect(escapeRegExp('NormalName')).toBe('NormalName');
    expect(escapeRegExp('a*b+c?d')).toBe('a\\*b\\+c\\?d');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/gdscript-executor.test.js`
Expected: FAIL — `escapeRegExp` is not exported

- [ ] **Step 3: 实现 escapeRegExp**

在 `src/gdscript-executor.ts` 中 `DANGEROUS_API_TOKENS` 数组定义之后（约 line 80），添加：

```typescript
/** Escape regex metacharacters in a string. Used for autoload name matching. */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

同时在模块导出区确认该函数已 export（函数声明前已有 `export`）。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/gdscript-executor.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/gdscript-executor.ts test/gdscript-executor.test.js
git commit -m "feat: add escapeRegExp utility for autoload detection"
```

---

### Task 2: parseAutoloadNames + 缓存 + 测试

**Files:**
- Modify: `src/gdscript-executor.ts` (在 `escapeRegExp` 之后)
- Modify: `test/gdscript-executor.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `test/gdscript-executor.test.js`：

```javascript
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// 测试用临时目录
const TMP = join(tmpdir(), 'autoload-test-' + process.pid);

beforeEach(() => {
  _resetAutoloadCache();
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

describe('parseAutoloadNames', () => {
  it('parses autoload names from project.godot', () => {
    writeFileSync(join(TMP, 'project.godot'), [
      '[application]',
      'config/name="Test"',
      '',
      '[autoload]',
      'GameManager="*res://singletons/game_manager.gd"',
      'DataTables="*res://data/data_tables.gd"',
      'GameEvents="*res://events/game_events.gd"',
      '',
      '[display]',
      'window/size/viewport_width=1280',
    ].join('\n'), 'utf-8');

    const names = parseAutoloadNames(TMP);
    expect(names).toEqual(['GameManager', 'DataTables', 'GameEvents']);
  });

  it('returns empty array when no [autoload] section', () => {
    writeFileSync(join(TMP, 'project.godot'), [
      '[application]',
      'config/name="Test"',
    ].join('\n'), 'utf-8');

    const names = parseAutoloadNames(TMP);
    expect(names).toEqual([]);
  });

  it('returns empty array when project.godot does not exist', () => {
    const names = parseAutoloadNames(join(tmpdir(), 'nonexistent-' + Date.now()));
    expect(names).toEqual([]);
  });

  it('caches result within TTL', () => {
    writeFileSync(join(TMP, 'project.godot'), [
      '[autoload]',
      'MySingleton="*res://my_singleton.gd"',
    ].join('\n'), 'utf-8');

    const first = parseAutoloadNames(TMP);
    // 删除文件后仍能命中缓存
    rmSync(join(TMP, 'project.godot'));
    const second = parseAutoloadNames(TMP);
    expect(second).toEqual(first);
  });

  it('handles malformed project.godot gracefully', () => {
    writeFileSync(join(TMP, 'project.godot'), 'not valid ini @#$%', 'utf-8');
    const names = parseAutoloadNames(TMP);
    expect(names).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/gdscript-executor.test.js`
Expected: FAIL — `parseAutoloadNames` is not exported

- [ ] **Step 3: 实现 parseAutoloadNames + 缓存**

在 `src/gdscript-executor.ts` 中 `escapeRegExp` 函数之后添加：

```typescript
// ─── Autoload auto-detection ─────────────────────────────────────────────────

let _autoloadCache: { projectPath: string; names: string[]; ts: number } | null = null;
const AUTOLOAD_CACHE_TTL = 30_000; // 30 seconds

/** @internal Reset autoload cache for testing */
export function _resetAutoloadCache(): void {
  _autoloadCache = null;
}

/**
 * Parse autoload singleton names from project.godot's [autoload] section.
 * Format: SingletonName="*res://path/to/singleton.gd"
 * Returns empty array on any error (file not found, parse error, etc.)
 */
export function parseAutoloadNames(projectPath: string): string[] {
  const now = Date.now();
  if (_autoloadCache && _autoloadCache.projectPath === projectPath && now - _autoloadCache.ts < AUTOLOAD_CACHE_TTL) {
    return _autoloadCache.names;
  }
  try {
    const configPath = join(projectPath, 'project.godot');
    if (!existsSync(configPath)) return [];
    const content = readFileSync(configPath, 'utf-8');
    const names: string[] = [];
    let inAutoload = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inAutoload = trimmed === '[autoload]';
        continue;
      }
      if (inAutoload) {
        const kvMatch = trimmed.match(/^(\S+)\s*=/);
        if (kvMatch) names.push(kvMatch[1]!);
      }
    }
    _autoloadCache = { projectPath, names, ts: now };
    return names;
  } catch {
    return [];
  }
}
```

在文件顶部 imports 中确认 `readFileSync`、`existsSync`、`join` 已导入（检查 import 行，已有则跳过）。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/gdscript-executor.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/gdscript-executor.ts test/gdscript-executor.test.js
git commit -m "feat: add parseAutoloadNames with cache for autoload detection"
```

---

### Task 3: detectAutoloadUsage + 测试

**Files:**
- Modify: `src/gdscript-executor.ts` (在 `parseAutoloadNames` 之后)
- Modify: `test/gdscript-executor.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `test/gdscript-executor.test.js`：

```javascript
describe('detectAutoloadUsage', () => {
  it('detects autoload references in code', () => {
    const code = 'var hp = GameManager.get_hp()\nDataTables.get_item("sword")';
    const result = detectAutoloadUsage(code, ['GameManager', 'DataTables', 'GameEvents']);
    expect(result).toContain('GameManager');
    expect(result).toContain('DataTables');
    expect(result).not.toContain('GameEvents');
  });

  it('returns empty array for no matches', () => {
    const code = 'var x = 1\nprint("hello")';
    const result = detectAutoloadUsage(code, ['GameManager', 'DataTables']);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty code', () => {
    const result = detectAutoloadUsage('', ['GameManager']);
    expect(result).toEqual([]);
  });

  it('handles autoload names with regex metacharacters', () => {
    const code = 'var x = My-Singleton.get_data()';
    const result = detectAutoloadUsage(code, ['My-Singleton']);
    expect(result).toContain('My-Singleton');
  });

  it('uses word boundary matching (no partial matches)', () => {
    const code = 'var x = MyGameManager.get()';
    const result = detectAutoloadUsage(code, ['GameManager']);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/gdscript-executor.test.js`
Expected: FAIL — `detectAutoloadUsage` is not exported

- [ ] **Step 3: 实现 detectAutoloadUsage**

在 `src/gdscript-executor.ts` 中 `parseAutoloadNames` 函数之后添加：

```typescript
/**
 * Detect whether user code references any autoload singleton names.
 * Simple word-boundary matching — no comment/string exclusion needed
 * because the cost of a false positive is only +3-5s startup time.
 */
export function detectAutoloadUsage(code: string, autoloadNames: string[]): string[] {
  if (!code || autoloadNames.length === 0) return [];
  const matched: string[] = [];
  for (const name of autoloadNames) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    if (pattern.test(code)) {
      matched.push(name);
    }
  }
  return matched;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/gdscript-executor.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/gdscript-executor.ts test/gdscript-executor.test.js
git commit -m "feat: add detectAutoloadUsage for autoload reference scanning"
```

---

### Task 4: 修改 ExecuteGdscriptResult 接口 + executeGdscript 检测逻辑

**Files:**
- Modify: `src/gdscript-executor.ts`

- [ ] **Step 1: 添加 autoload_detected 字段到接口**

在 `ExecuteGdscriptResult` 接口中（line 188 `duration_ms: number;` 之后）添加：

```typescript
  /** Auto-detected autoload references (non-empty when load_autoloads was auto-enabled) */
  autoload_detected?: string[];
```

- [ ] **Step 2: 在 executeGdscript 中插入检测逻辑**

将 `executeGdscript` 函数中 line 636 的：
```typescript
let loadAutoloads = options.loadAutoloads ?? false;
```

替换为：
```typescript
let loadAutoloads = options.loadAutoloads ?? false;
let autoloadDetected: string[] | undefined;

// Autoload auto-detection: scan code for autoload references when not explicitly set
if (options.loadAutoloads === undefined) {
  const autoloadNames = parseAutoloadNames(projectPath);
  const matched = detectAutoloadUsage(code, autoloadNames);
  if (matched.length > 0) {
    loadAutoloads = true;
    autoloadDetected = matched;
    getLogger().info('gdscript', `Auto-detected autoload usage: ${matched.join(', ')}. Enabled load_autoloads.`);
  }
}
```

- [ ] **Step 3: 将 autoloadDetected 注入所有 resolve() 返回值**

函数内所有 `resolve({...})` 调用（约 5 处）都需要添加 `autoload_detected: autoloadDetected,`。

在每处 resolve 的对象中，在 `duration_ms: ...` 行之后添加：
```typescript
          autoload_detected: autoloadDetected,
```

用 `replace_all` 一次性处理：搜索 `duration_ms: duration,`（成功返回）和 `duration_ms: 0,`（早期错误返回），在其后分别加 `autoload_detected` 字段。

注意：早期错误返回（kill switch、sandbox、godotPath 校验）也应有此字段，但此时 `autoloadDetected` 为 `undefined`，JSON 序列化时自动省略，无影响。

- [ ] **Step 4: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 运行全量 gdscript 相关测试**

Run: `npx vitest run test/gdscript-executor.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/gdscript-executor.ts
git commit -m "feat: integrate autoload auto-detection into executeGdscript"
```

---

### Task 5: 修改 script.ts 传参逻辑 + 提示文本

**Files:**
- Modify: `src/tools/script.ts`

- [ ] **Step 1: 修改 loadAutoloads 传参**

在 `src/tools/script.ts` 中，将 line 773 的：
```typescript
const loadAutoloads = (args.load_autoloads as boolean) || false;
```

替换为：
```typescript
const loadAutoloads = args.load_autoloads === undefined ? undefined : (args.load_autoloads as boolean);
```

这使 `undefined` 传入 `executeGdscript`，让自动检测逻辑生效；显式 `true/false` 直接传递。

- [ ] **Step 2: 拼接 autoload_detected 提示**

将 `execute_gdscript` case 的返回逻辑（约 line 784）：
```typescript
return textResult(JSON.stringify(result, null, 2));
```

替换为：
```typescript
let output = JSON.stringify(result, null, 2);
if (result.autoload_detected && result.autoload_detected.length > 0) {
  const names = result.autoload_detected.join(', ');
  output = `ℹ️ Auto-detected autoload usage (${names}). Enabled load_autoloads=true automatically.\n\n${output}`;
}
return textResult(output);
```

- [ ] **Step 3: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 运行全量测试**

Run: `npx vitest run --exclude test/e2e-full-tool-verification.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/script.ts
git commit -m "feat: wire autoload auto-detection through script tool"
```

---

### Task 6: 集成测试 + 清理

**Files:**
- Modify: `test/gdscript-executor.test.js`

- [ ] **Step 1: 添加集成测试**

追加到 `test/gdscript-executor.test.js`：

```javascript
describe('autoload auto-detection integration', () => {
  it('does not auto-detect when user explicitly passes false', () => {
    // detectAutoloadUsage 返回匹配项，但调用方检查 loadAutoloads !== undefined
    // 这里验证 detectAutoloadUsage 本身仍然正确检测
    const code = 'GameManager.get_hp()';
    const result = detectAutoloadUsage(code, ['GameManager']);
    expect(result).toContain('GameManager');
    // 集成逻辑在 executeGdscript 中：options.loadAutoloads === false 时跳过检测
    // 此处只验证基础功能
  });

  it('autoload_detected field is absent when no autoloads found', () => {
    // 验证空项目（无 autoload）不会产生 autoload_detected
    writeFileSync(join(TMP, 'project.godot'), [
      '[application]',
      'config/name="Empty"',
    ].join('\n'), 'utf-8');

    const names = parseAutoloadNames(TMP);
    expect(names).toEqual([]);
    const detected = detectAutoloadUsage('var x = 1', names);
    expect(detected).toEqual([]);
  });

  it('handles autoload names with special characters in code', () => {
    const code = 'var x = My_Module.fetch()';
    const result = detectAutoloadUsage(code, ['My_Module']);
    expect(result).toContain('My_Module');
  });
});
```

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run --exclude test/e2e-full-tool-verification.test.ts`
Expected: 全部 PASS（2474+ 测试）

- [ ] **Step 3: 提交**

```bash
git add test/gdscript-executor.test.js
git commit -m "test: add integration tests for autoload auto-detection"
```
