import { expect, it, describe, vi, beforeEach, afterEach } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  handleTool,
} from '../src/tools/batch-tools.js';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── getToolDefinitions ──────────────────────────────────────────────────────

describe('batch-tools getToolDefinitions', () => {
  it('returns non-empty array', () => {
    const defs = getToolDefinitions();
    expect(Array.isArray(defs)).toBeTruthy();
    expect(defs.length).toBeGreaterThan(0);
  });
  it('includes batch tool', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names.includes('batch')).toBeTruthy();
  });
  it('batch tool has action enum with create_files, run_verify, diff_scenes', () => {
    const defs = getToolDefinitions();
    const batch = defs.find(d => d.name === 'batch');
    const actionEnum = batch.inputSchema.properties.action.enum;
    expect(actionEnum).toContain('create_files');
    expect(actionEnum).toContain('run_verify');
    expect(actionEnum).toContain('diff_scenes');
  });
  it('returns exactly 1 merged tool', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe('batch');
  });
  it('each definition has name and inputSchema', () => {
    for (const def of getToolDefinitions()) {
      expect(def.name).toBeTruthy();
      expect(def.inputSchema).toBeTruthy();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

// ─── TOOL_META ───────────────────────────────────────────────────────────────

describe('batch-tools TOOL_META', () => {
  it('has entry for merged batch tool', () => {
    expect('batch' in TOOL_META).toBeTruthy();
  });
  it('batch is non-readonly and not long_running', () => {
    expect(TOOL_META.batch.readonly).toBe(false);
    expect(TOOL_META.batch.long_running).toBe(false);
  });
});

// ─── handleTool ──────────────────────────────────────────────────────────────

describe('batch-tools handleTool', () => {
  it('returns null for unknown tool', async () => {
    const result = await handleTool('unknown_tool', {}, {});
    expect(result).toBe(null);
  });

  it('returns null for unrelated tool name', async () => {
    const result = await handleTool('run_project', {}, {});
    expect(result).toBe(null);
  });

  it('batch create_files rejects empty files array', async () => {
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'create_files',
      files: [],
    }, {});
    expect(result).toBeTruthy();
    expect(result.content[0].text).toContain('error');
  });

  it('batch create_files rejects missing files', async () => {
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'create_files',
    }, {});
    expect(result).toBeTruthy();
    expect(result.content[0].text).toContain('error');
  });

  it('batch run_verify rejects empty scenes array', async () => {
    const result = await handleTool('batch', {
      project_path: '/fake/project',
      action: 'run_verify',
      scenes: [],
    }, { findGodot: async () => '/fake/godot' });
    expect(result).toBeTruthy();
    expect(result.content[0].text).toContain('error');
  });

  it('batch diff_scenes rejects non-existent scene files', async () => {
    const tmpDir = join(tmpdir(), `batch-test-diff-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const result = await handleTool('batch', {
        project_path: tmpDir,
        action: 'diff_scenes',
        scene_a: 'nonexistent_a.tscn',
        scene_b: 'nonexistent_b.tscn',
      }, {});
      expect(result).toBeTruthy();
      expect(result.content[0].text).toContain('not found');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── batch_create_files real file creation ────────────────────────────────────

describe('batch_create_files real file creation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `batch-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates files on disk', async () => {
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://test.txt', content: 'hello world' },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.failed).toBe(0);
    // Verify file actually exists
    expect(existsSync(join(tmpDir, 'test.txt'))).toBeTruthy();
  });

  it('creates multiple files', async () => {
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://a.txt', content: 'aaa' },
        { path: 'res://sub/b.txt', content: 'bbb' },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(2);
    expect(existsSync(join(tmpDir, 'a.txt'))).toBeTruthy();
    expect(existsSync(join(tmpDir, 'sub', 'b.txt'))).toBeTruthy();
  });

  it('skips existing files without overwrite', async () => {
    // Pre-create a file
    writeFileSync(join(tmpDir, 'existing.txt'), 'old', 'utf-8');
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://existing.txt', content: 'new' },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skipped).toBe(1);
    expect(parsed.created).toBe(0);
  });

  it('overwrites existing files with overwrite=true', async () => {
    writeFileSync(join(tmpDir, 'overwrite.txt'), 'old', 'utf-8');
    const ctx = { findGodot: vi.fn(async () => '/fake/godot') };
    const result = await handleTool('batch', {
      project_path: tmpDir,
      action: 'create_files',
      files: [
        { path: 'res://overwrite.txt', content: 'new', overwrite: true },
      ],
      validate: false,
    }, ctx);
    expect(result).toBeTruthy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(1);
    expect(parsed.skipped).toBe(0);
  });
});
