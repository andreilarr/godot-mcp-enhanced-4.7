// src/tscn-editor-detach.ts — Detach instance (inline subtree) from .tscn scene files
//
// I-10: Non-null assertions (!) on regex match groups are guarded by preceding
// `if (match)` checks — see tscn-parser.ts header for the full rationale.

import {
  normalizeLines,
  findSectionEnd,
  escapeTscnAttr,
  escapeRegExp,
  getBracketAttr,
} from './tscn-editor-shared.js';

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
