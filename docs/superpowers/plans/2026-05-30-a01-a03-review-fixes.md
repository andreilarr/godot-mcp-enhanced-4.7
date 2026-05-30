# A-01/A-03 审查修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 mergeTscn 的 format=3 ID 兼容性问题 + 为 DSL parser 添加严格输入校验

**Architecture:** A-01 改为保留原始 ID、仅碰撞时重映射（while 循环保证无二次碰撞）；A-03 在 parseE2eDsl 内部添加校验，失败返回 `_error` 命令

**Tech Stack:** TypeScript, Vitest, Godot .tscn format

---

## File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/tools/scene.ts:952-1079` | `mergeTscn` — ID 分配逻辑重写 | 修改 |
| `src/tools/workflow.ts:594-629` | `parseE2eDsl` — 添加参数校验 | 修改 |
| `src/tools/workflow.ts:214-242` | DSL 处理循环 — 识别 `_error` | 修改 |
| `test/tools/merge-scene.test.ts` | A-01 测试 — 更新 + 新增 | 修改 |
| `test/tools/e2e-dsl.test.ts` | A-03 测试 — 新增校验/边界/集成 | 修改 |

---

## Task 1: A-01 — 更新现有重编号测试的期望值

**Files:**
- Modify: `test/tools/merge-scene.test.ts:59-65`

当前测试断言所有 ext_resource ID 从 `"1"` 递增重编号。新行为是无碰撞时保留原始 ID。

- [ ] **Step 1: 更新 "应重新编号合并后的 ext_resource id" 测试**

将 `test/tools/merge-scene.test.ts` 第 59-65 行替换为：

```typescript
  it('应保留原始 ext_resource id（无碰撞时）', () => {
    const result = mergeTscn(ours, theirs);
    // ours: id="1" a.gd, id="2" b.gd — 保留
    expect(result).toContain('id="1" path="res://a.gd"');
    expect(result).toContain('id="2" path="res://b.gd"');
    // theirs: id="2" c.gd 碰撞 ours 的 id="2"，应分配新 id
    // theirs: id="3" d.gd 不碰撞，保留
    const extMatches = result.match(/\[ext_resource[^[]*id="([^"]+)"/g);
    expect(extMatches).toBeTruthy();
    const ids = extMatches!.map(m => m.match(/id="([^"]+)"/)![1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/merge-scene.test.ts`
Expected: 该测试因 mergeTscn 仍做全量重编号而失败（ID 不匹配）

---

## Task 2: A-01 — 重写 mergeTscn 的 ID 分配逻辑

**Files:**
- Modify: `src/tools/scene.ts:1025-1078`

将全量重编号改为保留原始 ID + 碰撞时重映射。

- [ ] **Step 1: 替换 ID 分配和引用重映射逻辑**

将 `src/tools/scene.ts` 中 `// Re-index: build old→new id maps`（约 1025 行）到 `return parts.join('\n');`（约 1078 行）替换为：

```typescript
  // ID assignment: preserve originals, remap only on collision
  const oursIds = new Set([
    ...oursExt.map(e => e.originalId).filter(Boolean),
    ...oursSub.map(s => s.originalId).filter(Boolean),
  ]);
  const usedIds = new Set(oursIds);

  // Helper: generate a collision-free new ID matching the type of the original
  const allocateId = (originalId: string): string => {
    if (!usedIds.has(originalId)) {
      usedIds.add(originalId);
      return originalId;
    }
    // Collision — generate new ID preserving type
    if (/^\d+$/.test(originalId)) {
      // Numeric ID: take max + 1
      const maxNum = [...usedIds].filter(id => /^\d+$/.test(id)).reduce((max, id) => Math.max(max, parseInt(id)), 0);
      const newId = String(maxNum + 1);
      usedIds.add(newId);
      return newId;
    }
    // String UID: append _m{N} with loop until free
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
    const newId = allocateId(ext.originalId);
    if (ext.originalId && ext.originalId !== newId) extIdMap[ext.originalId] = newId;
    reindexedExt.push(`[ext_resource type="${ext.type}" path="${ext.path}" id="${newId}"]`);
  });

  const subIdMap: Record<string, string> = {};
  const reindexedSub: string[] = [];
  mergedSub.forEach((sub) => {
    const newId = allocateId(sub.originalId);
    if (sub.originalId !== newId) subIdMap[sub.originalId] = newId;
    reindexedSub.push(`[sub_resource type="${sub.type}" id="${newId}"]\n${sub.body}`);
  });

  // Merge nodes: ours nodes + theirs nodes not in ours (by name)
  const oursNodes = parseNodes(ours);
  const theirsNodes = parseNodes(theirs);
  const oursNames = new Set(oursNodes.map(n => n.name));
  const mergedNodes = [...oursNodes];
  for (const node of theirsNodes) {
    if (!oursNames.has(node.name)) {
      mergedNodes.push(node);
    }
  }

  // Update header load_steps
  const totalResources = mergedExt.length + mergedSub.length;
  const updatedHeader = header.replace(/load_steps=\d+/, `load_steps=${totalResources + 1}`);

  // Detect format mismatch
  const formatOf = (content: string): string | null => {
    const m = content.match(/format=(\d+)/);
    return m ? m[1] : null;
  };
  const fmtA = formatOf(ours);
  const fmtB = formatOf(theirs);

  // Rebuild the scene file
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
    // Remap ExtResource("oldId") → ExtResource("newId") only if remapped
    if (Object.keys(extIdMap).length > 0) {
      body = body.replace(/ExtResource\("([^"]+)"\)/g, (_match, id: string) => {
        const newId = extIdMap[id];
        return newId ? `ExtResource("${newId}")` : `ExtResource("${id}")`;
      });
    }
    // Remap SubResource("oldId") → SubResource("newId") only if remapped
    if (Object.keys(subIdMap).length > 0) {
      body = body.replace(/SubResource\("([^"]+)"\)/g, (_match, id: string) => {
        const newId = subIdMap[id];
        return newId ? `SubResource("${newId}")` : `SubResource("${id}")`;
      });
    }
    parts.push(body);
    parts.push('');
  }

  return parts.join('\n');
```

- [ ] **Step 2: 运行全部 merge 测试**

Run: `npx vitest run test/tools/merge-scene.test.ts`
Expected: 所有测试 PASS（包括 Task 1 更新的测试）

---

## Task 3: A-01 — 新增碰撞 + UID + load_steps + format 测试

**Files:**
- Modify: `test/tools/merge-scene.test.ts`

- [ ] **Step 1: 添加新测试用例**

在 `test/tools/merge-scene.test.ts` 末尾（`});` 前）添加：

```typescript
  it('应处理 ID 碰撞（theirs 的 ID 已被 ours 使用）', () => {
    const a = `[gd_scene format=3]
[ext_resource type="Script" path="res://a.gd" id="1"]
[ext_resource type="Script" path="res://b.gd" id="2"]
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=3]
[ext_resource type="Script" path="res://c.gd" id="2"]
[ext_resource type="Script" path="res://d.gd" id="3"]
[node name="Root" type="Node3D"]
`;
    const result = mergeTscn(a, b);
    // a.gd 保留 id="1", b.gd 保留 id="2"
    expect(result).toContain('id="1" path="res://a.gd"');
    expect(result).toContain('id="2" path="res://b.gd"');
    // c.gd 原 id="2" 碰撞 → 分配新 id="3"
    expect(result).toContain('id="3" path="res://c.gd"');
    // d.gd 原 id="3" 碰撞（"3" 已分配给 c.gd）→ 分配 id="4"
    expect(result).toContain('id="4" path="res://d.gd"');
    // 所有 ID 唯一
    const ids = result.match(/id="(\d+)"/g);
    expect(new Set(ids).size).toBe(ids!.length);
  });

  it('应保留字符串 UID 的 sub_resource id', () => {
    const a = `[gd_scene format=3]
[sub_resource type="BoxShape3D" id="BoxShape3D_gds123"]
size = Vector3(1, 1, 1)
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=3]
[node name="Extra" type="Node3D" parent="."]
`;
    const result = mergeTscn(a, b);
    expect(result).toContain('id="BoxShape3D_gds123"');
  });

  it('应处理字符串 UID 二次碰撞（while 循环）', () => {
    const a = `[gd_scene format=3]
[sub_resource type="BoxShape3D" id="Box3D_abc"]
size = Vector3(1, 1, 1)

[sub_resource type="SphereShape3D" id="Box3D_abc_m1"]
radius = 2.0

[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=3]
[sub_resource type="BoxShape3D" id="Box3D_abc"]
size = Vector3(3, 3, 3)

[node name="Extra" type="Node3D" parent="."]
`;
    const result = mergeTscn(a, b);
    // ours 的 Box3D_abc 和 Box3D_abc_m1 保留
    expect(result).toContain('id="Box3D_abc"]');
    expect(result).toContain('id="Box3D_abc_m1"]');
    // theirs 的 Box3D_abc 碰撞 → 跳过 _m1（已占用）→ 分配 _m2
    expect(result).toContain('id="Box3D_abc_m2"]');
    expect(result).toContain('size = Vector3(3, 3, 3)');
  });

  it('应更新 header 的 load_steps', () => {
    const a = `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://a.gd" id="1"]
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://b.gd" id="2"]
[node name="Root" type="Node3D"]
`;
    const result = mergeTscn(a, b);
    // 2 ext_resources → load_steps=3
    expect(result).toContain('load_steps=3');
  });

  it('应在 format 不匹配时添加警告注释', () => {
    const a = `[gd_scene format=3]
[ext_resource type="Script" path="res://a.gd" id="1"]
[node name="Root" type="Node3D"]
`;
    const b = `[gd_scene format=2]
[ext_resource type="Script" path="res://b.gd" id="2"]
[node name="Root" type="Node3D"]
`;
    const result = mergeTscn(a, b);
    expect(result).toContain('WARNING: format mismatch');
  });
```

- [ ] **Step 2: 运行全部 merge 测试**

Run: `npx vitest run test/tools/merge-scene.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 3: 提交 A-01**

```bash
git add src/tools/scene.ts test/tools/merge-scene.test.ts
git commit -m "fix(A-01): mergeTscn 保留原始 ID + 碰撞重映射 + load_steps + format 检测

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: A-03 — 添加 DSL 校验失败测试

**Files:**
- Modify: `test/tools/e2e-dsl.test.ts`

- [ ] **Step 1: 添加校验失败 + 边界值测试**

在 `test/tools/e2e-dsl.test.ts` 末尾（最后一个 `});` 前）添加：

```typescript
  // ── Validation failure tests ──

  it('waitFor: 无效路径应返回 _error', () => {
    const result = parseE2eDsl('waitFor("abc")');
    expect(result?.method).toBe('_error');
    expect((result?.params as Record<string, unknown>)?.message).toContain('waitFor');
  });

  it('waitFor: 带连字符和点号的路径应通过', () => {
    const result = parseE2eDsl('waitFor("root/UI-Panel/node.v2")');
    expect(result?.method).toBe('wait_for_node');
  });

  it('click: 坐标越界应返回 _error', () => {
    const r1 = parseE2eDsl('click(-1, 100)');
    expect(r1?.method).toBe('_error');

    const r2 = parseE2eDsl('click(100, 10001)');
    expect(r2?.method).toBe('_error');
  });

  it('click: 边界值 0 和 10000 应通过', () => {
    const r1 = parseE2eDsl('click(0, 0)');
    expect(r1?.method).toBe('send_mouse_click');

    const r2 = parseE2eDsl('click(10000, 10000)');
    expect(r2?.method).toBe('send_mouse_click');
  });

  it('click: 无效 button 应返回 _error', () => {
    const result = parseE2eDsl('click(100, 100, "explode")');
    // "explode" 不在 allowed buttons 中，但当前正则只匹配 \w+
    // 实际校验在校验层完成
    expect(result?.method).toBe('_error');
  });

  it('press: 非法键名应返回 _error', () => {
    const result = parseE2eDsl('press("Key<Script>")');
    expect(result?.method).toBe('_error');
  });

  it('press: 空键名应返回 _error', () => {
    const result = parseE2eDsl('press("")');
    expect(result?.method).toBe('_error');
  });

  it('typeText: 控制字符应返回 _error', () => {
    const result = parseE2eDsl('typeText("hello\x00world")');
    expect(result?.method).toBe('_error');
  });

  it('typeText: 空字符串应通过', () => {
    const result = parseE2eDsl('typeText("")');
    expect(result?.method).toBe('send_text');
    expect((result?.params as Record<string, unknown>)?.text).toBe('');
  });

  it('waitMs: 越界应返回 _error', () => {
    const r1 = parseE2eDsl('waitMs(999999)');
    expect(r1?.method).toBe('_error');

    const r2 = parseE2eDsl('waitMs(-1)');
    expect(r2?.method).toBe('_error');
  });

  it('waitMs: 边界值 0 和 60000 应通过', () => {
    const r1 = parseE2eDsl('waitMs(0)');
    expect(r1?.method).toBe('_sleep');

    const r2 = parseE2eDsl('waitMs(60000)');
    expect(r2?.method).toBe('_sleep');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/e2e-dsl.test.ts`
Expected: 新增的校验测试失败（parseE2eDsl 尚无校验逻辑，返回正常命令而非 `_error`）

---

## Task 5: A-03 — 实现 parseE2eDsl 参数校验

**Files:**
- Modify: `src/tools/workflow.ts:594-629`

- [ ] **Step 1: 替换 parseE2eDsl 函数为带校验版本**

将 `src/tools/workflow.ts` 中 `export function parseE2eDsl` 整个函数（第 594-629 行）替换为：

```typescript
const DSL_ERROR = (msg: string): DslCommand => ({ method: '_error', params: { message: msg } });
const CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/; // exclude \t \n \r

export function parseE2eDsl(line: string): DslCommand | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // waitFor("path")
  const waitMatch = trimmed.match(/^waitFor\(\s*"([^"]+)"\s*\)$/);
  if (waitMatch) {
    const path = waitMatch[1];
    if (path.length > 1024) return DSL_ERROR(`waitFor: path exceeds 1024 chars (${path.length})`);
    if (CTRL_RE.test(path)) return DSL_ERROR(`waitFor: path contains control characters`);
    if (!/^root(\/[\w.\-]+)+$/.test(path)) return DSL_ERROR(`waitFor: invalid path "${path}" — must be root/X/Y format with alphanumeric, dot, or hyphen segments`);
    return { method: 'wait_for_node', params: { path } };
  }

  // click(x, y[, "button"])
  const clickMatch = trimmed.match(/^click\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*"(\w+)")?\s*\)$/);
  if (clickMatch) {
    const x = Number(clickMatch[1]);
    const y = Number(clickMatch[2]);
    const button = clickMatch[3] || 'left';
    if (x < 0 || x > 10000) return DSL_ERROR(`click: x=${x} out of range [0, 10000]`);
    if (y < 0 || y > 10000) return DSL_ERROR(`click: y=${y} out of range [0, 10000]`);
    if (!['left', 'right', 'middle'].includes(button)) return DSL_ERROR(`click: invalid button "${button}" — must be left, right, or middle`);
    return { method: 'send_mouse_click', params: { x, y, button, pressed: true } };
  }

  // press("key")
  const pressMatch = trimmed.match(/^press\(\s*"([^"]+)"\s*\)$/);
  if (pressMatch) {
    const key = pressMatch[1];
    if (!key) return DSL_ERROR(`press: empty key name`);
    if (key.length > 64) return DSL_ERROR(`press: key name exceeds 64 chars`);
    if (!/^[\w ]+$/.test(key)) return DSL_ERROR(`press: invalid key name "${key}" — only alphanumeric, underscore, space allowed`);
    return { method: 'send_key', params: { key, pressed: true } };
  }

  // typeText("text")
  const typeMatch = trimmed.match(/^typeText\(\s*"([^"]*)"\s*\)$/);
  if (typeMatch) {
    const text = typeMatch[1];
    if (text.length > 512) return DSL_ERROR(`typeText: text exceeds 512 chars (${text.length})`);
    if (CTRL_RE.test(text)) return DSL_ERROR(`typeText: text contains control characters`);
    return { method: 'send_text', params: { text } };
  }

  // waitMs(ms)
  const sleepMatch = trimmed.match(/^waitMs\(\s*(\d+)\s*\)$/);
  if (sleepMatch) {
    const ms = Number(sleepMatch[1]);
    if (ms < 0 || ms > 60000) return DSL_ERROR(`waitMs: ${ms}ms out of range [0, 60000]`);
    return { method: '_sleep', params: { ms } };
  }

  return null;
}
```

- [ ] **Step 2: 运行 DSL 测试**

Run: `npx vitest run test/tools/e2e-dsl.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 3: 提交校验逻辑**

```bash
git add src/tools/workflow.ts test/tools/e2e-dsl.test.ts
git commit -m "fix(A-03): parseE2eDsl 添加严格参数校验 + _error 返回

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: A-03 — DSL 处理循环识别 _error + 集成测试

**Files:**
- Modify: `src/tools/workflow.ts:214-215`
- Modify: `test/tools/e2e-dsl.test.ts`

- [ ] **Step 1: 修改 DSL 处理循环，识别 _error 而非当作合法 DSL**

将 `src/tools/workflow.ts` 第 214-215 行：

```typescript
      const dslCommands = nonEmptyLines.map(l => parseE2eDsl(l));
      const allDsl = nonEmptyLines.length > 0 && dslCommands.every(c => c !== null);
```

替换为：

```typescript
      const dslCommands = nonEmptyLines.map(l => parseE2eDsl(l));
      const allDsl = nonEmptyLines.length > 0 && dslCommands.every(c => c !== null && c.method !== '_error');
```

- [ ] **Step 2: 添加 _error 集成测试**

在 `test/tools/e2e-dsl.test.ts` 末尾（最后一个 `});` 前）添加：

```typescript
  // ── Integration: _error in DSL context ──

  it('含 _error 的行不应被识别为合法 DSL（allDsl=false）', () => {
    // 模拟 dev_loop 的 DSL 检测逻辑
    const codeLines = ['waitFor("invalid")', 'click(100, 200)'];
    const cmds = codeLines.map(l => parseE2eDsl(l));
    const allDsl = codeLines.length > 0 && cmds.every(c => c !== null && c.method !== '_error');
    expect(allDsl).toBe(false);
    // 第一行返回 _error，第二行正常
    expect(cmds[0]?.method).toBe('_error');
    expect(cmds[1]?.method).toBe('send_mouse_click');
  });

  it('全合法 DSL 应被识别为 allDsl=true', () => {
    const codeLines = ['waitFor("root/Player")', 'click(100, 200)', 'waitMs(500)'];
    const cmds = codeLines.map(l => parseE2eDsl(l));
    const allDsl = codeLines.length > 0 && cmds.every(c => c !== null && c.method !== '_error');
    expect(allDsl).toBe(true);
  });

  it('混合合法与非法行：非法行返回 _error，合法行正常', () => {
    const lines = ['press("Key_W")', 'waitFor("no-root")', 'typeText("ok")'];
    const cmds = lines.map(l => parseE2eDsl(l));
    expect(cmds[0]?.method).toBe('send_key');      // 合法
    expect(cmds[1]?.method).toBe('_error');          // 非法路径
    expect(cmds[2]?.method).toBe('send_text');       // 合法
  });
```

- [ ] **Step 3: 运行全部 DSL 测试**

Run: `npx vitest run test/tools/e2e-dsl.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 4: 提交 _error 集成**

```bash
git add src/tools/workflow.ts test/tools/e2e-dsl.test.ts
git commit -m "fix(A-03): DSL 处理循环识别 _error + 集成测试

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 全量验证

- [ ] **Step 1: TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: ESLint**

Run: `npx eslint src/tools/scene.ts src/tools/workflow.ts`
Expected: 0 problems

- [ ] **Step 3: 全部单元测试**

Run: `npx vitest run`
Expected: 所有测试 PASS

---

## Spec Coverage Check

| 设计需求 | 任务 |
|----------|------|
| 保留原始 ID，仅碰撞时重映射 | Task 2 |
| 数字 ID 碰撞：max+1 | Task 2 |
| 字符串 UID 碰撞：while 循环 _m{N} | Task 2 |
| 引用重映射（仅重分配的） | Task 2 |
| load_steps 更新 | Task 2 |
| format 不匹配警告 | Task 2 |
| 更新现有重编号测试 | Task 1 |
| ID 碰撞测试 | Task 3 |
| 字符串 UID 保留测试 | Task 3 |
| UID 二次碰撞测试 | Task 3 |
| load_steps 测试 | Task 3 |
| format 警告测试 | Task 3 |
| waitFor 路径校验（含 `.-` 允许） | Task 4+5 |
| click 坐标范围 + button 校验 | Task 4+5 |
| press 键名校验 | Task 4+5 |
| typeText 控制字符 + 长度 | Task 4+5 |
| waitMs 范围校验 | Task 4+5 |
| _error 返回格式 | Task 5 |
| 边界值测试 | Task 4 |
| _error 集成（多行收集） | Task 6 |
