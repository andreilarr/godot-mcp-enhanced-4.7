import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { parseGodotConfig } from '../../build/helpers.js';

// opsScript 指向编译后的 godot_operations.gd
const OPS_SCRIPT = join(dirname(import.meta.url.replace('file:///', '').replace('file://', '')),
  '..', '..', 'build', 'scripts', 'godot_operations.gd');

/** 创建最小 ToolContext mock */
export function createToolContext(projectPath) {
  return {
    opsScript: OPS_SCRIPT,
    findGodot: async () => { throw new Error('findGodot not overridden'); },
    runningProcess: null,
    setRunningProcess: () => {},
    outputBuffer: [],
    setOutputBuffer: () => {},
    processStartTime: 0,
    setProcessStartTime: () => {},
    projectDir: projectPath,
    setProjectDir: () => {},
    parseGodotConfig,
  };
}

/** 创建临时 Godot 项目目录 */
export function createTempProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'godot-inttest-'));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }
  return dir;
}

/** 注册清理回调（在 describe 顶层调用） */
export function registerCleanup(dirRef) {
  afterEach(() => {
    if (dirRef.path) {
      try { rmSync(dirRef.path, { recursive: true, force: true }); } catch {}
      dirRef.path = null;
    }
  });
}
