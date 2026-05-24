# v0.14.0 质量加固 + IK 框架 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全核心模块测试、安全加固、新增 IK 框架工具集 MVP、GitHub Actions CI

**Architecture:** 复用现有 node_create_3d 模式（白名单 + validateIdentifier）构建 IK 工具模块；安全加固在 shared.ts 添加边界校验；测试沿用 uvu + test/helpers/tool-context.js mock 框架

**Tech Stack:** TypeScript, uvu test runner, GitHub Actions, Godot 4.6 IK API

**Design Spec:** `docs/superpowers/specs/2026-05-23-v0140-quality-and-ik-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/tools/shared.ts` | Modify | 添加 validateIdentifier 长度限制、validateTimeout 函数 |
| `src/tools/ik-tools.ts` | Create | IK 工具集：创建、读取、设置、骨骼列表 |
| `src/tools/script.ts` | Modify | timeout 参数使用 validateTimeout |
| `src/GodotServer.ts` | Modify | 注册 ik-tools 模块 |
| `test/shared.test.js` | Modify | 新增 validateIdentifier 长度测试、validateTimeout 测试 |
| `test/script.test.js` | Modify | 新增 timeout 边界测试 |
| `test/ik-tools.test.js` | Create | IK 工具集单元测试 |
| `test/tscn-parser.test.js` | Modify | 新增 parent="." 多层嵌套、空场景、unique_id、instance 测试 |
| `.github/workflows/ci.yml` | Create | CI 工作流 |
| `package.json` | Modify | 版本号更新 |

---

### Task 1: validateIdentifier 长度限制

**Files:**
- Modify: `src/tools/shared.ts`
- Modify: `test/shared.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/shared.test.js` 末尾追加：

```javascript
describe('validateIdentifier length limit', () => {
  it('rejects names longer than 64 characters', () => {
    const longName = 'a'.repeat(65);
    assert.throws(() => validateIdentifier(longName), /must be 1-64 characters/);
  });
  it('accepts names exactly 64 characters', () => {
    const name64 = 'a'.repeat(64);
    assert.doesNotThrow(() => validateIdentifier(name64));
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx uvu test shared.test.js`
Expected: FAIL — `validateIdentifier` currently accepts any length

- [ ] **Step 3: 实现**

在 `src/tools/shared.ts` 的 `validateIdentifier` 函数中，在现有正则校验之后添加长度校验：

```typescript
export function validateIdentifier(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error('Identifier must be a non-empty string');
  }
  if (name.length > 64) {
    throw new Error(`Identifier "${name.slice(0, 20)}..." must be 1-64 characters (got ${name.length})`);
  }
  if (!/^[a-zA-Z_]\w*$/.test(name)) {
    throw new Error(`Invalid identifier: "${name}". Must start with letter/underscore, contain only alphanumeric/underscore`);
  }
  return name;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx uvu test shared.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/shared.ts test/shared.test.js
git commit -m "feat: add validateIdentifier length limit (max 64 chars)"
```

---

### Task 2: script.ts timeout 边界校验

**Files:**
- Modify: `src/tools/shared.ts`
- Modify: `src/tools/script.ts`
- Modify: `test/shared.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/shared.test.js` 追加：

```javascript
describe('validateTimeout', () => {
  it('clamps timeout to [5, 120] range', () => {
    const { validateTimeout } = await import('../build/tools/shared.js');
    assert.strictEqual(validateTimeout(0), 5);
    assert.strictEqual(validateTimeout(200), 120);
    assert.strictEqual(validateTimeout(30), 30);
  });
  it('returns default for undefined', () => {
    const { validateTimeout } = await import('../build/tools/shared.js');
    assert.strictEqual(validateTimeout(undefined), 30);
  });
});
```

> 注意: uvu 不支持顶层 await，需要调整为同步导入或使用 import 导入。由于 shared.test.js 顶部已有 `import { validateIdentifier } from '../build/tools/shared.js'`，直接在该 import 中添加 `validateTimeout`。

实际代码：在 `test/shared.test.js` 顶部 import 行添加 `validateTimeout`，然后追加测试：

```javascript
import {
  validateIdentifier,
  validateTimeout,
  // ... 其他已有导入
} from '../build/tools/shared.js';

// ... 在文件末尾追加
describe('validateTimeout', () => {
  it('clamps timeout to [5, 120] range', () => {
    assert.strictEqual(validateTimeout(0), 5);
    assert.strictEqual(validateTimeout(200), 120);
    assert.strictEqual(validateTimeout(30), 30);
  });
  it('returns default for undefined', () => {
    assert.strictEqual(validateTimeout(undefined), 30);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx uvu test shared.test.js`
Expected: FAIL — `validateTimeout` not yet exported

- [ ] **Step 3: 实现 validateTimeout**

在 `src/tools/shared.ts` 添加：

```typescript
export function validateTimeout(value: unknown, min = 5, max = 120, defaultVal = 30): number {
  if (value === undefined || value === null) return defaultVal;
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultVal;
  return Math.min(max, Math.max(min, Math.round(num)));
}
```

- [ ] **Step 4: 在 script.ts 中使用**

在 `src/tools/script.ts` 中，找到 timeout 参数处理位置，替换为：

```typescript
const timeout = validateTimeout(args.timeout);
```

确保 import 中添加 `validateTimeout`。

- [ ] **Step 5: 运行测试验证通过**

Run: `npx uvu test shared.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/tools/shared.ts src/tools/script.ts test/shared.test.js
git commit -m "feat: add validateTimeout boundary check [5, 120]s for script tools"
```

---

### Task 3: tscn-parser 边缘用例测试

**Files:**
- Modify: `test/tscn-parser.test.js`

- [ ] **Step 1: 写测试**

在 `test/tscn-parser.test.js` 的 `describe('parseTscn')` 块内追加：

```javascript
  it('handles parent="." multi-level nesting', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Node3D"]

[node name="Child" type="Node3D" parent="."]

[node name="GrandChild" type="Node3D" parent="Child"]
`;
    const result = parseTscn(content);
    assert.strictEqual(result.nodes.length, 3);
    assert.strictEqual(result.nodes[0].name, 'Root');
    assert.strictEqual(result.nodes[0].children.length, 1);
    assert.strictEqual(result.nodes[0].children[0].name, 'Child');
    assert.strictEqual(result.nodes[0].children[0].children.length, 1);
    assert.strictEqual(result.nodes[0].children[0].children[0].name, 'GrandChild');
  });

  it('parses instance ExtResource references', () => {
    const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://player.tscn" id="1"]

[node name="Player" parent="." instance=ExtResource("1")]
`;
    const result = parseTscn(content);
    assert.strictEqual(result.nodes[0].instance, 1);
    assert.strictEqual(result.nodes[0].instance_of, 'res://player.tscn');
  });

  it('handles connections', () => {
    const content = `[gd_scene load_steps=1 format=3]

[node name="Root" type="Node"]

[connection signal="pressed" from="Root/Button" to="Root" method="_on_pressed"]
`;
    const result = parseTscn(content);
    assert.strictEqual(result.connections.length, 1);
    assert.strictEqual(result.connections[0].signal, 'pressed');
    assert.strictEqual(result.connections[0].from, 'Root/Button');
    assert.strictEqual(result.connections[0].to, 'Root');
    assert.strictEqual(result.connections[0].method, '_on_pressed');
  });
```

- [ ] **Step 2: 运行测试验证通过**

Run: `npx uvu test tscn-parser.test.js`
Expected: PASS（parent="." 修复已在 v0.13.0 中完成）

- [ ] **Step 3: 提交**

```bash
git add test/tscn-parser.test.js
git commit -m "test: add tscn-parser edge cases (multi-level nesting, instance, connections)"
```

---

### Task 4: IK 工具模块

**Files:**
- Create: `src/tools/ik-tools.ts`
- Modify: `src/GodotServer.ts`

- [ ] **Step 1: 创建 ik-tools.ts**

```typescript
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import {
  SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult,
  gdEscape, normalizeNodePath, validateIdentifier, validateVector3,
} from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_PROPERTY: 'INVALID_PROPERTY',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

/** Concrete IK types that can be instantiated */
const IK_TYPE_WHITELIST = [
  'TwoBoneIK3D',
  'FABRIK3D',
  'CCDIK3D',
  'SplineIK3D',
  'JacobianIK3D',
] as const;

/** Properties allowed in ik_modifier_set */
const IK_SETTABLE_PROPS = [
  'active', 'influence', 'bone_name', 'target_nodepath',
  'use_magnet', 'magnet_position',
] as const;

export const TOOL_NAMES = [
  'ik_modifier_create',
  'ik_modifier_get',
  'ik_modifier_set',
  'ik_list_bones',
] as const;

// ─── GDScript Generators ───────────────────────────────────────────────────

export function genIkCreateScript(
  type: string, name: string, parent: string,
  position?: { x: number; y: number; z: number },
  boneName?: string, targetNodepath?: string,
): string {
  const posLine = position
    ? `\n\tik_node.position = Vector3(${position.x}, ${position.y}, ${position.z})`
    : '';
  const boneLine = boneName
    ? `\n\tik_node.bone_name = "${gdEscape(boneName)}"`
    : '';
  const targetLine = targetNodepath
    ? `\n\tik_node.target_nodepath = NodePath("${gdEscape(targetNodepath)}")`
    : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar ik_node = ${type}.new()
\tik_node.name = "${gdEscape(name)}"${posLine}${boneLine}${targetLine}
\tvar parent_node = _mcp_get_node("${gdEscape(parent)}")
\tif parent_node == null:
\t\t_mcp_output("error", "Parent not found: ${gdEscape(parent)}")
\t\t_mcp_done()
\t\treturn
\tparent_node.add_child(ik_node)
\tik_node.owner = root
\t_mcp_output("created", true)
\t_mcp_output("path", str(ik_node.get_path()))
\t_mcp_output("type", "${type}")
\t_mcp_done()
`;
}

export function genIkGetScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar ik_node = _mcp_get_node("${gdEscape(nodePath)}")
\tif ik_node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\t_mcp_output("type", ik_node.get_class())
\t_mcp_output("active", ik_node.active)
\t_mcp_output("influence", ik_node.influence)
\tif ik_node.has_method("get_bone_name"):
\t\t_mcp_output("bone_name", str(ik_node.bone_name))
\t\t_mcp_output("target_nodepath", str(ik_node.target_nodepath))
\t\t_mcp_output("use_magnet", ik_node.use_magnet)
\t\tvar mag = ik_node.magnet_position
\t\t_mcp_output("magnet_position", {"x": mag.x, "y": mag.y, "z": mag.z})
\tvar skeleton = ik_node.get_parent()
\tif skeleton is Skeleton3D:
\t\t_mcp_output("skeleton_path", str(skeleton.get_path()))
\t_mcp_done()
`;
}

export function genIkSetScript(nodePath: string, props: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`${SCENE_TREE_HEADER}`);
  lines.push(`func _initialize():`);
  lines.push(`\t_mcp_load_main_scene()`);
  lines.push(`\tvar ik_node = _mcp_get_node("${gdEscape(nodePath)}")`);
  lines.push(`\tif ik_node == null:`);
  lines.push(`\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")`);
  lines.push(`\t\t_mcp_done()`);
  lines.push(`\t\treturn`);

  for (const [key, val] of Object.entries(props)) {
    if (key === 'active') {
      lines.push(`\tik_node.active = ${val}`);
    } else if (key === 'influence') {
      lines.push(`\tik_node.influence = ${val}`);
    } else if (key === 'bone_name') {
      lines.push(`\tik_node.bone_name = "${gdEscape(String(val))}"`);
    } else if (key === 'target_nodepath') {
      lines.push(`\tik_node.target_nodepath = NodePath("${gdEscape(String(val))}")`);
    } else if (key === 'use_magnet') {
      lines.push(`\tik_node.use_magnet = ${val}`);
    } else if (key === 'magnet_position') {
      const mp = val as { x: number; y: number; z: number };
      lines.push(`\tik_node.magnet_position = Vector3(${mp.x}, ${mp.y}, ${mp.z})`);
    }
  }

  lines.push(`\t_mcp_output("updated", true)`);
  lines.push(`\t_mcp_output("path", str(ik_node.get_path()))`);
  lines.push(`\t_mcp_done()`);
  return lines.join('\n') + '\n';
}

export function genListBonesScript(nodePath: string, limit?: number): string {
  const limitLine = limit ? `\n\tif bones.size() > ${limit}:\n\t\tbones = bones.slice(0, ${limit})` : '';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Skeleton3D:
\t\t_mcp_output("error", "Node is not a Skeleton3D: " + node.get_class())
\t\t_mcp_done()
\t\treturn
\tvar bones = []
\tfor i in range(node.get_bone_count()):
\t\tvar bname = node.get_bone_name(i)
\t\tvar rest = node.get_bone_rest(i)
\t\tbones.append({"index": i, "name": bname, "rest_position": {"x": rest.origin.x, "y": rest.origin.y, "z": rest.origin.z}})${limitLine}
\t_mcp_output("bone_count", node.get_bone_count())
\t_mcp_output("bones", bones)
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'ik_modifier_create',
      description: `Create IK modifier node. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          type: {
            type: 'string',
            description: 'IK 类型: TwoBoneIK3D, FABRIK3D, CCDIK3D, SplineIK3D, JacobianIK3D',
            enum: [...IK_TYPE_WHITELIST],
          },
          name: { type: 'string', description: '节点名称' },
          parent: { type: 'string', description: '父节点路径（默认 root）', default: 'root' },
          position: {
            type: 'object',
            description: '位置 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
          },
          bone_name: { type: 'string', description: '要控制的骨骼名（TwoBoneIK3D）' },
          target_nodepath: { type: 'string', description: 'IK 目标节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'type', 'name'],
      },
    },
    {
      name: 'ik_modifier_get',
      description: `Read IK modifier node properties. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'IK 节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'ik_modifier_set',
      description: `Set IK modifier parameters. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'IK 节点路径' },
          properties: {
            type: 'object',
            description: '属性键值对: active(bool), influence(float 0-1), bone_name(string), target_nodepath(string), use_magnet(bool), magnet_position({x,y,z})',
          },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'properties'],
      },
    },
    {
      name: 'ik_list_bones',
      description: `List Skeleton3D bones. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: 'Skeleton3D 节点路径' },
          limit: { type: 'number', description: '最大返回数量（可选）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;

    switch (name) {
      case 'ik_modifier_create': {
        const ikType = args.type as string;
        if (!IK_TYPE_WHITELIST.includes(ikType as any)) {
          return opsErrorResult(ERROR_CODES.INVALID_TYPE,
            `Invalid IK type: "${ikType}". Must be one of: ${IK_TYPE_WHITELIST.join(', ')}`);
        }
        const nodeName = validateIdentifier(args.name as string);
        const parent = normalizeNodePath((args.parent as string) || 'root');
        const position = args.position ? validateVector3(args.position) : undefined;
        const boneName = args.bone_name as string | undefined;
        const targetNodepath = args.target_nodepath as string | undefined;
        script = genIkCreateScript(ikType, nodeName, parent, position, boneName, targetNodepath);
        break;
      }
      case 'ik_modifier_get': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genIkGetScript(nodePath);
        break;
      }
      case 'ik_modifier_set': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const props = args.properties as Record<string, unknown>;
        if (!props || typeof props !== 'object') {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'properties must be an object');
        }
        // Whitelist check
        for (const key of Object.keys(props)) {
          if (!IK_SETTABLE_PROPS.includes(key as any)) {
            return opsErrorResult(ERROR_CODES.INVALID_PROPERTY,
              `Unknown property: "${key}". Allowed: ${IK_SETTABLE_PROPS.join(', ')}`);
          }
        }
        // bone_name non-empty check
        if ('bone_name' in props && (!props.bone_name || String(props.bone_name).trim() === '')) {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'bone_name must be non-empty');
        }
        script = genIkSetScript(nodePath, props);
        break;
      }
      case 'ik_list_bones': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const limit = args.limit as number | undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
          return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, 'limit must be a positive integer');
        }
        script = genListBonesScript(nodePath, limit);
        break;
      }
      default:
        return null;
    }

    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const errorMapper = (msg: string) =>
      msg.includes('not found') ? ERROR_CODES.NODE_NOT_FOUND :
      msg.includes('not a Skeleton3D') ? ERROR_CODES.INVALID_TYPE :
      ERROR_CODES.SCRIPT_EXEC_FAILED;

    return parseGdscriptResult(result, [], errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('Identifier')) return opsErrorResult(ERROR_CODES.INVALID_PROPERTY, msg);
    if (msg.includes('NodePath')) return opsErrorResult(ERROR_CODES.NODE_NOT_FOUND, msg);
    return opsErrorResult(ERROR_CODES.SCRIPT_EXEC_FAILED, msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  ik_modifier_create: { readonly: false, long_running: false },
  ik_modifier_get: { readonly: true, long_running: false },
  ik_modifier_set: { readonly: false, long_running: false },
  ik_list_bones: { readonly: true, long_running: false },
};
```

- [ ] **Step 2: 注册模块**

在 `src/GodotServer.ts` 顶部 import 区域添加：

```typescript
import * as ikTools from './tools/ik-tools.js';
```

在 `toolModules` 数组中添加 `ikTools`：

```typescript
const toolModules = [
  // ... 已有模块
  ikTools,
];
```

- [ ] **Step 3: 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add src/tools/ik-tools.ts src/GodotServer.ts
git commit -m "feat: add IK framework toolset MVP (4 tools)"
```

---

### Task 5: IK 工具单元测试

**Files:**
- Create: `test/ik-tools.test.js`

- [ ] **Step 1: 写测试**

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_NAMES,
  getToolDefinitions,
  genIkCreateScript,
  genIkGetScript,
  genIkSetScript,
  genListBonesScript,
} from '../build/tools/ik-tools.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('ik-tools TOOL_NAMES', () => {
  it('contains exactly 4 tool names', () => {
    assert.strictEqual(TOOL_NAMES.length, 4);
  });
  const expected = ['ik_modifier_create', 'ik_modifier_get', 'ik_modifier_set', 'ik_list_bones'];
  for (const name of expected) {
    it(`includes ${name}`, () => {
      assert.ok(TOOL_NAMES.includes(name));
    });
  }
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('ik-tools getToolDefinitions', () => {
  it('returns 4 tool definitions', () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 4);
  });
  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      assert.ok(names.includes(tn), `missing tool definition for ${tn}`);
    }
  });
});

// ─── genIkCreateScript ──────────────────────────────────────────────────────

describe('genIkCreateScript', () => {
  it('generates valid GDScript with type and name', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'RightArmIK', 'root/Player/Skeleton3D');
    assert.ok(script.includes('TwoBoneIK3D.new()'));
    assert.ok(script.includes('RightArmIK'));
    assert.ok(script.includes('root/Player/Skeleton3D'));
  });
  it('includes position when provided', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', { x: 1, y: 2, z: 3 });
    assert.ok(script.includes('Vector3(1, 2, 3)'));
  });
  it('includes bone_name and target_nodepath', () => {
    const script = genIkCreateScript('TwoBoneIK3D', 'IK', 'root', undefined, 'RightArm', 'root/Target');
    assert.ok(script.includes('RightArm'));
    assert.ok(script.includes('root/Target'));
    assert.ok(script.includes('NodePath'));
  });
});

// ─── genIkGetScript ─────────────────────────────────────────────────────────

describe('genIkGetScript', () => {
  it('contains node path and property reads', () => {
    const script = genIkGetScript('root/Player/IK');
    assert.ok(script.includes('root/Player/IK'));
    assert.ok(script.includes('ik_node.active'));
    assert.ok(script.includes('ik_node.influence'));
    assert.ok(script.includes('bone_name'));
    assert.ok(script.includes('target_nodepath'));
  });
});

// ─── genIkSetScript ─────────────────────────────────────────────────────────

describe('genIkSetScript', () => {
  it('sets active and influence', () => {
    const script = genIkSetScript('root/IK', { active: true, influence: 0.5 });
    assert.ok(script.includes('ik_node.active = true'));
    assert.ok(script.includes('ik_node.influence = 0.5'));
  });
  it('sets bone_name and magnet_position', () => {
    const script = genIkSetScript('root/IK', {
      bone_name: 'RightArm',
      magnet_position: { x: 0.1, y: 0.2, z: 0.3 },
    });
    assert.ok(script.includes('RightArm'));
    assert.ok(script.includes('Vector3(0.1, 0.2, 0.3)'));
  });
});

// ─── genListBonesScript ─────────────────────────────────────────────────────

describe('genListBonesScript', () => {
  it('contains Skeleton3D check and bone iteration', () => {
    const script = genListBonesScript('root/Player/Skeleton3D');
    assert.ok(script.includes('Skeleton3D'));
    assert.ok(script.includes('get_bone_count'));
    assert.ok(script.includes('get_bone_name'));
    assert.ok(script.includes('get_bone_rest'));
  });
  it('includes limit when provided', () => {
    const script = genListBonesScript('root/Skeleton3D', 10);
    assert.ok(script.includes('10'));
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx uvu test ik-tools.test.js`
Expected: PASS（所有 ~15 断言通过）

- [ ] **Step 3: 提交**

```bash
git add test/ik-tools.test.js
git commit -m "test: add IK tool unit tests (15 assertions)"
```

---

### Task 6: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 创建 CI 工作流**

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
```

- [ ] **Step 2: 验证 YAML 语法**

Run: `npx yaml .github/workflows/ci.yml`
Expected: 无解析错误（或用 `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` 验证）

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow (Node 20/22 matrix)"
```

---

### Task 7: 版本发布

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 更新版本号**

在 `package.json` 中将 `"version": "0.13.0"` 改为 `"version": "0.14.0"`。

- [ ] **Step 2: 编译 + 全量测试**

Run: `npm run build && npm test`
Expected: 所有测试通过（774+ 现有 + ~50 新增）

- [ ] **Step 3: 提交**

```bash
git add package.json
git commit -m "release: v0.14.0 quality hardening + IK framework MVP"
```
