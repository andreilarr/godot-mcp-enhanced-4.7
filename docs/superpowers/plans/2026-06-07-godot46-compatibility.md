# Godot 4.6+ 片段模式兼容性修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 MCP 片段模式在 Godot 4.6+ 中的 `get_tree()` / `root` 冲突问题

**Architecture:** 修改 `GD_MCP_GET_ROOT` 模板用 `self.root` 替代裸 `root` 和 `Engine.get_main_loop()` 中间层；在错误分析器中增加关键词组合匹配自动附带兼容性提示

**Tech Stack:** TypeScript, GDScript templates, Vitest

---

### Task 1: 修改 GD_MCP_GET_ROOT 模板

**Files:**
- Modify: `src/tools/shared/gdscript-templates.ts:15-27`

- [ ] **Step 1: 替换 GD_MCP_GET_ROOT 常量**

将 `src/tools/shared/gdscript-templates.ts` 中的 `GD_MCP_GET_ROOT` 从：

```typescript
export const GD_MCP_GET_ROOT: readonly string[] = [
  'func _mcp_get_root() -> Node:',
  '\tif _mcp_root != null:',
  '\t\treturn _mcp_root',
  '\tif root != null:',
  '\t\t_mcp_root = root',
  '\t\treturn _mcp_root',
  '\tvar ml: Variant = Engine.get_main_loop()',
  '\tif ml != null and ml is SceneTree and ml.root != null:',
  '\t\t_mcp_root = ml.root',
  '\t\treturn _mcp_root',
  '\treturn null',
];
```

替换为：

```typescript
export const GD_MCP_GET_ROOT: readonly string[] = [
  'func _mcp_get_root() -> Node:',
  '\tif _mcp_root != null:',
  '\t\treturn _mcp_root',
  '\t# Godot 4.6+: self.root is required (extends SceneTree — root is native property)',
  '\tif self.root != null:',
  '\t\t_mcp_root = self.root',
  '\t\treturn _mcp_root',
  '\treturn null',
];
```

- [ ] **Step 2: 更新 SCENE_TREE_HEADER 变量注释**

在 `SCENE_TREE_HEADER` 常量中，将：

```typescript
'var _mcp_root: Node = null',
```

替换为：

```typescript
'# Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)',
'var _mcp_root: Node = null',
```

- [ ] **Step 3: 更新 wrapSnippet 变量注释**

在 `src/gdscript-executor.ts` 的 `wrapSnippet()` 函数中，将：

```typescript
'var _mcp_root: Node = null',
```

替换为：

```typescript
'# Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)',
'var _mcp_root: Node = null',
```

- [ ] **Step 4: 运行测试确认改动正确**

Run: `npx vitest run test/gdscript-helpers.test.ts test/gdscript-executor.test.js`
Expected: 快照测试失败（快照中仍包含旧的 `_mcp_get_root`），其余测试通过

- [ ] **Step 5: 更新快照**

Run: `npx vitest run test/gdscript-helpers.test.ts --update`
Expected: 快照更新成功，所有测试通过

- [ ] **Step 6: 修复受影响的断言**

`test/gdscript-helpers.test.ts` 第 44 行当前断言：
```typescript
expect(GD_MCP_GET_ROOT.join('\n')).toContain('_mcp_root = ml.root');
```

`ml.root` 已不存在，替换为验证新行为：
```typescript
expect(GD_MCP_GET_ROOT.join('\n')).toContain('self.root');
expect(GD_MCP_GET_ROOT.join('\n')).not.toContain('Engine.get_main_loop');
```

- [ ] **Step 7: 全量运行确认**

Run: `npx vitest run`
Expected: 全部测试通过

- [ ] **Step 8: Commit**

```bash
git add src/tools/shared/gdscript-templates.ts src/gdscript-executor.ts test/gdscript-helpers.test.ts test/__snapshots__/gdscript-helpers.test.ts.snap
git commit -m "fix: GD_MCP_GET_ROOT uses self.root for Godot 4.6+ compatibility

- Replace bare 'root' with 'self.root' in _mcp_get_root()
- Remove Engine.get_main_loop() fallback (unnecessary in extends SceneTree)
- Add naming constraint comments for _mcp_root variable
- Update snapshot and assertion to match new template"
```

---

### Task 2: 添加运行时兼容性提示

**Files:**
- Modify: `src/error-analyzer.ts:36-135` (ERROR_PATTERNS 数组)
- Create tests in: `test/error-analyzer.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/error-analyzer.test.js`：

```javascript
import { describe, it, expect } from 'vitest';
import { analyzeOutput } from '../src/error-analyzer.js';

describe('Godot 4.6+ compatibility hints', () => {
  it('detects get_tree() not found and adds compatibility hint', () => {
    const output = [
      'SCRIPT ERROR: Function \'get_tree()\' not found in base self.',
      '  at: res://mcp_script.gd:5',
    ];
    const result = analyzeOutput(output);
    expect(result.hasErrors).toBe(true);
    const hint = result.suggestions.find(s => s.includes('self.root') && s.includes('get_tree'));
    expect(hint).toBeDefined();
  });

  it('detects root redefined and adds compatibility hint', () => {
    const output = [
      'SCRIPT ERROR: Member \'root\' redefined in parent class.',
      '  at: res://mcp_script.gd:3',
    ];
    const result = analyzeOutput(output);
    expect(result.hasErrors).toBe(true);
    const hint = result.suggestions.find(s => s.includes('root') && s.includes('SceneTree') && s.includes('redefined'));
    expect(hint).toBeDefined();
  });

  it('does not add compatibility hint for unrelated errors', () => {
    const output = [
      'SCRIPT ERROR: Identifier "foo" not found in base self.',
      '  at: res://mcp_script.gd:10',
    ];
    const result = analyzeOutput(output);
    const hint = result.suggestions.find(s => s.includes('self.root') || s.includes('SceneTree.root'));
    expect(hint).toBeUndefined();
  });

  it('matches get_tree with varied error wording', () => {
    // 模拟不同小版本可能的不同措辞
    const output = [
      'SCRIPT ERROR: The function get_tree() could not be found.',
      '  at: res://mcp_script.gd:8',
    ];
    const result = analyzeOutput(output);
    const hint = result.suggestions.find(s => s.includes('self.root'));
    expect(hint).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/error-analyzer.test.js`
Expected: FAIL — 新测试中的 `expect(hint).toBeDefined()` 失败，因为还没有添加兼容性提示模式

- [ ] **Step 3: 添加兼容性提示模式**

在 `src/error-analyzer.ts` 的 `ERROR_PATTERNS` 数组中，在 `headless_limitation` 模式之前（约第 107 行），添加两条新模式：

```typescript
{
  test: (msg) => /get_tree/.test(msg) && /not found/.test(msg),
  type: 'script_error',
  suggestion: () => 'Godot 4.6+ 兼容性提示: 在 extends SceneTree 脚本中，请使用 self.root 代替 get_tree().root，使用 quit() 代替 get_tree().quit()',
},
{
  test: (msg) => /\broot\b/.test(msg) && /redefined/.test(msg),
  type: 'script_error',
  suggestion: () => "Godot 4.6+ 兼容性提示: 变量名 'root' 与 SceneTree.root 冲突，请改用其他名称如 scene_root 或 _root",
},
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/error-analyzer.test.js`
Expected: PASS — 4 个测试全部通过

- [ ] **Step 5: 全量运行确认无回归**

Run: `npx vitest run`
Expected: 全部测试通过

- [ ] **Step 6: Commit**

```bash
git add src/error-analyzer.ts test/error-analyzer.test.js
git commit -m "feat: add Godot 4.6+ compatibility hints in error analyzer

- Detect get_tree() + not found → suggest self.root / quit()
- Detect root + redefined → suggest renaming variable
- Keyword combination matching (not exact string) for robustness"
```

---

### Task 3: 添加模板正确性验证测试

**Files:**
- Modify: `test/gdscript-helpers.test.ts`

- [ ] **Step 1: 添加验证测试**

在 `test/gdscript-helpers.test.ts` 的 `GD_MCP shared constants` describe 块中，在现有测试之后添加：

```typescript
it('GD_MCP_GET_ROOT uses self.root (Godot 4.6+ compatible)', () => {
  const joined = GD_MCP_GET_ROOT.join('\n');
  expect(joined).toContain('self.root');
  expect(joined).not.toContain('Engine.get_main_loop');
});

it('SCENE_TREE_HEADER uses self.root via _mcp_get_root', () => {
  expect(SCENE_TREE_HEADER).toContain('self.root');
  expect(SCENE_TREE_HEADER).not.toMatch(/\bif root != null:/);
});
```

在 `GDScript helpers - baseline snapshots` describe 块中添加：

```typescript
it('wrapSnippet does not contain bare root access', () => {
  const result = wrapSnippet('var x = 1');
  expect(result).toContain('self.root');
  expect(result).not.toContain('Engine.get_main_loop');
});

it('wrapSnippetAsNode still uses get_tree().quit() (Node context)', () => {
  const result = wrapSnippetAsNode('var x = 1');
  expect(result).toContain('get_tree().quit(0)');
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run test/gdscript-helpers.test.ts`
Expected: PASS — 所有测试通过（快照已在 Task 1 中更新）

- [ ] **Step 3: 全量运行确认**

Run: `npx vitest run`
Expected: 全部测试通过

- [ ] **Step 4: Commit**

```bash
git add test/gdscript-helpers.test.ts
git commit -m "test: add Godot 4.6+ template compatibility assertions

- Verify GD_MCP_GET_ROOT uses self.root
- Verify SCENE_TREE_HEADER uses self.root
- Verify wrapSnippet does not contain bare root or Engine.get_main_loop
- Verify wrapSnippetAsNode still uses get_tree().quit() (correct for Node)"
```

---

### Task 4: 全量验证 + 最终提交

**Files:**
- None (verification only)

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
Expected: 全部测试通过，0 失败

- [ ] **Step 2: 检查 git 状态**

Run: `git diff --stat`
Expected: 仅包含已提交的文件变更，无遗漏

- [ ] **Step 3: 检查快照正确性**

Run: `git diff HEAD~3 -- test/__snapshots__/gdscript-helpers.test.ts.snap`
Expected: 快照中 `_mcp_get_root` 部分已更新为 `self.root`，无 `Engine.get_main_loop`
