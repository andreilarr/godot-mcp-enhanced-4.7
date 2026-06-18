// src/tscn-editor-shared.ts — Shared helpers for .tscn scene file editing
//
// I-10: Non-null assertions (!) on regex match groups are guarded by preceding
// `if (match)` checks — see tscn-parser.ts header for the full rationale.

export interface SceneEditResult {
  success: boolean;
  message: string;
  scene?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Find the end of a section (next `[...]` line or end of file). Returns index of the next section start. */
export function findSectionEnd(lines: string[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('[')) return i;
  }
  return lines.length;
}

/** Escape special characters in .tscn quoted attribute values */
export function escapeTscnAttr(value: string): string {
  if (!value) return '';
  // I-1: 与 escapeTscnValue 对齐——拒绝换行符。name/type/parent 等 [node] 头部属性若含换行,
  // 头部会被拆成多行,第二行可能被 Godot 词法分析器识别为新节点段(注入新 [node]/[ext_resource])。
  // 当前 add 路径白名单(^[A-Za-z0-9_]+$)与 detach 严格相等意外阻挡了换行进入,但根因(转义函数
  // 本身不拒绝换行)是定时炸弹——任何对 findInstanceNode 的"善意"修改都会立即激活注入。此处消除根因。
  if (/[\r\n]/.test(value)) throw new Error('Attribute value must not contain newlines');
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\]/g, '\\]');
}

/** Detect values that are Godot expressions or primitives and should NOT be quoted in .tscn. */
// I-3: 完整锚定 ^...$ —— 每个 Type( 必须匹配到闭合 ),防止 `Vector2(1,2) junk` 这类
// "合法字面量前缀 + 垃圾后缀" 被当字面量不加引号输出(单行内污染属性行语义,escapeTscnValue
// 的换行 throw 已防跨行注入新 [node] 段,此处补单行校验)。[^)]* 允许括号内任意非右括号字符
// (含空格/逗号/引号);Packed\w*Array 限定单词字符防滥用(原 Packed.*Array 的 .* 过宽)。
const GODOT_LITERAL_RE = /^(true|false|null|-?\d+(\.\d+)?(e[+-]?\d+)?|0x[0-9a-fA-F]+|ExtResource\([^)]*\)|SubResource\([^)]*\)|NodePath\([^)]*\)|Vector2i?\([^)]*\)|Vector3i?\([^)]*\)|Vector4i?\([^)]*\)|AABB\([^)]*\)|Color\([^)]*\)|Plane\([^)]*\)|Projection\([^)]*\)|Rect2i?\([^)]*\)|Transform2D\([^)]*\)|Transform3D\([^)]*\)|Basis\([^)]*\)|Quaternion\([^)]*\)|Callable\([^)]*\)|Signal\([^)]*\)|StringName\([^)]*\)|Packed\w*Array\([^)]*\)|Array\([^)]*\)|Dictionary\([^)]*\)|RID\([^)]*\)|Object\([^)]*\)|Resource\([^)]*\)|Variant\([^)]*\)|&"[^"]*")$/;

export function formatTscnValue(value: string): string {
  const trimmed = value.trim();
  if (GODOT_LITERAL_RE.test(trimmed)) {
    // 字面量是 Godot 表达式(Vector2(1,2)、ExtResource(1)、Array([1,2,3])、NodePath("a/b") 等),
    // 内部字符(] " 等)有语法意义,不能再 escape——否则 Array 字面量的 ] 会被转义为 \] 破坏语法。
    // 但仍须拒绝换行,防止跨行注入新 [node] 段。
    if (/[\r\n]/.test(value)) throw new Error('Value must not contain newlines');
    return trimmed;
  }
  return `"${escapeTscnValue(value)}"`;
}

/** Escape property values for safe embedding inside quoted .tscn values (e.g. `property = "value"`).
 *  Does NOT handle unquoted .tscn values or structural syntax. */
export function escapeTscnValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Value must not contain newlines');
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\]/g, '\\]');
}

/** Escape string for safe use in RegExp constructor */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a quoted attribute from a bracket header like `[node name="X" type="Y"]` */
export function getBracketAttr(header: string, attr: string): string | null {
  const safeAttr = escapeRegExp(attr);
  const re = new RegExp(`(?:^|\\s)${safeAttr}="([^"]*)"`);
  const m = header.match(re);
  return m ? m[1]! : null;
}

/** Get the name part of a nodePath like "Root/Player/Sprite2D" → "Sprite2D" */
export function leafName(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts[parts.length - 1]!;
}

/** Build a parent path prefix from a nodePath. "Root/Player/Sprite2D" → "Root/Player" */
export function parentPath(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

/**
 * For a nodePath like "Root/Player/Sprite2D", we need to find the node whose
 * name is "Sprite2D" AND whose parent attribute matches the path prefix.
 * In .tscn, the parent is stored as NodePath("Root/Player").
 */
export function findNodeSectionLine(lines: string[], nodePath: string): number {
  const targetName = leafName(nodePath);
  const targetParent = parentPath(nodePath);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;

    const name = getBracketAttr(trimmed, 'name');
    if (name !== targetName) continue;

    // If targetParent is empty, this is a root node (no parent attr)
    if (!targetParent) {
      const p = getBracketAttr(trimmed, 'parent');
      if (p === null || p === '') return i;
      continue;
    }

    // Match parent — could be inline or on a property line
    const inlineParent = getBracketAttr(trimmed, 'parent');
    if (inlineParent === targetParent) return i;

    // Check property lines below the header
    const end = findSectionEnd(lines, i);
    for (let j = i + 1; j < end; j++) {
      const propLine = lines[j]!.trim();
      if (propLine.startsWith('parent = ') || propLine.startsWith('parent=')) {
        const val = propLine.replace(/^parent\s*=\s*/, '').replace(/"/g, '').trim();
        if (val === targetParent) return i;
      }
    }
  }
  return -1;
}

/** Return the last line of the node section (inclusive). */
export function nodeSectionEnd(lines: string[], nodeLine: number): number {
  return findSectionEnd(lines, nodeLine) - 1;
}
