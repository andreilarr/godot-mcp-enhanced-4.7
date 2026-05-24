import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import {
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from '../build/tools/project.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir;

function createMockCtx() {
  return {
    opsScript: '/fake/ops.gd',
    findGodot: vi.fn(async () => '/fake/godot'),
    runningProcess: null,
    setRunningProcess: vi.fn(),
    outputBuffer: [],
    setOutputBuffer: vi.fn(),
    processStartTime: 0,
    setProcessStartTime: vi.fn(),
    projectDir: '/fake/project',
    setProjectDir: vi.fn(),
    parseGodotConfig: vi.fn(() => ({
      application: { name: 'TestProject', run_main_scene: 'res://main.tscn' },
    })),
  };
}

function makeTempDir() {
  tempDir = mkdtempSync(join(tmpdir(), 'godot-test-'));
  return tempDir;
}

function makeGodotProject(dir) {
  const projectGodot = [
    '; Engine config',
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="TestGame"',
    'run/main_scene="res://scenes/main.tscn"',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'project.godot'), projectGodot, 'utf-8');
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'player.gd'), 'extends Node2D', 'utf-8');
  writeFileSync(join(dir, 'scenes', 'main.tscn'), '[gd_scene]', 'utf-8');
}

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('project-tools getToolDefinitions', () => {
  it('returns a non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
  });

  it('has 5 tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(5);
    const names = defs.map(d => d.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('get_project_info');
    expect(names).toContain('list_files');
    expect(names).toContain('read_project_config');
    expect(names).toContain('create_project');
  });

  it('each definition has name, description, and inputSchema', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('project-tools TOOL_META', () => {
  it('has entries for all 5 tools', () => {
    expect(Object.keys(TOOL_META).length).toBe(5);
    expect(TOOL_META.list_projects).toBeDefined();
    expect(TOOL_META.get_project_info).toBeDefined();
    expect(TOOL_META.list_files).toBeDefined();
    expect(TOOL_META.read_project_config).toBeDefined();
    expect(TOOL_META.create_project).toBeDefined();
  });

  it('marks read operations as readonly', () => {
    expect(TOOL_META.list_projects.readonly).toBe(true);
    expect(TOOL_META.get_project_info.readonly).toBe(true);
    expect(TOOL_META.list_files.readonly).toBe(true);
    expect(TOOL_META.read_project_config.readonly).toBe(true);
  });

  it('marks create_project as non-readonly', () => {
    expect(TOOL_META.create_project.readonly).toBe(false);
  });
});

// ─── handleTool — unknown tool ──────────────────────────────────────────────

describe('project-tools handleTool — unknown tool', () => {
  it('returns null for an unrecognized tool name', async () => {
    const result = await handleTool('unknown_tool', {}, createMockCtx());
    expect(result).toBeNull();
  });
});

// ─── handleTool — list_projects ─────────────────────────────────────────────

describe('project-tools handleTool — list_projects', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty list when no projects found', async () => {
    const ctx = createMockCtx();
    // Create a bare temp dir with no project.godot
    const emptyDir = join(dir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    const result = await handleTool('list_projects', { search_dir: emptyDir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(0);
  });

  it('finds projects with project.godot', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await handleTool('list_projects', { search_dir: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.projects).toContain(dir);
  });
});

// ─── handleTool — get_project_info ──────────────────────────────────────────

describe('project-tools handleTool — get_project_info', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns error when project.godot missing', async () => {
    const ctx = createMockCtx();
    const emptyDir = join(dir, 'nogodot');
    mkdirSync(emptyDir, { recursive: true });

    const result = await handleTool('get_project_info', { project_path: emptyDir }, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No project.godot found');
  });

  it('returns project info for valid project', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await handleTool('get_project_info', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe('TestProject');
    expect(parsed.config).toBeDefined();
    expect(parsed.file_stats).toBeDefined();
  });
});

// ─── handleTool — list_files ────────────────────────────────────────────────

describe('project-tools handleTool — list_files', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists all files in project', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await handleTool('list_files', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBeGreaterThanOrEqual(3);
    expect(parsed.files.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by extension', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await handleTool('list_files', {
      project_path: dir,
      extensions: ['.gd'],
    }, ctx);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBeGreaterThanOrEqual(1);
    for (const f of parsed.files) {
      expect(f.endsWith('.gd')).toBe(true);
    }
  });
});

// ─── handleTool — read_project_config ───────────────────────────────────────

describe('project-tools handleTool — read_project_config', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns error when project.godot missing', async () => {
    const ctx = createMockCtx();
    const emptyDir = join(dir, 'nogodot');
    mkdirSync(emptyDir, { recursive: true });

    const result = await handleTool('read_project_config', { project_path: emptyDir }, ctx);
    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('No project.godot found');
  });

  it('parses project.godot via ctx.parseGodotConfig', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await handleTool('read_project_config', { project_path: dir }, ctx);
    expect(result).not.toBeNull();
    expect(ctx.parseGodotConfig).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toBeDefined();
  });
});

// ─── handleTool — create_project ────────────────────────────────────────────

describe('project-tools handleTool — create_project', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a new Godot project structure', async () => {
    const ctx = createMockCtx();
    const newProject = join(dir, 'NewGame');

    const result = await handleTool('create_project', {
      project_path: newProject,
      project_name: 'NewGame',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Project created successfully');
    expect(existsSync(join(newProject, 'project.godot'))).toBe(true);
    expect(existsSync(join(newProject, 'scenes', 'main.tscn'))).toBe(true);
    expect(existsSync(join(newProject, 'scripts', 'main.gd'))).toBe(true);
    expect(existsSync(join(newProject, 'assets'))).toBe(true);
  });

  it('refuses to create if project.godot already exists', async () => {
    const ctx = createMockCtx();
    makeGodotProject(dir);

    const result = await handleTool('create_project', {
      project_path: dir,
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('already exists');
  });

  it('returns error for invalid renderer', async () => {
    const ctx = createMockCtx();
    const newProject = join(dir, 'BadRenderer');

    const result = await handleTool('create_project', {
      project_path: newProject,
      renderer: 'invalid_renderer',
    }, ctx);

    expect(result).not.toBeNull();
    expect(result.content[0].text).toContain('Invalid renderer');
  });
});
