# execute_gdscript 危险检测增量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `execute_gdscript` 沙箱补两个增量——① `stripLiterals` 剥字符串/注释防 Phase 1 误报；② `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS` 环境变量运行时注入自定义危险正则。

**Architecture:** 两个纯函数（`stripLiterals`、`loadExtraDangerousPatterns`）独立实现并各自单测，然后接入 `scanGdscriptSandbox`：Phase 1 与 strict FileAccess 检测改用骨架（skeleton），Phase 2 `detectStringConcatBypass` **保持原文**（不可违反契约）。TDD，每任务一 commit。

**Tech Stack:** TypeScript（strict + noUncheckedIndexedAccess）、Vitest、Node.js ESM。无新依赖。

## Global Constraints

- 目标源文件：`src/gdscript-executor.ts`；测试文件：`test/gdscript-executor-core.test.js`
- `tsconfig.json` 开启 `strict: true` + `noUncheckedIndexedAccess: true` → 索引访问用 `code.charAt(i)`，禁止裸 `code[i]`
- 测试为 ESM `.js`，从 `'../src/gdscript-executor.js'` import；运行单文件：`npx vitest run test/gdscript-executor-core.test.js`
- **契约 P2-RAW**：`detectStringConcatBypass(code)` 必须接收**原文**，绝不接收 `skeleton`（否则 13 条 Phase 2 拼接绕过检测全部失效）
- 不引入任何新依赖；匹配现有代码风格（中文注释、`getLogger()` 审计）
- 命名对齐现有 env：`GODOT_MCP_SANDBOX` / `GODOT_MCP_DISABLE_SAFETY` / `GODOT_MCP_ALLOW_UNSAFE`

---

## File Structure

| 文件 | 责任 | 本计划改动 |
|------|------|-----------|
| `src/gdscript-executor.ts` | GDScript 执行器 + 沙箱扫描 | 新增 `stripLiterals`、`loadExtraDangerousPatterns`、`_resetExtraDangerousPatternsCache`（均 export）；改造 `scanGdscriptSandbox` |
| `test/gdscript-executor-core.test.js` | 执行器核心单测 | 新增 3 个 describe 块；翻转行 300 断言 |

---

## Task 1: stripLiterals 纯函数（TDD）

**Files:**
- Modify: `src/gdscript-executor.ts`（在 `scanGdscriptSandbox` 定义之前插入；并加入 export）
- Test: `test/gdscript-executor-core.test.js`（新增 `describe('stripLiterals', ...)` 块；import 加 `stripLiterals`）

**Interfaces:**
- Produces: `export function stripLiterals(code: string): string` —— 输入 GDScript 原文，返回剥去字符串内容与注释、保留引号/换行/代码结构的"骨架"

- [ ] **Step 1: 在测试文件 import 中加入 stripLiterals**

修改 `test/gdscript-executor-core.test.js` 行 2-11 的 import 块，在 `scanGdscriptSandbox,` 之后加入 `stripLiterals,`：

```js
import {
  wrapSnippet,
  wrapSnippetAsNode,
  isFullClass,
  injectHelpers,
  createAutoloadLoaderScript,
  createAutoloadLoaderScene,
  parseMcpMarkers,
  scanGdscriptSandbox,
  stripLiterals,
} from '../src/gdscript-executor.js';
```

- [ ] **Step 2: 写失败测试（在文件末尾追加）**

```js
// ─── stripLiterals ───────────────────────────────────────────────────────────

describe('stripLiterals', () => {
  it('strips content of double-quoted string but keeps quotes', () => {
    expect(stripLiterals('var s = "OS.execute is dangerous"')).toBe('var s = ""');
  });

  it('strips content of single-quoted string', () => {
    expect(stripLiterals("var s = 'OS.kill'")).toBe("var s = ''");
  });

  it('strips a full-line comment', () => {
    expect(stripLiterals('# OS.execute("ls")')).toBe('');
  });

  it('strips trailing comment but preserves code and newline', () => {
    expect(stripLiterals('var a = 1 # OS.execute\nvar b = 2')).toBe('var a = 1 \nvar b = 2');
  });

  it('does not treat # inside a string as a comment', () => {
    expect(stripLiterals('var s = "a#b"')).toBe('var s = ""');
  });

  it('handles triple-quoted string', () => {
    expect(stripLiterals('var s = """OS.execute"""')).toBe('var s = """"""');
  });

  it('handles escaped quote inside string without early close', () => {
    // GDScript 源码: var s = "a\"b"  (JS 字符串里 \\ 代表一个反斜杠)
    expect(stripLiterals('var s = "a\\"b"')).toBe('var s = ""');
  });

  it('preserves a real dangerous call so Phase 1 still detects it', () => {
    expect(stripLiterals('OS.execute("ls")')).toBe('OS.execute("")');
  });

  it('preserves reflection pattern so .call("x") is still detectable', () => {
    expect(stripLiterals('obj.call("execute")')).toBe('obj.call("")');
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run test/gdscript-executor-core.test.js -t stripLiterals`
Expected: FAIL —— `stripLiterals is not a function`（或 import 报错 undefined）

- [ ] **Step 4: 在 src 中实现 stripLiterals（export）**

在 `src/gdscript-executor.ts` 中、`scanGdscriptSandbox` 函数定义（行 244）之前插入：

```typescript
/**
 * 剥去 GDScript 代码中的字符串字面量内容与注释，返回"骨架"。
 * 保留引号对、换行和代码结构；仅删除字符串内容与注释文本。
 *
 * 用途：让 Phase 1 正则扫描在骨架上进行，避免注释/字符串里的危险 API 名导致误报。
 *
 * ⚠️ 契约 P2-RAW：此函数的输出【绝不能】喂给 detectStringConcatBypass（Phase 2）。
 *    Phase 2 依赖字符串字面量内容做拼接重构，必须接收原文。见 scanGdscriptSandbox。
 *
 * 算法：字符级状态机，正确处理单/双/三引号字符串、转义引号、# 注释。
 * 用 charAt 而非 code[i]，规避 noUncheckedIndexedAccess 的 string|undefined。
 * 顺序：先识别字符串（字符串内的 # 不当注释），再识别注释。 */
export function stripLiterals(code: string): string {
  let result = '';
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code.charAt(i);

    // 三引号字符串 """ 或 '''
    if ((ch === '"' || ch === "'") && code.charAt(i + 1) === ch && code.charAt(i + 2) === ch) {
      const quote = ch;
      result += quote + quote + quote; // 保留开引号
      i += 3;
      while (i < len) {
        if (code.charAt(i) === '\\' && i + 1 < len) {
          i += 2; // 转义:跳过下一字符
          continue;
        }
        if (code.charAt(i) === quote && code.charAt(i + 1) === quote && code.charAt(i + 2) === quote) {
          result += quote + quote + quote; // 保留闭引号
          i += 3;
          break;
        }
        i++; // 字符串内容:丢弃
      }
      continue;
    }

    // 单/双引号字符串
    if (ch === '"' || ch === "'") {
      const quote = ch;
      result += quote; // 保留开引号
      i++;
      while (i < len) {
        if (code.charAt(i) === '\\' && i + 1 < len) {
          i += 2; // 转义跳过
          continue;
        }
        if (code.charAt(i) === quote) {
          result += quote; // 保留闭引号
          i++;
          break;
        }
        if (code.charAt(i) === '\n') {
          result += '\n'; // 未闭合即换行:保留换行,退出字符串态
          i++;
          break;
        }
        i++; // 字符串内容:丢弃
      }
      continue;
    }

    // 行注释 # 到行尾
    if (ch === '#') {
      while (i < len && code.charAt(i) !== '\n') {
        i++; // 注释内容:丢弃
      }
      continue; // 换行交给外层循环保留
    }

    result += ch; // 普通代码字符:保留
    i++;
  }

  return result;
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run test/gdscript-executor-core.test.js -t stripLiterals`
Expected: PASS —— 9 条 stripLiterals 用例全绿

- [ ] **Step 6: 提交**

```bash
cd /d/GitHub/godot-mcp-enhanced
git add src/gdscript-executor.ts test/gdscript-executor-core.test.js
git commit -m "feat(gdscript-executor): 新增 stripLiterals 剥字符串/注释的纯函数"
```

---

## Task 2: loadExtraDangerousPatterns 纯函数（TDD）

**Files:**
- Modify: `src/gdscript-executor.ts`（新增 `loadExtraDangerousPatterns` + `_resetExtraDangerousPatternsCache` + 模块级 cache 变量；均 export）
- Test: `test/gdscript-executor-core.test.js`（新增 `describe('loadExtraDangerousPatterns', ...)`；import 加 `loadExtraDangerousPatterns, _resetExtraDangerousPatternsCache`）

**Interfaces:**
- Produces:
  - `export function loadExtraDangerousPatterns(): Array<{ pattern: RegExp; label: string }>`
  - `export function _resetExtraDangerousPatternsCache(): void`（测试重置缓存）
- Consumes: `getLogger`（已 import，行 29）

- [ ] **Step 1: 在测试文件 import 中加入新符号**

修改 import 块，继续追加：

```js
import {
  wrapSnippet,
  wrapSnippetAsNode,
  isFullClass,
  injectHelpers,
  createAutoloadLoaderScript,
  createAutoloadLoaderScene,
  parseMcpMarkers,
  scanGdscriptSandbox,
  stripLiterals,
  loadExtraDangerousPatterns,
  _resetExtraDangerousPatternsCache,
} from '../src/gdscript-executor.js';
```

- [ ] **Step 2: 写失败测试（追加到文件末尾）**

```js
// ─── loadExtraDangerousPatterns (env-injected extra danger patterns) ────────

describe('loadExtraDangerousPatterns', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS;
    _resetExtraDangerousPatternsCache();
  });

  it('returns empty array when env is not set', () => {
    expect(loadExtraDangerousPatterns()).toEqual([]);
  });

  it('loads valid patterns from env', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\\.request', label: 'HTTP request (project policy)' },
    ]);
    const patterns = loadExtraDangerousPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].label).toBe('HTTP request (project policy)');
    expect(patterns[0].pattern.test('HTTPRequest.request("url")')).toBe(true);
  });

  it('skips invalid regex without crashing and keeps valid ones', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: '(', label: 'bad regex' },
      { pattern: 'ValidPattern', label: 'good' },
    ]);
    const patterns = loadExtraDangerousPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].label).toBe('good');
  });

  it('ignores non-array JSON', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify({ not: 'array' });
    expect(loadExtraDangerousPatterns()).toEqual([]);
  });

  it('ignores malformed JSON', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = 'not json {{{';
    expect(loadExtraDangerousPatterns()).toEqual([]);
  });

  it('skips entries with missing/non-string fields', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'OK', label: 'valid' },
      { pattern: 123, label: 'bad-type' },
      { pattern: 'OK2' },
      'not-an-object',
    ]);
    const patterns = loadExtraDangerousPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].label).toBe('valid');
  });

  it('memoizes: same env returns same array reference', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'X', label: 'Y' },
    ]);
    const a = loadExtraDangerousPatterns();
    const b = loadExtraDangerousPatterns();
    expect(a).toBe(b);
  });

  it('re-parses when env value changes', () => {
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'A', label: 'a' },
    ]);
    const first = loadExtraDangerousPatterns();
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'B', label: 'b' },
    ]);
    const second = loadExtraDangerousPatterns();
    expect(first).not.toBe(second);
    expect(second[0].label).toBe('b');
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run test/gdscript-executor-core.test.js -t loadExtraDangerousPatterns`
Expected: FAIL —— `loadExtraDangerousPatterns is not a function`

- [ ] **Step 4: 在 src 中实现（紧邻 `_autoloadCache` 的缓存风格，放在 `stripLiterals` 之后）**

```typescript
// ─── Extra dangerous patterns (env-injected, C-SEC-02 扩展) ──────────────────

let _extraPatternsCache: { raw: string; patterns: Array<{ pattern: RegExp; label: string }> } | null = null;

/** @internal 测试用:重置 extra patterns 缓存 */
export function _resetExtraDangerousPatternsCache(): void {
  _extraPatternsCache = null;
}

/**
 * 从环境变量 GODOT_MCP_EXTRA_DANGEROUS_PATTERNS 加载用户自定义危险正则。
 * 格式:JSON 数组 [{"pattern": <正则源码>, "label": <人类可读标签>}, ...]
 *
 * memoized:以 raw 字符串为键,相同 env 不重复解析(风格同 _autoloadCache)。
 * 坏正则/坏 JSON 降级:跳过该条或整体忽略,记录 warn,绝不抛异常。 */
export function loadExtraDangerousPatterns(): Array<{ pattern: RegExp; label: string }> {
  const raw = process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS;
  if (!raw) return [];
  if (_extraPatternsCache && _extraPatternsCache.raw === raw) {
    return _extraPatternsCache.patterns;
  }
  const patterns: Array<{ pattern: RegExp; label: string }> = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      getLogger().warn('security', 'GODOT_MCP_EXTRA_DANGEROUS_PATTERNS is not a JSON array, ignoring');
      _extraPatternsCache = { raw, patterns };
      return patterns;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { pattern?: unknown; label?: unknown };
      if (typeof e.pattern !== 'string' || typeof e.label !== 'string') continue;
      try {
        patterns.push({ pattern: new RegExp(e.pattern), label: e.label });
      } catch (regexErr) {
        getLogger().warn('security', `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS: invalid regex skipped: "${e.pattern}" (${regexErr instanceof Error ? regexErr.message : regexErr})`);
      }
    }
  } catch (jsonErr) {
    getLogger().warn('security', `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS: invalid JSON, ignoring (${jsonErr instanceof Error ? jsonErr.message : jsonErr})`);
  }
  _extraPatternsCache = { raw, patterns };
  return patterns;
}
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run test/gdscript-executor-core.test.js -t loadExtraDangerousPatterns`
Expected: PASS —— 8 条用例全绿

- [ ] **Step 6: 提交**

```bash
cd /d/GitHub/godot-mcp-enhanced
git add src/gdscript-executor.ts test/gdscript-executor-core.test.js
git commit -m "feat(gdscript-executor): 新增 loadExtraDangerousPatterns 支持 env 注入危险正则"
```

---

## Task 3: 接入 stripLiterals 到 scanGdscriptSandbox + 翻转行 300

**Files:**
- Modify: `src/gdscript-executor.ts:244-270`（`scanGdscriptSandbox`）
- Test: `test/gdscript-executor-core.test.js:300-307`（翻转断言）+ 新增注释场景用例

**Interfaces:**
- Consumes: `stripLiterals`（Task 1 产出）
- 依赖：Task 1 必须先完成

- [ ] **Step 1: 翻转行 300 的"自相矛盾"测试**

修改 `test/gdscript-executor-core.test.js` 行 300-307，把"会误报"断言改为"不误报"：

```js
  it('does not flag OS.execute inside a string literal context', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var s = "OS.execute is dangerous"';
    const warnings = scanGdscriptSandbox(code);
    // stripLiterals 剥去字符串内容后,Phase 1 不再误报
    expect(warnings).toEqual([]);
  });
```

- [ ] **Step 2: 在 scanGdscriptSandbox extended describe 内追加注释/字符串不误报用例**

在 `describe('scanGdscriptSandbox extended', ...)` 块内（行 307 的 `}` 之后、行 309 的 `flags OS.shell_open` 之前）插入：

```js
  it('does not flag OS.execute inside a line comment', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = '# OS.execute("ls") is just a comment';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings).toEqual([]);
  });

  it('does not flag DirAccess.remove inside a string literal', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const code = 'var desc = "DirAccess.remove deletes a directory"';
    const warnings = scanGdscriptSandbox(code);
    expect(warnings).toEqual([]);
  });

  it('still flags a real OS.execute call (regression guard)', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('OS.execute("ls")');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('OS system command');
  });
```

- [ ] **Step 3: 运行测试验证 Task 3 新增/翻转用例失败（尚未接入）**

Run: `npx vitest run test/gdscript-executor-core.test.js -t "scanGdscriptSandbox extended"`
Expected: FAIL —— 翻转后的"不误报"用例实际仍被误报（`expected []`），因为 Phase 1 还在用原文

- [ ] **Step 4: 改造 scanGdscriptSandbox —— Phase 1 + strict 用 skeleton，Phase 2 保持原文**

修改 `src/gdscript-executor.ts` 行 244-270 的 `scanGdscriptSandbox`，整体替换为：

```typescript
export function scanGdscriptSandbox(code: string): string[] {
  if (process.env.GODOT_MCP_SANDBOX === 'disabled') {
    getLogger().warn('security', '⚠️ GODOT_MCP_SANDBOX=disabled — ALL sandbox checks bypassed. Any GDScript code will execute with unrestricted host access.');
    return [];
  }
  const warnings: string[] = [];

  // 骨架:剥去字符串内容与注释,仅用于 Phase 1 正则匹配,避免注释/字符串里的 API 名误报。
  // ⚠️ 契约 P2-RAW:skeleton 绝不能传给 detectStringConcatBypass(Phase 2)!
  const skeleton = stripLiterals(code);

  // Phase 1: Direct pattern matching (on skeleton)
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(skeleton)) {
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${label}`);
    }
  }

  // 用户自定义额外危险模式 (GODOT_MCP_EXTRA_DANGEROUS_PATTERNS),同样在骨架上检测
  for (const { pattern, label } of loadExtraDangerousPatterns()) {
    if (pattern.test(skeleton)) {
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${label}`);
    }
  }

  // C-03: In strict mode, also block FileAccess.READ (all file access) — on skeleton
  if (process.env.GODOT_MCP_SANDBOX === 'strict') {
    if (/FileAccess\.open\b/.test(skeleton)) {
      warnings.push('[SANDBOX] Potential dangerous operation detected: File access (strict mode)');
    }
  }

  // Phase 2: String concatenation bypass detection
  // ⚠️ 契约 P2-RAW:detectStringConcatBypass 必须接收【原文 code】,不能是 skeleton。
  //    它自己提取字符串字面量内容做拼接重构;喂骨架会让所有拼接绕过检测失效。
  const concatWarnings = detectStringConcatBypass(code);
  warnings.push(...concatWarnings);

  return warnings;
}
```

> 注：此步同时接入了 Task 2 的 extra patterns 循环（依赖 Task 2 已完成）。若按 Task 顺序执行，Task 2 已先落地，此处可直接编译通过。

- [ ] **Step 5: 运行整个测试文件验证全绿（含 13 条 Phase 2 回归）**

Run: `npx vitest run test/gdscript-executor-core.test.js`
Expected: PASS —— 全部用例通过，包括：
- 翻转后的行 300（不误报）
- 新增注释/字符串不误报 + 真实调用仍检测
- 13 条 Phase 2 拼接绕过检测（行 333-457）零回归
- 反射检测（`.call("str")`/`.callv`/`ClassDB`）零回归

- [ ] **Step 6: 提交**

```bash
cd /d/GitHub/godot-mcp-enhanced
git add src/gdscript-executor.ts test/gdscript-executor-core.test.js
git commit -m "fix(gdscript-executor): Phase 1 改用 stripLiterals 骨架消除注释/字符串误报

翻转行 300 自相矛盾测试(原断言会误报)。Phase 2 detectStringConcatBypass
保持接收原文(契约 P2-RAW),13 条拼接绕过检测零回归。"
```

---

## Task 4: extra patterns 端到端验证

**Files:**
- Test: `test/gdscript-executor-core.test.js`（新增 `describe('scanGdscriptSandbox extra patterns (env-injected)', ...)`）

**Interfaces:**
- Consumes: `loadExtraDangerousPatterns`（Task 2）、`scanGdscriptSandbox` 已接入 extra 循环（Task 3 Step 4）
- 依赖：Task 2、Task 3 必须先完成

> 说明：Task 3 Step 4 已经把 extra patterns 循环接入 `scanGdscriptSandbox`。本任务只补端到端行为测试，验证 env 注入确实生效、且同样走骨架（字符串内不误报）。

- [ ] **Step 1: 写端到端测试（追加到文件末尾）**

```js
// ─── scanGdscriptSandbox extra patterns (env-injected, end-to-end) ──────────

describe('scanGdscriptSandbox extra patterns (env-injected)', () => {
  afterEach(() => {
    delete process.env.GODOT_MCP_SANDBOX;
    delete process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS;
    _resetExtraDangerousPatternsCache();
  });

  it('blocks code matching a user-defined extra pattern', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\\.request', label: 'HTTP request (project policy)' },
    ]);
    const warnings = scanGdscriptSandbox('HTTPRequest.request("https://example.com")');
    expect(warnings.some(w => w.includes('HTTP request (project policy)'))).toBe(true);
  });

  it('does not block when extra pattern env is unset', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    const warnings = scanGdscriptSandbox('HTTPRequest.request("https://example.com")');
    expect(warnings.filter(w => w.includes('HTTP request'))).toEqual([]);
  });

  it('extra pattern runs on skeleton: string content does not trigger', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\\.request', label: 'HTTP policy' },
    ]);
    const warnings = scanGdscriptSandbox('var s = "HTTPRequest.request is blocked by policy"');
    expect(warnings.filter(w => w.includes('HTTP policy'))).toEqual([]);
  });

  it('extra pattern runs on skeleton: comment content does not trigger', () => {
    process.env.GODOT_MCP_SANDBOX = 'strict';
    process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS = JSON.stringify([
      { pattern: 'HTTPRequest\\.request', label: 'HTTP policy' },
    ]);
    const warnings = scanGdscriptSandbox('# HTTPRequest.request mentioned in comment');
    expect(warnings.filter(w => w.includes('HTTP policy'))).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行端到端测试验证通过**

Run: `npx vitest run test/gdscript-executor-core.test.js -t "extra patterns"`
Expected: PASS —— 4 条用例全绿

- [ ] **Step 3: 跑全量测试套件确认零回归**

Run: `npm test`
Expected: PASS —— 全仓库测试通过（含 `gdscript-executor.test.js`、`gdscript-executor-cache.test.js`）

- [ ] **Step 4: 跑 lint 确认零新增告警**

Run: `npm run lint`
Expected: 无新增 ESLint 告警

- [ ] **Step 5: 提交**

```bash
cd /d/GitHub/godot-mcp-enhanced
git add test/gdscript-executor-core.test.js
git commit -m "test(gdscript-executor): 补 extra patterns 端到端测试(生效/未设/字符串/注释)"
```

---

## Self-Review

**1. Spec 覆盖检查（逐条对照 spec）**

- spec §4 增量① `stripLiterals` 算法 → Task 1 Step 4（字符级状态机，charAt，三引号/转义/注释全覆盖）✅
- spec §4 增量① 接入点（Phase 1 + strict 用 skeleton）→ Task 3 Step 4 ✅
- spec §4 增量② `loadExtraDangerousPatterns`（memoized + 坏正则降级）→ Task 2 Step 4 ✅
- spec §4 增量② 接入点（Phase 1 骨架检测）→ Task 3 Step 4 的 extra 循环 ✅
- spec §5 契约 P2-RAW（Phase 2 接收原文）→ Task 3 Step 4 代码注释 + `detectStringConcatBypass(code)` ✅
- spec §7 测试翻转（行 300）→ Task 3 Step 1 ✅
- spec §7 新增 stripLiterals case → Task 1 Step 2 ✅
- spec §7 新增 extra patterns case（生效/坏正则/非JSON/memoize）→ Task 2 Step 2 ✅
- spec §7 回归（13 条 Phase 2）→ Task 3 Step 5 全文件运行 ✅
- spec §7 反射回归（`.call("execute")`）→ Task 1 Step 2（stripLiterals 保留 `.call("")`）+ Task 3 Step 5（现有反射测试零回归）✅
- spec §9 验收标准 1-6 → Task 3 Step 5（测试）、Task 4 Step 3-4（全量+lint）、Task 3 Step 4（契约注释）✅

**2. Placeholder 扫描**：无 TBD/TODO/"适当处理"；每个代码步骤含完整可运行代码；命令含确切路径与预期输出。✅

**3. 类型一致性**：
- `stripLiterals(code: string): string` —— Task 1 定义，Task 3 Step 4 消费，签名一致 ✅
- `loadExtraDangerousPatterns(): Array<{ pattern: RegExp; label: string }>` —— Task 2 定义，Task 3 Step 4 消费，签名一致 ✅
- `_resetExtraDangerousPatternsCache(): void` —— Task 2 定义，Task 2/Task 4 测试消费，名称一致 ✅
- 命名 `stripLiterals`（非 `stripStrings`）、`loadExtraDangerousPatterns`（非 `getExtraPatterns`）全计划一致 ✅

**4. 任务依赖**：Task 3 Step 4 同时接入 stripLiterals（依赖 Task 1）与 extra 循环（依赖 Task 2），故执行顺序须为 Task 1 → Task 2 → Task 3 → Task 4。已在各 Task 的 Interfaces 标注依赖。✅
