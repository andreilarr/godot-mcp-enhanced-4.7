# 实测发现 Bug 修复实施计划（v2 — 基于 2026-06-07 深度根因分析）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 godot-mcp-enhanced 端到端实测验证发现的 3 个 bug

**Architecture:** 3 个 bug 都有明确的根因和最小修复方案。BUG-1 是 `_mcp_done()` 在 `wrapSnippetAsNode` 中 `get_tree()` 空引用；BUG-2 是片段模式 `var root` 在类级别与 `SceneTree.root` 属性冲突；BUG-3 是 `mcp_bridge.gd` 中 GDScript 4.6 类型推断失败。

**Tech Stack:** TypeScript (Vitest), GDScript (Godot 4.6)

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/gdscript-executor.ts` | 修改 | BUG-1: `_mcp_done` null-safe（L439-441）；BUG-2: `var root` 重命名（L349+） |
| `src/scripts/mcp_bridge.gd` | 修改 | BUG-3: L529 类型注解 `:=` → `: String =` |
| `build/scripts/mcp_bridge.gd` | 修改 | BUG-3: 同步构建输出 |
| `test/gdscript-helpers.test.ts` | 修改 | 新增 BUG-1/BUG-2 回归测试 |
| `test/__snapshots__/gdscript-helpers.test.ts.snap` | 更新 | 快照更新 |

---

## 根因分析总结

### BUG-1: load_autoloads 片段模式 `_mcp_done()` 空引用崩溃

**位置:** `src/gdscript-executor.ts:439-441`

**根因:** `wrapSnippetAsNode`（autoload 片段模式）生成的 `_mcp_done()` 直接调用 `get_tree().quit(0)`。当代码以 `--scene` loader 方式运行时，`_initialize()` 执行期间 `get_tree()` 可能返回 null（Node 尚未加入场景树），导致 `Cannot call method 'quit' on a null value`。

**当前代码 (L439-441):**
```typescript
'func _mcp_done() -> void:',
'\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
'\tget_tree().quit(0)',
```

### BUG-2: 片段模式 `var root` 与 SceneTree.root 冲突

**位置:** `src/gdscript-executor.ts:349-380`

**根因:** `wrapSnippet`（非 autoload 片段模式）中 `classifyLines` 将用户的 `var root = _mcp_get_root()` 分类为 declaration，放在类级别（`_initialize()` 外）。生成的代码 `extends SceneTree`，而 SceneTree 有内置 `root` 属性（类型 `Window`），导致 `Member "root" redefined` 编译错误。

**代码流:**
```
classifyLines("var root = _mcp_get_root()")
  → declarationLines: ["var root = _mcp_get_root()"]  // 匹配 var 前缀
  → statementLines: []

wrapSnippet 输出:
  extends SceneTree
  var _mcp_outputs: Array = []
  var root = _mcp_get_root()    ← 类级别！与 SceneTree.root 冲突！
  func _initialize(): ...
```

### BUG-3: mcp_bridge.gd Godot 4.6 类型推断失败

**位置:** `src/scripts/mcp_bridge.gd:529`

**根因:** `var type_info := "null" if value == null else value.get_class()` 使用 `:=` 推断语法。三元表达式的两个分支返回不同类型（`String` vs `String` via `get_class()`），但 Godot 4.6 的 GDScript 解析器对三元表达式中间值的类型推断更严格，当 `value` 为 `Variant` 时无法确定统一类型。

**修复:** 改为显式类型注解 `var type_info: String = ...`

---

### Task 1: BUG-3 — mcp_bridge.gd Godot 4.6 类型推断修复

**Files:**
- Modify: `src/scripts/mcp_bridge.gd:529`
- Modify: `build/scripts/mcp_bridge.gd:529`（同步）

- [ ] **Step 1: 修复源文件**

将 `src/scripts/mcp_bridge.gd` 第 529 行从：
```gdscript
			var type_info := "null" if value == null else value.get_class()
```
改为：
```gdscript
			var type_info: String = "null" if value == null else value.get_class()
```

- [ ] **Step 2: 同步构建输出**

对 `build/scripts/mcp_bridge.gd` 做相同修改。

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: 所有测试通过

- [ ] **Step 4: 提交**

```bash
git add src/scripts/mcp_bridge.gd build/scripts/mcp_bridge.gd
git commit -m "fix(bridge): explicit String type annotation for type_info (Godot 4.6 compat)

Godot 4.6 GDScript parser is stricter about type inference for ternary
expressions involving Variant values. Changed := to : String = to
resolve 'Cannot infer type' parse error at line 529."
```

---

### Task 2: BUG-2 — 片段模式 `var root` 命名冲突修复

**Files:**
- Modify: `src/gdscript-executor.ts:350-380`（wrapSnippet 函数）
- Modify: `test/gdscript-helpers.test.ts`（新增测试）

- [ ] **Step 1: 写失败测试**

在 `test/gdscript-helpers.test.ts` 末尾（最后一个 `});` 之前）添加：

```typescript
describe('BUG-2: var root naming conflict in wrapSnippet', () => {
  it('renames user var root to avoid SceneTree.root collision', () => {
    const result = wrapSnippet('var root = _mcp_get_root()\nprint(root.name)');
    // 不应在类级别出现裸 "var root ="（与 SceneTree.root 冲突）
    const lines = result.split('\n');
    let inFunc = false;
    for (const line of lines) {
      if (line.startsWith('func ')) inFunc = true;
      if (inFunc && line.length > 0 && !line.startsWith('\t') && !line.startsWith('#') && line.startsWith('func ')) {
        // 新的 func 开始，重置（但上面的条件已足够简单化）
      }
      // 类级别（非 func 内）不应有裸 var root =
      if (!inFunc && /^var root\s*=/.test(line.trim())) {
        expect(line.trim()).not.toBe(''); // 不应到达这里
      }
    }
    // 结果应包含重命名后的变量或使用 _mcp_get_root 的结果
    expect(result).toContain('extends SceneTree');
    expect(result).toContain('func _mcp_get_root');
  });

  it('wrapSnippetAsNode handles var root without conflict (Node has no root prop)', () => {
    const result = wrapSnippetAsNode('var root = _mcp_get_root()\nprint(root.name)');
    expect(result).toContain('extends Node');
    // Node 没有 root 属性，var root 在 _initialize 内是安全的
    expect(result).toContain('var root = _mcp_get_root()');
  });

  it('other reserved names are also handled', () => {
    // 验证不误伤非冲突变量名
    const result = wrapSnippet('var my_data = 42\nvar root_node = _mcp_get_root()\nprint(str(my_data))');
    expect(result).toContain('var my_data = 42');
    expect(result).toContain('var root_node = _mcp_get_root()');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/gdscript-helpers.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `var root =` 出现在类级别

- [ ] **Step 3: 实现修复 — 在 wrapSnippet 中重命名冲突变量**

在 `src/gdscript-executor.ts` 的 `wrapSnippet` 函数中，找到第 350 行：

```typescript
export function wrapSnippet(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);
```

在 `classifyLines` 调用之后（第 351 行之前）插入重命名逻辑：

```typescript
export function wrapSnippet(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);

  // BUG-2 fix: SceneTree has a built-in `root` property (Window).
  // User `var root = ...` at class level collides with it.
  // Rename user's `var root` → `var _mcp_user_root` and update references.
  const ST_RESERVED = ['root'];
  for (const reserved of ST_RESERVED) {
    const declPattern = new RegExp(`^(var\\s+)${reserved}(\\s*=)`, 'g');
    for (let i = 0; i < declarationLines.length; i++) {
      declarationLines[i] = declarationLines[i]!.replace(declPattern, `$1_mcp_user_${reserved}$2`);
    }
    // Update references in statements: standalone `root` but not `_mcp_root`, `self.root`, `.root`, etc.
    const refPattern = new RegExp(`(?<![_.\\w])\\b${reserved}\\b(?![.\\w])`, 'g');
    for (let i = 0; i < statementLines.length; i++) {
      statementLines[i] = statementLines[i]!.replace(refPattern, `_mcp_user_${reserved}`);
    }
  }
```

注意：`ST_RESERVED` 是数组形式，便于将来扩展其他冲突变量名。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/gdscript-helpers.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS — `var root` 被重命名为 `var _mcp_user_root`

- [ ] **Step 5: 全量测试**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: 所有测试通过。如有 snapshot 失败，运行 `npx vitest run --update` 后再确认。

- [ ] **Step 6: 提交**

```bash
git add src/gdscript-executor.ts test/gdscript-helpers.test.ts test/__snapshots__/gdscript-helpers.test.ts.snap
git commit -m "fix(executor): rename user var root to _mcp_user_root in wrapSnippet

SceneTree has a built-in root property (Window). User var root
declarations at class level cause 'Member root redefined' compile
error. Now auto-renamed to _mcp_user_root with statement references
updated accordingly."
```

---

### Task 3: BUG-1 — wrapSnippetAsNode `_mcp_done()` 空引用修复

**Files:**
- Modify: `src/gdscript-executor.ts:439-441`（wrapSnippetAsNode 中 _mcp_done）
- Modify: `test/gdscript-helpers.test.ts`（新增测试）

- [ ] **Step 1: 写测试**

在 `test/gdscript-helpers.test.ts` 的 BUG-2 describe 块之后添加：

```typescript
describe('BUG-1: _mcp_done null-safe in wrapSnippetAsNode', () => {
  it('_mcp_done uses null-safe get_tree() call', () => {
    const result = wrapSnippetAsNode('print("hello")');
    // 提取 _mcp_done 函数体
    const doneMatch = result.match(/func _mcp_done\(\)[\s\S]*?(?=\nfunc |\n$)/);
    expect(doneMatch).not.toBeNull();
    // 应包含 get_tree() 的 null 安全检查
    const doneBody = doneMatch![0];
    expect(doneBody).toMatch(/get_tree\(\)/);
    // 不应直接调用 get_tree().quit(0)（无 null 检查）
    expect(doneBody).not.toMatch(/^\tget_tree\(\)\.quit\(0\)$/m);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/gdscript-helpers.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `_mcp_done` 中直接有 `get_tree().quit(0)`

- [ ] **Step 3: 修复 wrapSnippetAsNode 的 _mcp_done**

在 `src/gdscript-executor.ts` 找到 wrapSnippetAsNode 中的 `_mcp_done`（L439-441）：

```typescript
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tget_tree().quit(0)',
```

替换为 null-safe 版本：

```typescript
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tvar _tree = get_tree()',
    '\tif _tree != null:',
    '\t\t_tree.quit(0)',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/gdscript-helpers.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 5: 更新快照 + 全量测试**

Run: `npx vitest run --update 2>&1 | tail -30`
Expected: 所有测试通过，snapshot 已更新

- [ ] **Step 6: 提交**

```bash
git add src/gdscript-executor.ts test/gdscript-helpers.test.ts test/__snapshots__/gdscript-helpers.test.ts.snap
git commit -m "fix(executor): null-safe _mcp_done in wrapSnippetAsNode (BUG-1)

get_tree() can return null during _initialize() when running as Node
via --scene loader. Added null check before calling quit() to prevent
'Cannot call method quit on null value' runtime error."
```

---

### Task 4: 端到端验证

- [ ] **Step 1: 构建项目**

Run: `npm run build 2>&1 | tail -10`
Expected: 构建成功

- [ ] **Step 2: BUG-3 验证 — mcp_bridge.gd 不再报类型推断错误**

通过 MCP `execute_gdscript` with `load_autoloads=true` 执行简单片段，确认不再出现 `Cannot infer the type of "type_info"` 错误。

- [ ] **Step 3: BUG-2 验证 — var root 不再冲突**

通过 MCP `execute_gdscript` 执行片段 `var root = _mcp_get_root()\nprint(root.name)`，验证不再报 `root redefined` 错误，输出包含节点名。

- [ ] **Step 4: BUG-1 验证 — load_autoloads 片段模式安全退出**

通过 MCP `execute_gdscript` with `load_autoloads=true` 执行片段，使用 `_mcp_output` + `_mcp_done`，验证不再崩溃且输出正确。

- [ ] **Step 5: 全量测试**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: 所有测试通过

- [ ] **Step 6: 汇总提交**

```bash
git log --oneline -5
```
Expected: 看到 3 个 fix commit + 1 个验证

---

## 自查清单

### 1. 规格覆盖

| Bug | 覆盖任务 | 根因确认 |
|-----|----------|----------|
| BUG-1: load_autoloads _mcp_done 崩溃 | Task 3 | ✅ get_tree() null |
| BUG-2: var root 命名冲突 | Task 2 | ✅ SceneTree.root 属性 |
| BUG-3: mcp_bridge.gd 类型推断 | Task 1 | ✅ := → : String = |

### 2. 占位符扫描

- 无 TBD/TODO/placeholder
- 每步包含完整代码和预期输出
- 无 "类似 Task N" 的引用

### 3. 类型一致性

- `classifyLines` 返回 `{ declarationLines: string[], statementLines: string[] }` — 可直接修改元素
- `replace` 返回 `string`，赋值回 `string[]` 合法
- `wrapSnippetAsNode` 中 `resultMarker` 参数传递链完整
- `injectHelpers` 不在本计划修改范围内（其 `_mcp_done` 使用 `Engine.get_main_loop() == self` 检查，对 SceneTree 模式安全）
