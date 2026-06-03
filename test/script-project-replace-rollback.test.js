import { expect, it, beforeEach, afterEach, describe, vi } from 'vitest';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Mock the executor
vi.mock('../src/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, compile_success: true, compile_error: '',
    errors: [], run_success: true, run_error: '',
    outputs: [], raw_output: '', duration_ms: 100,
  })),
  parseMcpMarkers: vi.fn((raw) => ({
    parsed: null,
    logLines: raw.split('\n').map((l) => l.trim()).filter(Boolean),
  })),
}));

vi.mock('../src/tools/validation.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    batchValidateScripts: vi.fn(() => Promise.resolve([
      { file: 'scripts/main.gd', errors: [], warnings: [] },
    ])),
  };
});

// 关键：mock 'fs' 模块的 renameSync，使用 hoisted 变量
let _renameMock = null;

vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    get renameSync() {
      return _renameMock ?? original.renameSync;
    },
  };
});

import * as script from '../src/tools/script.js';
import { createToolContext, createTempProject } from './helpers/tool-context.js';

describe('project_replace rollback on rename failure', () => {
  const dirRef = { path: null };
  let ctx;

  afterEach(() => {
    _renameMock = null;
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });

  beforeEach(() => {
    _renameMock = null;
    dirRef.path = createTempProject({
      'project.godot': '; Engine config\n[application]\nconfig/name="Test"\n',
      'scripts/a.gd': 'extends Node\n\nfunc foo():\n\told_name()\n',
      'scripts/b.gd': 'extends Node\n\nvar x = old_name\n',
    });
    ctx = createToolContext(dirRef.path);
  });

  it('returns ATOMIC_WRITE_FAILED and cleans up .tmp files on rename failure', async () => {
    // 让 renameSync 在第一次调用时抛异常
    let callCount = 0;
    _renameMock = () => {
      callCount++;
      throw new Error('Simulated rename failure');
    };

    const result = await script.handleTool('script', {
      project_path: dirRef.path,
      action: 'project_replace',
      search: 'old_name',
      replace: 'new_name',
      extensions: ['.gd'],
      dry_run: false,
    }, ctx);

    expect(result).toBeTruthy();
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('ATOMIC_WRITE_FAILED');
    expect(text).toContain('Simulated rename failure');

    // 确认没有残留 .tmp 文件
    const tmpFiles = readdirSync(join(dirRef.path, 'scripts')).filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});
