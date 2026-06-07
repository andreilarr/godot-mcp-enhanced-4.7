// .tscn merge conflict resolver and scene health check.

export function mergeTscn(ours: string, theirs: string): string {
  // Parse ext_resources from both sides
  interface ExtRes { type: string; path: string; originalId: string; line: string }
  const parseExt = (content: string): ExtRes[] => {
    const result: ExtRes[] = [];
    let m: RegExpExecArray | null;
    const regex = /\[ext_resource\s+([^[\]]+)\]/g;
    while ((m = regex.exec(content)) !== null) {
      const line = m[1]!;
      const typeMatch = line.match(/type="([^"]+)"/);
      const pathMatch = line.match(/path="([^"]+)"/);
      const idMatch = line.match(/id="([^"]+)"/);
      if (pathMatch) {
        result.push({ type: typeMatch?.[1] ?? '', path: pathMatch[1]!, originalId: idMatch?.[1] ?? '', line: m[0] });
      }
    }
    return result;
  };

  // Parse sub_resources from both sides
  interface SubRes { type: string; originalId: string; body: string }
  const parseSub = (content: string): SubRes[] => {
    const result: SubRes[] = [];
    const regex = /\[sub_resource\s+type="([^"]+)"\s+id="([^"]+)"\]([\s\S]*?)(?=\n\[sub_resource|\n\[node|\n\[ext_resource|$)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      result.push({ type: m[1]!, originalId: m[2]!, body: m[3]!.trim() });
    }
    return result;
  };

  // Parse nodes from both sides
  // C-02: include parent in NodeDef for correct dedup (same name under different parents is valid)
  interface NodeDef { name: string; parent: string; line: string; body: string }
  const parseNodes = (content: string): NodeDef[] => {
    const result: NodeDef[] = [];
    const sections = content.split(/\n(?=\[node\s)/);
    for (const section of sections) {
      const headerMatch = section.match(/^\[node\s+name="([^"]+)"/);
      if (headerMatch) {
        const parentMatch = section.match(/parent="([^"]*)"/);
        const parent = parentMatch ? parentMatch[1]! : '.';
        result.push({ name: headerMatch[1]!, parent, line: headerMatch[0], body: section.trim() });
      }
    }
    return result;
  };

  // Get header (before first ext_resource or sub_resource or node)
  const headerMatch = ours.match(/^([\s\S]*?)(?=\n\[ext_resource|\n\[sub_resource|\n\[node)/);
  const header = headerMatch ? headerMatch[1]!.trim() : '[gd_scene format=3]';

  // Merge ext_resources: ours first, then new from theirs (by path dedup)
  const oursExt = parseExt(ours);
  const theirsExt = parseExt(theirs);
  const seenPaths = new Set(oursExt.map(e => e.path));
  const mergedExt = [...oursExt];
  for (const ext of theirsExt) {
    if (!seenPaths.has(ext.path)) {
      mergedExt.push(ext);
      seenPaths.add(ext.path);
    }
  }

  // Merge sub_resources: ours first, then new from theirs (by type+body signature dedup)
  const oursSub = parseSub(ours);
  const theirsSub = parseSub(theirs);
  const subSignature = (s: SubRes) => `${s.type}::${s.body}`;
  const seenSubSigs = new Set(oursSub.map(s => subSignature(s)));
  const mergedSub = [...oursSub];
  for (const sub of theirsSub) {
    if (!seenSubSigs.has(subSignature(sub))) {
      mergedSub.push(sub);
    }
  }

  // ID assignment: preserve originals, remap only on collision
  const usedIds = new Set<string>();
  oursExt.forEach(e => { if (e.originalId) usedIds.add(e.originalId); });
  oursSub.forEach(s => { if (s.originalId) usedIds.add(s.originalId); });

  const allocateId = (originalId: string, isOurs: boolean): string => {
    if (isOurs || !usedIds.has(originalId)) {
      usedIds.add(originalId);
      return originalId;
    }
    if (/^\d+$/.test(originalId)) {
      const maxNum = [...usedIds].filter(id => /^\d+$/.test(id)).reduce((max, id) => Math.max(max, parseInt(id)), 0);
      const newId = String(maxNum + 1);
      usedIds.add(newId);
      return newId;
    }
    let seq = 1;
    let candidate = `${originalId}_m${seq}`;
    while (usedIds.has(candidate)) {
      seq++;
      candidate = `${originalId}_m${seq}`;
    }
    usedIds.add(candidate);
    return candidate;
  };

  const extIdMap: Record<string, string> = {};
  const reindexedExt: string[] = [];
  mergedExt.forEach((ext) => {
    const isOurs = oursExt.some(o => o.path === ext.path);
    const newId = allocateId(ext.originalId, isOurs);
    if (ext.originalId && ext.originalId !== newId) extIdMap[ext.originalId] = newId;
    reindexedExt.push(`[ext_resource type="${ext.type}" path="${ext.path}" id="${newId}"]`);
  });

  const subIdMap: Record<string, string> = {};
  const reindexedSub: string[] = [];
  mergedSub.forEach((sub) => {
    const isOurs = oursSub.some(o => o.type === sub.type && o.body === sub.body);
    const newId = allocateId(sub.originalId, isOurs);
    if (sub.originalId && sub.originalId !== newId) subIdMap[sub.originalId] = newId;
    reindexedSub.push(`[sub_resource type="${sub.type}" id="${newId}"]\n${sub.body}`);
  });

  const oursNodes = parseNodes(ours);
  const theirsNodes = parseNodes(theirs);
  // C-02: dedup by parent/name combo (not just name) to allow same-named nodes under different parents
  const oursNodeKeys = new Set(oursNodes.map(n => `${n.parent}/${n.name}`));
  const mergedNodes = [...oursNodes];
  for (const node of theirsNodes) {
    if (!oursNodeKeys.has(`${node.parent}/${node.name}`)) {
      mergedNodes.push(node);
    }
  }

  const parseConnections = (content: string): string[] => {
    const result: string[] = [];
    const regex = /^\[connection\s+[^\]]+\]/gm;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      result.push(m[0]);
    }
    return result;
  };

  const oursConns = parseConnections(ours);
  const theirsConns = parseConnections(theirs);
  const seenConns = new Set(oursConns);
  const mergedConns = [...oursConns];
  for (const conn of theirsConns) {
    if (!seenConns.has(conn)) {
      mergedConns.push(conn);
      seenConns.add(conn);
    }
  }

  const totalResources = mergedExt.length + mergedSub.length;
  const updatedHeader = header.replace(/load_steps=\d+/, `load_steps=${totalResources + 1}`);

  const formatOf = (content: string): string | null => {
    const m = content.match(/format=(\d+)/);
    return m ? m[1]! : null;
  };
  const fmtA = formatOf(ours);
  const fmtB = formatOf(theirs);

  const parts: string[] = [updatedHeader, ''];
  if (fmtA && fmtB && fmtA !== fmtB) {
    parts.push(`; WARNING: format mismatch — ours=${fmtA} theirs=${fmtB}`);
  }
  parts.push(...reindexedExt);
  if (reindexedSub.length > 0) {
    parts.push('');
    parts.push(...reindexedSub);
  }
  parts.push('');
  for (const node of mergedNodes) {
    let body = node.body;
    body = body.replace(/^\[connection\s+[^\]]+\]\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    if (Object.keys(extIdMap).length > 0) {
      body = body.replace(/ExtResource\("([^"]+)"\)/g, (_match, id: string) => {
        const newId = extIdMap[id];
        return newId ? `ExtResource("${newId}")` : `ExtResource("${id}")`;
      });
    }
    if (Object.keys(subIdMap).length > 0) {
      body = body.replace(/SubResource\("([^"]+)"\)/g, (_match, id: string) => {
        const newId = subIdMap[id];
        return newId ? `SubResource("${newId}")` : `SubResource("${id}")`;
      });
    }
    parts.push(body);
    parts.push('');
  }

  for (const conn of mergedConns) {
    parts.push(conn);
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Scene health check ────────────────────────────────────────────────────────

export function checkSceneHealth(
  content: string,
  scenePath: string,
): { issues: string[]; nodesChecked: number } {
  const issues: string[] = [];
  const lines = content.split('\n');

  const nodeRegex = /^\[node\s+name="([^"]+)"(?:\s+type="([^"]+)")?(?:\s+parent="([^"]*)")?\]/;
  const nodes: Array<{ name: string; type?: string; parent?: string; hasScript: boolean; line: number }> = [];

  let currentSection = '';
  let currentNode: typeof nodes[0] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    if (line.startsWith('[node ')) {
      const match = line.match(nodeRegex);
      if (match) {
        currentNode = { name: match[1]!, type: match[2], parent: match[3], hasScript: false, line: i + 1 };
        nodes.push(currentNode!);
      }
      currentSection = 'node';
      continue;
    }

    if (line.startsWith('[')) {
      currentSection = line.startsWith('[gd_') ? 'header' : 'resource';
      currentNode = null;
      continue;
    }

    if (currentNode && currentSection === 'node') {
      if (/^script\s*=/.test(line)) {
        currentNode.hasScript = true;
      }
    }
  }

  // Check 1: Self-referencing instance (circular)
  const extSceneRegex = /\[ext_resource[^[]*type="PackedScene"[^[]*path="([^"]+)"/g;
  let extMatch: RegExpExecArray | null;
  while ((extMatch = extSceneRegex.exec(content)) !== null) {
    const resPath = extMatch[1]!;
    const normalizedScene = scenePath.replace(/\\/g, '/');
    if (resPath.endsWith(normalizedScene) || normalizedScene.endsWith(resPath.replace('res://', ''))) {
      issues.push(`Circular self-reference: scene instances itself via ${resPath}`);
    }
  }

  // Check 2: Duplicate node names at same parent level
  const childrenByParent: Record<string, string[]> = {};
  for (const node of nodes) {
    const parent = node.parent || '.';
    if (!childrenByParent[parent]) childrenByParent[parent] = [];
    childrenByParent[parent].push(node.name);
  }
  for (const [parent, names] of Object.entries(childrenByParent)) {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        issues.push(`Duplicate node name "${name}" under parent "${parent}"`);
      }
      seen.add(name);
    }
  }

  // Check 3: Orphan leaf nodes (no script, no children, not a built-in type)
  const builtInTypes = new Set(['Camera2D', 'Camera3D', 'CollisionShape2D', 'CollisionShape3D',
    'VisibleOnScreenNotifier2D', 'VisibleOnScreenNotifier3D', 'AudioListener2D', 'AudioListener3D']);

  for (const node of nodes) {
    const hasChildren = nodes.some(n => {
      if (!n.parent) return false;
      const expected = node.parent ? `${node.parent}/${node.name}` : node.name;
      return n.parent === expected || (node.parent === '.' && n.parent === node.name);
    });
    if (!node.hasScript && !hasChildren && node.type && !builtInTypes.has(node.type)) {
      issues.push(`Orphan node "${node.name}" (${node.type}) has no script and no children`);
    }
  }

  return { issues, nodesChecked: nodes.length };
}
