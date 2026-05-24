# CSS Flex Layout 翻译层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `ui_build_layout` 工具中增加 CSS Flexbox 语义层，AI 用 `layout`/`flex` 描述布局，MCP 侧翻译成原生 Godot Container 嵌套。

**Architecture:** 在 `ui-tools.ts` 的 `uiNodeToGd` 函数中检测 `layout` 字段，将 direction/justify/align/wrap/gap/padding 翻译成对应的 Godot Container 类型 + size_flags + theme override。`layout` 存在时覆盖 `type`，无 `layout` 时行为不变。

**Tech Stack:** TypeScript, GDScript 代码生成, Node.js test runner

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/tools/ui-tools.ts` | 新增 `FlexLayout`/`FlexChild` 类型，扩展 `UiNodeSpec`，修改 `uiNodeToGd`，新增 `resolveFlexContainer`/`applyFlexChild` helper |
| `test/ui-tools.test.js` | 新增 ~19 个 layout 翻译测试用例 |
| `docs/superpowers/specs/2026-05-19-css-flex-layout-design.md` | 设计文档（已完成，不修改） |

---

### Task 1: 新增类型定义和导出

**Files:**
- Modify: `src/tools/ui-tools.ts:494-500`（UiNodeSpec 定义区域）

- [ ] **Step 1: 在 UiNodeSpec 上方添加 FlexLayout 和 FlexChild 接口，扩展 UiNodeSpec**

在 `export type UiNodeSpec` 之前插入两个新接口，然后在 UiNodeSpec 中添加 `layout` 和 `flex` 可选字段：

```typescript
export interface FlexLayout {
  direction: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  justify?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  align?: 'stretch' | 'flex-start' | 'center' | 'flex-end';
  wrap?: 'nowrap' | 'wrap';
  gap?: number;
  row_gap?: number;
  padding?: number | [number, number, number, number];
}

export interface FlexChild {
  grow?: number;
  shrink?: number;
  align_self?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch';
  min_width?: number;
  min_height?: number;
  max_width?: number;
  max_height?: number;
}
```

然后修改 UiNodeSpec 添加两个字段：

```typescript
export type UiNodeSpec = {
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  anchor_preset?: string;
  layout?: FlexLayout;
  flex?: FlexChild;
  children?: UiNodeSpec[];
};
```

- [ ] **Step 2: 构建验证**

Run: `npx tsc --noEmit`
Expected: 无错误（只是添加类型，不改逻辑）

- [ ] **Step 3: Commit**

```bash
git add src/tools/ui-tools.ts
git commit -m "feat(ui): add FlexLayout and FlexChild type definitions"
```

---

### Task 2: layout 验证函数

**Files:**
- Modify: `src/tools/ui-tools.ts`（在 `validateUiNodeSpec` 附近）

- [ ] **Step 1: 添加 validateFlexLayout 和 validateFlexChild 函数**

在 `validateUiNodeSpec` 函数之后添加：

```typescript
const VALID_DIRECTIONS = ['row', 'column', 'row-reverse', 'column-reverse'] as const;
const VALID_JUSTIFY = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as const;
const VALID_ALIGN = ['stretch', 'flex-start', 'center', 'flex-end'] as const;
const VALID_WRAP = ['nowrap', 'wrap'] as const;
const VALID_ALIGN_SELF = ['auto', 'flex-start', 'center', 'flex-end', 'stretch'] as const;

function validateFlexLayout(layout: FlexLayout, warnings: string[]): void {
  if (!VALID_DIRECTIONS.includes(layout.direction)) {
    throw new Error(`INVALID_LAYOUT: direction must be one of: ${VALID_DIRECTIONS.join(', ')}, got "${layout.direction}"`);
  }
  if (layout.gap !== undefined && (typeof layout.gap !== 'number' || layout.gap < 0 || !Number.isFinite(layout.gap))) {
    throw new Error('INVALID_LAYOUT: gap must be a non-negative finite number');
  }
  if (layout.row_gap !== undefined && (typeof layout.row_gap !== 'number' || layout.row_gap < 0 || !Number.isFinite(layout.row_gap))) {
    throw new Error('INVALID_LAYOUT: row_gap must be a non-negative finite number');
  }
  if (layout.justify !== undefined && !VALID_JUSTIFY.includes(layout.justify)) {
    throw new Error(`INVALID_LAYOUT: justify must be one of: ${VALID_JUSTIFY.join(', ')}, got "${layout.justify}"`);
  }
  if (layout.align !== undefined && !VALID_ALIGN.includes(layout.align)) {
    throw new Error(`INVALID_LAYOUT: align must be one of: ${VALID_ALIGN.join(', ')}, got "${layout.align}"`);
  }
  if (layout.wrap !== undefined && !VALID_WRAP.includes(layout.wrap)) {
    throw new Error(`INVALID_LAYOUT: wrap must be one of: ${VALID_WRAP.join(', ')}, got "${layout.wrap}"`);
  }
  if (layout.padding !== undefined) {
    if (typeof layout.padding === 'number') {
      if (layout.padding < 0) throw new Error('INVALID_LAYOUT: padding must be non-negative');
    } else if (Array.isArray(layout.padding)) {
      if (layout.padding.length !== 4 || layout.padding.some(v => typeof v !== 'number' || v < 0)) {
        throw new Error('INVALID_LAYOUT: padding array must be [top, right, bottom, left] with non-negative numbers');
      }
    } else {
      throw new Error('INVALID_LAYOUT: padding must be a number or [top, right, bottom, left] array');
    }
  }
  if (layout.row_gap !== undefined && layout.wrap !== 'wrap') {
    warnings.push('layout.row_gap is ignored when wrap is not "wrap"');
  }
  if (layout.justify !== undefined && ['space-between', 'space-around', 'space-evenly'].includes(layout.justify)) {
    warnings.push(`layout.justify "${layout.justify}" is approximated (no exact Godot equivalent)`);
  }
}

function validateFlexChild(flex: FlexChild, warnings: string[]): void {
  if (flex.grow !== undefined && (typeof flex.grow !== 'number' || flex.grow < 0 || !Number.isFinite(flex.grow))) {
    throw new Error('INVALID_FLEX: grow must be a non-negative finite number');
  }
  if (flex.align_self !== undefined && !VALID_ALIGN_SELF.includes(flex.align_self)) {
    throw new Error(`INVALID_FLEX: align_self must be one of: ${VALID_ALIGN_SELF.join(', ')}, got "${flex.align_self}"`);
  }
  if (flex.shrink !== undefined) {
    warnings.push('flex.shrink is ignored (no Godot equivalent)');
  }
  if (flex.max_width !== undefined) {
    warnings.push('flex.max_width is ignored (no Godot equivalent)');
  }
  if (flex.max_height !== undefined) {
    warnings.push('flex.max_height is ignored (no Godot equivalent)');
  }
}
```

- [ ] **Step 2: 修改 validateUiNodeSpec 调用新验证函数**

修改 `validateUiNodeSpec` 签名，接受 `warnings` 参数：

```typescript
function validateUiNodeSpec(spec: UiNodeSpec, depth: number, warnings: string[] = []): void {
```

在函数体末尾、`children` 递归之前，添加：

```typescript
  if (spec.layout) {
    validateFlexLayout(spec.layout, warnings);
  }
  if (spec.flex) {
    validateFlexChild(spec.flex, warnings);
  }
```

- [ ] **Step 3: 构建验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/tools/ui-tools.ts
git commit -m "feat(ui): add FlexLayout and FlexChild validation"
```

---

### Task 3: 核心翻译函数

**Files:**
- Modify: `src/tools/ui-tools.ts`（在 `uiNodeToGd` 之前）

- [ ] **Step 1: 添加 resolveFlexContainer, genFlexContainerProps, genFlexChildLines, applyAlignSelf**

```typescript
function resolveFlexContainer(layout: FlexLayout): {
  containerType: string;
  isReverse: boolean;
  isWrap: boolean;
} {
  const isReverse = layout.direction === 'row-reverse' || layout.direction === 'column-reverse';
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';
  const isWrap = layout.wrap === 'wrap';

  let containerType: string;
  if (isWrap) {
    containerType = isRow ? 'HFlowContainer' : 'VFlowContainer';
  } else {
    containerType = isRow ? 'HBoxContainer' : 'VBoxContainer';
  }

  return { containerType, isReverse, isWrap };
}

function genFlexContainerProps(layout: FlexLayout, indent: string): string {
  const { isWrap } = resolveFlexContainer(layout);
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';
  let lines = '';

  // justify → alignment (BoxContainer only)
  if (layout.justify && !isWrap) {
    const justifyMap: Record<string, number> = {
      'flex-start': 0,
      'center': 1,
      'flex-end': 2,
      'space-between': 0,
      'space-around': 1,
      'space-evenly': 1,
    };
    const alignment = justifyMap[layout.justify];
    if (alignment !== undefined) {
      lines += `\n${indent}node.alignment = ${alignment}`;
    }
  }

  // gap
  if (layout.gap !== undefined) {
    if (isWrap) {
      if (isRow) {
        lines += `\n${indent}node.add_theme_constant_override("h_separation", ${layout.gap})`;
        const vSep = layout.row_gap ?? layout.gap;
        lines += `\n${indent}node.add_theme_constant_override("v_separation", ${vSep})`;
      } else {
        const hSep = layout.row_gap ?? layout.gap;
        lines += `\n${indent}node.add_theme_constant_override("h_separation", ${hSep})`;
        lines += `\n${indent}node.add_theme_constant_override("v_separation", ${layout.gap})`;
      }
    } else {
      lines += `\n${indent}node.add_theme_constant_override("separation", ${layout.gap})`;
    }
  }

  // padding (BoxContainer: direct theme override; FlowContainer: handled in caller)
  if (layout.padding !== undefined && !isWrap) {
    const p = typeof layout.padding === 'number'
      ? [layout.padding, layout.padding, layout.padding, layout.padding]
      : layout.padding;
    lines += `\n${indent}node.add_theme_constant_override("margin_top", ${p[0]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_right", ${p[1]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_bottom", ${p[2]})`;
    lines += `\n${indent}node.add_theme_constant_override("margin_left", ${p[3]})`;
  }

  return lines;
}

function genFlexChildLines(flex: FlexChild, isRow: boolean, indent: string): string {
  let lines = '';

  if (flex.grow !== undefined && flex.grow > 0) {
    lines += `\n${indent}node.size_flags_stretch_ratio = ${flex.grow}`;
    if (isRow) {
      lines += `\n${indent}node.size_flags_horizontal = node.size_flags_horizontal | Control.SIZE_EXPAND`;
    } else {
      lines += `\n${indent}node.size_flags_vertical = node.size_flags_vertical | Control.SIZE_EXPAND`;
    }
  }

  if (flex.align_self && flex.align_self !== 'auto') {
    lines += applyAlignSelf(flex.align_self, isRow, indent);
  }

  if (flex.min_width !== undefined || flex.min_height !== undefined) {
    const w = flex.min_width ?? 'node.custom_minimum_size.x';
    const h = flex.min_height ?? 'node.custom_minimum_size.y';
    lines += `\n${indent}node.custom_minimum_size = Vector2(${w}, ${h})`;
  }

  return lines;
}

function applyAlignSelf(align: string, isRow: boolean, indent: string): string {
  if (align === 'stretch') {
    if (isRow) {
      return `\n${indent}node.size_flags_vertical = node.size_flags_vertical | Control.SIZE_EXPAND_FILL`;
    } else {
      return `\n${indent}node.size_flags_horizontal = node.size_flags_horizontal | Control.SIZE_EXPAND_FILL`;
    }
  } else if (align === 'center') {
    if (isRow) {
      return `\n${indent}node.size_flags_vertical = node.size_flags_vertical | Control.SIZE_SHRINK_CENTER`;
    } else {
      return `\n${indent}node.size_flags_horizontal = node.size_flags_horizontal | Control.SIZE_SHRINK_CENTER`;
    }
  }
  return '';
}
```

- [ ] **Step 2: 构建验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/tools/ui-tools.ts
git commit -m "feat(ui): add flex layout translation helpers"
```

---

### Task 4: 修改 uiNodeToGd 支持 layout 字段

**Files:**
- Modify: `src/tools/ui-tools.ts:526-557`（`uiNodeToGd` 函数）

- [ ] **Step 1: 修改 uiNodeToGd 签名，添加 layout 分支**

```typescript
function uiNodeToGd(spec: UiNodeSpec, parentVar: string, ownerVar: string, indent: string, warnings: string[] = []): string {
  if (spec.layout) {
    return uiNodeToGdWithLayout(spec, parentVar, ownerVar, indent, warnings);
  }
  // ... 现有逻辑不变
```

- [ ] **Step 2: 添加 uiNodeToGdWithLayout 函数**

在 `uiNodeToGd` 函数之后添加：

```typescript
function uiNodeToGdWithLayout(spec: UiNodeSpec, parentVar: string, ownerVar: string, indent: string, warnings: string[]): string {
  const layout = spec.layout!;
  const { containerType, isReverse, isWrap } = resolveFlexContainer(layout);
  const isRow = layout.direction === 'row' || layout.direction === 'row-reverse';

  let lines = `${indent}node = ClassDB.instantiate("${gdEscape(containerType)}")
${indent}if node == null:
${indent}\t_mcp_output("error", "Failed to instantiate: ${gdEscape(containerType)}")
${indent}\t_mcp_done()
${indent}\treturn
${indent}node.name = "${gdEscape(spec.name)}"`;

  // anchor_preset（默认 full_rect）
  const preset = spec.anchor_preset ? ANCHOR_PRESETS[spec.anchor_preset] : 15;
  lines += `\n${indent}node.set_anchors_preset(${preset})`;

  // properties
  if (spec.properties && Object.keys(spec.properties).length > 0) {
    lines += '\n' + Object.entries(spec.properties).map(
      ([k, v]) => `${indent}node.set("${gdEscape(k)}", ${serializePropertyValue(v)})`
    ).join('\n');
  }

  // 容器属性
  lines += genFlexContainerProps(layout, indent);

  // FlowContainer padding 需要 MarginContainer 包裹
  let marginWrapperVar: string | null = null;
  if (isWrap && layout.padding !== undefined) {
    const p = typeof layout.padding === 'number'
      ? [layout.padding, layout.padding, layout.padding, layout.padding]
      : layout.padding;
    const marginIdx = _savedCounter++;
    marginWrapperVar = `_margin_${marginIdx}`;
    const marginBlock = `${indent}var ${marginWrapperVar} = ClassDB.instantiate("MarginContainer")
${indent}${marginWrapperVar}.name = "${gdEscape(spec.name)}_margin"
${indent}${marginWrapperVar}.add_theme_constant_override("margin_top", ${p[0]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_right", ${p[1]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_bottom", ${p[2]})
${indent}${marginWrapperVar}.add_theme_constant_override("margin_left", ${p[3]})
${indent}${marginWrapperVar}.set_anchors_preset(${preset})`;
    lines = marginBlock + '\n' + lines;
  }

  // 子节点
  const savedIdx = _savedCounter++;
  const savedVar = `_saved_${savedIdx}`;
  lines += `\n${indent}var ${savedVar} = node`;

  let children = spec.children ?? [];
  if (isReverse) {
    children = [...children].reverse();
  }

  for (const child of children) {
    lines += '\n' + uiNodeToGd(child, savedVar, ownerVar, indent, warnings);

    // 容器级 align（子节点没有 align_self 覆盖时）
    if (layout.align && (!child.flex || !child.flex.align_self || child.flex.align_self === 'auto')) {
      lines += applyAlignSelf(layout.align, isRow, indent);
    }

    // 子级 flex 属性
    if (child.flex) {
      lines += genFlexChildLines(child.flex, isRow, indent);
    }
  }

  lines += `\n${indent}node = ${savedVar}`;

  if (marginWrapperVar) {
    lines += `\n${indent}node = ${marginWrapperVar}`;
    lines += `\n${indent}${marginWrapperVar}.add_child(${savedVar})`;
    lines += `\n${indent}${savedVar}.owner = ${ownerVar}`;
    lines += `\n${indent}${parentVar}.add_child(node)`;
    lines += `\n${indent}node.owner = ${ownerVar}`;
  } else {
    lines += `\n${indent}${parentVar}.add_child(node)`;
    lines += `\n${indent}node.owner = ${ownerVar}`;
  }

  return lines;
}
```

- [ ] **Step 3: 修改 genUiBuildLayoutScript 传递 warnings**

修改 `genUiBuildLayoutScript` 收集 warnings：

```typescript
export function genUiBuildLayoutScript(
  scenePath: string,
  parentPath: string,
  tree: UiNodeSpec,
): string {
  const warnings: string[] = [];
  validateUiNodeSpec(tree, 1, warnings);

  _savedCounter = 0;
  const buildBlock = uiNodeToGd(tree, 'parent', 'root', '\t', warnings);

  const warningLines = warnings.length > 0
    ? `\n\t_mcp_output("warnings", ${JSON.stringify(warnings.map(w => ({ field: "layout", message: w })))})`
    : '';

  const rootType = tree.layout ? resolveFlexContainer(tree.layout).containerType : tree.type;

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar root = _mcp_get_scene_node("${gdEscape(parentPath)}")
\tif root == null:
\t\t_mcp_output("error", "Parent not found: ${gdEscape(parentPath)}")
\t\t_mcp_done()
\t\treturn
\tvar parent = root
\tvar node: Node
${buildBlock}${warningLines}
\t_mcp_output("layout_built", {"parent": "${gdEscape(parentPath)}", "root_type": "${gdEscape(rootType)}", "root_name": "${gdEscape(tree.name)}"})
\t_mcp_done()
`;
}
```

- [ ] **Step 4: 构建并运行现有测试**

Run: `npm run build && node --test test/ui-tools.test.js`
Expected: 所有现有测试通过（向后兼容）

- [ ] **Step 5: Commit**

```bash
git add src/tools/ui-tools.ts
git commit -m "feat(ui): integrate flex layout into uiNodeToGd code generation"
```

---

### Task 5: 更新 MCP tool schema

**Files:**
- Modify: `src/tools/ui-tools.ts:962-985`（`ui_build_layout` tool schema）

- [ ] **Step 1: 在 tree schema 的 properties 中添加 layout 和 flex 字段**

在 `anchor_preset` 之后、`children` 之前插入：

```typescript
              layout: {
                type: 'object',
                description: 'CSS Flexbox 布局描述（存在时覆盖 type 字段）',
                properties: {
                  direction: { type: 'string', enum: ['row', 'column', 'row-reverse', 'column-reverse'], description: '主轴方向' },
                  justify: { type: 'string', enum: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'], description: '主轴对齐' },
                  align: { type: 'string', enum: ['stretch', 'flex-start', 'center', 'flex-end'], description: '交叉轴对齐' },
                  wrap: { type: 'string', enum: ['nowrap', 'wrap'], description: '换行模式' },
                  gap: { type: 'number', description: '主轴间距' },
                  row_gap: { type: 'number', description: '换行时行间距（仅 wrap 模式）' },
                  padding: {
                    description: '内边距：数字或 [上, 右, 下, 左]',
                    oneOf: [
                      { type: 'number' },
                      { type: 'array', items: { type: 'number' } },
                    ],
                  },
                },
                required: ['direction'],
              },
              flex: {
                type: 'object',
                description: '子节点 flex 控制',
                properties: {
                  grow: { type: 'number', description: '扩展比例（0=不扩展）' },
                  shrink: { type: 'number', description: '收缩比例（忽略，无 Godot 对应）' },
                  align_self: { type: 'string', enum: ['auto', 'flex-start', 'center', 'flex-end', 'stretch'], description: '单独对齐覆盖' },
                  min_width: { type: 'number', description: '最小宽度' },
                  min_height: { type: 'number', description: '最小高度' },
                  max_width: { type: 'number', description: '最大宽度（忽略，无 Godot 对应）' },
                  max_height: { type: 'number', description: '最大高度（忽略，无 Godot 对应）' },
                },
              },
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add src/tools/ui-tools.ts
git commit -m "feat(ui): add layout/flex fields to ui_build_layout MCP schema"
```

---

### Task 6: 添加 layout 翻译测试

**Files:**
- Modify: `test/ui-tools.test.js`

- [ ] **Step 1: 在文件末尾最后一个 `});` 之前添加完整测试组**

```javascript
// ─── Flex Layout Translation ────────────────────────────────────────────────

describe('Flex Layout: direction', () => {
  it('direction: row → HBoxContainer', () => {
    const tree = { type: 'Panel', name: 'Root', layout: { direction: 'row' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("HBoxContainer")'));
    assert.ok(!script.includes('ClassDB.instantiate("Panel")'));
  });

  it('direction: column → VBoxContainer', () => {
    const tree = { type: 'Panel', name: 'Root', layout: { direction: 'column' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("VBoxContainer")'));
    assert.ok(!script.includes('ClassDB.instantiate("Panel")'));
  });

  it('direction: row-reverse → HBoxContainer with reversed children', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'row-reverse' },
      children: [
        { type: 'Button', name: 'A' },
        { type: 'Button', name: 'B' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("HBoxContainer")'));
    const idxB = script.indexOf('node.name = "B"');
    const idxA = script.indexOf('node.name = "A"');
    assert.ok(idxB < idxA, 'B should be generated before A (reversed order)');
  });

  it('direction: column-reverse → VBoxContainer with reversed children', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'column-reverse' },
      children: [
        { type: 'Label', name: 'X' },
        { type: 'Label', name: 'Y' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("VBoxContainer")'));
    const idxY = script.indexOf('node.name = "Y"');
    const idxX = script.indexOf('node.name = "X"');
    assert.ok(idxY < idxX, 'Y should be generated before X (reversed order)');
  });
});

describe('Flex Layout: justify', () => {
  it('justify: center → alignment = 1', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'center' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('node.alignment = 1'));
  });

  it('justify: flex-start → alignment = 0', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'flex-start' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('node.alignment = 0'));
  });

  it('justify: flex-end → alignment = 2', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'flex-end' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('node.alignment = 2'));
  });

  it('justify: space-between → approximated with warning', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', justify: 'space-between' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('node.alignment = 0'));
    assert.ok(script.includes('approximated'));
  });
});

describe('Flex Layout: align', () => {
  it('align: stretch → SIZE_EXPAND_FILL on cross axis', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row', align: 'stretch' },
      children: [{ type: 'Button', name: 'Btn' }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('SIZE_EXPAND_FILL'));
  });

  it('align: center → SIZE_SHRINK_CENTER', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row', align: 'center' },
      children: [{ type: 'Button', name: 'Btn' }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('SIZE_SHRINK_CENTER'));
  });
});

describe('Flex Layout: wrap', () => {
  it('wrap: wrap + row → HFlowContainer', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("HFlowContainer")'));
  });

  it('wrap: wrap + column → VFlowContainer', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'column', wrap: 'wrap' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("VFlowContainer")'));
  });
});

describe('Flex Layout: gap', () => {
  it('BoxContainer gap → separation', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', gap: 10 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('add_theme_constant_override("separation", 10)'));
  });

  it('HFlowContainer gap → h_separation + v_separation', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', gap: 8 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('add_theme_constant_override("h_separation", 8)'));
    assert.ok(script.includes('add_theme_constant_override("v_separation", 8)'));
  });

  it('row_gap in wrap mode', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', gap: 8, row_gap: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('add_theme_constant_override("h_separation", 8)'));
    assert.ok(script.includes('add_theme_constant_override("v_separation", 5)'));
  });

  it('row_gap without wrap → warning', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', row_gap: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('row_gap'));
  });
});

describe('Flex Layout: padding', () => {
  it('BoxContainer padding → theme override margin_*', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', padding: 10 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('add_theme_constant_override("margin_top", 10)'));
    assert.ok(script.includes('add_theme_constant_override("margin_right", 10)'));
    assert.ok(script.includes('add_theme_constant_override("margin_bottom", 10)'));
    assert.ok(script.includes('add_theme_constant_override("margin_left", 10)'));
    assert.ok(!script.includes('MarginContainer'));
  });

  it('BoxContainer padding array → individual margins', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', padding: [1, 2, 3, 4] } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('add_theme_constant_override("margin_top", 1)'));
    assert.ok(script.includes('add_theme_constant_override("margin_right", 2)'));
    assert.ok(script.includes('add_theme_constant_override("margin_bottom", 3)'));
    assert.ok(script.includes('add_theme_constant_override("margin_left", 4)'));
  });

  it('FlowContainer padding → MarginContainer wrapper', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'row', wrap: 'wrap', padding: 5 } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("MarginContainer")'));
    assert.ok(script.includes('R_margin'));
  });
});

describe('Flex Layout: flex child properties', () => {
  it('flex.grow → stretch_ratio + SIZE_EXPAND', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { grow: 2 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('size_flags_stretch_ratio = 2'));
    assert.ok(script.includes('SIZE_EXPAND'));
  });

  it('flex.align_self: center → SIZE_SHRINK_CENTER', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { align_self: 'center' } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('SIZE_SHRINK_CENTER'));
  });

  it('flex.min_width → custom_minimum_size', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { min_width: 200 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('custom_minimum_size = Vector2(200'));
  });

  it('flex.shrink → warning', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { shrink: 1 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('shrink'));
  });

  it('flex.max_width → warning', () => {
    const tree = {
      type: 'Panel', name: 'R', layout: { direction: 'row' },
      children: [{ type: 'Button', name: 'Btn', flex: { max_width: 300 } }],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('max_width'));
  });
});

describe('Flex Layout: backward compatibility', () => {
  it('no layout field → existing behavior unchanged', () => {
    const tree = { type: 'Button', name: 'MyButton' };
    const script = genUiBuildLayoutScript('/scene.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("Button")'));
    assert.ok(script.includes('node.name = "MyButton"'));
    assert.ok(!script.includes('HBoxContainer'));
    assert.ok(!script.includes('VBoxContainer'));
  });

  it('layout overrides type', () => {
    const tree = { type: 'Panel', name: 'R', layout: { direction: 'column' } };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("VBoxContainer")'));
    assert.ok(!script.includes('ClassDB.instantiate("Panel")'));
  });

  it('nested layout: row inside column', () => {
    const tree = {
      type: 'Panel', name: 'Root', layout: { direction: 'column', gap: 10 },
      children: [
        {
          type: 'Panel', name: 'TopRow', layout: { direction: 'row', gap: 5 },
          children: [
            { type: 'Button', name: 'A' },
            { type: 'Button', name: 'B' },
          ],
        },
        { type: 'Label', name: 'Title' },
      ],
    };
    const script = genUiBuildLayoutScript('/s.tscn', 'root', tree);
    assert.ok(script.includes('ClassDB.instantiate("VBoxContainer")'));
    assert.ok(script.includes('ClassDB.instantiate("HBoxContainer")'));
    assert.ok(script.includes('separation", 10)'));
    assert.ok(script.includes('separation", 5)'));
  });
});

describe('Flex Layout: validation', () => {
  it('invalid direction → error', () => {
    assert.throws(
      () => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'P', name: 'R', layout: { direction: 'diagonal' } }),
      /INVALID_LAYOUT/,
    );
  });

  it('negative gap → error', () => {
    assert.throws(
      () => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'P', name: 'R', layout: { direction: 'row', gap: -1 } }),
      /INVALID_LAYOUT/,
    );
  });

  it('invalid padding format → error', () => {
    assert.throws(
      () => genUiBuildLayoutScript('/s.tscn', 'root', { type: 'P', name: 'R', layout: { direction: 'row', padding: 'big' } }),
      /INVALID_LAYOUT/,
    );
  });

  it('invalid align_self → error', () => {
    assert.throws(
      () => genUiBuildLayoutScript('/s.tscn', 'root', {
        type: 'P', name: 'R', layout: { direction: 'row' },
        children: [{ type: 'Button', name: 'B', flex: { align_self: 'middle' } }],
      }),
      /INVALID_FLEX/,
    );
  });
});
```

- [ ] **Step 2: 运行全部测试**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add test/ui-tools.test.js
git commit -m "test(ui): add flex layout translation tests"
```

---

### Task 7: 全量测试和最终验证

**Files:** 无新文件

- [ ] **Step 1: 运行完整测试套件**

Run: `npm test`
Expected: 全部通过

- [ ] **Step 2: 检查向后兼容性**

Run: `node -e "const {genUiBuildLayoutScript} = require('./build/tools/ui-tools.js'); const s = genUiBuildLayoutScript('/s.tscn', 'root', {type:'Button',name:'X'}); console.log(s.includes('ClassDB.instantiate(\"Button\")'))"`
Expected: `true`

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(ui): flex layout test fixes and final adjustments"
```
