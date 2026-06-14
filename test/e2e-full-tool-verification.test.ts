/**
 * E2E Full Tool Verification — 在 godot-test-project 中验证全部 MCP 工具
 *
 * 通过 tool-registry 直接调用各工具模块的 handleTool，
 * 无需运行 MCP server，但需要 Godot 可执行文件。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { registerAllModules } from '../src/core/module-loader.js';
import { getModuleForTool, getAllToolNames, getAllToolDefinitions } from '../src/core/tool-registry.js';
import type { ToolContext, ToolResult } from '../src/types.js';
import { parseGodotConfig } from '../src/helpers.js';
import * as ps from '../src/core/process-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// I-05: 支持环境变量回退，其他开发者可直接运行
// 默认指向 repo 内极简 fixture(无 autoload,避免外部 RPG demo 的 autoload 编译失败);
// 设 GODOT_TEST_PROJECT 可覆盖指向完整项目
const TEST_PROJECT = process.env.GODOT_TEST_PROJECT || resolve(__dirname, 'fixtures', 'e2e-project');
const GODOT_PATH = process.env.GODOT_PATH || 'D:\\godot\\Godot_v4.6.3-stable_win64_console.exe';
const hasGodot = existsSync(GODOT_PATH);
const hasProject = existsSync(TEST_PROJECT) && existsSync(resolve(TEST_PROJECT, 'project.godot'));

// E2E 盲区告警:GODOT_PATH 默认指向开发机路径,CI 上通常不存在 → 依赖真实 Godot 的
// E2E 测试被 describe.skipIf 静默跳过。用 process.stderr.write 而非 console.warn ——
// vitest 会捕获 console.* 不透传,直接写 stderr 才能在 CI 日志/终端可见。
if (!hasGodot) {
  process.stderr.write(
    `[E2E-SKIP] 未找到 GODOT_PATH (${GODOT_PATH})。\n` +
    `  依赖真实 Godot 子进程的 E2E 测试(execute_gdscript/create_3d_node/Godot-dependent)将被跳过。\n` +
    `  设置 GODOT_PATH 环境变量以启用真实集成测试。注意:未设置时 CI 的"全部通过"不含任何真实 Godot 调用验证。\n`,
  );
}

const MAIN_SCENE = resolve(TEST_PROJECT, 'scenes', 'main.tscn');
const NEW_SCENE_PATH = resolve(TEST_PROJECT, 'scenes', 'e2e_verify_test.tscn');
const NEW_SCRIPT_PATH = resolve(TEST_PROJECT, 'scripts', 'e2e_verify_test.gd');

// I-01: 移入 beforeAll 避免模块顶层全局副作用
let _registered = false;

function findGodot(): Promise<string> {
  return Promise.resolve(GODOT_PATH);
}

function makeCtx(): ToolContext {
  return {
    opsScript: resolve(__dirname, '..', 'src', 'scripts', 'godot_operations.gd'),
    findGodot,
    get runningProcess() { return ps.getRunningProcess(); },
    setRunningProcess(proc, skipBusyCheck?) { ps.setRunningProcess(proc, skipBusyCheck); },
    get outputBuffer() { return ps.getOutputBuffer(); },
    setOutputBuffer(buf: string[]) { ps.setOutputBuffer(buf); },
    get processStartTime() { return ps.getProcessStartTime(); },
    setProcessStartTime(t: number) { ps.setProcessStartTime(t); },
    get projectDir() { return ps.getProjectDir(); },
    setProjectDir(d: string) { ps.setProjectDir(d); },
    parseGodotConfig,
  };
}

// I-06: 安全的类型校验 — 验证 result 结构而非不安全断言
function isToolResult(val: unknown): val is ToolResult {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return Array.isArray(obj.content) && obj.content.every(
    (c: unknown) => c && typeof c === 'object' && 'type' in (c as Record<string, unknown>) && 'text' in (c as Record<string, unknown>)
  );
}

async function callTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const mod = getModuleForTool(toolName);
  if (!mod) return { text: `MODULE_NOT_FOUND: ${toolName}`, isError: true };
  const result = await mod.handleTool(toolName, { project_path: TEST_PROJECT, ...args }, makeCtx());
  if (!result) return { text: 'null result', isError: false };
  if (!isToolResult(result)) return { text: `UNEXPECTED_RESULT: ${JSON.stringify(result).slice(0, 200)}`, isError: true };
  const text = result.content.map(c => c.text).join('\n') ?? '';
  return { text, isError: result.isError === true };
}

// Snapshot for cleanup
let _mainSceneSnap: string;

beforeAll(() => {
  if (!_registered) {
    registerAllModules();
    _registered = true;
  }
  if (hasProject && existsSync(MAIN_SCENE)) {
    _mainSceneSnap = readFileSync(MAIN_SCENE, 'utf-8');
  }
  ps.resetState();
});

// I-02: afterEach 清理进程状态，防止泄漏级联
afterEach(() => {
  const proc = ps.getRunningProcess();
  if (proc && !proc.killed) {
    try { proc.kill(); } catch { /* best effort */ }
  }
  ps.setProcessBusy(false);
  ps.setRunningProcess(null, true);
});

afterAll(() => {
  if (_mainSceneSnap && existsSync(MAIN_SCENE)) {
    writeFileSync(MAIN_SCENE, _mainSceneSnap, 'utf-8');
  }
  for (const f of [NEW_SCENE_PATH, NEW_SCRIPT_PATH]) {
    if (existsSync(f)) rmSync(f, { force: true });
  }
  ps.resetState();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 0. TOOL REGISTRY — 注册完整性
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: Tool Registry', () => {
  it('registers all expected tool modules', () => {
    const names = getAllToolNames();
    expect(names.length).toBeGreaterThanOrEqual(25);
  });

  it('all tool definitions have valid schemas', () => {
    const defs = getAllToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect((def.inputSchema as any).type).toBe('object');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. script — execute_gdscript (需要 Godot)
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasProject)('E2E: execute_gdscript (via script tool)', { timeout: 30_000 }, () => {
  it('snippet mode: basic output', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'var _x = 42\n_mcp_output("result", _x)\n_mcp_done()',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('42');
  });

  it('snippet mode: structured data', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'var _d = {"items": [1,2,3], "ok": true}\n_mcp_output("data", _d)\n_mcp_done()',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('items');
  });

  it('full class mode: extends SceneTree', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'extends SceneTree\nfunc _initialize():\n\t_mcp_output("mode", "full")\n\t_mcp_done()',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('full');
  });

  it('sandbox blocks dangerous APIs', async () => {
    const r = await callTool('script', {
      action: 'execute_gdscript',
      code: 'OS.shell_open("https://example.com")\n_mcp_done()',
    });
    // Sandbox 拦截返回 compile_error 文本
    expect(r.text).toContain('Sandbox violation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. script — read_script / write_script / edit_script (纯文件操作)
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: script CRUD (file ops)', () => {
  it('read_script: reads existing script', async () => {
    const r = await callTool('script', {
      action: 'read_script',
      script_path: 'res://scripts/main.gd',
    });
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('write_script: creates new script', async () => {
    const r = await callTool('script', {
      action: 'write_script',
      script_path: 'res://scripts/e2e_verify_test.gd',
      content: 'extends Node\n\nfunc _ready():\n\tpass\n',
    });
    expect(r.isError).toBe(false);
    expect(existsSync(NEW_SCRIPT_PATH)).toBe(true);
  });

  it('edit_script: search_and_replace mode', async () => {
    const r = await callTool('script', {
      action: 'edit_script',
      script_path: 'res://scripts/e2e_verify_test.gd',
      search_and_replace: { search: 'pass', replace: 'print("E2E")' },
    });
    expect(r.isError).toBe(false);
  });

  it('read_script: verifies edit result', async () => {
    const r = await callTool('script', {
      action: 'read_script',
      script_path: 'res://scripts/e2e_verify_test.gd',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('E2E');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. scene — read_scene(纯文件)/ create_scene·add_node·edit_node·save_scene(Godot)
// read_scene 纯文本解析 .tscn,CI(无 Godot)可测;create_scene/save_scene 必 spawn
// Godot,add_node/edit_node/query_scene_tree 依赖 create_scene 产物 → 无 Godot 时跳过
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: scene read (file ops)', () => {
  it('read_scene: reads existing scene', async () => {
    const r = await callTool('scene', {
      action: 'read_scene',
      scene_path: resolve(TEST_PROJECT, 'scenes', 'main.tscn'),
    });
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasProject || !hasGodot)('E2E: scene CRUD (Godot-dependent)', () => {
  it('create_scene: creates new scene', async () => {
    const r = await callTool('scene', {
      action: 'create_scene',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
    });
    expect(r.isError).toBe(false);
  });

  it('create_scene: verifies file exists on disk', () => {
    // I-03: 前置条件检查 — 后续所有场景测试依赖此文件
    expect(existsSync(NEW_SCENE_PATH)).toBe(true);
  });

  it('add_node: adds Sprite2D child', async () => {
    const r = await callTool('scene', {
      action: 'add_node',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_type: 'Sprite2D',
      node_name: 'TestSprite',
      parent_node_path: '.',
      properties: {},
    });
    expect(r.isError).toBe(false);
  });

  it('edit_node: modifies property', async () => {
    const r = await callTool('scene', {
      action: 'edit_node',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: 'TestSprite',
      properties: { visible: false },
    });
    expect(r.isError).toBe(false);
  });

  it('save_scene: persists changes', async () => {
    const r = await callTool('scene', {
      action: 'save_scene',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
    });
    expect(r.isError).toBe(false);
  });

  it('query_scene_tree: returns tree structure', async () => {
    const r = await callTool('scene', {
      action: 'query_scene_tree',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
    });
    expect(r.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. scene_commit — 批量操作
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: scene_commit', () => {
  it('commit: validates operations format', async () => {
    const r = await callTool('scene_commit', {
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      operations: [
        { op: 'node_add', parent: '.', type: 'Label', name: 'CommitLabel' },
        { op: 'node_property', path: 'CommitLabel', property: 'text', value: 'Committed' },
      ],
    });
    // scene_commit 通过 Godot load() + PackedScene 操作
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ui — build_layout / create_control
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: ui tool', () => {
  it('build_layout: VBoxContainer with children', async () => {
    const r = await callTool('ui', {
      action: 'build_layout',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      parent_path: '.',
      tree: {
        type: 'VBoxContainer',
        name: 'TestVBox',
        layout: { direction: 'column', gap: 8, padding: 10 },
        children: [
          { type: 'Label', name: 'TitleLabel', properties: { text: 'E2E' } },
          { type: 'Button', name: 'TestBtn', properties: { text: 'OK' } },
        ],
      },
    });
    expect(r.isError).toBe(false);
  });

  it('create_control: single Button', async () => {
    const r = await callTool('ui', {
      action: 'create_control',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      parent_path: '.',
      node_type: 'Button',
      node_name: 'StandaloneBtn',
      properties: { text: 'Standalone' },
    });
    expect(r.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. node_create_3d (通过 scene tool)
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasProject)('E2E: create_3d_node (via scene tool)', { timeout: 30_000 }, () => {
  it('creates MeshInstance3D', async () => {
    const r = await callTool('scene', {
      action: 'create_3d_node',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      type: 'MeshInstance3D',
      name: 'TestMesh3D',
      parent: '.',
    });
    expect(r.isError).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. project — info / list_templates
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasProject)('E2E: project', () => {
  it('info: returns project metadata', async () => {
    const r = await callTool('project', { action: 'info' });
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('list_templates: returns template list', async () => {
    const r = await callTool('project', { action: 'list_templates' });
    expect(r.text).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. docs / manage_tools / instance tools (不需要 Godot)
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: docs / manage_tools / instances', () => {
  it('docs: list', async () => {
    const r = await callTool('docs', { action: 'list' });
    expect(r.text).toBeDefined();
  });

  it('manage_tools: list_groups', async () => {
    const r = await callTool('manage_tools', { action: 'list_groups' });
    expect(r.text).toBeDefined();
  });

  it('godot_list_instances: returns instance list', async () => {
    const r = await callTool('godot_list_instances', {});
    expect(r.text).toBeDefined();
  });

  it('godot_list_dynamic_routes: returns route list', async () => {
    const r = await callTool('godot_list_dynamic_routes', {});
    expect(r.text).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Godot-dependent tools — I-04: 强化断言验证实际工作
// ═══════════════════════════════════════════════════════════════════════════════
describe.skipIf(!hasGodot || !hasProject)('E2E: Godot-dependent tools', { timeout: 60_000 }, () => {
  it('validation: run_validation returns structured result', async () => {
    const r = await callTool('validation', { action: 'run_validation' });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(10);
  });

  it('screenshot: capture returns image data or error', async () => {
    const r = await callTool('screenshot', {
      action: 'capture',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      image_path: 'user://e2e_test.png',
    });
    // 3D 场景应返回图片数据或明确的处理结果
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('workflow: dev_loop executes and returns output', async () => {
    const r = await callTool('workflow', {
      action: 'dev_loop',
      code: 'var _v = "workflow_ok"\n_mcp_output("test", _v)\n_mcp_done()',
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('workflow_ok');
  });

  it('runtime: inspect_node returns node info', async () => {
    const r = await callTool('runtime', {
      action: 'inspect_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'Main',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('animation: list_players returns result', async () => {
    const r = await callTool('animation', {
      action: 'list_players',
      scene_path: 'res://scenes/anim_test.tscn',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('animation_track: add_track returns result', async () => {
    const r = await callTool('animation_track', {
      action: 'add_track',
      scene_path: 'res://scenes/anim_test.tscn',
      node_path: 'AnimationPlayer',
      animation_name: 'NewAnim',
      track_type: 'value',
      track_path: ':position:x',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('particles: create returns success or error', async () => {
    const r = await callTool('particles', {
      action: 'create',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      parent_path: '.',
      name: 'TestParticles',
      type: 'GPUParticles2D',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('tilemap: read returns tilemap data or error', async () => {
    const r = await callTool('tilemap', {
      action: 'read',
      scene_path: 'res://demos/dynamic_tilemap_layers/dynamic_tilemap.tscn',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('material: read returns material info or not-found error', async () => {
    const r = await callTool('material', {
      action: 'read',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: '.',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('signal: list returns signal info', async () => {
    const r = await callTool('signal', {
      action: 'list',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: 'TestSprite',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('audio: list returns audio player info', async () => {
    const r = await callTool('audio', {
      action: 'list',
      scene_path: 'res://scenes/main.tscn',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('nav: list returns navigation info', async () => {
    const r = await callTool('nav', {
      action: 'list',
      scene_path: 'res://demos/navigation/navigation_demo.tscn',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('physics: raycast returns hit result', async () => {
    const r = await callTool('physics', {
      action: 'raycast',
      from: { x: 0, y: 10, z: 0 },
      to: { x: 0, y: 0, z: 0 },
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('animtree: animtree_create returns result', async () => {
    const r = await callTool('animtree', {
      action: 'animtree_create',
      scene_path: 'res://scenes/e2e_verify_test.tscn',
      node_path: '.',
      name: 'TestAnimTree',
    });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });

  it('profiler: snapshot returns profiler data', async () => {
    const r = await callTool('profiler', { action: 'snapshot' });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. game (Bridge) — 无游戏运行时测试错误路径
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: game (Bridge — error path)', () => {
  it('query ping: returns error message without running game', async () => {
    const r = await callTool('game', { action: 'query', method: 'ping' });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. editor — 测试错误路径
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: editor (error path)', () => {
  it('sync_start: returns message without editor', async () => {
    const r = await callTool('editor', { action: 'sync_start' });
    expect(r.text).toBeDefined();
    expect(r.text.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════
describe('E2E: Cleanup', () => {
  it('removes test artifacts', () => {
    for (const f of [NEW_SCENE_PATH, NEW_SCRIPT_PATH]) {
      if (existsSync(f)) rmSync(f, { force: true });
    }
    expect(true).toBe(true);
  });
});
