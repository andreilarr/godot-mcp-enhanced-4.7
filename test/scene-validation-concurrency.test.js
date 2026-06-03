// A-12/A-13/A-14: scene_path 输入校验 + edit_node/remove_node 并发控制 + 回归测试
import { expect, it, beforeEach, afterEach, describe, vi } from 'vitest';

// Mock the executor — hoisted by Vitest
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [{ key: 'result', value: '{"ok":true}' }],
    raw_output: '', duration_ms: 100,
  })),
  parseMcpMarkers: vi.fn((raw) => ({
    parsed: null,
    logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
  })),
}));

import * as scene from '../src/tools/scene.js';
import { createToolContext, createTempProject, registerCleanup } from './helpers/tool-context.js';
import { MINIMAL_PROJECT } from './helpers/fixtures.js';
import { resetState, getShortRunningCount, acquireShortRunningSlot, releaseShortRunningSlot } from '../src/core/process-state.js';

describe('A-12: scene_path validation', () => {
  const dirRef = { path: null };
  let ctx;

  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => 'godot';
  });

  // --- read_scene: missing scene_path ---
  it('read_scene — missing scene_path returns INVALID_PARAMS', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'read_scene',
    }, ctx);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('INVALID_PARAMS');
    expect(text).toContain('scene_path');
  });

  // --- read_scene: empty string scene_path ---
  it('read_scene — empty string scene_path returns INVALID_PARAMS', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'read_scene',
      scene_path: '',
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
  });

  // --- read_scene: non-string scene_path ---
  it('read_scene — numeric scene_path returns INVALID_PARAMS', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'read_scene',
      scene_path: 123,
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
  });

  // --- edit_node: missing scene_path ---
  it('edit_node — missing scene_path returns INVALID_PARAMS', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'edit_node',
      node_path: 'root/Root/SomeNode',
      properties: { position: [1, 2] },
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
    expect(result.content[0].text).toContain('scene_path');
  });

  // --- edit_node: null scene_path ---
  it('edit_node — null scene_path returns INVALID_PARAMS', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'edit_node',
      scene_path: null,
      node_path: 'root/Root/SomeNode',
      properties: { position: [1, 2] },
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
  });

  // --- remove_node: missing scene_path ---
  it('remove_node — missing scene_path returns INVALID_PARAMS', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'remove_node',
      node_path: 'root/Root/SomeNode',
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
    expect(result.content[0].text).toContain('scene_path');
  });

  // --- remove_node: empty string scene_path ---
  it('remove_node — empty string scene_path returns INVALID_PARAMS', async () => {
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'remove_node',
      scene_path: '   ',
      node_path: 'root/Root/SomeNode',
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INVALID_PARAMS');
  });
});

describe('A-13: edit_node/remove_node concurrency control', () => {
  const dirRef = { path: null };
  let ctx;

  registerCleanup(dirRef);

  beforeEach(() => {
    resetState();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
    ctx.findGodot = async () => 'godot';
  });

  afterEach(() => {
    resetState();
  });

  // --- edit_node: slot acquired and released ---
  it('edit_node — acquires and releases slot on success', async () => {
    expect(getShortRunningCount()).toBe(0);
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'edit_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/SomeNode',
      properties: { position: [1, 2] },
    }, ctx);
    // Slot should be released after completion
    expect(getShortRunningCount()).toBe(0);
    // Result should be successful (mock returns success)
    expect(result.isError).toBeFalsy();
  });

  // --- edit_node: slot released on validation error ---
  it('edit_node — releases slot when validation fails (no properties)', async () => {
    expect(getShortRunningCount()).toBe(0);
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'edit_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/SomeNode',
      properties: {},
    }, ctx);
    // Slot should still be released even after validation error
    expect(getShortRunningCount()).toBe(0);
    expect(result.isError).toBe(true);
  });

  // --- edit_node: slot released on findGodot error ---
  it('edit_node — releases slot when findGodot throws', async () => {
    ctx.findGodot = async () => { throw new Error('Godot not found'); };
    expect(getShortRunningCount()).toBe(0);

    await expect(async () => {
      await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'edit_node',
        scene_path: 'res://scenes/main.tscn',
        node_path: 'root/Root/SomeNode',
        properties: { position: [1, 2] },
      }, ctx);
    }).rejects.toThrow('Godot not found');

    expect(getShortRunningCount()).toBe(0);
  });

  // --- remove_node: slot acquired and released ---
  it('remove_node — acquires and releases slot on success', async () => {
    expect(getShortRunningCount()).toBe(0);
    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'remove_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/SomeNode',
    }, ctx);
    expect(getShortRunningCount()).toBe(0);
    expect(result.isError).toBeFalsy();
  });

  // --- remove_node: slot released on findGodot error ---
  it('remove_node — releases slot when findGodot throws', async () => {
    ctx.findGodot = async () => { throw new Error('Godot not found'); };
    expect(getShortRunningCount()).toBe(0);

    await expect(async () => {
      await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'remove_node',
        scene_path: 'res://scenes/main.tscn',
        node_path: 'root/Root/SomeNode',
      }, ctx);
    }).rejects.toThrow('Godot not found');

    expect(getShortRunningCount()).toBe(0);
  });

  // --- edit_node: blocked when slots exhausted ---
  it('edit_node — returns CONCURRENCY_LIMIT when all slots taken', async () => {
    // Fill all 3 slots
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    expect(getShortRunningCount()).toBe(3);

    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'edit_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/SomeNode',
      properties: { position: [1, 2] },
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CONCURRENCY_LIMIT');

    // Clean up
    releaseShortRunningSlot();
    releaseShortRunningSlot();
    releaseShortRunningSlot();
  });

  // --- remove_node: blocked when slots exhausted ---
  it('remove_node — returns CONCURRENCY_LIMIT when all slots taken', async () => {
    acquireShortRunningSlot();
    acquireShortRunningSlot();
    acquireShortRunningSlot();

    const result = await scene.handleTool('scene', {
      project_path: dirRef.path,
      action: 'remove_node',
      scene_path: 'res://scenes/main.tscn',
      node_path: 'root/Root/SomeNode',
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('CONCURRENCY_LIMIT');

    releaseShortRunningSlot();
    releaseShortRunningSlot();
    releaseShortRunningSlot();
  });
});

describe('A-14: regression — findGodot failure releases slot (create_scene)', () => {
  const dirRef = { path: null };
  let ctx;

  registerCleanup(dirRef);

  beforeEach(() => {
    resetState();
    dirRef.path = createTempProject(MINIMAL_PROJECT);
    ctx = createToolContext(dirRef.path);
  });

  afterEach(() => {
    resetState();
  });

  it('create_scene — findGodot failure releases slot', async () => {
    ctx.findGodot = async () => { throw new Error('No Godot binary'); };
    expect(getShortRunningCount()).toBe(0);

    await expect(async () => {
      await scene.handleTool('scene', {
        project_path: dirRef.path,
        action: 'create_scene',
        scene_path: 'res://scenes/test.tscn',
        root_node_type: 'Node2D',
      }, ctx);
    }).rejects.toThrow('No Godot binary');

    expect(getShortRunningCount()).toBe(0);
  });
});
