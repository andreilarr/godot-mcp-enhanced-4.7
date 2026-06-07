// src/tscn-editor.ts — Line-based .tscn scene file editor
//
// I-10: Non-null assertions (!) on regex match groups are guarded by preceding
// `if (match)` checks — see tscn-parser.ts header for the full rationale.

export interface SceneEditResult {
  success: boolean;
  message: string;
  scene?: string;
}

export interface ResourceAddResult {
  success: boolean;
  message: string;
  id: string;
  scene?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalizeLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/** Find the end of a section (next `[...]` line or end of file). Returns index of the next section start. */
function findSectionEnd(lines: string[], startLine: number): number {
  for (let i = startLine + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('[')) return i;
  }
  return lines.length;
}

/** Escape special characters in .tscn quoted attribute values */
function escapeTscnAttr(value: string): string {
  if (!value) return '';
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Detect values that are Godot expressions or primitives and should NOT be quoted in .tscn. */
const GODOT_LITERAL_RE = /^(true|false|null|-?\d+(\.\d+)?(e[+-]?\d+)?|0x[0-9a-fA-F]+|ExtResource\(|SubResource\(|NodePath\(|Vector2i?\(|Vector3i?\(|Vector4i?\(|AABB\(|Color\(|Plane\(|Projection\(|Rect2i?\(|Transform2D\(|Transform3D\(|Basis\(|Quaternion\(|Callable\(|Signal\(|StringName\(|Packed.*Array\(|Array\(|Dictionary\(|RID\(|Object\(|Resource\(|Variant\(|&")/;

function formatTscnValue(value: string): string {
  const escaped = escapeTscnValue(value);
  if (GODOT_LITERAL_RE.test(value.trim())) return escaped;
  return `"${escaped}"`;
}

/** Escape property values for safe embedding inside quoted .tscn values (e.g. `property = "value"`).
 *  Does NOT handle unquoted .tscn values or structural syntax. */
function escapeTscnValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Value must not contain newlines');
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\]/g, '\\]');
}

/** Escape string for safe use in RegExp constructor */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a quoted attribute from a bracket header like `[node name="X" type="Y"]` */
function getBracketAttr(header: string, attr: string): string | null {
  const safeAttr = escapeRegExp(attr);
  const re = new RegExp(`(?:^|\\s)${safeAttr}="([^"]*)"`);
  const m = header.match(re);
  return m ? m[1]! : null;
}

/** Get the name part of a nodePath like "Root/Player/Sprite2D" → "Sprite2D" */
function leafName(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts[parts.length - 1]!;
}

/** Build a parent path prefix from a nodePath. "Root/Player/Sprite2D" → "Root/Player" */
function parentPath(nodePath: string): string {
  const parts = nodePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

/**
 * For a nodePath like "Root/Player/Sprite2D", we need to find the node whose
 * name is "Sprite2D" AND whose parent attribute matches the path prefix.
 * In .tscn, the parent is stored as NodePath("Root/Player").
 */
function findNodeSectionLine(lines: string[], nodePath: string): number {
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
function nodeSectionEnd(lines: string[], nodeLine: number): number {
  return findSectionEnd(lines, nodeLine) - 1;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Edit a node property in a .tscn scene.
 * If the property already exists its value is replaced; otherwise a new line is appended
 * inside the node section.
 */
export function editNodeProperty(
  tscnContent: string,
  nodePath: string,
  property: string,
  value: string,
): SceneEditResult {
  if (!/^[a-zA-Z_]\w*$/.test(property)) {
    return { success: false, message: `Invalid property name: ${property}` };
  }

  const lines = normalizeLines(tscnContent);
  const nodeLine = findNodeSectionLine(lines, nodePath);

  if (nodeLine === -1) {
    return { success: false, message: `Node not found: ${nodePath}` };
  }

  const end = nodeSectionEnd(lines, nodeLine);
  const propPrefix = `${property} = `;

  // Try to find existing property line
  for (let i = nodeLine + 1; i <= end; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith(propPrefix)) {
      lines[i] = `${property} = ${formatTscnValue(value)}`;
      return { success: true, message: `Updated ${property} on ${nodePath}`, scene: lines.join('\n') };
    }
    // Also handle property:type = value format
    if (trimmed.startsWith(`${property}:`)) {
      const rest = trimmed.slice(trimmed.indexOf(':') + 1);
      const typeMatch = rest.match(/^(\w+)\s*=/);
      if (typeMatch) {
        lines[i] = `${property}:${typeMatch[1]} = ${formatTscnValue(value)}`;
        return { success: true, message: `Updated ${property} on ${nodePath}`, scene: lines.join('\n') };
      }
    }
  }

  // Property not found — insert after the last property line of the node section
  let insertAt = nodeLine + 1;
  for (let i = nodeLine + 1; i <= end; i++) {
    if (lines[i]!.trim() !== '' && (lines[i]!.startsWith('\t') || lines[i]!.startsWith(' '))) {
      insertAt = i + 1;
    }
  }
  lines.splice(insertAt, 0, `${property} = ${formatTscnValue(value)}`);

  return { success: true, message: `Added ${property} = ${value} to ${nodePath}`, scene: lines.join('\n') };
}

/**
 * Delete a node and all its children from a .tscn scene.
 * Children are identified by having a parent path that starts with the target nodePath.
 */
export function deleteNode(
  tscnContent: string,
  nodePath: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);

  // Detect root node name from .tscn for path normalization
  let rootName: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[node')) continue;
    const parentAttr = getBracketAttr(trimmed, 'parent');
    if (parentAttr === null || parentAttr === '') {
      rootName = getBracketAttr(trimmed, 'name');
      break;
    }
  }

  // Normalize nodePath: strip leading "root/" or "rootName/" prefix
  let normalizedPath = nodePath;
  if (rootName && nodePath.startsWith(rootName + '/')) {
    normalizedPath = nodePath.slice(rootName.length + 1);
  } else if (nodePath.startsWith('root/')) {
    normalizedPath = nodePath.slice('root/'.length);
  }

  const targetLine = findNodeSectionLine(lines, normalizedPath);
  if (targetLine === -1) {
    // Try original path as fallback
    const fallbackLine = findNodeSectionLine(lines, nodePath);
    if (fallbackLine === -1) {
      return { success: false, message: `Node not found: ${nodePath}` };
    }
    normalizedPath = nodePath;
  }

  // Find all descendant node sections
  const descendantRanges: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;

    const name = getBracketAttr(trimmed, 'name');
    let parent = getBracketAttr(trimmed, 'parent');

    // Also check property lines for parent
    if (parent === null) {
      const end = findSectionEnd(lines, i);
      for (let j = i + 1; j < end; j++) {
        const pl = lines[j]!.trim();
        if (pl.startsWith('parent = ') || pl.startsWith('parent=')) {
          parent = pl.replace(/^parent\s*=\s*/, '').replace(/"/g, '').trim();
          break;
        }
      }
    }

    // Build this node's full path (relative to root).
    // Each node's path is unique in .tscn because parent is recorded explicitly,
    // so startsWith(normalizedPath + '/') won't accidentally match nodes under
    // a different ancestor that merely shares a name component.
    let thisPath = name || '';
    if (parent && parent !== '') {
      thisPath = `${parent}/${thisPath}`;
    }

    if (thisPath === normalizedPath || thisPath.startsWith(normalizedPath + '/')) {
      const sectionEnd = nodeSectionEnd(lines, i);
      descendantRanges.push([i, sectionEnd]);
    }
  }

  // Sort by start line descending so we can splice from bottom up
  descendantRanges.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of descendantRanges) {
    lines.splice(start, end - start + 1);
  }

  // C-02: Decrement load_steps to stay consistent with actual section count
  decrementLoadSteps(lines, descendantRanges.length);

  return {
    success: true,
    message: `Deleted node ${nodePath} and ${descendantRanges.length} section(s)`,
    scene: lines.join('\n'),
  };
}

/**
 * Add a signal connection to a .tscn scene.
 * Appends a [connection] section at the end of the file.
 */
export function addConnection(
  tscnContent: string,
  signal: string,
  fromNode: string,
  toNode: string,
  method: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);

  const connLine = `[connection signal="${escapeTscnAttr(signal)}" from="${escapeTscnAttr(fromNode)}" to="${escapeTscnAttr(toNode)}" method="${escapeTscnAttr(method)}"]`;

  // Append before any trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }
  lines.push('');
  lines.push(connLine);
  lines.push('');

  return {
    success: true,
    message: `Added connection: ${fromNode}.${signal} -> ${toNode}.${method}`,
    scene: lines.join('\n'),
  };
}

/**
 * Remove a signal connection from a .tscn scene.
 * Matches by signal name and from node.
 */
export function removeConnection(
  tscnContent: string,
  signal: string,
  fromNode: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);
  let removed = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[connection')) continue;

    const sig = getBracketAttr(trimmed, 'signal');
    const from = getBracketAttr(trimmed, 'from');

    if (sig === signal && from === fromNode) {
      lines.splice(i, 1);
      removed = true;
      break;
    }
  }

  if (!removed) {
    return { success: false, message: `Connection not found: ${fromNode}.${signal}` };
  }

  return {
    success: true,
    message: `Removed connection: ${fromNode}.${signal}`,
    scene: lines.join('\n'),
  };
}

/**
 * Set (or change) the script attached to a node.
 * This involves:
 * 1. Adding an ext_resource entry for the script (if not already present).
 * 2. Setting the `script` property on the node to ExtResource(id).
 */
export function setNodeScript(
  tscnContent: string,
  nodePath: string,
  scriptPath: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);

  const nodeLine = findNodeSectionLine(lines, nodePath);
  if (nodeLine === -1) {
    return { success: false, message: `Node not found: ${nodePath}` };
  }

  // C-01: Check if ext_resource for this script already exists
  // Use \bid="([^"]+)" to match both numeric IDs and Godot 4.x string UIDs
  let extId: string | number | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[ext_resource')) continue;
    if (trimmed.includes(`path="${scriptPath}"`)) {
      const idMatch = trimmed.match(/\bid="([^"]+)"/);
      if (idMatch) {
        const raw = idMatch[1]!;
        const num = Number(raw);
        extId = Number.isFinite(num) && raw !== '' ? num : raw;
        break;
      }
    }
  }

  if (extId === null) {
    // Find the next available ext_resource id
    let maxId = 0;
    for (const line of lines) {
      const idMatch = line.match(/\[ext_resource.*\bid=(\d+)/);
      if (idMatch) {
        const id = parseInt(idMatch[1]!);
        if (id > maxId) maxId = id;
      }
    }
    extId = maxId + 1;

    // Insert the new ext_resource after the last ext_resource or after the header
    let insertAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim().startsWith('[ext_resource')) {
        insertAt = i + 1;
        break;
      }
    }
    // If no ext_resource found, insert after header
    if (insertAt === lines.length) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.trim().startsWith('[') && !lines[i]!.trim().startsWith('[gd_scene')) {
          insertAt = i;
          break;
        }
      }
    }

    lines.splice(insertAt, 0, `[ext_resource type="Script" path="${escapeTscnAttr(scriptPath)}" id="${extId}"]`);
  }

  // Re-find node line after potential insertion
  const newNodeLine = findNodeSectionLine(lines, nodePath);
  if (newNodeLine === -1) {
    return { success: false, message: `Node not found after ext_resource insertion: ${nodePath}` };
  }

  const end = nodeSectionEnd(lines, newNodeLine);
  let found = false;
  for (let i = newNodeLine + 1; i <= end; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('script = ') || trimmed.startsWith('script=')) {
      lines[i] = `script = ExtResource("${extId}")`;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.splice(newNodeLine + 1, 0, `script = ExtResource("${extId}")`);
  }

  return {
    success: true,
    message: `Set script on ${nodePath} to ${scriptPath} (ExtResource(${extId}))`,
    scene: lines.join('\n'),
  };
}

/**
 * Change the type of a node in a .tscn scene.
 * Replaces the `type` attribute in the [node] header.
 */
export function changeNodeType(
  tscnContent: string,
  nodePath: string,
  newType: string,
): SceneEditResult {
  const lines = normalizeLines(tscnContent);
  const nodeLine = findNodeSectionLine(lines, nodePath);

  if (nodeLine === -1) {
    return { success: false, message: `Node not found: ${nodePath}` };
  }

  const header = lines[nodeLine]!;
  const typeMatch = header.match(/type="[^"]*"/);

  if (!typeMatch) {
    return { success: false, message: `Node ${nodePath} has no type attribute` };
  }

  const oldType = typeMatch[0].match(/type="([^"]*)"/)![1];
  lines[nodeLine] = header.replace(/type="[^"]*"/, `type="${escapeTscnAttr(newType)}"`);

  // A-08: Update load_steps in gd_scene header to match ext_resource + sub_resource count + 1
  let extCount = 0;
  let subCount = 0;
  for (const line of lines) {
    if (line.trim().startsWith('[ext_resource')) extCount++;
    if (line.trim().startsWith('[sub_resource')) subCount++;
  }
  const newLoadSteps = extCount + subCount + 1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('[gd_scene') && lines[i]!.includes('load_steps=')) {
      lines[i] = lines[i]!.replace(/load_steps=\d+/, `load_steps=${newLoadSteps}`);
      break;
    }
  }

  return {
    success: true,
    message: `Changed ${nodePath} type from ${oldType} to ${newType}`,
    scene: lines.join('\n'),
  };
}

// ── Detach instance (inline subtree) ─────────────────────────────────────────

export interface InstanceNodeInfo {
  instanceId: string | number;
  sourcePath: string;
  lineIndex: number;
  propertyOverrides: string[];
}

/**
 * Parse all [ext_resource ...] lines from .tscn text, returning id → path map.
 */
function parseExtResourceMap(lines: string[]): Map<string | number, string> {
  const map = new Map<string | number, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[ext_resource')) continue;
    // Match id="N" and path="res://..." — supports both numeric and string UIDs
    // Use \b to avoid matching "uid" as "id"
    const idMatch = trimmed.match(/\bid="([^"]+)"/);
    const pathMatch = trimmed.match(/\bpath="([^"]+)"/);
    if (idMatch && pathMatch) {
      const rawId = idMatch[1]!;
      const numericId = Number(rawId);
      map.set(!isNaN(numericId) && rawId !== '' ? numericId : rawId, pathMatch[1]!);
    }
  }
  return map;
}

/**
 * Convert node_path format to .tscn parent format.
 * "root/Player" → "."  (direct child of root)
 * "root/Level/Player" → "Level"
 * "." or "root" → "."
 */
function parentToTscnParent(nodePathParent: string): string {
  if (nodePathParent === '.' || nodePathParent === 'root' || nodePathParent === '/root') {
    return '.';
  }
  let p = nodePathParent.startsWith('/') ? nodePathParent.slice(1) : nodePathParent;
  if (p.startsWith('root/')) {
    p = p.slice('root/'.length);
  } else if (p === 'root') {
    return '.';
  }
  return p || '.';
}

/**
 * Convert node_path to (nodeName, tscnParent) pair.
 * "/root/Player/Sprite" → ("Sprite", "Player")
 * "/root/Player" → ("Player", ".")
 */
export function nodePathToNameAndParent(nodePath: string): { nodeName: string; parent: string } {
  let p = nodePath.startsWith('/') ? nodePath.slice(1) : nodePath;
  if (p.startsWith('root/')) {
    p = p.slice('root/'.length);
  } else if (p === 'root') {
    throw new Error('Cannot detach the root node');
  }
  const parts = p.split('/');
  const nodeName = parts.pop()!;
  const parent = parts.length === 0 ? '.' : parts.join('/');
  return { nodeName, parent };
}

/**
 * Scan .tscn text to find a node with `instance=ExtResource(N)`.
 *
 * @param nodeName - The value of the `name` attribute in .tscn
 * @param parent - The .tscn parent value: "." for root children, "ParentName" for nested
 */
export function findInstanceNode(
  tscn: string,
  nodeName: string,
  parent: string,
): InstanceNodeInfo | null {
  const lines = normalizeLines(tscn);
  const extMap = parseExtResourceMap(lines);

  const tscnParent = parentToTscnParent(parent);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('[node ')) continue;

    const nameMatch = line.match(/name="([^"]+)"/);
    if (!nameMatch || nameMatch[1]! !== nodeName) continue;

    const parentMatch = line.match(/parent="([^"]+)"/);
    const lineParent = parentMatch ? parentMatch[1]! : '.';
    if (lineParent !== tscnParent) continue;

    const instanceMatch = line.match(/instance=ExtResource\("([^"]+)"\)/);
    if (!instanceMatch) continue;

    const rawInstId = instanceMatch[1]!;
    const numericInstId = Number(rawInstId);
    const instanceId: string | number = Number.isFinite(numericInstId) && rawInstId !== '' ? numericInstId : rawInstId;
    const sourcePath = extMap.get(instanceId);
    if (!sourcePath) return null;

    // Collect property overrides: lines after [node] with '=' that don't start with '['
    const propertyOverrides: string[] = [];
    const end = findSectionEnd(lines, i);
    for (let j = i + 1; j < end; j++) {
      const propLine = lines[j]!;
      if (propLine.includes('=')) {
        propertyOverrides.push(propLine);
      }
    }

    return { instanceId, sourcePath, lineIndex: i, propertyOverrides };
  }

  return null;
}

/**
 * Find max ext_resource id in a .tscn text.
 */
function findMaxExtResourceId(lines: string[]): number {
  let maxId = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[ext_resource')) continue;
    const m = trimmed.match(/\bid="([^"]+)"/);
    if (m) {
      const id = Number(m[1]);
      // Only consider numeric IDs for max calculation; string UIDs are skipped
      if (Number.isFinite(id) && m[1] !== '' && id > maxId) maxId = id;
    }
  }
  return maxId;
}

/**
 * Extract sections from source .tscn text into structured groups.
 * Handles ext_resources, sub_resources (multi-line), connections, and nodes.
 */
function parseSourceScene(sourceTscn: string): {
  extResources: string[];
  subResources: string[];
  connections: string[];
  nodeGroups: Array<{ header: string; props: string[] }>;
} {
  const lines = normalizeLines(sourceTscn);
  const extResources: string[] = [];
  const subResources: string[] = [];
  const connections: string[] = [];
  const nodeGroups: Array<{ header: string; props: string[] }> = [];

  let section = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[ext_resource')) {
      extResources.push(trimmed);
      section = 'ext';
    } else if (trimmed.startsWith('[sub_resource')) {
      subResources.push(trimmed);
      section = 'sub';
    } else if (trimmed.startsWith('[connection')) {
      connections.push(trimmed);
      section = 'connection';
    } else if (trimmed.startsWith('[node')) {
      nodeGroups.push({ header: trimmed, props: [] });
      section = 'node';
    } else if (trimmed.startsWith('[')) {
      section = ''; // unknown section, skip
    } else if (section === 'sub') {
      subResources.push(line);
    } else if (section === 'node') {
      nodeGroups[nodeGroups.length - 1]!.props.push(line);
    }
    // ext_resource and connection are typically single-line — nothing extra to collect
  }

  return { extResources, subResources, connections, nodeGroups };
}

/**
 * Remap ext_resource IDs in source lines to avoid conflicts with target.
 */
function remapExtResourceIds(
  sourceExtResources: string[],
  targetMaxId: number,
): { remapped: string[]; idMap: Map<number, number> } {
  const idMap = new Map<number, number>();
  let nextId = targetMaxId + 1;

  const remapped = sourceExtResources.map((line) => {
    const idMatch = line.match(/\bid="([^"]+)"/);
    if (!idMatch) return line;
    const rawId = Number(idMatch[1]);
    // Only remap numeric IDs; string UIDs are left as-is
    if (!Number.isFinite(rawId) || idMatch[1] === '') return line;
    const oldId = rawId;
    const newId = nextId++;
    idMap.set(oldId, newId);
    return line.replace(`id="${oldId}"`, `id="${newId}"`);
  });

  return { remapped, idMap };
}

/**
 * Apply ID remapping to a line's ExtResource("N") references.
 */
function remapNodeLineRefs(line: string, idMap: Map<number, number>): string {
  return line.replace(/ExtResource\("([^"]+)"\)/g, (_match, idStr) => {
    const numericId = Number(idStr);
    // Only remap numeric IDs; string UIDs are left as-is
    if (isNaN(numericId) || idStr === '') return _match;
    const newId = idMap.get(numericId);
    return newId !== undefined ? `ExtResource("${newId}")` : _match;
  });
}

/**
 * Find max sub_resource id in a .tscn text (lines).
 * Format: [sub_resource type="..." id="N"]
 */
function findMaxSubResourceId(lines: string[]): number {
  let maxId = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[sub_resource')) continue;
    const m = trimmed.match(/\bid="(\d+)"/);
    if (m) {
      const id = parseInt(m[1]!);
      if (id > maxId) maxId = id;
    }
  }
  return maxId;
}

/**
 * Remap sub_resource IDs in source lines to avoid conflicts with target.
 * Returns remapped lines and a map from old ID → new ID.
 * I-06: Handles both numeric IDs ("123") and Godot 4.x string UIDs ("StyleBoxFlat_xb1kx").
 */
function remapSubResourceIds(
  sourceSubResources: string[],
  targetMaxId: number,
): { remapped: string[]; idMap: Map<string, number> } {
  const idMap = new Map<string, number>();
  let nextId = targetMaxId + 1;

  const remapped: string[] = [];
  for (const line of sourceSubResources) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[sub_resource')) {
      const idMatch = trimmed.match(/\bid="([^"]+)"/);
      if (idMatch) {
        const oldId = idMatch[1]!;
        const newId = nextId++;
        idMap.set(oldId, newId);
        remapped.push(line.replace(`id="${oldId}"`, `id="${newId}"`));
        continue;
      }
    }
    remapped.push(line);
  }

  return { remapped, idMap };
}

/**
 * Apply sub_resource ID remapping to SubResource("N") references in a line.
 * I-06: Also handles Godot 4.x string UID references like SubResource("StyleBoxFlat_xb1kx").
 */
function remapSubResourceRefs(line: string, idMap: Map<string, number>): string {
  if (idMap.size === 0) return line;
  return line.replace(/SubResource\("([^"]+)"\)/g, (_match, oldId) => {
    const newId = idMap.get(oldId);
    return newId !== undefined ? `SubResource("${newId}")` : _match;
  });
}

/**
 * Remap connection paths for inlined subtree.
 * Prepends instanceNodeName prefix to from/to fields.
 * "." → instanceNodeName, "Child" → "instanceNodeName/Child"
 */
function remapConnectionPaths(
  connections: string[],
  instanceNodeName: string,
  _tscnParent: string,
): string[] {
  return connections.map(line => {
    let result = line;
    // Remap from="..." attribute
    result = result.replace(/from="([^"]+)"/, (_match, path) => {
      const newPath = path === '.' ? instanceNodeName : `${instanceNodeName}/${path}`;
      return `from="${newPath}"`;
    });
    // Remap to="..." attribute
    result = result.replace(/to="([^"]+)"/, (_match, path) => {
      const newPath = path === '.' ? instanceNodeName : `${instanceNodeName}/${path}`;
      return `to="${newPath}"`;
    });
    return result;
  });
}

/**
 * Detach (inline) an instance node by replacing `instance=ExtResource(N)` with
 * the expanded subtree from the source scene.
 *
 * Equivalent to Godot editor's "Make Local" operation.
 *
 * @param targetTscn - The .tscn file text containing the instance reference
 * @param sourceTscn - The .tscn file text of the instanced scene
 * @param nodeName - The node name as used in .tscn `name` attribute
 * @param parent - The .tscn parent value ("." for root children, "X" for nested)
 */
export function detachInstance(
  targetTscn: string,
  sourceTscn: string,
  nodeName: string,
  parent: string,
): string {
  const info = findInstanceNode(targetTscn, nodeName, parent);
  if (!info) throw new Error(`Instance node not found: ${nodeName} (parent: ${parent})`);

  const targetLines = normalizeLines(targetTscn);
  const source = parseSourceScene(sourceTscn);

  if (source.nodeGroups.length === 0) {
    throw new Error('Source scene has no nodes');
  }

  // 1. Find max ext_resource ID in target for remapping
  const targetMaxId = findMaxExtResourceId(targetLines);

  // 2. Remap source ext_resource IDs to avoid conflicts
  const { remapped: remappedExtResources, idMap } = remapExtResourceIds(
    source.extResources,
    targetMaxId,
  );

  // 2b. Remap source sub_resource IDs to avoid conflicts with target
  const targetMaxSubId = findMaxSubResourceId(targetLines);
  const { remapped: remappedSubResources, idMap: subIdMap } = remapSubResourceIds(
    source.subResources,
    targetMaxSubId,
  );

  // 2c. Remap connection paths for inlined subtree
  const remappedConnections = remapConnectionPaths(
    source.connections,
    nodeName,
    parentToTscnParent(parent),
  );

  // 3. Build expanded node lines from source
  const expandedLines: string[] = [];

  // Root node: remove instance attr, adjust name and parent
  const rootGroup = source.nodeGroups[0]!;
  let rootHeader = rootGroup.header;

  // Remove instance=ExtResource("N") if present (source might itself be instanced)
  rootHeader = rootHeader.replace(/\s*instance=ExtResource\("[^"]+"\)/, '');

  // Determine the target parent attribute for this node
  const tscnParent = parentToTscnParent(parent);

  // Set name to the instance node's name
  rootHeader = rootHeader.replace(/name="[^"]+"/, `name="${escapeTscnAttr(nodeName)}"`);

  // Set parent
  if (!rootHeader.includes('parent=')) {
    if (tscnParent !== '.') {
      rootHeader = rootHeader.replace(']', ` parent="${escapeTscnAttr(tscnParent)}"]`);
    }
    // If tscnParent is ".", root node has no parent attr — which is correct for scene root children
    // But in a target scene, nodes under root need parent="."
    // Only the source root (which has no parent attr) needs adjustment when being inlined
    // under a non-root parent. If being inlined as direct child of target root (parent="."),
    // no parent attr is needed.
    if (tscnParent === '.') {
      // Explicit parent="." for clarity
      rootHeader = rootHeader.replace(']', ` parent="."]`);
    }
  } else {
    rootHeader = rootHeader.replace(/parent="[^"]+"/, `parent="${escapeTscnAttr(tscnParent)}"`);
  }

  // Remap ExtResource references in root header
  rootHeader = remapNodeLineRefs(rootHeader, idMap);
  rootHeader = remapSubResourceRefs(rootHeader, subIdMap);

  expandedLines.push(rootHeader);

  // Add root node property lines (remapped), but remove any that will be overridden
  let sourceNodeLines = rootGroup!.props.map(l => {
    return remapSubResourceRefs(remapNodeLineRefs(l, idMap), subIdMap);
  });

  // C1 fix: deduplicate source properties against overrides
  if (info.propertyOverrides.length > 0) {
    const overrideKeys = new Set<string>();
    for (const ovr of info.propertyOverrides) {
      const m = ovr.trim().match(/^(\w+)\s*=/);
      if (m) overrideKeys.add(m[1]!);
    }
    sourceNodeLines = sourceNodeLines.filter(line => {
      const m = line.trim().match(/^(\w+)\s*=/);
      return !m || !overrideKeys.has(m[1]!);
    });
  }

  for (const propLine of sourceNodeLines) {
    expandedLines.push(propLine);
  }

  // Add property overrides from target instance
  for (const override of info.propertyOverrides) {
    expandedLines.push(override);
  }

  // Child nodes: prepend nodeName/ to their parent attribute
  for (let i = 1; i < source.nodeGroups.length; i++) {
    const group = source.nodeGroups[i]!;
    let header = group.header;

    const parentMatch = header.match(/parent="([^"]+)"/);
    if (parentMatch) {
      const originalParent = parentMatch[1];
      const newParent = originalParent === '.' ? nodeName : `${nodeName}/${originalParent}`;
      header = header.replace(/parent="[^"]+"/, `parent="${escapeTscnAttr(newParent)}"`);
    } else {
      header = header.replace(']', ` parent="${escapeTscnAttr(nodeName)}"]`);
    }

    header = remapNodeLineRefs(header, idMap);
    header = remapSubResourceRefs(header, subIdMap);

    expandedLines.push(header);
    for (const propLine of group.props) {
      expandedLines.push(remapSubResourceRefs(remapNodeLineRefs(propLine, idMap), subIdMap));
    }
  }

  // 4. Build result: replace instance line with expanded subtree, insert new ext_resources
  const instanceEndIdx = info.lineIndex + 1 + info.propertyOverrides.length;

  // Find where to insert new ext_resources (after last existing ext_resource)
  let lastExtResourceIdx = -1;
  for (let i = 0; i < targetLines.length; i++) {
    if (targetLines[i]!.trim().startsWith('[ext_resource')) {
      lastExtResourceIdx = i;
    }
  }

  // Find the first [node] line in target — sub_resources go before it
  let firstNodeIdx = -1;
  for (let i = 0; i < targetLines.length; i++) {
    if (targetLines[i]!.trim().startsWith('[node')) {
      firstNodeIdx = i;
      break;
    }
  }

  const cleanResult: string[] = [];
  let insertedExpanded = false;
  let insertedSubResources = false;

  for (let i = 0; i < targetLines.length; i++) {
    // Skip the instance node line and its property overrides
    if (i >= info.lineIndex && i < instanceEndIdx) {
      if (!insertedExpanded) {
        for (const expLine of expandedLines) {
          cleanResult.push(expLine);
        }
        insertedExpanded = true;
      }
      continue;
    }

    // Insert remapped sub_resources before the first [node] section
    if (!insertedSubResources && i === firstNodeIdx && remappedSubResources.length > 0) {
      cleanResult.push('');  // blank line separator
      for (const subLine of remappedSubResources) {
        cleanResult.push(subLine);
      }
      insertedSubResources = true;
    }

    cleanResult.push(targetLines[i]!);

    // After last existing ext_resource, insert new ext_resources from source
    if (i === lastExtResourceIdx && remappedExtResources.length > 0) {
      for (const extLine of remappedExtResources) {
        cleanResult.push(extLine);
      }
    }
  }

  if (!insertedExpanded) {
    for (const expLine of expandedLines) {
      cleanResult.push(expLine);
    }
  }

  // Append remapped connections at the end (before trailing blank lines)
  if (remappedConnections.length > 0) {
    // Remove trailing blank lines, add connections, then trailing newline
    while (cleanResult.length > 0 && cleanResult[cleanResult.length - 1]!.trim() === '') {
      cleanResult.pop();
    }
    cleanResult.push('');
    for (const connLine of remappedConnections) {
      cleanResult.push(connLine);
    }
    cleanResult.push('');
  }

  // 5. Remove the now-unused ext_resource if no other nodes reference it
  const refPattern = new RegExp(`ExtResource\\("${info.instanceId}"\\)`);
  let otherRefs = 0;
  for (const line of cleanResult) {
    if (refPattern.test(line)) {
      otherRefs++;
    }
  }

  if (otherRefs === 0) {
    const extLinePattern = new RegExp(`^\\s*\\[ext_resource[^\\]]*\\bid="${info.instanceId}"`);
    for (let i = cleanResult.length - 1; i >= 0; i--) {
      if (extLinePattern.test(cleanResult[i]!)) {
        cleanResult.splice(i, 1);
        break;
      }
    }
  }

  // 6. Update load_steps in header if present
  let extCount = 0;
  let subCount = 0;
  for (const line of cleanResult) {
    if (line.trim().startsWith('[ext_resource')) extCount++;
    if (line.trim().startsWith('[sub_resource')) subCount++;
  }
  const newLoadSteps = extCount + subCount + 1;
  for (let i = 0; i < cleanResult.length; i++) {
    if (cleanResult[i]!.startsWith('[gd_scene') && cleanResult[i]!.includes('load_steps=')) {
      cleanResult[i] = cleanResult[i]!.replace(
        /load_steps=\d+/,
        `load_steps=${newLoadSteps}`,
      );
      break;
    }
  }

  return cleanResult.join('\n');
}

// ── Resource add helpers ─────────────────────────────────────────────────────

/**
 * Increment load_steps in [gd_scene] header by 1.
 * If no load_steps attribute exists, adds load_steps=2.
 */
function incrementLoadSteps(lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[gd_scene')) continue;
    if (trimmed.includes('load_steps=')) {
      lines[i] = lines[i]!.replace(/load_steps=\d+/, (m) => {
        const n = parseInt(m.split('=')[1]!);
        return `load_steps=${n + 1}`;
      });
    } else {
      // Insert load_steps=2 before the closing bracket
      lines[i] = lines[i]!.replace(']', ' load_steps=2]');
    }
    return;
  }
}

/**
 * Decrement load_steps in [gd_scene] header by `count`.
 * C-02: Used by deleteNode to keep load_steps consistent with actual section count.
 * Floor at 2 (minimum for a valid scene: header counts as 1 step).
 */
function decrementLoadSteps(lines: string[], count: number): void {
  if (count <= 0) return;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[gd_scene') || !trimmed.includes('load_steps=')) continue;
    lines[i] = lines[i]!.replace(/load_steps=\d+/, (m) => {
      const n = parseInt(m.split('=')[1]!);
      return `load_steps=${Math.max(2, n - count)}`;
    });
    return;
  }
}

/**
 * Add an external resource to a .tscn scene.
 * Deduplicates by path — if an ext_resource with the same path already exists,
 * returns the existing id without adding a duplicate or incrementing load_steps.
 */
export function addExtResource(
  tscnContent: string,
  type: string,
  resourcePath: string,
): ResourceAddResult {
  const lines = normalizeLines(tscnContent);

  // 1. Check for existing ext_resource with same path (dedup)
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[ext_resource')) continue;
    if (trimmed.includes(`path="${resourcePath}"`)) {
      const idMatch = trimmed.match(/\bid="([^"]+)"/);
      if (idMatch) {
        return {
          success: true,
          message: `ext_resource for ${resourcePath} already exists`,
          id: idMatch[1]!,
        };
      }
    }
  }

  // 2. Find max numeric id among all ext_resource entries
  const maxId = findMaxExtResourceId(lines);
  const newId = maxId + 1;

  // 3. Insert after last ext_resource line (or after header if none)
  let insertAt = 0;
  let foundExt = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().startsWith('[ext_resource')) {
      insertAt = i + 1;
      foundExt = true;
      break;
    }
  }
  if (!foundExt) {
    // Insert after [gd_scene ...] header line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim().startsWith('[gd_scene')) {
        insertAt = i + 1;
        break;
      }
    }
  }

  const newLine = `[ext_resource type="${escapeTscnAttr(type)}" path="${escapeTscnAttr(resourcePath)}" id="${newId}"]`;
  lines.splice(insertAt, 0, newLine);

  // 4. Update load_steps
  incrementLoadSteps(lines);

  return {
    success: true,
    message: `Added ext_resource type="${type}" path="${resourcePath}" id="${newId}"`,
    id: String(newId),
    scene: lines.join('\n'),
  };
}

/**
 * Add a sub resource to a .tscn scene.
 * Generates an id in the format `Type_N` where N is the next available suffix for that type.
 */
export function addSubResource(
  tscnContent: string,
  type: string,
  props: Record<string, string>,
): ResourceAddResult {
  const lines = normalizeLines(tscnContent);

  // 1. Find max numeric suffix among sub_resource entries with the same type
  let maxSuffix = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[sub_resource')) continue;
    // Match id="Type_N" pattern
    const idMatch = trimmed.match(/\bid="([^"]+)"/);
    if (idMatch) {
      const id = idMatch[1]!;
      if (id.startsWith(`${type}_`)) {
        const suffixStr = id.slice(type.length + 1);
        const suffix = parseInt(suffixStr);
        if (Number.isFinite(suffix) && suffix > maxSuffix) {
          maxSuffix = suffix;
        }
      }
    }
  }

  const newId = `${type}_${maxSuffix + 1}`;

  // 2. Build sub_resource section
  const headerLine = `[sub_resource type="${escapeTscnAttr(type)}" id="${newId}"]`;
  const propLines: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    propLines.push(`${key} = ${formatTscnValue(value)}`);
  }

  // 3. Insert before first [node] section, after last [sub_resource]
  let insertAt = 0;
  let lastSubResourceIdx = -1;
  let firstNodeIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('[sub_resource')) {
      lastSubResourceIdx = i;
    }
    if (firstNodeIdx === -1 && trimmed.startsWith('[node')) {
      firstNodeIdx = i;
    }
  }

  if (lastSubResourceIdx >= 0) {
    // After last sub_resource section end
    insertAt = findSectionEnd(lines, lastSubResourceIdx);
  } else if (firstNodeIdx >= 0) {
    // Before first node section
    insertAt = firstNodeIdx;
  } else {
    // Append at end
    insertAt = lines.length;
  }

  const sectionLines = [headerLine, ...propLines];
  lines.splice(insertAt, 0, ...sectionLines);

  // 4. Update load_steps
  incrementLoadSteps(lines);

  return {
    success: true,
    message: `Added sub_resource type="${type}" id="${newId}"`,
    id: newId,
    scene: lines.join('\n'),
  };
}

// ── addNode ──────────────────────────────────────────────────────────────────

export interface AddNodeParams {
  parent: string;     // "." for root children, or node path like "Player"
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface AddNodeResult {
  success: boolean;
  message: string;
  fallback: boolean;  // true = needs Godot process (unsupported property types)
  scene?: string;
}

/**
 * Check whether a property value can be safely serialized to .tscn text.
 * Returns true for primitives and flat objects with only primitive values.
 * Returns false for arrays and objects with nested objects.
 */
export function canSerializeProperty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) {
    return value.every(v =>
      v === null || v === undefined ||
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (typeof v === 'object' && v !== null) return false;
    }
    return true;
  }
  return false;
}

/**
 * Format a property value for .tscn serialization.
 * - string → auto-quoted via formatTscnValue
 * - number → unquoted string
 * - boolean → true/false (unquoted)
 * - null/undefined → null
 * - Array of primitives → [v1, v2, ...]
 * - Object with _type → uses _type as constructor name
 * - Plain object with r,g,b → Color(r, g, b, a)
 * - Plain object with x,y,w,h (no z) → Rect2(x, y, w, h)
 * - Plain object with x,y,z → Vector3(x, y, z)
 * - Plain object with x,y → Vector2(x, y)
 * - Other objects → JSON stringified and auto-quoted
 */
export function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return formatTscnValue(value);
  if (Array.isArray(value)) {
    const items = value.map(v => formatPropertyValue(v)).join(', ');
    return `[${items}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    // _type explicit override — always wins
    if (obj._type && typeof obj._type === 'string') {
      const t = obj._type;
      if (t === 'Rect2' || t === 'Rect2i') {
        return `${t}(${obj.x ?? 0}, ${obj.y ?? 0}, ${obj.w ?? 0}, ${obj.h ?? 0})`;
      }
      if (t === 'Vector2' || t === 'Vector2i' || t === 'Vector3' || t === 'Vector3i') {
        const args = t.startsWith('Vector3') ? [obj.x, obj.y, obj.z] : [obj.x, obj.y];
        return `${t}(${args.map(a => a ?? 0).join(', ')})`;
      }
      if (t === 'Color') {
        return `Color(${obj.r ?? 1}, ${obj.g ?? 1}, ${obj.b ?? 1}, ${obj.a ?? 1})`;
      }
      // I-01: Unknown _type intentionally falls through to auto-inference.
      // Users must use a known type or rely on auto-detection.
      // Unknown _type
    }
    // Color: has r, g, b
    if (keys.includes('r') && keys.includes('g') && keys.includes('b')
      && typeof obj.r === 'number' && typeof obj.g === 'number' && typeof obj.b === 'number') {
      const a = typeof obj.a === 'number' ? obj.a : 1;
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
    }
    // Rect2: has x, y, w, h
    if (keys.includes('x') && keys.includes('y') && keys.includes('w') && keys.includes('h')) {
      return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
    }
    // Vector3: has x, y, z
    if (keys.includes('x') && keys.includes('y') && keys.includes('z')
      && typeof obj.x === 'number' && typeof obj.y === 'number' && typeof obj.z === 'number') {
      return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
    }
    // Vector2: has x, y
    if (keys.includes('x') && keys.includes('y')
      && typeof obj.x === 'number' && typeof obj.y === 'number') {
      return `Vector2(${obj.x}, ${obj.y})`;
    }
    // C-02: Strip _type from fallback to avoid leaking meta-field into .tscn
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _type: _ignored, ...sanitized } = obj;
    return formatTscnValue(JSON.stringify(sanitized));
  }
  // Other types — should not reach here if canSerializeProperty was called
  return formatTscnValue(String(value));
}

/**
 * Find a node section line by name only (ignoring parent path).
 * Used by addNode to locate the parent node, since the parent param
 * is just a name like "Player", not a full path.
 * For "." parent, returns the root node (first node without parent attr or with parent=".").
 */
function findNodeByName(lines: string[], nodeName: string): number {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;
    const name = getBracketAttr(trimmed, 'name');
    if (name === nodeName) return i;
  }
  return -1;
}

/**
 * Find the insertion line index for a new child of `targetParent`.
 *
 * In .tscn files, nodes are in depth-first order. A new child of "Player"
 * must be placed AFTER all of Player's descendants (Player/Sprite,
 * Player/Sprite/Anim, etc.), not just after Player's own section.
 *
 * Algorithm:
 * 1. Find the target parent node section.
 * 2. Scan forward from the parent section.
 * 3. For each subsequent [node] section, check if its parent attribute
 *    matches the target parent OR starts with targetParent + "/".
 * 4. If yes → it's a descendant, continue scanning.
 * 5. If no → this is the insertion point (the line before this section).
 * 6. If we reach the end of file, insert there.
 */
function findLastDescendantLine(lines: string[], parentNodeLine: number, tscnParent: string): number {
  let lastDescendantEnd = nodeSectionEnd(lines, parentNodeLine);

  for (let i = parentNodeLine + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;

    // Get parent attribute from this node
    const parentAttr = getBracketAttr(trimmed, 'parent');

    // Also check property lines for parent
    let effectiveParent = parentAttr;
    if (effectiveParent === null) {
      const end = findSectionEnd(lines, i);
      for (let j = i + 1; j < end; j++) {
        const pl = lines[j]!.trim();
        if (pl.startsWith('parent = ') || pl.startsWith('parent=')) {
          effectiveParent = pl.replace(/^parent\s*=\s*/, '').replace(/"/g, '').trim();
          break;
        }
      }
    }

    // Check if this node is a descendant of the target parent
    // For root children (tscnParent="."), descendants have parent="." or parent="ChildOfParent/..."
    // For non-root (tscnParent="Player"), descendants have parent="Player" or parent="Player/..."
    const isDescendant = effectiveParent === tscnParent ||
      (effectiveParent !== null && effectiveParent.startsWith(tscnParent + '/'));

    if (isDescendant) {
      lastDescendantEnd = nodeSectionEnd(lines, i);
    } else {
      // Not a descendant — insertion point found
      return lastDescendantEnd;
    }
  }

  return lastDescendantEnd;
}

/**
 * Add a node to a .tscn scene with property type whitelist and auto-fallback.
 *
 * If any property value cannot be serialized to .tscn text (arrays, nested objects),
 * returns `{ success: true, fallback: true }` without modifying the file,
 * signaling that a Godot process should handle the insertion instead.
 *
 * The node is inserted after the last descendant of the parent node,
 * preserving .tscn depth-first ordering.
 */
export function addNode(
  tscnContent: string,
  params: AddNodeParams,
): AddNodeResult {
  try {
  return _addNodeInner(tscnContent, params);
  } catch (err) {
    return { success: false, message: `tscn-editor error: ${err instanceof Error ? err.message : String(err)}`, fallback: false };
  }
}

function _addNodeInner(
  tscnContent: string,
  params: AddNodeParams,
): AddNodeResult {
  const { parent, name, type, properties } = params;

  // 1. Validate name and type
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return { success: false, message: `Invalid node name: ${name}`, fallback: false };
  }
  if (!/^[A-Za-z0-9_]+$/.test(type)) {
    return { success: false, message: `Invalid node type: ${type}`, fallback: false };
  }

  // 2. Check all properties via canSerializeProperty
  if (properties) {
    for (const value of Object.values(properties)) {
      if (!canSerializeProperty(value)) {
        return {
          success: true,
          fallback: true,
          message: `Unsupported property type for node ${name}, requires Godot process`,
        };
      }
    }
  }

  const lines = normalizeLines(tscnContent);

  // 3. Determine tscn parent attribute
  const tscnParent = parent;

  // 4. Find parent node section
  let parentNodeLine = -1;

  if (parent === '.') {
    // Adding as root child — find the root node (no parent attr or parent=".")
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (!trimmed.startsWith('[node')) continue;
      const p = getBracketAttr(trimmed, 'parent');
      if (p === null || p === '' || p === '.') {
        parentNodeLine = i;
        break;
      }
    }
  } else {
    // C-03: Find parent node by name, preferring path-aware match when parent contains "/".
    // For simple names (e.g. "Player"), fall back to name-only search.
    // For paths (e.g. "Level/Player"), use findNodeSectionLine which matches name+parent.
    if (parent.includes('/')) {
      parentNodeLine = findNodeSectionLine(lines, parent);
    } else {
      parentNodeLine = findNodeByName(lines, parent);
    }
  }

  if (parentNodeLine === -1) {
    return { success: false, message: `Parent node not found: ${parent}`, fallback: false };
  }

  // 5. Find insertion point: after the last descendant of the parent
  const insertAfter = findLastDescendantLine(lines, parentNodeLine, tscnParent);

  // 6. Build [node] section
  const nodeLines: string[] = [];

  // Header line
  if (tscnParent === '.') {
    nodeLines.push(`[node name="${escapeTscnAttr(name)}" type="${escapeTscnAttr(type)}" parent="."]`);
  } else {
    nodeLines.push(`[node name="${escapeTscnAttr(name)}" type="${escapeTscnAttr(type)}" parent="${escapeTscnAttr(tscnParent)}"]`);
  }

  // Property lines
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      nodeLines.push(`${key} = ${formatPropertyValue(value)}`);
    }
  }

  // 7. Insert after last descendant (add blank line separator before new node)
  nodeLines.unshift(''); // blank line before the new node
  lines.splice(insertAfter + 1, 0, ...nodeLines);

  // 8. Update load_steps (+1)
  incrementLoadSteps(lines);

  return {
    success: true,
    fallback: false,
    message: `Added node ${name} (type=${type}) as child of ${parent}`,
    scene: lines.join('\n'),
  };
}

// ── addNodes (batch) ────────────────────────────────────────────────────────

/**
 * Add multiple nodes to a .tscn scene in one pass.
 *
 * 1. Empty array → immediate success, no changes.
 * 2. If ANY node has unsupported property types → returns fallback=true
 *    so the caller can fall through to the Godot-process path.
 * 3. Otherwise processes each node sequentially, threading the scene content
 *    through each addNode call.
 */
export function addNodes(
  tscnContent: string,
  nodes: Array<AddNodeParams>,
): AddNodeResult {
  try {
  return _addNodesInner(tscnContent, nodes);
  } catch (err) {
    return { success: false, message: `tscn-editor error: ${err instanceof Error ? err.message : String(err)}`, fallback: false };
  }
}

function _addNodesInner(
  tscnContent: string,
  nodes: Array<AddNodeParams>,
): AddNodeResult {
  if (nodes.length === 0) {
    return { success: true, fallback: false, scene: tscnContent, message: 'No nodes to add' };
  }

  // Pre-check: if any node has unsupported properties, fall back entirely
  for (const node of nodes) {
    if (node.properties) {
      for (const value of Object.values(node.properties)) {
        if (!canSerializeProperty(value)) {
          return {
            success: true,
            fallback: true,
            message: `Unsupported property type in node ${node.name}, requires Godot process`,
          };
        }
      }
    }
  }

  // Process sequentially, threading content
  let content = tscnContent;
  for (const node of nodes) {
    const result = addNode(content, node);
    if (!result.success) {
      return result;
    }
    if (result.scene) {
      content = result.scene;
    }
  }

  return {
    success: true,
    fallback: false,
    message: `Added ${nodes.length} node(s)`,
    scene: content,
  };
}