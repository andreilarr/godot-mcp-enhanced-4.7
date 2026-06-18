# execute_gdscript 危险检测增量设计文档

> 日期：2026-06-17
> 来源：brainstorming（GateGuard 能力对照 → 真实增量收敛）
> 目标文件：`src/gdscript-executor.ts`、`test/gdscript-executor-core.test.js`
> 策略：补两个**真实增量缺口**，不重造沙箱
> 核心约束：**Phase 2（`detectStringConcatBypass`）永远接收原文，绝不接收骨架**——不可违反契约

---

## 1. 背景与现状（真实代码事实）

`execute_gdscript` 的沙箱扫描器 `scanGdscriptSandbox`（`src/gdscript-executor.ts:244`，C-SEC-02）已具备相当强的能力，**甚至超过 funplay**：

| 能力 | 现状 |
|------|------|
| 危险 API 正则黑名单 | ✅ `DANGEROUS_PATTERNS`（行 46-83）21 条 |
| 字符串拼接绕过检测 | ✅ `detectStringConcatBypass`（行 170-223）滑窗重构 |
| 反射绕过检测 | ✅ `.call("str")`/`.callv`/`ClassDB`/`Expression.execute`/`get_script` |
| `%` 格式化构造 API 检测 | ✅（行 206-220） |
| BLOCK 执行（非仅警告） | ✅ 默认 BLOCK + 审计日志（行 785-806） |
| strict 模式 / 逃生舱 | ✅ `GODOT_MCP_SANDBOX=strict/disabled`、`GODOT_MCP_DISABLE_SAFETY` |

**结论**：不应"再加一套 GateGuard 检测"。对照 GateGuard 后，真实增量收敛为两个缺口。

## 2. 问题陈述（两个增量缺口）

### 缺口①：Phase 1 直接对原文跑正则，未剥字符串/注释 → 误报

`scanGdscriptSandbox` Phase 1（行 252-256）：

```js
for (const { pattern, label } of DANGEROUS_PATTERNS) {
  if (pattern.test(code)) { ... }   // ← code 是原文，含注释和字符串内容
}
```

**铁证——行 300 的"自相矛盾"测试**（`test/gdscript-executor-core.test.js:300`）：

```js
it('does not flag OS.execute inside a string literal context', () => {
  const code = 'var s = "OS.execute is dangerous"';
  const warnings = scanGdscriptSandbox(code);
  // 名字说"不误报"，断言却写:
  expect(warnings.length).toBeGreaterThan(0);  // ← 实际:会误报
});
```

测试名字叫 `does not flag`（不误报），断言却是 `toBeGreaterThan(0)`（被标记 = 误报）。注释明说 *“regex-based scanner will still flag this — documented behavior”*。这是把已知缺陷**锁定成测试**的妥协。

**影响**：注释或字符串里出现 `OS.execute` / `DirAccess.remove` 等字样会被误 BLOCK，阻断合法执行。项目的 core rule 也记录了这个痛点。

### 缺口②：`DANGEROUS_PATTERNS` 是硬编码数组，无法运行时扩展

行 46-83 是模块级 `const`，21 条写死。部署场景若需追加自定义危险模式（如特定游戏项目禁用 `HTTPRequest`、自定义反射入口），必须改源码重新发布。

## 3. 设计目标与非目标

### 目标

1. **缺口①**：新增 `stripLiterals()`，Phase 1（及 strict FileAccess 检查）在剥去字符串/注释的骨架上跑正则，消除误报
2. **缺口②**：新增 `loadExtraDangerousPatterns()`，通过环境变量运行时注入自定义危险正则
3. **安全不降级**：误报下降，漏报不增

### 非目标（明确不做）

- ❌ 不重写沙箱、不引入 GDScript 语法解析器（过度工程）
- ❌ 不改 Phase 2 `detectStringConcatBypass` 的输入（原文）——见 §5 硬约束
- ❌ 不把 extra patterns 做成工具调用级参数（dangerous 模式应为部署级，非调用级）
- ❌ 不改逃生舱语义（`GODOT_MCP_SANDBOX=disabled` / `DISABLE_SAFETY` 不动）

## 4. 详细设计

### 增量①：`stripLiterals(code)`

**职责**：返回剥去字符串字面量内容和注释后的"骨架"，保留引号和换行结构，供 Phase 1 正则匹配。

**算法（字符级状态机，最稳健）**：

```
状态: NORMAL | IN_STRING(single/double/triple) | IN_COMMENT
扫描每个字符:
  - NORMAL:
      遇 "'''" 或 '"""' → 进入三引号字符串态（记录引号类型）
      遇 " 或 '         → 进入单行字符串态
      遇 #              → 进入注释态（直到行尾）
      否则              → 保留字符
  - IN_STRING:
      遇转义 (\")       → 跳过下一字符（保留引号对结构）
      遇 匹配的闭合引号 → 回到 NORMAL（保留闭合引号）
      否则（字符串内容）→ 替换为占位（删除内容，不破坏行列）
  - IN_COMMENT:
      遇 \n             → 回到 NORMAL（保留 \n）
      否则              → 删除（注释内容）
```

**关键正确性要求**：

| 场景 | 输入 | 骨架输出（示意） |
|------|------|------------------|
| 字符串内含危险 API | `var s = "OS.execute is bad"` | `var s = ""` |
| 注释内含危险 API | `# OS.execute("ls")` | `` (空) |
| 字符串内含 `#` | `var s = "a#b"` | `var s = ""`（`#` 不当注释） |
| 三引号字符串 | `var s = """OS.execute"""` | `var s = """"""` 或规整为 `""` |
| 转义引号 | `var s = "a\"b"` | `var s = ""`（转义正确处理，不提前闭合） |
| 真实危险调用 | `OS.execute("ls")` | `OS.execute("")`（**调用本身保留 → 仍被检测**） |

**顺序契约**：先剥字符串，再剥注释。理由：字符串内可能含 `#`，若先剥注释会把字符串内的 `#` 误当注释起点，破坏字符串边界识别。

**为什么用状态机而非纯正则**：`detectStringConcatBypass` 行 174 的正则 `/([^"\\]*(?:\\.[^"\\]*)*)/` 不处理三引号，且正则做"替换并保留结构"易错。状态机一次性正确处理转义、三引号、注释嵌套边界。

**接入点**：`scanGdscriptSandbox`（行 244-270）改造：

```js
export function scanGdscriptSandbox(code: string): string[] {
  if (process.env.GODOT_MCP_SANDBOX === 'disabled') { ... return []; }
  const warnings: string[] = [];

  // 新增:剥字符串/注释后的骨架,仅用于 Phase 1 + strict 文件检测
  const skeleton = stripLiterals(code);

  // Phase 1: 直接模式匹配(改用骨架)
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(skeleton)) { ... }
  }
  // 增量②:extra patterns 同样在骨架上检测
  for (const { pattern, label } of loadExtraDangerousPatterns()) {
    if (pattern.test(skeleton)) { ... }
  }

  // C-03: strict 模式 FileAccess 检测(改用骨架,保持一致)
  if (process.env.GODOT_MCP_SANDBOX === 'strict') {
    if (/FileAccess\.open\b/.test(skeleton)) { ... }
  }

  // Phase 2: 拼接绕过检测 —— 保持原文!!(见 §5 硬约束)
  const concatWarnings = detectStringConcatBypass(code);   // ← code, 非 skeleton
  warnings.push(...concatWarnings);

  return warnings;
}
```

**测试翻转**：行 300 断言从 `toBeGreaterThan(0)` → `toEqual([])`，名字 `does not flag` 终于名副其实。

### 增量②：`loadExtraDangerousPatterns()`

**职责**：从环境变量加载用户自定义危险正则，memoized，坏正则降级不崩。

**环境变量**：

| 变量 | 格式 | 示例 |
|------|------|------|
| `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS` | JSON 数组 `[{"pattern": string, "label": string}]` | `[{"pattern":"HTTPRequest\\.request","label":"HTTP request (project policy)"}]` |

命名风格对齐现有 `GODOT_MCP_SANDBOX` / `GODOT_MCP_DISABLE_SAFETY` / `GODOT_MCP_ALLOW_UNSAFE`。

**实现**：

```js
let _extraPatternsCache: { raw: string; patterns: Array<{pattern: RegExp; label: string}> } | null = null;

/** @internal 测试用:重置缓存 */
export function _resetExtraDangerousPatternsCache(): void {
  _extraPatternsCache = null;
}

export function loadExtraDangerousPatterns(): Array<{ pattern: RegExp; label: string }> {
  const raw = process.env.GODOT_MCP_EXTRA_DANGEROUS_PATTERNS;
  if (!raw) return [];
  if (_extraPatternsCache && _extraPatternsCache.raw === raw) {
    return _extraPatternsCache.patterns;
  }
  const patterns: Array<{ pattern: RegExp; label: string }> = [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      getLogger().warn('security', 'GODOT_MCP_EXTRA_DANGEROUS_PATTERNS is not a JSON array, ignoring');
      _extraPatternsCache = { raw, patterns };
      return patterns;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry.pattern !== 'string' || typeof entry.label !== 'string') continue;
      try {
        patterns.push({ pattern: new RegExp(entry.pattern), label: entry.label });
      } catch (regexErr) {
        // 坏正则降级:跳过该条,不崩溃,记录审计
        getLogger().warn('security',
          `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS: invalid regex skipped: "${entry.pattern}" (${regexErr instanceof Error ? regexErr.message : regexErr})`);
      }
    }
  } catch (jsonErr) {
    getLogger().warn('security',
      `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS: invalid JSON, ignoring (${jsonErr instanceof Error ? jsonErr.message : jsonErr})`);
  }
  _extraPatternsCache = { raw, patterns };
  return patterns;
}
```

memoize 模式抄 `_autoloadCache`（行 110-116）：以 `raw` 字符串为缓存键，相同 env 不重复解析。

**接入点**：见增量①代码块的 Phase 1 段——extra patterns 与 `DANGEROUS_PATTERNS` 同循环结构，在骨架上检测。

## 5. 安全不降级契约（不可违反）

> **这是本设计的最高约束，写进代码注释，防止未来维护者"顺手统一"打穿检测。**

### 契约 P2-RAW：`detectStringConcatBypass` 必须接收原文

`detectStringConcatBypass`（行 174-179）**自己提取字符串字面量内容**做滑窗拼接重构：

```js
const stringLiteralRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
// 提取所有字符串内容 → stringContents[]
// 滑窗组合 ≤4 个相邻字符串,检查是否拼成危险 token
```

若喂入骨架（字符串内容已被剥空），`stringContents` 全为空 → **13 条 Phase 2 拼接绕过测试（行 338-457）全部失效**，攻击者可用 `"OS" + ".execute"` 绕过。这是灾难性回归。

**因此 Phase 2 永远接收 `code`（原文），不接收 `skeleton`。**

### 为什么剥字符串不会引入漏报

| 攻击向量 | 是否受 stripLiterals 影响 | 理由 |
|----------|--------------------------|------|
| 真实 API 调用 `OS.execute(...)` | ❌ 不受影响 | 调用本身不在字符串内，骨架保留 `OS.execute` |
| 字符串拼接绕过 `"OS"+".execute"` | ❌ 不受影响 | 由 Phase 2 `detectStringConcatBypass` 在**原文**上独立覆盖 |
| 反射 `.call("execute")` | ❌ 不受影响 | `.call(` 和字符串 `"execute"` 在骨架里 `.call(` 保留，Phase 1 正则 `\.call\s*\(\s*["']/` 仍命中（因为该正则只看 `(` 后是否紧跟引号，骨架里引号还在） |
| `Expression.execute` | ❌ 不受影响 | 真实调用不在字符串内 |
| 注释里的 API 名 | ✅ 不再误报（正是目标） | 注释非代码，剥除正确 |

**唯一需在测试中验证的边界**：`.call("execute")` 这类反射——骨架里字符串内容被剥（`"execute"` → `""`），但 Phase 1 正则 `\.call\s*\(\s*["']/` 匹配的是 `.call(` 后紧跟引号字符，骨架里引号仍在，故仍命中。**必须在测试中显式验证此场景不回归**（行 427-431 已有 `.call("execute")` 测试，作回归护栏）。

## 6. 落点清单

| 文件 | 改动 |
|------|------|
| `src/gdscript-executor.ts` | 新增 `stripLiterals()`、`loadExtraDangerousPatterns()` + `_resetExtraDangerousPatternsCache()`；`scanGdscriptSandbox` Phase 1 + strict FileAccess 改用骨架；Phase 2 保持原文（加契约注释） |
| `test/gdscript-executor-core.test.js` | 翻转行 300 断言；新增 stripLiterals case（注释/字符串/三引号/转义不误报）；新增 extra patterns case（生效/坏正则降级/memoize）；现有 13 条 Phase 2 测试作回归护栏 |

## 7. 测试策略

### 新增（增量① stripLiterals）

- `# OS.execute("ls")` 注释 → 不误报（`toEqual([])`）
- `var s = "DirAccess.remove"` 字符串 → 不误报
- `var s = """OS.kill"""` 三引号 → 不误报
- `var s = "a#b"` 字符串内 `#` → 不破坏（不误报、不漏报）
- `var s = "a\"b"` 转义引号 → 正确处理
- **回归护栏**：真实 `OS.execute("ls")` → 仍被检测（`toBeGreaterThan(0)`）
- **反射回归**：`.call("execute")` → 仍被检测（验证 §5 边界）

### 翻转

- 行 300：`toBeGreaterThan(0)` → `toEqual([])`

### 新增（增量② extra patterns）

- 设置 `GODOT_MCP_EXTRA_DANGEROUS_PATTERNS=[{"pattern":"HTTPRequest\\.request","label":"HTTP policy"}]` → 代码含 `HTTPRequest.request` 被 BLOCK
- 坏正则 `[{"pattern":"(","label":"bad"}]` → 降级跳过、不崩、warn 日志、其他正则仍生效
- 非 JSON / 非数组 → 降级、不崩
- memoize：相同 env 两次调用返回同一引用（性能）
- `afterEach` 清理 env + `_resetExtraDangerousPatternsCache()`

### 回归（不可破坏）

- 现有 `gdscript-executor-core.test.js` 全部通过（尤其 13 条 Phase 2 拼接绕过 + 反射检测）
- 现有 `gdscript-executor.test.js` 全部通过

## 8. 风险与替代方案

| 风险 | 缓解 |
|------|------|
| `stripLiterals` 状态机有边界 bug（罕见字符串语法） | 字符级状态机 + 充分单测（三引号/转义/嵌套）；状态机比正则更可控 |
| extra patterns 用户写了过宽正则导致误杀 | 用户自担（部署级配置）；逃生舱 `DISABLE_SAFETY` 兜底；warn 日志可见 |
| Phase 2 误用骨架（未来回归） | §5 契约写进代码注释；13 条 Phase 2 测试作回归护栏 |

**替代方案（均不选）**：

- ① 只剥注释不剥字符串 → 误报减少有限（字符串内危险 API 名仍误报），收益不足
- ① 用 GDScript 语法解析器 → 最准但引入依赖、过度工程，与"正则黑名单是安全网非边界"的项目定位冲突
- ② 配置文件（非 env）→ 增加 IO + 路径安全考量，与现有 env 风格不一致
- ② 工具参数级 → dangerous 模式应是部署级（运维决定），非每次调用级

## 9. 验收标准

1. 行 300 测试断言翻转为 `toEqual([])`，且测试名与行为一致
2. 新增 stripLiterals case 全绿（注释/字符串/三引号/转义不误报 + 真实调用仍检测）
3. 新增 extra patterns case 全绿（生效 + 坏正则降级 + memoize）
4. `npm test`（vitest run）全绿，尤其 13 条 Phase 2 + 反射检测零回归
5. Phase 2 仍接收原文（代码审查确认 `detectStringConcatBypass(code)` 未改成 skeleton）
6. `npm run lint`（eslint src/）零新增告警
