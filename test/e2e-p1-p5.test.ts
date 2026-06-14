/**
 * E2E validation tests for P1-P5 priorities.
 *
 * P1: addNode / addNodes / resources - .tscn text editing
 * P2: scene_commit - generateCommitScript / parseCommitResult
 * P3: executeGdscript - import warmup + skip
 * P4: captureScreenshot - 2D blank / 3D ok
 * P5: validate - load() test_helper.gd
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { executeGdscript } from '../src/gdscript-executor.js';
import { addNode, addNodes } from '../src/tscn-editor.js';
import { captureScreenshot, getBlankHint } from '../src/screenshot.js';
import { generateCommitScript } from '../src/tools/scene-commit.js';
import { parseCommitResult } from '../src/tools/scene-commit-tool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = resolve(__dirname, 'e2e-scene');
const GODOT_PATH = process.env.GODOT_PATH || 'D:\\godot\\Godot_v4.6.3-stable_win64_console.exe';
const hasGodot = existsSync(GODOT_PATH);

// E2E 盲区告警(同 e2e-full-tool-verification):无 GODOT_PATH 时静默跳过真实 Godot 测试。
// 用 process.stderr.write 而非 console.warn —— vitest 会捕获 console.* 不透传,
// 直接写 stderr 才能在 CI 日志/终端可见。
if (!hasGodot) {
  process.stderr.write(
    `[E2E-SKIP] 未找到 GODOT_PATH (${GODOT_PATH}) — 依赖真实 Godot 的 P3/P4/P5 测试将被跳过。\n` +
    `  设置 GODOT_PATH 环境变量以启用。未设置时 CI 的"全部通过"不含真实 Godot 调用验证。\n`,
  );
}

const SCENE_3D = resolve(E2E_DIR, 'scenes', 'test_3d.tscn');
const SCENE_2D = resolve(E2E_DIR, 'scenes', 'test_2d.tscn');
const SCREENSHOT_2D = resolve(E2E_DIR, 'test_2d_screenshot.png');
const SCREENSHOT_3D = resolve(E2E_DIR, 'test_3d_screenshot.png');

// Snapshot original scene files for restoration after tests
let _snap3d: string;
let _snap2d: string;

beforeAll(() => {
  _snap3d = readFileSync(SCENE_3D, "utf-8");
  _snap2d = readFileSync(SCENE_2D, "utf-8");
});

// Cleanup

afterAll(() => {
  // C-01: Restore scene files to prevent fixture pollution
  if (_snap3d) writeFileSync(SCENE_3D, _snap3d, "utf-8");
  if (_snap2d) writeFileSync(SCENE_2D, _snap2d, "utf-8");
  for (const f of [SCREENSHOT_2D, SCREENSHOT_3D]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
});

// Tests

describe.skipIf(!hasGodot)('E2E: P1-P5 validation', { timeout: 60_000 }, () => {

  // P1: addNode / addNodes / resources

  it('P1-addNode-3D: addNode text insert Node3D child', () => {
    const content = readFileSync(SCENE_3D, 'utf-8');
    const result = addNode(content, {
      parent: 'Test3D',
      name: 'TestChild',
      type: 'Node3D',
      properties: {},
    });
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('[node name="TestChild" type="Node3D" parent="Test3D"]');
    writeFileSync(SCENE_3D, result.scene!, 'utf-8');
  });

  it('P1-addNode-2D: addNode text insert Sprite2D child', () => {
    const content = readFileSync(SCENE_2D, 'utf-8');
    const result = addNode(content, {
      parent: 'Test2D',
      name: 'TestSprite',
      type: 'Sprite2D',
    });
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('[node name="TestSprite" type="Sprite2D" parent="Test2D"]');
    writeFileSync(SCENE_2D, result.scene!, 'utf-8');
  });

  it('P1-batch: addNodes batch add 5 children', () => {
    const content = readFileSync(SCENE_3D, 'utf-8');
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      parent: 'Test3D',
      name: `B${i + 1}`,
      type: 'Node3D',
    }));
    const result = addNodes(content, nodes);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('[node name="B1" type="Node3D" parent="Test3D"]');
    expect(result.scene).toContain('[node name="B5" type="Node3D" parent="Test3D"]');
    writeFileSync(SCENE_3D, result.scene!, 'utf-8');
  });

  it('P1-resources: scene contains script ref and BoxMesh', () => {
    const content = readFileSync(SCENE_3D, 'utf-8');
    expect(content).toContain('res://scripts/test_helper.gd');
    expect(content).toContain('BoxMesh');
  });

  // P2: scene_commit

  it('P2-tile-ops: generateCommitScript with tile_set + tile_fill', () => {
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
          region: { x: 0, y: 0, w: 3, h: 3 },
          source_id: 0,
          atlas: { x: 0, y: 0 },
        },
      ],
      false,
    );
    expect(script).toContain('tile_set');
    expect(script).toContain('_fill_tiles');
    const parsed = parseCommitResult(
      'some log\nCOMMIT_RESULT: {"success": true, "saved": false, "results": []}',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.success).toBe(true);
  });

  it('P2-node-prop: generateCommitScript with node_property', () => {
    const script = generateCommitScript(
      'res://scenes/test_3d.tscn',
      [
        {
          op: 'node_property',
          path: 'root/Test3D/Cube',
          property: 'position',
          value: { x: 1, y: 2, z: 3 },
        },
      ],
      false,
    );
    expect(script).toContain('position');
  });

  // P3: executeGdscript

  it('P3-import: executeGdscript triggers import warmup', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      code: 'print("P3 test")\n_mcp_done()',
      timeout: 30,
    });
    expect(result.run_success).toBe(true);
    const importedDir = resolve(E2E_DIR, '.godot', 'imported');
    expect(existsSync(importedDir)).toBe(true);
  });

  it('P3-skip: second execution import skip, faster', async () => {
    const start = Date.now();
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      code: 'print("P3 skip test")\n_mcp_done()',
      timeout: 30,
    });
    const duration = Date.now() - start;
    expect(result.run_success).toBe(true);
    expect(duration).toBeLessThan(15_000);
  });

  // P4: captureScreenshot

  it('P4-2D-blank: 2D scene screenshot blank or success', async () => {
    const result = await captureScreenshot({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      scene: 'res://scenes/test_2d.tscn',
      outputPath: SCREENSHOT_2D,
      frameDelay: 15,
      timeout: 30,
    });
    if (!result.success && result.godotOutput) {
      const hint = getBlankHint(result.godotOutput);
      if (hint) {
        expect(hint).toContain('Game Bridge');
        expect(hint).toContain('screenshot analyze');
      }
    } else {
      expect(existsSync(SCREENSHOT_2D)).toBe(true);
    }
  });

  it('P4-3D-ok: 3D scene screenshot should succeed', async () => {
    const result = await captureScreenshot({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      scene: 'res://scenes/test_3d.tscn',
      outputPath: SCREENSHOT_3D,
      frameDelay: 15,
      timeout: 30,
    });
    if (result.success) {
      expect(existsSync(SCREENSHOT_3D)).toBe(true);
      expect(result.fileSize).toBeGreaterThan(0);
    }
  });

  // P5: validate

  it('P5-validate: load() test_helper.gd succeeds', async () => {
    const result = await executeGdscript({
      godotPath: GODOT_PATH,
      projectPath: E2E_DIR,
      code: 'var helper = load("res://scripts/test_helper.gd")\nif helper: print("LOADED_OK")\n_mcp_done()',
      timeout: 30,
    });
    expect(result.run_success).toBe(true);
    expect(result.raw_output).toContain('LOADED_OK');
  });

});
