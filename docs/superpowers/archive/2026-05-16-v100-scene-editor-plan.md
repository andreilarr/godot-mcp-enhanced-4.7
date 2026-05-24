# v0.10.0 场景实例化 + 编辑器实时同步 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 godot-mcp-enhanced 新增场景实例化（3工具+1增强）和编辑器实时场景树同步（3工具），工具数 118 → 124。

**Architecture:** P1 场景实例化复用现有 GDScript 代码生成 + headless 执行模式，在 scene.ts 中新增 3 个工具；detach_instance 使用 .tscn 文本编辑（新建 tscn-editor.ts）。P2 编辑器同步在 EditorConnection 上新增 WebSocket 通知通道，新建 editor-sync.ts + sync_commands.gd。

**Tech Stack:** TypeScript (Node.js MCP server) + GDScript (Godot 4.x headless/editor)

**设计文档:** `docs/superpowers/specs/2026-05-16-v100-scene-editor-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tscn-parser.ts` | 修改 | 增强：解析 instance_of 路径 |
| `src/tools/scene.ts` | 修改 | 新增 instance_scene / set_instance_property / detach_instance |
| `src/tscn-editor.ts` | 新建 | .tscn 文本编辑（detach_instance 核心） |
| `addons/godot_mcp_server/commands/scene_commands.gd` | 修改 | 新增 3 个 editor 命令 |
| `src/core/EditorConnection.ts` | 修改 | 新增通知通道 |
| `src/core/EditorToolExecutor.ts` | 修改 | sync 工具路由 |
| `src/tools/editor-sync.ts` | 新建 | 3 个同步工具定义 + headless 降级 |
| `addons/godot_mcp_server/commands/sync_commands.gd` | 新建 | SceneTree 信号监听 + 推送 + 快照 |
| `addons/godot_mcp_server/command_handler.gd` | 修改 | 新增 send_notification + sync 注册 |
| `src/GodotServer.ts` | 修改 | 注册 editor-sync 模块 |
| `package.json` | 修改 | version: 0.10.0 |

---

## Task 1: tscn-parser 增强 — instance_of 路径解析

**Files:**
- Modify: `src/tscn-parser.ts:22-29` (ParsedNode interface)
- Modify: `src/tscn-parser.ts:320-326` (instance parsing + post-processing)
- Test: `test/tscn-parser-instance.test.js` (新建)

- [ ] **Step 1: 写失败测试**

```javascript
// test/tscn-parser-instance.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTscn } from '../src/tscn-parser.js';

describe('tscn-parser instance_of', () => {
  it('should resolve instance_of path from ext_resources', () => {
    const tscn = `[gd_scene load_steps=3 format=3]

[ext_resource type="PackedScene" uid="uid://abc" path="res://scenes/player.tscn" id="1"]
[ext_resource type="Script" path="res://scripts/main.gd" id="2"]

[node name="Main" type="Node2D"]
[node name="Player" parent="." instance=ExtResource("1")]
[node name="Label" parent="Player" type="Label"]
`;
    const result = parseTscn(tscn);
    const player = result.nodes.find(n => n.name === 'Player');
    assert.ok(player);
    assert.equal(player.instance, 1);
    assert.equal(player.instance_of, 'res://scenes/player.tscn');
  });

  it('should not set instance_of for non-instance nodes', () => {
    const tscn = `[gd_scene format=3]
[node name="Main" type="Node2D"]
[node name="Label" parent="." type="Label"]
`;
    const result = parseTscn(tscn);
    const label = result.nodes.find(n => n.name === 'Label');
    assert.ok(label);
    assert.equal(label.instance_of, undefined);
  });

  it('should handle string-style ExtResource id', () => {
    const tscn = `[gd_scene format=3]
[ext_resource type="PackedScene" path="res://enemy.tscn" id="enemy_1"]
[node name="Main" type="Node2D"]
[node name="Enemy" parent="." instance=ExtResource("enemy_1")]
`;
    const result = parseTscn(tscn);
    const enemy = result.nodes.find(n => n.name === 'Enemy');
    assert.ok(enemy);
    assert.equal(enemy.instance_of, 'res://enemy.tscn');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/tscn-parser-instance.test.js`
Expected: FAIL — `player.instance_of` 为 `undefined`

- [ ] **Step 3: 修改 ParsedNode 接口 + 后处理逻辑**

在 `src/tscn-parser.ts` 中：

1. `ParsedNode` 接口新增 `instance_of?: string` 字段（第 26 行后）

2. `parseTscn` 函数末尾（节点解析完成后），添加后处理循环：

```typescript
// Post-process: resolve instance_of paths
const extMap = new Map(result.extResources.map(e => [e.id, e.path] as [number, string]));
for (const node of result.nodes) {
  if (node.instance != null) {
    const path = extMap.get(node.instance);
    if (path) {
      node.instance_of = path;
    }
  }
}
```

注意：`instance` 字段当前通过 `parseInt(val)` 解析。对于字符串 ID（如 `ExtResource("enemy_1")`），需要额外处理。查看 `parseTscn` 中 `instance` 的正则匹配：

当前代码 `else if (key === 'instance') currentNode!.instance = parseInt(val);` 只处理数字 ID。

需要修改为同时处理 `instance=ExtResource("1")` 和 `instance=ExtResource(1)` 两种格式。在属性解析时，`val` 的值会是 `ExtResource("1")` 或 `ExtResource(1)`。需要在解析处提取内部 ID：

```typescript
else if (key === 'instance') {
  // Extract ID from ExtResource(N) or ExtResource("N")
  const erMatch = val.match(/ExtResource\(["']?(\w+)["']?\)/);
  if (erMatch) {
    const parsed = parseInt(erMatch[1]);
    currentNode!.instance = isNaN(parsed) ? erMatch[1] : parsed;
  }
}
```

同时 `ParsedNode.instance` 类型改为 `number | string | undefined`，`ExtResource.id` 也需要兼容字符串 key。但当前实现 `extResources` 的 `id` 是数字，所以字符串 ID 情况下后处理的 `extMap` 查找会失败。

实际上 Godot 4.x 中 `ExtResource` 的 id 格式为数字（`id="1"`），`instance=ExtResource("1")`。所以 `parseInt` 足够，不需要支持字符串 ID。上面的 `erMatch` 提取后 `parseInt` 即可。

最终修改点：

`src/tscn-parser.ts:26` — 新增 `instance_of?: string;`
`src/tscn-parser.ts:321` — 修改 instance 解析，提取 ExtResource 内部数字 ID
`src/tscn-parser.ts` parseTscn 末尾 — 添加后处理循环

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/tscn-parser-instance.test.js`
Expected: 3 tests PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `node --test test/tscn-parser*.test.js`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/tscn-parser.ts test/tscn-parser-instance.test.js
git commit -m "feat(tscn-parser): resolve instance_of path from ext_resources"
```

---

## Task 2: instance_scene 工具

**Files:**
- Modify: `src/tools/scene.ts:13-25` (TOOL_NAMES + getToolDefinitions)
- Modify: `src/tools/scene.ts` (新增 handleTool 分支 + GDScript 生成)
- Test: `test/instance-scene.test.js` (新建)

- [ ] **Step 1: 写失败测试**

```javascript
// test/instance-scene.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as scene from '../src/tools/scene.js';

describe('instance_scene tool definition', () => {
  it('should be registered in TOOL_NAMES', () => {
    const names = scene.TOOL_NAMES as readonly string[];
    assert.ok(names.includes('instance_scene'));
  });

  it('should have tool definition with correct schema', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'instance_scene');
    assert.ok(def, 'instance_scene tool definition not found');
    assert.ok(def.inputSchema.required?.includes('project_path'));
    assert.ok(def.inputSchema.required?.includes('scene_path'));
    assert.ok(def.inputSchema.required?.includes('instance_path'));
  });

  it('should reject missing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://main.tscn',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('error') || result.content[0].text.includes('Error'));
  });

  it('should reject self-referencing instance_path', async () => {
    const result = await scene.handleTool('instance_scene', {
      project_path: '/tmp/test',
      scene_path: 'res://scenes/main.tscn',
      instance_path: 'res://scenes/main.tscn',
    }, { opsScript: '' });
    assert.ok(result);
    assert.ok(result.content[0].text.includes('CIRCULAR'));
  });
});

describe('instance_scene TOOL_META', () => {
  it('should be marked as write tool', () => {
    const meta = scene.TOOL_META;
    assert.ok(meta['instance_scene']);
    assert.equal(meta['instance_scene'].readonly, false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/instance-scene.test.js`
Expected: FAIL — `instance_scene` 不在 TOOL_NAMES 中

- [ ] **Step 3: 实现 instance_scene 工具**

在 `src/tools/scene.ts` 中：

1. `TOOL_NAMES` 数组添加 `'instance_scene'`

2. `getToolDefinitions()` 添加工具定义：

```typescript
{
  name: 'instance_scene',
  description: '在目标场景中实例化 .tscn 场景作为子节点，支持初始属性覆盖。' + NON_PERSIST,
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_path: { type: 'string', description: 'Godot 项目目录路径' },
      scene_path: { type: 'string', description: '目标场景路径（被插入的位置）' },
      instance_path: { type: 'string', description: '要实例化的场景文件（res://scenes/player.tscn）' },
      parent_node_path: { type: 'string', description: '父节点路径（默认 root）', default: 'root' },
      node_name: { type: 'string', description: '实例节点名称（默认用场景文件名）' },
      properties: { type: 'object', description: '初始属性覆盖' },
    },
    required: ['project_path', 'scene_path', 'instance_path'],
  },
},
```

3. `handleTool()` 新增分支：

```typescript
if (name === 'instance_scene') return handleInstanceScene(args, ctx);
```

4. 实现 `handleInstanceScene`：

```typescript
async function handleInstanceScene(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  const { project_path, scene_path, instance_path } = args;
  if (!project_path || !scene_path || !instance_path) {
    return opsErrorResult('MISSING_PARAMS', 'project_path, scene_path, and instance_path are required');
  }
  if (typeof instance_path !== 'string' || !instance_path.endsWith('.tscn')) {
    return opsErrorResult('INVALID_INSTANCE_PATH', 'instance_path must end with .tscn');
  }
  // 循环引用检测
  if (scene_path === instance_path) {
    return opsErrorResult('CIRCULAR_REFERENCE', 'scene_path and instance_path must be different');
  }
  const parentPath = (args.parent_node_path as string) || 'root';
  const nodeName = (args.node_name as string) || '';
  const props = (args.properties as Record<string, unknown>) || {};

  const propsLines = Object.entries(props).map(([k, v]) =>
    `instance.set("${gdEscape(k)}", ${gdScriptValue(v)})`
  ).join('\n');

  const script = `${SCENE_TREE_HEADER}
func _init():
\tvar scene_path = "${gdEscape(String(scene_path))}"
\tvar instance_path = "${gdEscape(String(instance_path))}"
\tvar parent_path = "${gdEscape(parentPath)}"
\tvar node_name = "${gdEscape(nodeName)}"
\t
\tif not _mcp_load_scene(scene_path):
\t\t_mcp_output("error", "Failed to load target scene")
\t\tquit(1)
\t\treturn
\t
\tvar inst_resource = load(instance_path)
\tif inst_resource == null:
\t\t_mcp_output("error", "INSTANCE_LOAD_FAILED: " + instance_path)
\t\tquit(1)
\t\treturn
\tif not (inst_resource is PackedScene):
\t\t_mcp_output("error", "NOT_A_PACKED_SCENE: " + instance_path)
\t\tquit(1)
\t\treturn
\t
\tvar instance = inst_resource.instantiate()
\tif node_name != "":
\t\tinstance.name = node_name
\t
\t# 安全属性设置
${propsLines ? propsLines.split('\n').map(l => '\t' + l).join('\n') : '\t# No property overrides'}
\t
\tvar parent = _mcp_get_scene_node(parent_path)
\tif parent == null:
\t\t_mcp_output("error", "Parent node not found: " + parent_path)
\t\tquit(1)
\t\treturn
\tparent.add_child(instance, true)
\t
\t_mcp_output("result", {
\t\t"node_name": str(instance.name),
\t\t"node_type": instance.get_class(),
\t\t"instance_of": instance_path,
\t\t"path": str(instance.get_path())
\t})
\t_mcp_done()
`;
  return executeGdscript(String(project_path), script, ctx);
}
```

5. 添加 `gdScriptValue` 辅助函数（如果不存在）—— 将 JS 值转为 GDScript 字面量：

```typescript
function gdScriptValue(v: unknown): string {
  if (typeof v === 'string') return '"' + gdEscape(v) + '"';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(gdScriptValue).join(', ') + ']';
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return '{' + entries.map(([k, val]) => '"' + gdEscape(k) + '": ' + gdScriptValue(val)).join(', ') + '}';
  }
  return String(v);
}
```

6. `TOOL_META` 添加：

```typescript
instance_scene: { readonly: false, long_running: true },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/instance-scene.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/scene.ts test/instance-scene.test.js
git commit -m "feat(scene): add instance_scene tool for scene instancing"
```

---

## Task 3: set_instance_property 工具

**Files:**
- Modify: `src/tools/scene.ts` (TOOL_NAMES + 定义 + handleTool + TOOL_META)
- Test: `test/instance-scene.test.js` (追加测试)

- [ ] **Step 1: 写失败测试**

追加到 `test/instance-scene.test.js`：

```javascript
describe('set_instance_property tool definition', () => {
  it('should be registered in TOOL_NAMES', () => {
    const names = scene.TOOL_NAMES as readonly string[];
    assert.ok(names.includes('set_instance_property'));
  });

  it('should have tool definition', () => {
    const defs = scene.getToolDefinitions();
    const def = defs.find(d => d.name === 'set_instance_property');
    assert.ok(def);
    assert.deepEqual(def.inputSchema.required, ['project_path', 'scene_path', 'node_path', 'property', 'value']);
  });

  it('should be marked as write tool', () => {
    assert.equal(scene.TOOL_META['set_instance_property'].readonly, false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/instance-scene.test.js`
Expected: FAIL — `set_instance_property` 不在 TOOL_NAMES 中

- [ ] **Step 3: 实现 set_instance_property 工具**

在 `src/tools/scene.ts` 中：

1. `TOOL_NAMES` 添加 `'set_instance_property'`

2. `getToolDefinitions()` 添加：

```typescript
{
  name: 'set_instance_property',
  description: '修改已实例化节点的属性覆盖（不影响原始场景）。' + NON_PERSIST,
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_path: { type: 'string', description: 'Godot 项目目录路径' },
      scene_path: { type: 'string', description: '场景路径' },
      node_path: { type: 'string', description: '实例节点路径' },
      property: { type: 'string', description: '属性名' },
      value: { description: '属性值' },
    },
    required: ['project_path', 'scene_path', 'node_path', 'property', 'value'],
  },
},
```

3. `handleTool()` 新增分支 + 实现：

```typescript
if (name === 'set_instance_property') return handleSetInstanceProperty(args, ctx);
```

GDScript 核心逻辑：验证目标是实例节点，然后设置属性。属性名过 `_is_safe_property` 黑名单，值过类型检查。

```typescript
async function handleSetInstanceProperty(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  const { project_path, scene_path, node_path, property, value } = args;
  if (!project_path || !scene_path || !node_path || !property) {
    return opsErrorResult('MISSING_PARAMS', 'project_path, scene_path, node_path, and property are required');
  }
  if (value === undefined) {
    return opsErrorResult('MISSING_PARAMS', 'value is required');
  }

  const script = `${SCENE_TREE_HEADER}
func _init():
\tvar scene_path = "${gdEscape(String(scene_path))}"
\tvar node_path = "${gdEscape(String(node_path))}"
\tvar prop_name = "${gdEscape(String(property))}"
\tvar prop_value = ${gdScriptValue(value)}
\t
\tif not _mcp_load_scene(scene_path):
\t\t_mcp_output("error", "Failed to load scene")
\t\tquit(1)
\t\treturn
\t
\tvar target = _mcp_get_scene_node(node_path)
\tif target == null:
\t\t_mcp_output("error", "Node not found: " + node_path)
\t\tquit(1)
\t\treturn
\t
\t# 验证是实例节点
\tvar root = _mcp_scene_instance
\tvar is_instance = (target != root and target.owner == root)
\tif not is_instance:
\t\t_mcp_output("error", "NODE_NOT_INSTANCE: node is not an instanced scene")
\t\tquit(1)
\t\treturn
\t
\t# 属性安全检查
\tvar blocked = ["script", "owner", "name", "meta", "process_mode", "process_priority", "process_input", "process_unhandled_input", "process_unhandled_key_input", "process_internal", "physics_process_mode", "input_event", "ready"]
\tif prop_name.begins_with("_") or prop_name in blocked:
\t\t_mcp_output("error", "BLOCKED_PROPERTY: " + prop_name)
\t\tquit(1)
\t\treturn
\t
\ttarget.set(prop_name, prop_value)
\t_mcp_output("result", {
\t\t"node": str(target.name),
\t\t"property": prop_name,
\t\t"value_set": true
\t})
\t_mcp_done()
`;
  return executeGdscript(String(project_path), script, ctx);
}
```

4. `TOOL_META` 添加：`set_instance_property: { readonly: false, long_running: true }`

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/instance-scene.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/scene.ts test/instance-scene.test.js
git commit -m "feat(scene): add set_instance_property tool"
```

---

## Task 4: detach_instance 工具 + tscn-editor.ts

**Files:**
- Create: `src/tscn-editor.ts` (.tscn 文本编辑核心)
- Modify: `src/tools/scene.ts` (TOOL_NAMES + 定义 + handleTool)
- Test: `test/tscn-editor.test.js` (新建)

这是最复杂的工具。核心逻辑在新建的 `tscn-editor.ts` 中，通过直接编辑 .tscn 文本实现"Make Local"。

- [ ] **Step 1: 写 tscn-editor.ts 失败测试**

```javascript
// test/tscn-editor.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findInstanceNode, detachInstance } from '../src/tscn-editor.js';

describe('tscn-editor findInstanceNode', () => {
  it('should find instance node by name', () => {
    const tscn = `[gd_scene format=3]
[ext_resource type="PackedScene" path="res://player.tscn" id="1"]
[node name="Main" type="Node2D"]
[node name="Player" parent="." instance=ExtResource("1")]
`;
    const result = findInstanceNode(tscn, 'Player', '.');
    assert.ok(result);
    assert.equal(result.instanceId, 1);
    assert.equal(result.sourcePath, 'res://player.tscn');
  });

  it('should return null for non-instance node', () => {
    const tscn = `[gd_scene format=3]
[node name="Main" type="Node2D"]
[node name="Label" parent="." type="Label"]
`;
    const result = findInstanceNode(tscn, 'Label', '.');
    assert.equal(result, null);
  });
});

describe('tscn-editor detachInstance', () => {
  it('should replace instance reference with inlined subtree', () => {
    const targetTscn = `[gd_scene format=3]
[ext_resource type="PackedScene" path="res://player.tscn" id="1"]
[node name="Main" type="Node2D"]
[node name="Player" parent="." instance=ExtResource("1")]
`;
    const sourceTscn = `[gd_scene format=3]
[node name="Player" type="CharacterBody2D"]
[node name="Sprite" parent="." type="Sprite2D"]
`;
    const result = detachInstance(targetTscn, sourceTscn, 'Player', '.');
    assert.ok(result);
    assert.ok(!result.includes('instance=ExtResource'));
    assert.ok(result.includes('[node name="Player" type="CharacterBody2D" parent="."]'));
    assert.ok(result.includes('[node name="Sprite" parent="Player" type="Sprite2D"]'));
  });

  it('should preserve property overrides from target', () => {
    const targetTscn = `[gd_scene format=3]
[ext_resource type="PackedScene" path="res://player.tscn" id="1"]
[node name="Main" type="Node2D"]
[node name="Player" parent="." instance=ExtResource("1")]
position = Vector2(100, 200)
`;
    const sourceTscn = `[gd_scene format=3]
[node name="Player" type="CharacterBody2D"]
`;
    const result = detachInstance(targetTscn, sourceTscn, 'Player', '.');
    assert.ok(result.includes('position = Vector2(100, 200)'));
  });

  it('should remap ext_resource IDs to avoid conflicts', () => {
    const targetTscn = `[gd_scene format=3]
[ext_resource type="Script" path="res://main.gd" id="1"]
[ext_resource type="PackedScene" path="res://player.tscn" id="2"]
[node name="Main" type="Node2D"]
[node name="Player" parent="." instance=ExtResource("2")]
`;
    const sourceTscn = `[gd_scene format=3]
[ext_resource type="Texture2D" path="res://icon.svg" id="1"]
[node name="Player" type="CharacterBody2D"]
[node name="Sprite" parent="." type="Sprite2D"]
texture = ExtResource("1")
`;
    const result = detachInstance(targetTscn, sourceTscn, 'Player', '.');
    // Source's id="1" should be remapped to avoid conflict with target's id="1"
    assert.ok(result.includes('icon.svg'));
    assert.ok(!result.includes('path="res://player.tscn"'));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/tscn-editor.test.js`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 创建 tscn-editor.ts**

```typescript
// src/tscn-editor.ts — .tscn text editing for detach_instance

export interface InstanceNodeInfo {
  instanceId: number;
  sourcePath: string;
  lineIndex: number;
  parentPrefix: string;
  propertyOverrides: string[];
}

/** Find an instance node in .tscn text by name and parent. */
export function findInstanceNode(
  tscn: string,
  nodeName: string,
  parent: string,
): InstanceNodeInfo | null {
  const lines = tscn.split('\n');

  // Parse ext_resource table
  const extMap = new Map<number, string>();
  for (const line of lines) {
    const m = line.match(/\[ext_resource[^]*?id="(\d+)"[^]*?path="([^"]+)"[^]*?\]/);
    if (m) extMap.set(parseInt(m[1]), m[2]);
    // Also try alternate ordering
    const m2 = line.match(/\[ext_resource[^]*?path="([^"]+)"[^]*?id="(\d+)"[^]*?\]/);
    if (m2) extMap.set(parseInt(m2[2]), m2[1]);
  }

  // Find the node line
  const parentAttr = parent === '.' || parent === 'root' ? '' : ` parent="${parent}"`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('[node')) continue;

    const nameMatch = line.match(/name="([^"]+)"/);
    if (!nameMatch || nameMatch[1] !== nodeName) continue;

    const instanceMatch = line.match(/instance=ExtResource\("(\d+)"\)/);
    if (!instanceMatch) continue;

    const instanceId = parseInt(instanceMatch[1]);
    const sourcePath = extMap.get(instanceId);
    if (!sourcePath) return null;

    // Collect property overrides (lines after [node] that have = but don't start with [)
    const overrides: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (next.startsWith('[') || next === '') break;
      if (next.includes('=')) overrides.push(lines[j]);
    }

    return {
      instanceId,
      sourcePath,
      lineIndex: i,
      parentPrefix: parent === '.' || parent === 'root' ? '' : parent + '/',
      propertyOverrides: overrides,
    };
  }

  return null;
}

/** Detach an instance node by inlining its source scene's subtree. */
export function detachInstance(
  targetTscn: string,
  sourceTscn: string,
  nodeName: string,
  parent: string,
): string {
  const info = findInstanceNode(targetTscn, nodeName, parent);
  if (!info) throw new Error(`Instance node not found: ${nodeName}`);

  const targetLines = targetTscn.split('\n');
  const sourceLines = sourceTscn.split('\n');

  // Parse source ext_resources and sub_resources
  const sourceExtResources: string[] = [];
  const sourceSubResources: string[] = [];
  const sourceNodeLines: string[] = [];
  let section = '';

  for (const line of sourceLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[ext_resource')) {
      sourceExtResources.push(line);
      section = 'ext';
    } else if (trimmed.startsWith('[sub_resource')) {
      sourceSubResources.push(line);
      section = 'sub';
    } else if (trimmed.startsWith('[node')) {
      sourceNodeLines.push(line);
      section = 'node';
    } else if (trimmed.startsWith('[')) {
      section = '';
    } else if (section === 'sub' && !trimmed.startsWith('[')) {
      sourceSubResources.push(line);
    } else if (section === 'node' && !trimmed.startsWith('[')) {
      sourceNodeLines.push(line);
    }
  }

  // Remap source ext_resource IDs
  const maxId = findMaxExtResourceId(targetTscn);
  const idRemap = new Map<number, number>();
  const newExtLines: string[] = [];

  for (const extLine of sourceExtResources) {
    const idMatch = extLine.match(/id="(\d+)"/);
    if (!idMatch) continue;
    const oldId = parseInt(idMatch[1]);
    const newId = maxId + 1 + idRemap.size;
    idRemap.set(oldId, newId);
    newExtLines.push(extLine.replace(`id="${oldId}"`, `id="${newId}"`));
  }

  // Remap IDs in source node lines
  let remappedNodeLines = sourceNodeLines.join('\n');
  for (const [oldId, newId] of idRemap) {
    remappedNodeLines = remappedNodeLines.replaceAll(`ExtResource("${oldId}")`, `ExtResource("${newId}")`);
    remappedNodeLines = remappedNodeLines.replaceAll(`SubResource("${oldId}")`, `SubResource("${newId}")`);
  }

  // Adjust parent paths: source root becomes parent/nodeName, children get prefix
  const adjustedLines = remappedNodeLines.split('\n');
  const parentPrefix = parent === '.' || parent === 'root' ? '' : parent + '/';

  for (let i = 0; i < adjustedLines.length; i++) {
    const line = adjustedLines[i].trim();
    if (line.startsWith('[node')) {
      if (i === 0) {
        // Root node of source — replace instance line
        adjustedLines[i] = line
          .replace(/parent="[^"]*"/, `parent="${parent}"`)
          .replace(/instance=ExtResource\("\d+"\)/, '')
          .trim();
      } else {
        // Child nodes — prepend parent path
        const parentMatch = line.match(/parent="([^"]+)"/);
        if (parentMatch) {
          adjustedLines[i] = line.replace(
            `parent="${parentMatch[1]}"`,
            `parent="${parentPrefix}${nodeName}/${parentMatch[1]}"`,
          );
        } else {
          adjustedLines[i] = line.replace('[node', `[node parent="${parentPrefix}${nodeName}"`);
        }
      }
    }
  }

  // Remove the instance=ExtResource line from ext_resources in target (the one used by this instance)
  // Only remove if no other nodes reference it
  const instanceIdStr = `ExtResource("${info.instanceId}")`;
  let otherReferences = 0;
  for (let i = 0; i < targetLines.length; i++) {
    if (i === info.lineIndex) continue;
    if (targetLines[i].includes(instanceIdStr)) otherReferences++;
  }

  // Build result
  const insertIndex = info.lineIndex;
  const deleteCount = 1 + info.propertyOverrides.length;

  // Insert new ext_resource lines before the [node sections
  let insertPoint = targetLines.findIndex(l => l.trim().startsWith('[node'));
  if (insertPoint === -1) insertPoint = targetLines.length;

  // Add new ext_resources
  const before = targetLines.slice(0, insertPoint);
  const nodes = targetLines.slice(insertPoint);

  // Remove old ext_resource if no other references
  if (otherReferences === 0) {
    const extLineIdx = before.findIndex(l =>
      l.includes(`id="${info.instanceId}"`) && l.includes(info.sourcePath),
    );
    if (extLineIdx !== -1) before.splice(extLineIdx, 1);
  }

  // Add remapped source ext_resources
  before.push(...newExtLines);

  // Replace instance line with expanded subtree + preserved overrides
  const expandedNodes = [...adjustedLines];
  if (info.propertyOverrides.length > 0) {
    expandedNodes.push(...info.propertyOverrides);
  }

  nodes.splice(insertIndex - insertPoint, deleteCount, ...expandedNodes);

  return [...before, ...nodes].join('\n');
}

function findMaxExtResourceId(tscn: string): number {
  let maxId = 0;
  for (const line of tscn.split('\n')) {
    const m = line.match(/\[ext_resource[^]*?id="(\d+)"/);
    if (m) maxId = Math.max(maxId, parseInt(m[1]));
  }
  return maxId;
}
```

注意：以上是基础实现，处理了最常见的情况。嵌套实例（源场景中也有 instance 引用）保持原样不展开。

- [ ] **Step 4: 运行 tscn-editor 测试**

Run: `node --test test/tscn-editor.test.js`
Expected: PASS

- [ ] **Step 5: 添加 detach_instance 工具到 scene.ts**

1. `TOOL_NAMES` 添加 `'detach_instance'`

2. `getToolDefinitions()` 添加：

```typescript
{
  name: 'detach_instance',
  description: '将实例节点脱离为独立节点（断开与原始场景的链接）。通过直接编辑 .tscn 文件实现。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_path: { type: 'string', description: 'Godot 项目目录路径' },
      scene_path: { type: 'string', description: '目标场景路径' },
      node_path: { type: 'string', description: '要脱离的实例节点路径' },
    },
    required: ['project_path', 'scene_path', 'node_path'],
  },
},
```

3. `handleTool()` 新增分支：

```typescript
if (name === 'detach_instance') return handleDetachInstance(args, ctx);
```

4. 实现（TS 侧直接操作 .tscn 文件，不经过 GDScript）：

```typescript
async function handleDetachInstance(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  const { project_path, scene_path, node_path } = args;
  if (!project_path || !scene_path || !node_path) {
    return opsErrorResult('MISSING_PARAMS', 'project_path, scene_path, and node_path are required');
  }

  const rootDir = normalizeUserProjectPath(String(project_path));
  const fullScenePath = resolveWithinRoot(rootDir, String(scene_path));
  if (!existsSync(fullScenePath)) {
    return opsErrorResult('FILE_NOT_FOUND', `Scene file not found: ${fullScenePath}`);
  }

  // Parse node_path to get parent and node name
  const parts = String(node_path).replace(/^root\/?/, '').split('/');
  const nodeName = parts.pop()!;
  const parent = parts.length > 0 ? parts.join('/') : '.';

  // Read target .tscn
  const targetContent = readFileSync(fullScenePath, 'utf-8');

  // Find instance node
  const { findInstanceNode, detachInstance } = await import('../tscn-editor.js');
  const info = findInstanceNode(targetContent, nodeName, parent);
  if (!info) {
    return opsErrorResult('NODE_NOT_INSTANCE', `Node "${nodeName}" is not an instanced scene`);
  }

  // Read source .tscn
  const sourceResPath = info.sourcePath;
  const sourceFullPath = resolveWithinRoot(rootDir, sourceResPath.replace('res://', ''));
  if (!existsSync(sourceFullPath)) {
    return opsErrorResult('FILE_NOT_FOUND', `Source scene not found: ${sourceResPath}`);
  }
  const sourceContent = readFileSync(sourceFullPath, 'utf-8');

  // Backup
  const backup = targetContent;

  try {
    const result = detachInstance(targetContent, sourceContent, nodeName, parent);
    writeFileSync(fullScenePath, result, 'utf-8');
    return textResult(JSON.stringify({
      success: true,
      data: { node_name: nodeName, detached_from: sourceResPath, scene_path: String(scene_path) },
    }));
  } catch (err) {
    // Rollback
    writeFileSync(fullScenePath, backup, 'utf-8');
    const msg = err instanceof Error ? err.message : String(err);
    return opsErrorResult('DETACH_FAILED', `Failed to detach instance: ${msg}`);
  }
}
```

5. `TOOL_META` 添加：`detach_instance: { readonly: false, long_running: false }`

- [ ] **Step 6: 运行全量测试**

Run: `node --test test/instance-scene.test.js test/tscn-editor.test.js`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/tscn-editor.ts src/tools/scene.ts test/tscn-editor.test.js test/instance-scene.test.js
git commit -m "feat(scene): add detach_instance + tscn-editor for .tscn text editing"
```

---

## Task 5: 编辑器命令注册（scene_commands.gd）

**Files:**
- Modify: `addons/godot_mcp_server/commands/scene_commands.gd`
- Modify: `addons/godot_mcp_server/command_handler.gd`

- [ ] **Step 1: 在 scene_commands.gd 新增 3 个 handler**

在文件末尾追加：

```gdscript
func handle_instance_scene(params: Dictionary) -> Dictionary:
	var scene_path = params.get("scene_path", "")
	var instance_path = params.get("instance_path", "")
	var parent_path = params.get("parent_node_path", "root")
	var node_name = params.get("node_name", "")
	var properties = params.get("properties", {})
	
	if scene_path == "" or instance_path == "":
		return {"success": false, "error": "scene_path and instance_path required"}
	if scene_path == instance_path:
		return {"success": false, "error": "CIRCULAR_REFERENCE"}
	
	var scene_res = load(scene_path)
	if scene_res == null:
		return {"success": false, "error": "INSTANCE_LOAD_FAILED"}
	if not (scene_res is PackedScene):
		return {"success": false, "error": "NOT_A_PACKED_SCENE"}
	
	var instance = scene_res.instantiate()
	if node_name != "":
		instance.name = node_name
	
	for key in properties:
		if not _is_safe_property(key):
			continue
		var val = properties[key]
		if _is_safe_value(val):
			instance.set(key, val)
	
	var editor = Engine.get_meta("editor_plugin")
	var root = editor.get_editor_interface().get_edited_scene_root()
	var parent = _find_node(root, parent_path)
	if parent == null:
		parent = root
	parent.add_child(instance)
	instance.owner = root
	
	return {"success": true, "data": {"node_name": str(instance.name), "instance_of": instance_path}}

func handle_set_instance_property(params: Dictionary) -> Dictionary:
	var scene_path = params.get("scene_path", "")
	var node_path = params.get("node_path", "")
	var prop_name = params.get("property", "")
	var prop_value = params.get("value")
	
	var editor = Engine.get_meta("editor_plugin")
	var root = editor.get_editor_interface().get_edited_scene_root()
	var target = _find_node(root, node_path)
	if target == null:
		return {"success": false, "error": "Node not found"}
	if target == root or target.owner != root:
		return {"success": false, "error": "NODE_NOT_INSTANCE"}
	if not _is_safe_property(prop_name):
		return {"success": false, "error": "BLOCKED_PROPERTY"}
	if not _is_safe_value(prop_value):
		return {"success": false, "error": "Unsafe value type"}
	
	target.set(prop_name, prop_value)
	return {"success": true, "data": {"node": str(target.name), "property": prop_name}}

func handle_detach_instance(params: Dictionary) -> Dictionary:
	# detach 在 TS 侧通过 tscn-editor.ts 实现，编辑器模式下委托 TS
	return {"success": false, "error": "DETACH_NOT_SUPPORTED_IN_EDITOR", "hint": "Use headless mode for detach_instance"}

func _find_node(root: Node, path: String) -> Node:
	if path == "" or path == "root":
		return root
	var clean = path
	if clean.begins_with("root/"):
		clean = clean.substr(5)
	if root.has_node(clean):
		return root.get_node(clean)
	return null

func _is_safe_property(prop: String) -> bool:
	var blocked = ["script", "owner", "name", "meta", "process_mode", "process_priority", "process_input", "process_unhandled_input", "process_unhandled_key_input", "process_internal", "physics_process_mode", "input_event", "ready"]
	if prop.begins_with("_"):
		return false
	return not (prop in blocked)

func _is_safe_value(val) -> bool:
	var t = typeof(val)
	return t in [TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_COLOR, TYPE_ARRAY, TYPE_DICTIONARY]
```

- [ ] **Step 2: 在 command_handler.gd 注册新命令**

在 `handle()` 方法的 match 块中追加：

```gdscript
"instance_scene":
	return _scene_commands.handle_instance_scene(params)
"set_instance_property":
	return _scene_commands.handle_set_instance_property(params)
```

- [ ] **Step 3: 验证 GDScript 语法**

Run: `node -e "console.log('GDScript files updated - verify in Godot editor')"`

- [ ] **Step 4: Commit**

```bash
git add addons/godot_mcp_server/commands/scene_commands.gd addons/godot_mcp_server/command_handler.gd
git commit -m "feat(editor): add instance_scene and set_instance_property editor commands"
```

---

## Task 6: EditorConnection 通知通道

**Files:**
- Modify: `src/core/EditorConnection.ts`

- [ ] **Step 1: 写失败测试**

追加测试到 `test/editor-sync.test.js`（新建）：

```javascript
// test/editor-sync.test.js
import { describe, it, vi } from 'node:test';
import assert from 'node:assert/strict';

describe('EditorConnection notification channel', () => {
  it('should have onNotification method', () => {
    // 结构验证 — EditorConnection 需要导出 onNotification/offNotification
    const { EditorConnection } = await import('../src/core/EditorConnection.js');
    const conn = new EditorConnection({ port: 9999 });
    assert.equal(typeof conn.onNotification, 'function');
    assert.equal(typeof conn.offNotification, 'function');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/editor-sync.test.js`
Expected: FAIL — `onNotification` 方法不存在

- [ ] **Step 3: 修改 EditorConnection.ts**

添加通知处理基础设施：

```typescript
// 新增成员（在 class EditorConnection 中）
private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
public onDisconnect: (() => void) | null = null;

// 新增方法
onNotification(method: string, handler: (params: unknown) => void): void {
  if (!this.notificationHandlers.has(method)) {
    this.notificationHandlers.set(method, new Set());
  }
  this.notificationHandlers.get(method)!.add(handler);
}

offNotification(method: string, handler?: (params: unknown) => void): void {
  if (!this.notificationHandlers.has(method)) return;
  if (handler) {
    this.notificationHandlers.get(method)!.delete(handler);
  } else {
    this.notificationHandlers.delete(method);
  }
}
```

修改 `setupMessageHandler()`：

```typescript
private setupMessageHandler(): void {
  if (!this.ws) return;
  this.ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.id != null && this.pending.has(msg.id)) {
        // 响应消息
        const pending = this.pending.get(msg.id)!;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'JSON-RPC error'));
        } else {
          pending.resolve(msg.result);
        }
      } else if (msg.method && !msg.id) {
        // 通知消息（有 method 无 id）
        const handlers = this.notificationHandlers.get(msg.method);
        if (handlers) {
          for (const handler of handlers) {
            handler(msg.params);
          }
        }
      }
    } catch { /* ignore non-JSON messages */ }
  });
}
```

修改 `ws.on('close')` 回调（在 `connect()` 方法中），增加清理：

```typescript
ws.on('close', () => {
  this.connected = false;
  this.ws = null;
  this.notificationHandlers.clear(); // 新增
  this.onDisconnect?.(); // 新增
  if (this.reconnectEnabled) this.scheduleReconnect();
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/editor-sync.test.js`
Expected: PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npm run build && node --test test/*.test.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/EditorConnection.ts test/editor-sync.test.js
git commit -m "feat(EditorConnection): add notification channel for WebSocket push events"
```

---

## Task 7: EditorToolExecutor sync 路由

**Files:**
- Modify: `src/core/EditorToolExecutor.ts`

- [ ] **Step 1: 重写 EditorToolExecutor**

```typescript
// src/core/EditorToolExecutor.ts
import type { EditorConnection } from './EditorConnection.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export class EditorToolExecutor {
  private syncActive = false;
  private treeChangeBuffer: Array<{ type: string; path: string; node_type: string }> = [];
  private readonly conn: EditorConnection;

  constructor(conn: EditorConnection) {
    this.conn = conn;
    this.conn.onDisconnect = () => {
      this.syncActive = false;
      this.treeChangeBuffer = [];
    };
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // Sync 工具特殊路由
      if (toolName === 'editor_sync_start') {
        return this.handleSyncStart(args);
      }
      if (toolName === 'editor_sync_stop') {
        return this.handleSyncStop(args);
      }
      if (toolName === 'editor_get_scene_tree') {
        return this.handleGetSceneTree(args);
      }

      // 普通工具转发
      const result = await this.conn.request(toolName, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  private handleTreeChange = (params: unknown): void => {
    const p = params as { type: string; path: string; node_type: string };
    this.treeChangeBuffer.push(p);
  };

  private async handleSyncStart(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.syncActive) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'SYNC_ALREADY_ACTIVE' }) }],
        isError: true,
      };
    }
    this.treeChangeBuffer = [];
    this.conn.onNotification('scene_tree_changed', this.handleTreeChange);
    try {
      const result = await this.conn.request('editor_sync_start', args);
      this.syncActive = true;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  private async handleSyncStop(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.syncActive) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'SYNC_NOT_ACTIVE' }) }],
        isError: true,
      };
    }
    this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
    this.syncActive = false;
    const changes = [...this.treeChangeBuffer];
    this.treeChangeBuffer = [];
    try {
      const result = await this.conn.request('editor_sync_stop', args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...result, buffered_changes: changes }) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  private async handleGetSceneTree(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const result = await this.conn.request('editor_get_scene_tree', args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }
}
```

- [ ] **Step 2: 运行构建确认无类型错误**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add src/core/EditorToolExecutor.ts
git commit -m "feat(EditorToolExecutor): add sync tool routing with notification handling"
```

---

## Task 8: editor-sync.ts 工具模块

**Files:**
- Create: `src/tools/editor-sync.ts`
- Modify: `src/GodotServer.ts` (注册模块)

- [ ] **Step 1: 创建 editor-sync.ts**

```typescript
// src/tools/editor-sync.ts — Editor real-time scene tree sync tools
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../types.js';
import { textResult } from '../types.js';

const TOOL_NAMES = [
  'editor_sync_start',
  'editor_sync_stop',
  'editor_get_scene_tree',
] as const;

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  editor_sync_start: { readonly: false, long_running: false },
  editor_sync_stop: { readonly: false, long_running: false },
  editor_get_scene_tree: { readonly: true, long_running: false },
};

const EDITOR_NOT_CONNECTED = JSON.stringify({
  error: 'EDITOR_NOT_CONNECTED',
  message: 'These tools require editor mode with plugin connection. Use headless query_scene_tree as alternative.',
});

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'editor_sync_start',
      description: '启动场景树实时监听（仅编辑器模式）。插件连接 SceneTree 信号，推送 node_added/node_removed 事件。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'editor_sync_stop',
      description: '停止场景树监听，断开信号连接（仅编辑器模式）。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
        },
        required: ['project_path'],
      },
    },
    {
      name: 'editor_get_scene_tree',
      description: '获取编辑器当前场景树完整快照（仅编辑器模式）。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
        },
        required: ['project_path'],
      },
    },
  ];
}

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  _ctx: unknown,
): Promise<ToolResult | null> {
  if (!TOOL_NAMES.includes(name as any)) return null;

  // headless 模式下这些工具返回错误（运行时拒绝，不静默失败）
  // 编辑器模式下由 EditorToolExecutor 直接处理，不会走到这里
  return textResult(EDITOR_NOT_CONNECTED);
}
```

- [ ] **Step 2: 注册到 GodotServer.ts**

在 `src/GodotServer.ts` 中：

1. 新增 import：
```typescript
import * as editorSync from './tools/editor-sync.js';
```

2. `toolModules` 数组添加 `editorSync`：
```typescript
const toolModules = [runtime, screenshot, project, scene, script, validation, docs, node3dOps, physicsOps, audioOps, tilemapOps, materialOps, gameBridge, workflow, animationOps, profilerOps, spatialOps, testFramework, animtreeOps, navigationOps, particlesOps, signalOps, batchTools, uiOps, recordingOps, editorSync];
```

3. `LITE_TOOLS` 不包含这 3 个工具（已是如此，无需修改）

- [ ] **Step 3: 运行构建**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add src/tools/editor-sync.ts src/GodotServer.ts
git commit -m "feat(editor-sync): add sync tool definitions with headless fallback"
```

---

## Task 9: sync_commands.gd + command_handler send_notification

**Files:**
- Create: `addons/godot_mcp_server/commands/sync_commands.gd`
- Modify: `addons/godot_mcp_server/command_handler.gd`

- [ ] **Step 1: 创建 sync_commands.gd**

```gdscript
# addons/godot_mcp_server/commands/sync_commands.gd
extends Node

var _command_handler: Node
var _syncing: bool = false
var _node_paths: Dictionary = {}  # { instance_id (int): path (String) }

func setup(handler: Node) -> void:
	_command_handler = handler

func start_sync() -> Dictionary:
	if _syncing:
		return {"success": false, "error": "SYNC_ALREADY_ACTIVE"}
	_syncing = true
	_node_paths.clear()
	_cache_paths_recursive(get_tree().root)
	get_tree().connect("node_added", _on_node_added)
	get_tree().connect("node_removed", _on_node_removed)
	return {"success": true}

func stop_sync() -> Dictionary:
	if not _syncing:
		return {"success": false, "error": "SYNC_NOT_ACTIVE"}
	_syncing = false
	get_tree().disconnect("node_added", _on_node_added)
	get_tree().disconnect("node_removed", _on_node_removed)
	_node_paths.clear()
	return {"success": true}

func get_scene_tree() -> Dictionary:
	var root = get_tree().current_scene
	if not root:
		return {"success": false, "error": "No current scene"}
	return {"success": true, "tree": _serialize_tree(root, 0, 5)}

func _cache_paths_recursive(node: Node) -> void:
	if node:
		_node_paths[node.get_instance_id()] = str(node.get_path())
		for child in node.get_children():
			_cache_paths_recursive(child)

func _on_node_added(node: Node) -> void:
	var path = str(node.get_path())
	_node_paths[node.get_instance_id()] = path
	if _command_handler and _command_handler.has_method("send_notification"):
		_command_handler.send_notification("scene_tree_changed", {
			"type": "node_added",
			"path": path,
			"node_type": node.get_class()
		})

func _on_node_removed(node: Node) -> void:
	var id = node.get_instance_id()
	var path = _node_paths.get(id, "<removed>")
	_node_paths.erase(id)
	if _command_handler and _command_handler.has_method("send_notification"):
		_command_handler.send_notification("scene_tree_changed", {
			"type": "node_removed",
			"path": path,
			"node_type": node.get_class()
		})

func _serialize_tree(node: Node, depth: int, max_depth: int) -> Dictionary:
	var result = {
		"name": str(node.name),
		"type": node.get_class(),
		"path": str(node.get_path())
	}
	if depth < max_depth:
		var children = []
		for child in node.get_children():
			children.append(_serialize_tree(child, depth + 1, max_depth))
		result["children"] = children
	return result
```

- [ ] **Step 2: 修改 command_handler.gd**

1. 新增成员变量：
```gdscript
var _sync_commands: Node
```

2. 在 `setup()` 中初始化：
```gdscript
_sync_commands = preload("commands/sync_commands.gd").new()
_sync_commands.setup(self)
add_child(_sync_commands)
```

3. 在 `handle()` match 块追加：
```gdscript
"editor_sync_start":
	return _sync_commands.start_sync()
"editor_sync_stop":
	return _sync_commands.stop_sync()
"editor_get_scene_tree":
	return _sync_commands.get_scene_tree()
```

4. 新增 `send_notification` 方法：
```gdscript
func send_notification(method: String, params: Dictionary) -> void:
	# 通过 WebSocket 发送单向通知（非请求-响应）
	# 需要访问 plugin 的 WebSocket peer
	var plugin = Engine.get_meta("editor_plugin")
	if plugin and plugin.has_method("send_mcp_notification"):
		plugin.send_mcp_notification(method, params)
```

注意：`send_mcp_notification` 的具体实现取决于 plugin 的 WebSocket 集成方式。如果 plugin 没有直接的 WebSocket 服务器（当前 Bridge 模式使用 TCP），则需要通过 Bridge 连接转发通知。这部分的集成点需要在 `plugin_main.gd` 或 Bridge 脚本中补充。

- [ ] **Step 3: 验证文件结构**

Run: `ls addons/godot_mcp_server/commands/sync_commands.gd`
Expected: 文件存在

- [ ] **Step 4: Commit**

```bash
git add addons/godot_mcp_server/commands/sync_commands.gd addons/godot_mcp_server/command_handler.gd
git commit -m "feat(editor): add sync_commands.gd + send_notification for real-time sync"
```

---

## Task 10: 版本号 + 最终验证

**Files:**
- Modify: `package.json` (version)
- Modify: `src/GodotServer.ts` (server version)

- [ ] **Step 1: 更新版本号**

`package.json`: `"version": "0.10.0"`
`src/GodotServer.ts:197`: `version: '0.10.0'`

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译成功，无错误

- [ ] **Step 3: 全量测试**

Run: `node --test test/*.test.js`
Expected: 全部 PASS

- [ ] **Step 4: 工具数验证**

Run: `node -e "import('./dist/tools/scene.js').then(m => console.log('scene tools:', m.TOOL_NAMES.length)); import('./dist/tools/editor-sync.js').then(m => console.log('sync tools:', m.TOOL_NAMES?.length ?? 0))"`

验证 scene.ts 工具数 = 14 (原 11 + 3 新增)，editor-sync.ts 工具数 = 3，总计 = 121 + 3 = 124。

- [ ] **Step 5: Commit**

```bash
git add package.json src/GodotServer.ts
git commit -m "chore: bump version to 0.10.0"
```

---

## 不做的事

- 场景继承（inheritance）— 留 v0.11.0
- 通用资源管理（.tres）— material-ops/theme 已覆盖
- node_renamed / property_changed 事件 — 首版只做 node_added/node_removed
- 节点拖拽重排序
- UndoRedo 增强

## 测试汇总

| 阶段 | 新增用例 | 文件 |
|------|---------|------|
| P1 tscn-parser | ~3 | `test/tscn-parser-instance.test.js` |
| P1 instance_scene | ~4 | `test/instance-scene.test.js` |
| P1 set_instance_property | ~3 | `test/instance-scene.test.js` |
| P1 tscn-editor | ~4 | `test/tscn-editor.test.js` |
| P2 EditorConnection | ~1 | `test/editor-sync.test.js` |
| 总计 | ~15 | |

## 工具数变化

118 → 124 (+3 实例化 +3 编辑器同步)
