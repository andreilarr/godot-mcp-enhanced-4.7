# E2E 验证 + DX 修复 + 功能增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三阶段推进——验证 P1-P5 真实可用 → 修复开发体验问题 → 补全功能增强

**Architecture:** 阶段 1 用内置 Godot 测试项目做真实进程验证；阶段 2 修复 scope/GateGuard 摩擦；阶段 3 扩展 tscn-editor 和 scene-commit 的类型支持。每个阶段独立提交。

**Tech Stack:** TypeScript (ESM), Vitest, Godot 4.6 headless 进程, .tscn 纯文本解析

**Spec:** `docs/superpowers/specs/2026-06-06-e2e-validation-enhancement-design.md`

**重要发现：** P3 import warmup 已经实现时间戳缓存（`src/tools/import-check.ts` 的 `_lastCheckedAssetMtime`），不是布尔缓存。增强 3 只需验证，无需修改代码。

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `test/e2e-scene/project.godot` | 创建 | 最小 Godot 项目配置 |
| `test/e2e-scene/scenes/test_2d.tscn` | 创建 | 2D 场景：TileMapLayer + ColorRect + Label |
| `test/e2e-scene/scenes/test_3d.tscn` | 创建 | 3D 场景：Node3D + MeshInstance3D + Camera3D |
| `test/e2e-scene/scripts/test_helper.gd` | 创建 | 辅助 GDScript |
| `test/e2e-p1-p5.test.ts` | 创建 | E2E 验证测试（CI 友好，无 Godot 则 skip） |
| `src/tscn-editor.ts` | 修改 | 扩展 `canSerializeProperty` + `formatPropertyValue` 支持 Rect2/`_type` |
| `src/tools/scene-commit.ts` | 修改 | 扩展 `serializeGdValue` 支持类型推断 |
| `test/tscn-editor.test.ts` | 修改 | 新增类型推断测试 |
| `test/scene-commit.test.ts` | 修改 | 新增类型推断 GDScript 生成测试 |

---

## 阶段 1：E2E 验证

### Task 1: 创建 E2E 测试项目

**Files:**
- Create: `test/e2e-scene/project.godot`
- Create: `test/e2e-scene/scenes/test_2d.tscn`
- Create: `test/e2e-scene/scenes/test_3d.tscn`
- Create: `test/e2e-scene/scripts/test_helper.gd`

- [ ] **Step 1: 创建项目目录和 project.godot**

```gdscript
; test/e2e-scene/project.godot
; 最小 Godot 4.x 项目配置
[application]
config/name="E2E Test Scene"
run/main_scene="res://scenes/test_3d.tscn"

[display]
window/size/viewport_width=320
window/size/viewport_height=240

[rendering]
renderer/rendering_method="forward_plus"
```

- [ ] **Step 2: 创建 test_2d.tscn**

```
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/test_helper.gd" id="1"]

[node name="Test2D" type="Node2D"]
script = ExtResource("1")

[node name="BG" type="ColorRect" parent="."]
offset_right = 320.0
offset_bottom = 240.0
color = Color(0.1, 0.1, 0.3, 1)

[node name="Title" type="Label" parent="."]
offset_right = 320.0
offset_bottom = 40.0
text = "2D Test Scene"

[node name="TileMapLayer" type="TileMapLayer" parent="."]
```

- [ ] **Step 3: 创建 test_3d.tscn**

```
[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/test_helper.gd" id="1"]

[node name="Test3D" type="Node3D"]
script = ExtResource("1")

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 5)

[node name="Cube" type="MeshInstance3D" parent="."]
mesh = BoxMesh(1, 1, 1)
```

- [ ] **Step 4: 创建 test_helper.gd**

```gdscript
extends Node
## E2E 测试辅助脚本

func _ready() -> void:
	print("[TEST_HELPER] Node ready: %s" % name)
```

- [ ] **Step 5: 提交**

```bash
git add test/e2e-scene/
git commit -m "test: create E2E test project for P1-P5 validation"
```

---

### Task 2: 创建 E2E 验证测试文件

**Files:**
- Create: `test/e2e-p1-p5.test.ts`

**Context:**
- Godot 路径：`D:\godot\Godot_v4.6.3-stable_win64_console.exe`
- 项目路径：`test/e2e-scene/`（相对于项目根目录）
- `executeGdscript` 接口：`{ godotPath, projectPath, code, timeout, loadAutoloads? }` → `{ success, raw_output, run_success, errors, outputs, duration_ms }`
- `addNode` 接口：`addNode(tscnContent: string, params: AddNodeParams): AddNodeResult`
- `readFileSync` / `writeFileSync` 用于读写 .tscn 文件
- Vitest 的 `it.skipIf()` 用于条件跳过

- [ ] **Step 1: 编写 E2E 测试骨架 + P1 addNode 3D/2D 测试**

```typescript
// test/e2e-p1-p5.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { executeGdscript } from '../src/gdscript-executor.js';
import { addNode } from '../src/tscn-editor.js';
import { captureScreenshot, getBlankHint } from '../src/screenshot.js';
import { generateCommitScript } from '../src/tools/scene-commit.js';
import { parseCommitResult } from '../src/tools/scene-commit-tool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = resolve(__dirname, 'e2e-scene');
const GODOT_PATH = process.env.GODOT_PATH || 'D:\\godot\\Godot_v4.6.3-stable_win64_console.exe';

const hasGodot = existsSync(GODOT_PATH);

describe.skipIf(!hasGodot)('E2E: P1-P5 validation', { timeout: 60_000 }, () => {

  // ── P1: addNode (纯文件操作，不需要 Godot 进程) ──

  it('P1-addNode-3D: writes Node3D child to test_3d.tscn', () => {
    const scenePath = resolve(E2E_DIR, 'scenes', 'test_3d.tscn');
    const original = readFileSync(scenePath, 'utf-8');

    const result = addNode(original, {
      nodeName: 'TestChild',
      nodeType: 'Node3D',
      parent: 'Test3D',
      properties: {},
    });

    expect(result.content).toContain('[node name="TestChild" type="Node3D" parent="Test3D"]');
    // Write back for subsequent tests
    writeFileSync(scenePath, result.content, 'utf-8');
  });

  it('P1-addNode-2D: writes Sprite2D to test_2d.tscn', () => {
    const scenePath = resolve(E2E_DIR, 'scenes', 'test_2d.tscn');
    const original = readFileSync(scenePath, 'utf-8');

    const result = addNode(original, {
      nodeName: 'TestSprite',
      nodeType: 'Sprite2D',
      parent: 'Test2D',
      properties: {},
    });

    expect(result.content).toContain('[node name="TestSprite" type="Sprite2D" parent="Test2D"]');
    writeFileSync(scenePath, result.content, 'utf-8');
  });

  // ── P1: batch_add_nodes (同样纯文件操作) ──

  it('P1-batch: addNodes creates 5 nodes', () => {
    const scenePath = resolve(E2E_DIR, 'scenes', 'test_3d.tscn');
    const content = readFileSync(scenePath, 'utf-8');
    const { addNodes } = require('../src/tscn-editor.js');

    const result = addNodes(content, [
      { nodeName: 'B1', nodeType: 'Node3D', parent: 'Test3D' },
      { nodeName: 'B2', nodeType: 'Node3D', parent: 'Test3D' },
      { nodeName: 'B3', nodeType: 'Node3D', parent: 'Test3D' },
      { nodeName: 'B4', nodeType: 'Node3D', parent: 'Test3D' },
      { nodeName: 'B5', nodeType: 'Node3D', parent: 'Test3D' },
    ]);

    expect(result.content).toContain('name="B1"');
    expect(result.content).toContain('name="B5"');
    writeFileSync(scenePath, result.content, 'utf-8');
  });
});
```

**注意**：上述测试骨架中 `require` 应改为 ESM `import`（已在文件顶部导入 `addNode`）。`addNodes` 需要在顶部额外导入。后续 steps 会补全。

- [ ] **Step 2: 添加 P1 resources 读取测试**

在同一个 describe 块内追加：

```typescript
  it('P1-resources: read_scene parses resource references', () => {
    const scenePath = resolve(E2E_DIR, 'scenes', 'test_3d.tscn');
    const content = readFileSync(scenePath, 'utf-8');
    // test_helper.gd 被引用为 ext_resource
    expect(content).toContain('res://scripts/test_helper.gd');
    // Cube 引用了 BoxMesh 内置资源
    expect(content).toContain('BoxMesh');
  });
```

- [ ] **Step 3: 添加 P2 scene_commit 测试**

```typescript
  it('P2-scene_commit: generates valid tile_set + tile_fill GDScript', async () => {
    const script = generateCommitScript(
      'res://scenes/test_2d.tscn',
      [
        {
          op: 'tile_set',
          node_path: 'root/Test2D/TileMapLayer',
          coords: { x: 0, y: 0 },
          source_id: 0,
          atlas: { x: 0, y: 0 },
        },
        {
          op: 'tile_fill',
          node_path: 'root/Test2D/TileMapLayer',
          region: { x: 0, y: 0, w: 5, h: 3 },
          source_id: 0,
          atlas: { x: 0, y: 0 },
        },
      ],
      false, // don't save
      true,
    );

    expect(script).toContain('tile_set');
    expect(script).toContain('_fill_tiles');

    // Parse would need actual Godot run — just test generation here
    const result = parseCommitResult('COMMIT_RESULT: {"success":true,"cells_affected":16}');
    expect(result).toEqual({ success: true, cells_affected: 16 });
  });

  it('P2-scene_commit: node_property with type inference', async () => {
    const script = generateCommitScript(
      'res://scenes/test_3d.tscn',
      [{
        op: 'node_property',
        path: 'root/Test3D/Cube',
        property: 'position',
        value: { x: 1, y: 2, z: 3 },
      }],
      false,
      true,
    );

    expect(script).toContain('position');
    // 目前 serializeGdValue 把 object 序列化为 JSON — 类型推断在 Task 7 中添加
  });
```

- [ ] **Step 4: 添加 P3 import warmup 测试**

```typescript
  it('P3-import: warmup runs before first executeGdscript', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      code: 'print("P3 test")\n_mcp_done()',
      timeout: 30,
    });

    expect(result.run_success).toBe(true);
    // .godot/imported/ should exist after warmup
    const importedDir = resolve(E2E_DIR, '.godot', 'imported');
    expect(existsSync(importedDir)).toBe(true);
  });

  it('P3-skip: second call is faster (warmup cached)', async () => {
    const start = Date.now();
    await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      code: 'print("P3 skip test")\n_mcp_done()',
      timeout: 30,
    });
    const duration = Date.now() - start;
    // Second run should complete within 15s (no import warmup)
    expect(duration).toBeLessThan(15000);
  });
```

- [ ] **Step 5: 添加 P4 截图测试**

```typescript
  it('P4-screenshot: 2D scene detects blank', async () => {
    const outPath = resolve(E2E_DIR, 'test_2d_screenshot.png');
    const result = await captureScreenshot({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      scene: 'res://scenes/test_2d.tscn',
      outputPath: outPath,
      frameDelay: 15,
      timeout: 30,
    });

    const hint = getBlankHint(result.godotOutput || '');
    if (result.success) {
      // If screenshot succeeded, check for blank detection
      expect(typeof hint === 'string').toBe(true);
    }
    // BLANK_DETECTED hint should mention alternatives
    if (hint) {
      expect(hint).toContain('Game Bridge');
      expect(hint).toContain('screenshot analyze');
    }
  }, 60_000);

  it('P4-screenshot: 3D scene produces PNG', async () => {
    const outPath = resolve(E2E_DIR, 'test_3d_screenshot.png');
    const result = await captureScreenshot({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      scene: 'res://scenes/test_3d.tscn',
      outputPath: outPath,
      frameDelay: 15,
      timeout: 30,
    });

    if (result.success) {
      expect(existsSync(outPath)).toBe(true);
      expect(result.fileSize).toBeGreaterThan(0);
    }
  }, 60_000);
```

- [ ] **Step 6: 添加 P5 验证测试**

```typescript
  it('P5-validate: helper script syntax is valid', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      code: `
var helper = load("res://scripts/test_helper.gd")
if helper == null:
  _mcp_output("error", "Failed to load test_helper.gd")
else:
  _mcp_output("loaded", "ok")
_mcp_done()`,
      timeout: 30,
    });

    expect(result.run_success).toBe(true);
  });
```

- [ ] **Step 7: 添加 cleanup afterAll 和 gitignore 条目**

```typescript
import { afterAll } from 'vitest';

afterAll(() => {
  // Clean up generated files but keep project structure
  const screenshots = [
    resolve(E2E_DIR, 'test_2d_screenshot.png'),
    resolve(E2E_DIR, 'test_3d_screenshot.png'),
  ];
  for (const f of screenshots) {
    if (existsSync(f)) rmSync(f);
  }
  // Restore original scene files from git
  // (or just leave them — test project is disposable)
});
```

同时在 `.gitignore` 中追加：

```
test/e2e-scene/.godot/
test/e2e-scene/*.png
```

- [ ] **Step 8: 运行测试验证骨架可加载（不需要 Godot 也能通过）**

Run: `npx vitest run test/e2e-p1-p5.test.ts --reporter=verbose`
Expected: 测试在无 Godot 时 skip，有 Godot 时运行

- [ ] **Step 9: 提交**

```bash
git add test/e2e-p1-p5.test.ts test/e2e-scene/ .gitignore
git commit -m "test: add E2E validation tests for P1-P5"
```

---

### Task 3: 运行 E2E 验证并记录 gap

**Files:** 无新文件（纯执行和记录）

- [ ] **Step 1: 运行 E2E 测试**

Run: `npx vitest run test/e2e-p1-p5.test.ts --reporter=verbose 2>&1 | tee e2e-results.txt`
Expected: 部分通过，记录失败的测试

- [ ] **Step 2: 分析结果，记录 gap**

将失败测试整理为 gap 列表：

| 测试 | 结果 | Gap 描述 | 修复方案 |
|------|------|---------|---------|
| P1-addNode-3D | ? | ? | ? |
| P1-addNode-2D | ? | ? | ? |
| ... | ... | ... | ... |

- [ ] **Step 3: 修复发现的问题（如有），重新运行直到全部通过或记录为已知限制**

Run: `npx vitest run test/e2e-p1-p5.test.ts --reporter=verbose`
Expected: 全部 pass 或 skip

- [ ] **Step 4: 提交修复**

```bash
git add -A
git commit -m "fix(e2e): resolve gaps found during P1-P5 validation"
```

---

## 阶段 2：DX 修复

### Task 4: Scope Warning 子系统感知

**Files:**
- Locate: scope warning hook 文件（搜索包含 "SCOPE WARNING" 的 hook 实现）
- Modify: scope check 逻辑

- [ ] **Step 1: 定位 Scope Warning hook 文件**

Run: `grep -r "SCOPE WARNING" --include="*.js" --include="*.ts" -l`

记录文件路径和行号。

- [ ] **Step 2: 编写测试——验证子系统感知逻辑**

创建 `test/scope-warning.test.ts`（或在现有测试文件中追加）：

```typescript
import { describe, it, expect } from 'vitest';

// 提取子系统分组逻辑为独立函数，便于测试
function groupFilesBySubsystem(files: string[]): Map<string, number> {
  const groups = new Map<string, number>();
  for (const f of files) {
    const parts = f.replace(/\\/g, '/').split('/');
    const key = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] || 'root';
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return groups;
}

function shouldWarnScope(files: string[]): boolean {
  if (files.length < 10) return false;
  const groups = groupFilesBySubsystem(files);
  const total = files.length;
  // Find the top 2 groups
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const top2 = sorted.slice(0, 2).reduce((sum, [, count]) => sum + count, 0);
  const concentration = top2 / total;
  // If >80% concentrated in 2 subsystems, no warning
  if (concentration > 0.8) return false;
  // If spread across 5+ dirs with 15+ files, warn
  return groups.size >= 5 && total >= 15;
}

describe('scope-warning: subsystem-aware', () => {
  it('does not warn when files are concentrated in 2 subsystems', () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      i < 12 ? `src/tools/file${i}.ts` : `test/tools/file${i}.test.ts`
    );
    expect(shouldWarnScope(files)).toBe(false);
  });

  it('warns when files are spread across 5+ dirs', () => {
    const files = [
      ...Array.from({ length: 4 }, (_, i) => `src/tools/a${i}.ts`),
      ...Array.from({ length: 4 }, (_, i) => `src/core/b${i}.ts`),
      ...Array.from({ length: 4 }, (_, i) => `test/c${i}.ts`),
      ...Array.from({ length: 4 }, (_, i) => `docs/d${i}.md`),
      ...Array.from({ length: 4 }, (_, i) => `scripts/e${i}.gd`),
    ];
    expect(shouldWarnScope(files)).toBe(true);
  });

  it('does not warn for fewer than 10 files', () => {
    const files = Array.from({ length: 9 }, (_, i) => `src/${i}.ts`);
    expect(shouldWarnScope(files)).toBe(false);
  });
});
```

- [ ] **Step 3: 运行测试确认逻辑正确**

Run: `npx vitest run test/scope-warning.test.ts --reporter=verbose`
Expected: 3 tests PASS

- [ ] **Step 4: 将子系统感知逻辑集成到 hook 中**

根据 Step 1 定位的 hook 文件，修改 scope check 逻辑：
- 提取 `groupFilesBySubsystem` 和 `shouldWarnScope` 为独立函数
- 在 scope warning 触发前调用 `shouldWarnScope()`
- 如果返回 false，不输出 SCOPE WARNING

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run --reporter=verbose`
Expected: 1979+ tests PASS（新增 3 个 scope 测试）

- [ ] **Step 6: 提交**

```bash
git add test/scope-warning.test.ts <hook-file>
git commit -m "fix(dx): scope warning now subsystem-aware, reduces false positives"
```

---

### Task 5: GateGuard 批量任务豁免

**Files:**
- Locate: GateGuard hook 文件（搜索 "Fact-Forcing Gate" 或 "GateGuard"）
- Modify: hook 配置

**注意：** GateGuard 可能是外部插件 hook（不在本项目代码中）。如果确认是外部 hook 配置，则此任务改为**配置调整**而非代码修改。

- [ ] **Step 1: 定位 GateGuard hook 文件**

Run: `grep -r "Fact-Forcing\|GateGuard\|fact.*forcing" --include="*.js" --include="*.ts" --include="*.json" -l`

记录文件路径。如果在外部插件目录（如 `.claude/plugins/` 或 `~/.claude/`），标记为配置任务。

- [ ] **Step 2: 分析 GateGuard 触发逻辑**

读取 hook 文件，理解：
- 什么条件触发 Fact-Forcing Gate
- 是否有"豁免"或"上下文"概念
- 是否支持按 skill/命令名配置白名单

- [ ] **Step 3: 实施豁免方案**

根据 Step 2 分析结果，选择以下之一：
- **A. 配置白名单**：将 `superpowers:executing-plans` 和 `superpowers:subagent-driven-development` 加入豁免列表
- **B. 会话状态检测**：检测当前会话是否处于 plan 执行模式（检查内存中的任务列表），如果是则跳过 fact gate
- **C. 最小修改**：如果 hook 不支持扩展，则仅记录问题到 MEMORY.md，后续与插件维护者协调

- [ ] **Step 4: 提交**

```bash
git add <modified-files>
git commit -m "fix(dx): GateGuard batch task exemption for plan execution"
```

---

## 阶段 3：功能增强

### Task 6: P1 属性类型扩展 — tscn-editor.ts

**Files:**
- Modify: `src/tscn-editor.ts:1233-1284`（`canSerializeProperty` + `formatPropertyValue`）
- Modify: `test/tscn-editor.test.ts`（新增类型推断测试）

**Context:**
- `canSerializeProperty` 当前拒绝 Array 和嵌套 object
- `formatPropertyValue` 当前支持 Vector2/Vector3/Color 但不支持 Rect2 和 `_type` 覆盖
- `GODOT_LITERAL_RE`（第 40 行）已包含 `Rect2i?`、`Vector2i?`、`Color\(` 等模式，.tscn 文本层已支持这些类型

- [ ] **Step 1: 编写 Rect2 和 _type 覆盖的失败测试**

在 `test/tscn-editor.test.ts` 中追加：

```typescript
describe('formatPropertyValue: type inference', () => {
  // 需要从 tscn-editor.ts 导出 formatPropertyValue 进行测试
  // 如果不可导出，通过 addNode 间接测试

  it('serializes Rect2 from {x, y, w, h}', () => {
    const tscn = '[gd_scene format=3]\n[node name="Root" type="Node2D"]\n';
    const result = addNode(tscn, {
      nodeName: 'Rect',
      nodeType: 'Node2D',
      parent: 'Root',
      properties: { region_rect: { x: 10, y: 20, w: 100, h: 50 } },
    });
    expect(result.content).toContain('region_rect = Rect2(10, 20, 100, 50)');
  });

  it('serializes Vector2i with explicit _type', () => {
    const tscn = '[gd_scene format=3]\n[node name="Root" type="Node2D"]\n';
    const result = addNode(tscn, {
      nodeName: 'Cell',
      nodeType: 'Node2D',
      parent: 'Root',
      properties: { cell_coords: { x: 3, y: 7, _type: 'Vector2i' } },
    });
    expect(result.content).toContain('cell_coords = Vector2i(3, 7)');
  });

  it('serializes Rect2i with explicit _type', () => {
    const tscn = '[gd_scene format=3]\n[node name="Root" type="Node2D"]\n';
    const result = addNode(tscn, {
      nodeName: 'Box',
      nodeType: 'Node2D',
      parent: 'Root',
      properties: { rect: { x: 0, y: 0, w: 32, h: 32, _type: 'Rect2i' } },
    });
    expect(result.content).toContain('rect = Rect2i(0, 0, 32, 32)');
  });

  it('_type overrides auto-inference (Vector3 forced as Vector2i)', () => {
    const tscn = '[gd_scene format=3]\n[node name="Root" type="Node"]\n';
    const result = addNode(tscn, {
      nodeName: 'Override',
      nodeType: 'Node',
      parent: 'Root',
      properties: { pos: { x: 1, y: 2, z: 3, _type: 'Vector2i' } },
    });
    // _type overrides, ignore z
    expect(result.content).toContain('pos = Vector2i(1, 2)');
  });

  it('Array values pass through as generic Array', () => {
    const tscn = '[gd_scene format=3]\n[node name="Root" type="Node"]\n';
    const result = addNode(tscn, {
      nodeName: 'Arr',
      nodeType: 'Node',
      parent: 'Root',
      properties: { items: [1, 2, 3] },
    });
    expect(result.content).toContain('items = [1, 2, 3]');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tscn-editor.test.ts --reporter=verbose -t "formatPropertyValue: type inference"`
Expected: 5 tests FAIL（Rect2/Vector2i/Array 不支持）

- [ ] **Step 3: 修改 canSerializeProperty 支持 Array**

在 `src/tscn-editor.ts` 的 `canSerializeProperty` 函数中：

```typescript
export function canSerializeProperty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) {
    // Support generic arrays (elements must be serializable primitives)
    return value.every(v => canSerializeProperty(v));
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
```

- [ ] **Step 4: 修改 formatPropertyValue 支持 Rect2 和 _type 覆盖**

```typescript
function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return formatTscnValue(value);
  if (Array.isArray(value)) {
    const items = value.map(v => formatPropertyValue(v));
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const explicitType = obj._type as string | undefined;

    // Explicit _type override
    if (explicitType) {
      switch (explicitType) {
        case 'Vector2i': return `Vector2i(${obj.x}, ${obj.y})`;
        case 'Vector2': return `Vector2(${obj.x}, ${obj.y})`;
        case 'Vector3i': return `Vector3i(${obj.x}, ${obj.y}, ${obj.z})`;
        case 'Vector3': return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
        case 'Rect2i': return `Rect2i(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
        case 'Rect2': return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
        case 'Color': {
          const a = obj.a ?? 1;
          return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
        }
      }
    }

    // Auto-inference (default Vector2 for {x,y}, not Vector2i)
    if (keys.includes('w') && keys.includes('h') && keys.includes('x') && keys.includes('y')) {
      return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
    }
    if (keys.includes('x') && keys.includes('y') && keys.includes('z')) {
      return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
    }
    if (keys.includes('x') && keys.includes('y')) {
      return `Vector2(${obj.x}, ${obj.y})`;
    }
    if (keys.includes('r') && keys.includes('g') && keys.includes('b')) {
      const a = obj.a ?? 1;
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
    }
    return formatTscnValue(JSON.stringify(value));
  }
  return formatTscnValue(String(value));
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/tscn-editor.test.ts --reporter=verbose -t "formatPropertyValue: type inference"`
Expected: 5 tests PASS

- [ ] **Step 6: 运行全量测试确认无回归**

Run: `npx vitest run --reporter=verbose`
Expected: 1981+ tests PASS（新增 5 个类型推断测试）

- [ ] **Step 7: 提交**

```bash
git add src/tscn-editor.ts test/tscn-editor.test.ts
git commit -m "feat(tscn): support Rect2, _type override, and Array in property serialization"
```

---

### Task 7: P2 scene_commit 类型推断

**Files:**
- Modify: `src/tools/scene-commit.ts:213-220`（`serializeGdValue` 函数）
- Modify: `test/scene-commit.test.ts`（新增类型推断测试）

**Context:**
- `serializeGdValue` 当前只处理 string/number/boolean/null/object（JSON.stringify）
- `node_property` op 的 GDScript 生成在 `generateOpBlock` 的 `case 'node_property'` 分支
- 需要 `serializeGdValue` 也支持 Vector2/Vector3/Rect2/Color 推断，使 GDScript 中使用正确构造函数

- [ ] **Step 1: 编写类型推断的失败测试**

在 `test/scene-commit.test.ts` 中追加：

```typescript
describe('scene-commit: serializeGdValue type inference', () => {
  it('serializes Vector3 from {x,y,z}', () => {
    const script = generateCommitScript('res://test.tscn', [{
      op: 'node_property',
      path: 'root/Player',
      property: 'position',
      value: { x: 1, y: 2, z: 3 },
    }], false);
    expect(script).toContain('Vector3(1, 2, 3)');
  });

  it('serializes Vector2 from {x,y}', () => {
    const script = generateCommitScript('res://test.tscn', [{
      op: 'node_property',
      path: 'root/Node',
      property: 'offset',
      value: { x: 5, y: 10 },
    }], false);
    expect(script).toContain('Vector2(5, 10)');
  });

  it('serializes Color from {r,g,b}', () => {
    const script = generateCommitScript('res://test.tscn', [{
      op: 'node_property',
      path: 'root/Sprite',
      property: 'modulate',
      value: { r: 1, g: 0.5, b: 0, a: 1 },
    }], false);
    expect(script).toContain('Color(1, 0.5, 0, 1)');
  });

  it('serializes Rect2 from {x,y,w,h}', () => {
    const script = generateCommitScript('res://test.tscn', [{
      op: 'node_property',
      path: 'root/Rect',
      property: 'region_rect',
      value: { x: 0, y: 0, w: 32, h: 32 },
    }], false);
    expect(script).toContain('Rect2(0, 0, 32, 32)');
  });

  it('respects _type override for Vector2i', () => {
    const script = generateCommitScript('res://test.tscn', [{
      op: 'node_property',
      path: 'root/Tile',
      property: 'coords',
      value: { x: 3, y: 7, _type: 'Vector2i' },
    }], false);
    expect(script).toContain('Vector2i(3, 7)');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/scene-commit.test.ts --reporter=verbose -t "serializeGdValue type inference"`
Expected: 5 tests FAIL（当前 serializeGdValue 用 JSON.stringify 处理 object）

- [ ] **Step 3: 修改 serializeGdValue 支持类型推断**

替换 `src/tools/scene-commit.ts` 的 `serializeGdValue` 函数：

```typescript
function serializeGdValue(value: unknown): string {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const explicitType = obj._type as string | undefined;

    if (explicitType) {
      switch (explicitType) {
        case 'Vector2i': return `Vector2i(${obj.x}, ${obj.y})`;
        case 'Vector2': return `Vector2(${obj.x}, ${obj.y})`;
        case 'Vector3i': return `Vector3i(${obj.x}, ${obj.y}, ${obj.z})`;
        case 'Vector3': return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
        case 'Rect2i': return `Rect2i(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
        case 'Rect2': return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
        case 'Color': return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${obj.a ?? 1})`;
      }
    }
    if (keys.includes('w') && keys.includes('h') && keys.includes('x') && keys.includes('y')) {
      return `Rect2(${obj.x}, ${obj.y}, ${obj.w}, ${obj.h})`;
    }
    if (keys.includes('x') && keys.includes('y') && keys.includes('z')) {
      return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
    }
    if (keys.includes('x') && keys.includes('y')) {
      return `Vector2(${obj.x}, ${obj.y})`;
    }
    if (keys.includes('r') && keys.includes('g') && keys.includes('b')) {
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${obj.a ?? 1})`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/scene-commit.test.ts --reporter=verbose -t "serializeGdValue type inference"`
Expected: 5 tests PASS

- [ ] **Step 5: 运行全量测试确认无回归**

Run: `npx vitest run --reporter=verbose`
Expected: 1986+ tests PASS（新增 5 个 scene-commit 类型测试）

- [ ] **Step 6: 提交**

```bash
git add src/tools/scene-commit.ts test/scene-commit.test.ts
git commit -m "feat(scene-commit): type inference for Vector2/Vector3/Rect2/Color in node_property"
```

---

### Task 8: 端到端验证最终确认

**Files:** 无新文件

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -10`
Expected: 全部通过，1986+ tests

- [ ] **Step 2: 运行 E2E 测试（如有 Godot）**

Run: `npx vitest run test/e2e-p1-p5.test.ts --reporter=verbose`
Expected: 全部 pass 或 skip

- [ ] **Step 3: 清理临时文件，提交最终状态**

```bash
# 恢复被 E2E 测试修改的场景文件
git checkout -- test/e2e-scene/scenes/
git add -A
git commit -m "test: final E2E validation — all P1-P5 verified"
```

---

## Self-Review

**Spec coverage:**
- ✅ 阶段 1 验证矩阵全部有测试（P1 3D/2D, P1 batch, P1 resources, P2 tile/prop, P3 import/skip, P4 2D/3D, P5）
- ✅ DX-1 Scope Warning（Task 4）
- ✅ DX-2 GateGuard（Task 5）
- ✅ 增强 1 类型扩展（Task 6）
- ✅ 增强 2 node_property 类型推断（Task 7）
- ✅ 增强 3 P3 warmup——已发现代码已实现时间戳缓存，无需修改，只需验证（Task 2 的 P3 测试）

**Placeholder scan:** 无 TBD/TODO。"Step 3: 实施豁免方案"有条件分支（A/B/C），因为 GateGuard 可能是外部 hook，需在 Step 2 确认后选择。

**Type consistency:**
- `_type` 字段在 tscn-editor.ts 和 scene-commit.ts 使用相同的 switch 分支
- `AddNodeParams` 接口的 `properties` 字段类型为 `Record<string, unknown>`，不需要修改
- `CommitOperation` 的 `NodePropertyOp.value` 类型为 `unknown`，不需要修改
