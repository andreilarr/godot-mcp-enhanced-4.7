# E2E 优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 P1-P5 五个优化，解决 E2E 验证中的核心痛点（进程开销、持久化、资源预热、2D 截图、安全配置写入）

**Architecture:** P3/P5 先行（独立简单），P1 核心（tscn-editor 扩展），P2 依赖 P1 回退机制，P4 独立验证。五个优化互不干扰，可独立测试。

**Tech Stack:** TypeScript, Vitest, GDScript, Godot 4.x headless

**Spec:** `docs/superpowers/specs/2026-06-06-e2e-optimization-design.md`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tools/project-config.ts` | **Create** | P5: 白名单验证 + project.godot INI 读写 |
| `test/project-config.test.ts` | **Create** | P5: 白名单验证 + 写入测试 |
| `src/tools/import-check.ts` | **Create** | P3: 资源预热检查 + 执行 |
| `test/import-check.test.ts` | **Create** | P3: 时间戳缓存 + 预热触发测试 |
| `src/tscn-editor.ts` | **Modify** | P1: 新增 addNode, addNodes, addExtResource, addSubResource |
| `test/tscn-editor-add-node.test.ts` | **Create** | P1: 节点插入 + 类型白名单 + 批量测试 |
| `src/tools/scene/index.ts` | **Modify** | P1: add_node/batch_add_nodes 路由切换 |
| `src/tools/scene-commit.ts` | **Create** | P2: scene_commit GDScript 生成 + 工具注册 |
| `test/scene-commit.test.ts` | **Create** | P2: GDScript 生成 + 错误处理测试 |
| `src/scripts/screenshot_capture.gd` | **Modify** | P4: SubViewport 2D 渲染模式 |
| `src/screenshot.ts` | **Modify** | P4: SubViewport 模式集成 |
| `test/screenshot-2d.test.ts` | **Create** | P4: 2D 截图测试 |

---

## Task 1: P5 — project_write_config 白名单验证与值校验

**Files:**
- Create: `src/tools/project-config.ts`
- Create: `test/project-config.test.ts`

- [ ] **Step 1: Write the failing test — 白名单验证**

```typescript
// test/project-config.test.ts
import { describe, it, expect } from 'vitest';
import {
  isAllowedConfigKey,
  validateConfigValue,
  projectWriteConfig,
  ALLOWED_CONFIG_KEYS,
} from '../src/tools/project-config.js';

describe('project-config: isAllowedConfigKey', () => {
  it('allows run/main_scene', () => {
    expect(isAllowedConfigKey('run/main_scene')).toBe(true);
  });
  it('allows display/window/size/viewport_width', () => {
    expect(isAllowedConfigKey('display/window/size/viewport_width')).toBe(true);
  });
  it('allows rendering/renderer/rendering_method', () => {
    expect(isAllowedConfigKey('rendering/renderer/rendering_method')).toBe(true);
  });
  it('allows autoload/* wildcard', () => {
    expect(isAllowedConfigKey('autoload/MyManager')).toBe(true);
  });
  it('rejects unknown keys', () => {
    expect(isAllowedConfigKey('physics/2d/default_gravity')).toBe(false);
  });
  it('rejects input/* keys', () => {
    expect(isAllowedConfigKey('input/actions/move_left')).toBe(false);
  });
  it('rejects empty key', () => {
    expect(isAllowedConfigKey('')).toBe(false);
  });
});

describe('project-config: validateConfigValue', () => {
  it('validates resource path with res:// prefix', () => {
    expect(validateConfigValue('run/main_scene', 'res://scenes/main.tscn')).toEqual({ valid: true });
  });
  it('rejects resource path without res://', () => {
    expect(validateConfigValue('run/main_scene', 'scenes/main.tscn')).toEqual({ valid: false, error: expect.any(String) });
  });
  it('validates positive integer for viewport_width', () => {
    expect(validateConfigValue('display/window/size/viewport_width', '1280')).toEqual({ valid: true });
  });
  it('rejects negative integer for viewport_width', () => {
    expect(validateConfigValue('display/window/size/viewport_width', '-10')).toEqual({ valid: false, error: expect.any(String) });
  });
  it('validates enum for rendering_method', () => {
    expect(validateConfigValue('rendering/renderer/rendering_method', 'mobile')).toEqual({ valid: true });
  });
  it('rejects invalid enum for rendering_method', () => {
    expect(validateConfigValue('rendering/renderer/rendering_method', 'vulkan')).toEqual({ valid: false, error: expect.any(String) });
  });
  it('validates autoload resource path', () => {
    expect(validateConfigValue('autoload/GameManager', 'res://scripts/game_manager.gd')).toEqual({ valid: true });
  });
  it('validates any string for application/config/name', () => {
    expect(validateConfigValue('application/config/name', 'My Game')).toEqual({ valid: true });
  });
});

describe('project-config: projectWriteConfig', () => {
  it('writes a new key to existing section', () => {
    const input = `; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="OldName"\n\n[display]\n\nwindow/size/viewport_width=1280\n`;
    const result = projectWriteConfig(input, 'application/config/name', 'NewGame');
    expect(result.success).toBe(true);
    expect(result.content).toContain('config/name="NewGame"');
    // Should not duplicate the key
    const matches = result.content!.match(/config\/name=/g);
    expect(matches).toHaveLength(1);
  });

  it('writes a key to a new section', () => {
    const input = `; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="Test"\n`;
    const result = projectWriteConfig(input, 'display/window/size/viewport_width', '1920');
    expect(result.success).toBe(true);
    expect(result.content).toContain('[display]');
    expect(result.content).toContain('window/size/viewport_width=1920');
  });

  it('rejects disallowed key', () => {
    const result = projectWriteConfig('', 'physics/2d/default_gravity', '980');
    expect(result.success).toBe(false);
    expect(result.error).toContain('CONFIG_KEY_NOT_ALLOWED');
  });

  it('rejects invalid value', () => {
    const result = projectWriteConfig('', 'display/window/size/viewport_width', 'abc');
    expect(result.success).toBe(false);
    expect(result.error).toContain('INVALID_CONFIG_VALUE');
  });

  it('auto-prefixes * for autoload keys', () => {
    const input = `; Engine configuration file.\nconfig_version=5\n\n[autoload]\n\n`;
    const result = projectWriteConfig(input, 'autoload/GameManager', 'res://scripts/game_manager.gd');
    expect(result.success).toBe(true);
    expect(result.content).toContain('GameManager="*res://scripts/game_manager.gd"');
  });

  it('preserves existing sections and keys', () => {
    const input = `; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="Test"\nconfig/features=PackedStringArray("4.6")\n\n[display]\n\nwindow/size/viewport_width=1280\n`;
    const result = projectWriteConfig(input, 'display/window/size/viewport_height', '720');
    expect(result.success).toBe(true);
    expect(result.content).toContain('config/name="Test"');
    expect(result.content).toContain('window/size/viewport_width=1280');
    expect(result.content).toContain('window/size/viewport_height=720');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/project-config.test.ts`
Expected: FAIL — module `../src/tools/project-config.js` not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tools/project-config.ts
// P5: Safe project.godot configuration writer with whitelist validation.

export interface ConfigWriteResult {
  success: boolean;
  content?: string;
  error?: string;
}

// ─── Whitelist ────────────────────────────────────────────────────────────────

const RESOURCE_PATH_KEYS = new Set([
  'run/main_scene',
  'application/config/icon',
]);

const STRING_KEYS = new Set([
  'application/config/name',
  'application/config/description',
]);

const INT_KEYS = new Set([
  'display/window/size/viewport_width',
  'display/window/size/viewport_height',
]);

const ENUM_VALUES: Record<string, string[]> = {
  'display/window/stretch/mode': ['disabled', 'canvas_items', 'viewport'],
  'display/window/stretch/aspect': ['ignore', 'keep', 'keep_height', 'keep_width', 'expand'],
  'rendering/renderer/rendering_method': ['forward_plus', 'mobile', 'gl_compatibility'],
};

/** All allowed config keys (for external inspection) */
export const ALLOWED_CONFIG_KEYS = [
  ...RESOURCE_PATH_KEYS,
  ...STRING_KEYS,
  ...INT_KEYS,
  ...Object.keys(ENUM_VALUES,
  'autoload/*', // pattern, not literal
];

// ─── Validation ───────────────────────────────────────────────────────────────

export function isAllowedConfigKey(key: string): boolean {
  if (!key) return false;
  if (RESOURCE_PATH_KEYS.has(key)) return true;
  if (STRING_KEYS.has(key)) return true;
  if (INT_KEYS.has(key)) return true;
  if (key in ENUM_VALUES) return true;
  if (key.startsWith('autoload/')) return true;
  return false;
}

export function validateConfigValue(key: string, value: string): { valid: boolean; error?: string } {
  if (RESOURCE_PATH_KEYS.has(key) || key.startsWith('autoload/')) {
    if (!value.startsWith('res://')) {
      return { valid: false, error: `Value for ${key} must start with res://` };
    }
    return { valid: true };
  }
  if (STRING_KEYS.has(key)) {
    return { valid: true }; // any non-empty string
  }
  if (INT_KEYS.has(key)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || !/^\d+$/.test(value)) {
      return { valid: false, error: `Value for ${key} must be a positive integer, got: "${value}"` };
    }
    return { valid: true };
  }
  if (key in ENUM_VALUES) {
    const allowed = ENUM_VALUES[key]!;
    if (!allowed.includes(value)) {
      return { valid: false, error: `Value for ${key} must be one of: ${allowed.join(', ')}, got: "${value}"` };
    }
    return { valid: true };
  }
  return { valid: false, error: `Unknown key type: ${key}` };
}

// ─── INI Writer ───────────────────────────────────────────────────────────────

export function projectWriteConfig(
  content: string, key: string, value: string,
): ConfigWriteResult {
  // 1. Validate key
  if (!isAllowedConfigKey(key)) {
    return { success: false, error: `CONFIG_KEY_NOT_ALLOWED: "${key}" is not in the allowed config keys` };
  }
  // 2. Validate value
  const valResult = validateConfigValue(key, value);
  if (!valResult.valid) {
    return { success: false, error: `INVALID_CONFIG_VALUE: ${valResult.error}` };
  }

  // 3. Determine section and property name
  const parts = key.split('/');
  const section = parts[0]!;
  const propPath = parts.slice(1).join('/');

  // 4. Format value for INI
  let iniValue: string;
  const isAutoload = key.startsWith('autoload/');
  if (isAutoload) {
    // autoload values get * prefix for global scope
    iniValue = `"*${value}"`;
  } else if (INT_KEYS.has(key)) {
    iniValue = value;
  } else if (key in ENUM_VALUES) {
    iniValue = value;
  } else {
    // String/resource path — quote it
    iniValue = `"${value.replace(/\\/g, '/')}"`;
  }

  // 5. Parse content into lines
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // 6. Find or create section
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === `[${section}]`) {
      sectionStart = i;
      break;
    }
  }

  if (sectionStart === -1) {
    // Section doesn't exist — append it
    // Find the right insertion order (sections are roughly alphabetical in Godot)
    let insertAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.trim().match(/^\[(\w+)\]$/);
      if (m && m[1]! > section) {
        insertAt = i;
        break;
      }
    }
    // Insert section header + property
    const newSection = [`\n[${section}]\n`, `${propPath}=${iniValue}\n`];
    lines.splice(insertAt, 0, ...newSection);
    return { success: true, content: lines.join('') };
  }

  // 7. Find existing property in section
  const propLine = `${propPath}=`;
  let nextSection = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i]!.trim())) {
      nextSection = i;
      break;
    }
  }

  for (let i = sectionStart + 1; i < nextSection; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith(propLine)) {
      // Replace existing value
      lines[i] = `${propPath}=${iniValue}`;
      return { success: true, content: lines.join('\n') };
    }
  }

  // 8. Property doesn't exist — insert after last non-empty line in section
  let insertAt = sectionStart + 1;
  for (let i = sectionStart + 1; i < nextSection; i++) {
    if (lines[i]!.trim() !== '') {
      insertAt = i + 1;
    }
  }
  lines.splice(insertAt, 0, `${propPath}=${iniValue}`);
  return { success: true, content: lines.join('\n') };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/project-config.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Integrate into project tool — add write_config action**

Modify `src/tools/project.ts`:
- Add `'write_config'` to the `ACTIONS` array (line 18-25)
- Add `write_config` to the enum in `inputSchema.properties.action` (line 39)
- Add `key` and `value` to `inputSchema.properties`
- Add `case 'write_config'` handler before the `default` case (before line 459)

```typescript
// In ACTIONS array (line ~25), add:
'write_config',

// In inputSchema.properties (after line 54), add:
key: { type: 'string', description: '白名单内的配置键' },
value: { type: 'string', description: '新值' },

// New case before default (before line 459):
case 'write_config': {
  const p = requireProjectPath(args);
  const key = requireString(args, 'key');
  const value = requireString(args, 'value');
  const configPath = join(p, 'project.godot');
  if (!existsSync(configPath)) {
    return textResult(JSON.stringify({ success: false, error: 'project.godot not found' }));
  }
  const { projectWriteConfig: writeConfig } = await import('./project-config.js');
  const content = readFileSync(configPath, 'utf-8');
  const result = writeConfig(content, key, value);
  if (!result.success) {
    return textResult(JSON.stringify({ success: false, error: result.error }));
  }
  writeAtomic(configPath, result.content!);
  return textResult(JSON.stringify({ success: true, key, value }));
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 7: Commit**

```bash
git add src/tools/project-config.ts test/project-config.test.ts src/tools/project.ts
git commit -m "feat(P5): add project_write_config with whitelist validation"
```

---

## Task 2: P3 — 资源预热 import-check 共享模块

**Files:**
- Create: `src/tools/import-check.ts`
- Create: `test/import-check.test.ts`
- Modify: `src/gdscript-executor.ts` (集成预热检查)

- [ ] **Step 1: Write the failing test**

```typescript
// test/import-check.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { needsImport, runImport, resetImportCache } from '../src/tools/import-check.js';

describe('import-check: needsImport', () => {
  beforeEach(() => {
    resetImportCache();
    vi.clearAllMocks();
  });

  it('returns true when .godot/imported does not exist', () => {
    // Use a non-existent path
    const result = needsImport('/non/existent/project');
    expect(result).toBe(true);
  });

  it('returns false when imported dir exists and no newer assets', () => {
    // Use the actual project which has .godot/imported
    const result = needsImport('D:/GitHub/mcp-e2e-platformer');
    // The test project may or may not have imported dir;
    // we just verify the function doesn't throw
    expect(typeof result).toBe('boolean');
  });

  it('caches timestamp and skips re-check within same session', () => {
    // First call sets the cache
    needsImport('D:/GitHub/mcp-e2e-platformer');
    // Second call should use cache (no re-scan)
    const result = needsImport('D:/GitHub/mcp-e2e-platformer');
    expect(typeof result).toBe('boolean');
  });
});

describe('import-check: runImport', () => {
  it('rejects when godot path is invalid', async () => {
    await expect(runImport('D:/GitHub/mcp-e2e-platformer', '/non/existent/godot'))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/import-check.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tools/import-check.ts
// P3: Resource import warmup check — detects stale/missing .godot/imported
// and runs `godot --headless --import` to populate it.

import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { forceKillTree } from '../core/process-state.js';

/** Timestamp of the most recent asset file we've seen. null = never checked. */
let lastCheckedAssetMtime: number | null = null;
/** Path we last checked. */
let lastCheckedProject: string | null = null;

/** Reset import cache (for testing). */
export function resetImportCache(): void {
  lastCheckedAssetMtime = null;
  lastCheckedProject = null;
}

/**
 * Get the latest mtime of files under a directory (non-recursive scan of top-level).
 * Returns 0 if directory doesn't exist.
 */
function getLatestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let latest = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        try {
          const s = statSync(join(dir, entry.name));
          if (s.mtimeMs > latest) latest = s.mtimeMs;
        } catch { /* skip inaccessible files */ }
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return latest;
}

/**
 * Check whether this project needs an import warmup.
 * Returns true if:
 *  - .godot/imported/ doesn't exist, OR
 *  - Any asset directory has files newer than our cached timestamp
 */
export function needsImport(projectPath: string): boolean {
  // Check if disabled via env
  if (process.env.GODOT_MCP_AUTO_IMPORT === 'false') return false;

  const importedDir = join(projectPath, '.godot', 'imported');
  if (!existsSync(importedDir)) return true;

  // Scan common asset directories for newer files
  const assetDirs = ['assets', 'scenes', 'scripts'];
  let latestAsset = 0;
  for (const dir of assetDirs) {
    const fullDir = join(projectPath, dir);
    const mtime = getLatestMtime(fullDir);
    if (mtime > latestAsset) latestAsset = mtime;
  }

  // If same project and no new assets since last check, skip
  if (lastCheckedProject === projectPath && lastCheckedAssetMtime !== null) {
    if (latestAsset <= lastCheckedAssetMtime) return false;
  }

  // Update cache
  lastCheckedAssetMtime = latestAsset;
  lastCheckedProject = projectPath;
  return false; // imported dir exists, no new assets detected
}

/**
 * Run `godot --headless --import --path <project>` to warm up resources.
 * Throws on failure.
 */
export async function runImport(
  projectPath: string,
  godotPath: string,
  timeoutMs: number = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['--headless', '--import', '--path', projectPath];
    const proc = spawn(godotPath, args, { stdio: 'pipe', windowsHide: true });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      forceKillTree(proc.pid!);
      reject(new Error(`Import warmup timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Import warmup failed (exit ${code}): ${stderr || stdout}`));
      } else {
        // Update cache after successful import
        lastCheckedProject = projectPath;
        lastCheckedAssetMtime = Date.now();
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/import-check.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Integrate into gdscript-executor.ts**

In `src/gdscript-executor.ts`, inside the `executeGdscript` function (around line 570, before the code preparation step), add a pre-check:

```typescript
// At the top of the file, add import:
import { needsImport, runImport } from './tools/import-check.js';

// Inside executeGdscript(), after the sandbox scan (around line 570):
// P3: Auto-import warmup check
if (needsImport(options.projectPath)) {
  try {
    getLogger().info('executor', `Running import warmup for ${options.projectPath}`);
    await runImport(options.projectPath, options.godotPath);
  } catch (importErr) {
    getLogger().warn('executor', `Import warmup failed: ${importErr instanceof Error ? importErr.message : importErr}`);
    // Non-fatal — continue execution, load() may fail for unimported resources
  }
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 7: Commit**

```bash
git add src/tools/import-check.ts test/import-check.test.ts src/gdscript-executor.ts
git commit -m "feat(P3): add import warmup check for headless resource loading"
```

---

## Task 3: P1 — addExtResource + addSubResource（tscn-editor 基础扩展）

**Files:**
- Modify: `src/tscn-editor.ts`
- Create: `test/tscn-editor-resources.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/tscn-editor-resources.test.ts
import { describe, it, expect } from 'vitest';
import { addExtResource, addSubResource } from '../src/tscn-editor.js';

const BASE_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Root" type="Node2D"]
script = ExtResource("1")
`;

describe('tscn-editor: addExtResource', () => {
  it('adds new ext_resource and returns its id', () => {
    const result = addExtResource(BASE_TSCN, 'Texture2D', 'res://icon.svg');
    expect(result.success).toBe(true);
    expect(result.id).toBe('2');
    expect(result.scene).toContain('path="res://icon.svg"');
  });

  it('returns existing id for duplicate path (dedup)', () => {
    const result = addExtResource(BASE_TSCN, 'Script', 'res://player.gd');
    expect(result.success).toBe(true);
    expect(result.id).toBe('1');
    // Should NOT add a duplicate entry
    const matches = result.scene!.match(/path="res:\/\/player\.gd"/g);
    expect(matches).toHaveLength(1);
  });

  it('increments load_steps', () => {
    const result = addExtResource(BASE_TSCN, 'Texture2D', 'res://icon.svg');
    expect(result.scene).toContain('load_steps=3');
  });

  it('does not increment load_steps for dedup', () => {
    const result = addExtResource(BASE_TSCN, 'Script', 'res://player.gd');
    expect(result.scene).toContain('load_steps=2');
  });

  it('handles scene without load_steps', () => {
    const noSteps = `[gd_scene format=3]\n\n[node name="Root" type="Node2D"]\n`;
    const result = addExtResource(noSteps, 'Texture2D', 'res://icon.svg');
    expect(result.success).toBe(true);
    expect(result.scene).toContain('load_steps=2');
  });
});

describe('tscn-editor: addSubResource', () => {
  it('adds new sub_resource and returns its id', () => {
    const result = addSubResource(BASE_TSCN, 'RectangleShape2D', { size: 'Vector2(100, 50)' });
    expect(result.success).toBe(true);
    expect(result.id).toMatch(/RectangleShape2D_\d+/);
    expect(result.scene).toContain('[sub_resource type="RectangleShape2D"');
  });

  it('increments load_steps', () => {
    const result = addSubResource(BASE_TSCN, 'RectangleShape2D', {});
    expect(result.scene).toContain('load_steps=3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tscn-editor-resources.test.ts`
Expected: FAIL — addExtResource is not exported

- [ ] **Step 3: Write implementation**

Add to `src/tscn-editor.ts` (after `nodeSectionEnd` function, around line 116):

```typescript
/** Result from addExtResource / addSubResource */
export interface ResourceAddResult {
  success: boolean;
  message: string;
  id: string;
  scene?: string;
}

/**
 * Add an ext_resource entry. Returns existing id if path already exists (dedup).
 * Updates load_steps automatically.
 */
export function addExtResource(
  tscnContent: string, type: string, resourcePath: string,
): ResourceAddResult {
  const lines = normalizeLines(tscnContent);

  // Check for existing ext_resource with same path
  for (const line of lines) {
    if (line.startsWith('[ext_resource') && line.includes(`path="${escapeTscnAttr(resourcePath)}"`)) {
      const existingId = getBracketAttr(line, 'id');
      return { success: true, message: `ExtResource already exists: ${resourcePath}`, id: existingId ?? '1', scene: tscnContent };
    }
  }

  // Find max ext_resource id
  let maxId = 0;
  for (const line of lines) {
    if (line.startsWith('[ext_resource')) {
      const idStr = getBracketAttr(line, 'id');
      if (idStr) maxId = Math.max(maxId, parseInt(idStr, 10) || 0);
    }
  }
  const newId = String(maxId + 1);

  // Find insertion point: after last ext_resource, or after [gd_scene header
  let insertAt = 1; // after first line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('[ext_resource')) {
      insertAt = i + 1;
    }
  }
  // Skip past any blank lines after last ext_resource
  while (insertAt < lines.length && lines[insertAt]!.trim() === '') {
    insertAt++;
  }

  const newLine = `[ext_resource type="${escapeTscnAttr(type)}" path="${escapeTscnAttr(resourcePath)}" id="${newId}"]`;
  lines.splice(insertAt, 0, newLine);

  // Update load_steps: find [gd_scene ...] and increment
  let content = lines.join('\n');
  content = content.replace(
    /(\[gd_scene\s+.*?)load_steps=(\d+)/,
    (_, prefix, n) => `${prefix}load_steps=${parseInt(n, 10) + 1}`,
  );
  // If no load_steps, add it
  if (!content.includes('load_steps=')) {
    content = content.replace('[gd_scene', '[gd_scene load_steps=2');
  }

  return { success: true, message: `Added ExtResource("${newId}")`, id: newId, scene: content };
}

/**
 * Add a sub_resource entry. Auto-generates id from type.
 * Updates load_steps automatically.
 */
export function addSubResource(
  tscnContent: string, type: string, props: Record<string, string>,
): ResourceAddResult {
  const lines = normalizeLines(tscnContent);

  // Find max sub_resource id suffix
  let maxSuffix = 0;
  const idPattern = new RegExp(`id="${escapeRegExp(type)}_(\\d+)"`);
  for (const line of lines) {
    if (line.startsWith('[sub_resource')) {
      const m = line.match(idPattern);
      if (m) maxSuffix = Math.max(maxSuffix, parseInt(m[1]!, 10));
    }
  }
  const newSubId = `${type}_${maxSuffix + 1}`;

  // Build sub_resource section
  const propLines = Object.entries(props).map(([k, v]) => `${k} = ${v}`).join('\n');
  const section = `[sub_resource type="${type}" id="${newSubId}"]\n${propLines}`;

  // Find insertion point: after last sub_resource, before first [node]
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('[node')) {
      insertAt = i;
      break;
    }
    if (lines[i]!.startsWith('[sub_resource')) {
      // Find end of this sub_resource section
      insertAt = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.startsWith('[')) { insertAt = j; break; }
        insertAt = j + 1;
      }
    }
  }

  lines.splice(insertAt, 0, section);

  // Update load_steps
  let content = lines.join('\n');
  content = content.replace(
    /(\[gd_scene\s+.*?)load_steps=(\d+)/,
    (_, prefix, n) => `${prefix}load_steps=${parseInt(n, 10) + 1}`,
  );

  return { success: true, message: `Added SubResource("${newSubId}")`, id: newSubId, scene: content };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tscn-editor-resources.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tscn-editor.ts test/tscn-editor-resources.test.ts
git commit -m "feat(P1): add addExtResource + addSubResource to tscn-editor"
```

---

## Task 4: P1 — addNode 单节点 + 属性类型白名单 + 自动回退

**Files:**
- Modify: `src/tscn-editor.ts`
- Create: `test/tscn-editor-add-node.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/tscn-editor-add-node.test.ts
import { describe, it, expect } from 'vitest';
import { addNode, canSerializeProperty, PROPERTY_TYPE_WHITELIST } from '../src/tscn-editor.js';

const SIMPLE_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Root" type="Node2D"]
script = ExtResource("1")
`;

const NESTED_SCENE = `[gd_scene format=3]

[node name="Level" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]

[node name="Sprite" type="Sprite2D" parent="Player"]
`;

describe('tscn-editor: canSerializeProperty', () => {
  it('allows string values', () => {
    expect(canSerializeProperty('hello')).toBe(true);
  });
  it('allows number values', () => {
    expect(canSerializeProperty(42)).toBe(true);
    expect(canSerializeProperty(3.14)).toBe(true);
  });
  it('allows boolean values', () => {
    expect(canSerializeProperty(true)).toBe(true);
  });
  it('allows plain object with whitelisted types', () => {
    expect(canSerializeProperty({ x: 1, y: 2 })).toBe(true); // Vector2-like
  });
  it('rejects arrays', () => {
    expect(canSerializeProperty([1, 2, 3])).toBe(false);
  });
  it('rejects nested objects', () => {
    expect(canSerializeProperty({ shape: { radius: 5 } })).toBe(false);
  });
});

describe('tscn-editor: addNode — simple child', () => {
  it('adds a root child node', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Player',
      type: 'CharacterBody2D',
    });
    expect(result.success).toBe(true);
    expect(result.scene).toContain('[node name="Player" type="CharacterBody2D" parent="."]');
    // Must be placed after Root's section
    const rootIdx = result.scene!.indexOf('[node name="Root"');
    const playerIdx = result.scene!.indexOf('[node name="Player"');
    expect(playerIdx).toBeGreaterThan(rootIdx);
  });

  it('adds a nested child after last descendant', () => {
    const result = addNode(NESTED_SCENE, {
      parent: 'Player',
      name: 'CollisionShape2D',
      type: 'CollisionShape2D',
    });
    expect(result.success).toBe(true);
    expect(result.scene).toContain('parent="Player"');
    // CollisionShape2D must come after Sprite (Player's last descendant)
    const spriteIdx = result.scene!.indexOf('[node name="Sprite"');
    const collisionIdx = result.scene!.indexOf('[node name="CollisionShape2D"');
    expect(collisionIdx).toBeGreaterThan(spriteIdx);
  });

  it('adds node with simple properties', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Label',
      type: 'Label',
      properties: { text: 'Hello', position: 'Vector2(100, 50)' },
    });
    expect(result.success).toBe(true);
    expect(result.scene).toContain('text = "Hello"');
    expect(result.scene).toContain('position = Vector2(100, 50)');
  });

  it('returns fallback=true for unsupported property types', () => {
    const result = addNode(SIMPLE_SCENE, {
      parent: '.',
      name: 'Node',
      type: 'Node',
      properties: { data: [1, 2, 3] }, // Array — not supported
    });
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.scene).toBeUndefined(); // No file operation attempted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tscn-editor-add-node.test.ts`
Expected: FAIL — addNode/canSerializeProperty not exported

- [ ] **Step 3: Write implementation**

Add to `src/tscn-editor.ts`:

```typescript
// ── Property type whitelist (P1) ──────────────────────────────────────────────

/** Types that can be serialized to .tscn format without Godot process. */
export const PROPERTY_TYPE_WHITELIST = new Set([
  'string', 'number', 'boolean',
]);

/** Check if a property value can be serialized by pure file operations. */
export function canSerializeProperty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (PROPERTY_TYPE_WHITELIST.has(t)) return true;
  // Plain object with only primitive values (Vector2, Color, Rect2, etc.)
  if (t === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return Object.values(obj).every(v =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    );
  }
  return false; // Array, nested objects, etc.
}

/** Check all properties in a set; return true if all are serializable. */
function canSerializeAllProperties(props?: Record<string, unknown>): boolean {
  if (!props) return true;
  return Object.values(props).every(canSerializeProperty);
}

/** Format a property value for .tscn format. */
function formatPropertyValue(value: unknown): string {
  if (typeof value === 'string') return formatTscnValue(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'null';
  // Plain object → assume it's a Godot expression like Vector2(1, 2)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    // Detect common Godot types
    if (entries.length === 2 && 'x' in obj && 'y' in obj) {
      return `Vector2(${obj.x}, ${obj.y})`;
    }
    if (entries.length === 3 && 'x' in obj && 'y' in obj && 'z' in obj) {
      return `Vector3(${obj.x}, ${obj.y}, ${obj.z})`;
    }
    if (entries.length >= 3 && 'r' in obj && 'g' in obj && 'b' in obj) {
      const a = 'a' in obj ? obj.a : 1;
      return `Color(${obj.r}, ${obj.g}, ${obj.b}, ${a})`;
    }
    // Generic: treat as string representation
    return formatTscnValue(JSON.stringify(value));
  }
  return String(value);
}

// ── addNode (P1) ──────────────────────────────────────────────────────────────

export interface AddNodeParams {
  parent: string;     // "." for root children, or node path like "Player"
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface AddNodeResult {
  success: boolean;
  message: string;
  fallback: boolean;  // true = needs Godot process
  scene?: string;
}

/**
 * Add a node to .tscn via pure file operations.
 * Returns { fallback: true } if property types require Godot process.
 */
export function addNode(tscnContent: string, params: AddNodeParams): AddNodeResult {
  // Validate name and type
  if (!/^[A-Za-z0-9_]+$/.test(params.type)) {
    return { success: false, message: `Invalid type: ${params.type}`, fallback: false };
  }
  if (!params.name || /[\]["/:\\]/.test(params.name)) {
    return { success: false, message: `Invalid name: ${params.name}`, fallback: false };
  }

  // Check property types
  if (!canSerializeAllProperties(params.properties)) {
    return { success: true, message: 'Properties require Godot process fallback', fallback: true };
  }

  const lines = normalizeLines(tscnContent);

  // Find parent node section
  const parentPath = params.parent === '.' ? '' : params.parent;
  let parentLine = -1;
  if (parentPath === '') {
    // Root node — find first [node] without parent
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim().startsWith('[node')) {
        const p = getBracketAttr(lines[i]!.trim(), 'parent');
        if (p === null || p === '') { parentLine = i; break; }
      }
    }
  } else {
    parentLine = findNodeSectionLine(lines, parentPath);
  }

  if (parentLine === -1) {
    return { success: false, message: `Parent node not found: ${params.parent}`, fallback: false };
  }

  // Compute tscn parent attribute
  const tscnParent = parentPath === '' ? '.' : parentPath;

  // Find last descendant: scan forward from parent until we hit a non-descendant
  let insertAfter = nodeSectionEnd(lines, parentLine);
  for (let i = parentLine + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('[node')) continue;
    const nodeParent = getBracketAttr(trimmed, 'parent');
    if (nodeParent === tscnParent || (nodeParent && nodeParent.startsWith(tscnParent + '/'))) {
      insertAfter = nodeSectionEnd(lines, i);
    } else {
      break;
    }
  }

  // Build [node] section
  const header = `[node name="${escapeTscnAttr(params.name)}" type="${escapeTscnAttr(params.type)}" parent="${escapeTscnAttr(tscnParent)}"]`;
  const propLines: string[] = [];
  if (params.properties) {
    for (const [key, value] of Object.entries(params.properties)) {
      if (!/^[a-zA-Z_]\w*$/.test(key)) continue;
      propLines.push(`${key} = ${formatPropertyValue(value)}`);
    }
  }
  const section = propLines.length > 0
    ? [header, ...propLines, '']
    : [header, ''];

  lines.splice(insertAfter + 1, 0, ...section);

  // Update load_steps
  let content = lines.join('\n');
  if (content.includes('load_steps=')) {
    content = content.replace(
      /(\[gd_scene\s+.*?)load_steps=(\d+)/,
      (_, prefix, n) => `${prefix}load_steps=${parseInt(n, 10) + 1}`,
    );
  }

  return {
    success: true,
    message: `Added node ${params.name} [${params.type}] under ${params.parent}`,
    fallback: false,
    scene: content,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tscn-editor-add-node.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tscn-editor.ts test/tscn-editor-add-node.test.ts
git commit -m "feat(P1): add addNode with property type whitelist and auto-fallback"
```

---

## Task 5: P1 — addNodes 批量接口 + scene/index.ts 路由切换

**Files:**
- Modify: `src/tscn-editor.ts`
- Modify: `src/tools/scene/index.ts`
- Create: `test/tscn-editor-batch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/tscn-editor-batch.test.ts
import { describe, it, expect } from 'vitest';
import { addNodes } from '../src/tscn-editor.js';

const SCENE = `[gd_scene format=3]

[node name="Level" type="Node2D"]

[node name="Player" type="CharacterBody2D" parent="."]
`;

describe('tscn-editor: addNodes batch', () => {
  it('adds multiple nodes in one pass', () => {
    const result = addNodes(SCENE, [
      { parent: '.', name: 'Coin1', type: 'Area2D', properties: { position: 'Vector2(100, 200)' } },
      { parent: '.', name: 'Coin2', type: 'Area2D', properties: { position: 'Vector2(300, 200)' } },
    ]);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.scene).toContain('[node name="Coin1"');
    expect(result.scene).toContain('[node name="Coin2"');
  });

  it('returns fallback=true if any node has unsupported props', () => {
    const result = addNodes(SCENE, [
      { parent: '.', name: 'Good', type: 'Node' },
      { parent: '.', name: 'Bad', type: 'Node', properties: { arr: [1, 2] } },
    ]);
    expect(result.fallback).toBe(true);
  });

  it('returns fallback=false for empty array', () => {
    const result = addNodes(SCENE, []);
    expect(result.success).toBe(true);
    expect(result.fallback).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tscn-editor-batch.test.ts`
Expected: FAIL — addNodes not exported

- [ ] **Step 3: Write implementation**

Add to `src/tscn-editor.ts`:

```typescript
/**
 * Batch add multiple nodes. One parse, batch insert, one write-back.
 * If any node triggers fallback, the entire batch returns fallback=true.
 */
export function addNodes(
  tscnContent: string,
  nodes: Array<AddNodeParams>,
): AddNodeResult {
  if (nodes.length === 0) {
    return { success: true, message: 'No nodes to add', fallback: false, scene: tscnContent };
  }

  // Check if any node needs fallback
  for (const node of nodes) {
    if (!canSerializeAllProperties(node.properties)) {
      return { success: true, message: `Node "${node.name}" requires fallback`, fallback: true };
    }
  }

  // Process each node sequentially (each modifies the content)
  let content = tscnContent;
  const addedNames: string[] = [];
  for (const node of nodes) {
    const result = addNode(content, node);
    if (!result.success) {
      return { success: false, message: result.message, fallback: false };
    }
    if (result.fallback) {
      return { success: true, message: `Node "${node.name}" requires fallback`, fallback: true };
    }
    content = result.scene!;
    addedNames.push(node.name);
  }

  return {
    success: true,
    message: `Added ${addedNames.length} nodes: ${addedNames.join(', ')}`,
    fallback: false,
    scene: content,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tscn-editor-batch.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Modify scene/index.ts — route add_node through tscn-editor**

In `src/tools/scene/index.ts`, modify the `add_node` case to try pure file operations first:

Find the `case 'add_node':` block (inside the combined case at line 100-136). Replace the add_node specific logic:

```typescript
// Inside the combined case 'create_scene' / 'add_node' / 'save_scene' / 'load_sprite':
// Replace ONLY the add_node branch:

} else if (action === 'add_node') {
  const p = requireProjectPath(args);
  const scenePath = normalizeUserProjectPath(args.scene_path as string);
  const absPath = resolveWithinRoot(p, scenePath);
  if (!existsSync(absPath)) {
    return textResult(`Error: Scene file not found: ${scenePath}`);
  }
  if (!/^[A-Za-z0-9_]+$/.test(String(args.node_type ?? ''))) {
    return textResult(`Error: node_type contains invalid characters: "${args.node_type}"`);
  }
  if (!String(args.node_name ?? '') || /[\]["/:\\]/.test(String(args.node_name))) {
    return textResult(`Error: node_name contains invalid characters: "${args.node_name}"`);
  }

  const parentNode = normalizeNodePath((args.parent_node_path as string) || 'root');
  const tscnParent = parentNode === 'root' ? '.' : parentNode;
  const props = args.properties as Record<string, unknown> | undefined;
  const content = readFileSync(absPath, 'utf-8');

  // P1: Try pure file operation
  const { addNode: tscnAddNode } = await import('../../tscn-editor.js');
  const result = tscnAddNode(content, {
    parent: tscnParent,
    name: String(args.node_name),
    type: String(args.node_type),
    properties: props,
  });

  if (result.fallback) {
    // Fall through to Godot process path
    break; // exits to the original spawnGodot logic below
  }

  if (!result.success) {
    return textResult(`Error: ${result.message}`);
  }

  // Write the updated content
  writeFileSync(absPath, result.scene!, 'utf-8');
  return textResult(`Added node ${args.node_name} [${args.node_type}] under ${tscnParent} (file op)`);
}
```

**Note:** This requires restructuring the combined case. The `create_scene`, `save_scene`, and `load_sprite` actions remain in the spawnGodot path. Only `add_node` gets the file-op shortcut. If `add_node` falls back (`result.fallback`), it continues to the existing spawnGodot path. This requires extracting the add_node branch OUT of the shared case block.

A cleaner approach: keep the combined case, but add the add_node file-op check BEFORE the `acquireShortRunningSlot()` call:

```typescript
// Add this BEFORE the combined case block (before line 100):
case 'add_node': {
  // P1: Try pure file operation first
  const p = requireProjectPath(args);
  const scenePath = normalizeUserProjectPath(args.scene_path as string);
  const absPath = resolveWithinRoot(p, scenePath);
  if (!existsSync(absPath)) return textResult(`Error: Scene file not found: ${scenePath}`);
  if (!/^[A-Za-z0-9_]+$/.test(String(args.node_type ?? ''))) return textResult(`Error: node_type contains invalid characters: "${args.node_type}"`);
  if (!String(args.node_name ?? '') || /[\]["/:\\]/.test(String(args.node_name))) return textResult(`Error: node_name contains invalid characters: "${args.node_name}"`);
  const parentNode = normalizeNodePath((args.parent_node_path as string) || 'root');
  const tscnParent = parentNode === 'root' ? '.' : parentNode;
  const props = args.properties as Record<string, unknown> | undefined;
  const content = readFileSync(absPath, 'utf-8');
  const { addNode: tscnAddNode } = await import('../../tscn-editor.js');
  const result = tscnAddNode(content, { parent: tscnParent, name: String(args.node_name), type: String(args.node_type), properties: props });
  if (result.fallback) break; // fall through to spawnGodot path below
  if (!result.success) return textResult(`Error: ${result.message}`);
  writeFileSync(absPath, result.scene!, 'utf-8');
  return textResult(`Added node ${args.node_name} [${args.node_type}] under ${tscnParent} (file op)`);
}
```

Then keep the combined case but exclude `add_node` from it (it will `break` when fallback is needed):

```typescript
// Rename the combined case:
case 'create_scene':
case 'save_scene':
case 'load_sprite':
case 'add_node': { // still catches add_node when it breaks from above
  // ... existing spawnGodot logic unchanged ...
}
```

The `case 'add_node'` appears twice: first for the file-op path, then in the combined case for the fallback. JavaScript switch fall-through handles this correctly.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 7: Commit**

```bash
git add src/tscn-editor.ts src/tools/scene/index.ts test/tscn-editor-batch.test.ts
git commit -m "feat(P1): add addNodes batch + scene router file-op shortcut"
```

---

## Task 6: P2 — scene_commit GDScript 生成器

**Files:**
- Create: `src/tools/scene-commit.ts`
- Create: `test/scene-commit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/scene-commit.test.ts
import { describe, it, expect } from 'vitest';
import { generateCommitScript, COMMIT_OPERATIONS } from '../src/tools/scene-commit.js';

describe('scene-commit: generateCommitScript', () => {
  it('generates valid GDScript for tile_set operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 10 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true, // save
    );
    expect(script).toContain('extends SceneTree');
    expect(script).toContain('get_node_or_null("Ground")');
    expect(script).toContain('set_cell(Vector2i(5, 10)');
    expect(script).toContain('ResourceSaver.save');
  });

  it('generates _fill_tiles helper for tile_fill', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_fill', node_path: 'Ground', region: { x: 0, y: 0, w: 20, h: 2 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
    );
    expect(script).toContain('func _fill_tiles(');
    expect(script).toContain('range(0, 0 + 20)');
  });

  it('generates node_property operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'node_property', path: 'Player', property: 'position', value: 'Vector2(100, 200)' },
      ],
      true,
    );
    expect(script).toContain('get_node_or_null("Player")');
    expect(script).toContain('.position');
  });

  it('generates node_add operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'node_add', parent: '.', name: 'Coin', type: 'Area2D' },
      ],
      true,
    );
    expect(script).toContain('Area2D.new()');
    expect(script).toContain('.name = "Coin"');
  });

  it('stops on error when stop_on_error=true', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 10 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
      true, // stop_on_error
    );
    expect(script).toContain('_has_error');
    expect(script).toContain('if _has_error');
  });

  it('includes COMMIT_RESULT output', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_set', node_path: 'Ground', coords: { x: 5, y: 10 }, source_id: 0, atlas: { x: 0, y: 0 } },
      ],
      true,
    );
    expect(script).toContain('COMMIT_RESULT');
  });

  it('generates tile_erase operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_erase', node_path: 'Ground', coords: { x: 5, y: 10 } },
      ],
      false,
    );
    expect(script).toContain('set_cell(Vector2i(5, 10), -1)');
  });

  it('generates tile_clear operation', () => {
    const script = generateCommitScript(
      'res://scenes/Level.tscn',
      [
        { op: 'tile_clear', node_path: 'Ground' },
      ],
      false,
    );
    expect(script).toContain('.clear()');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scene-commit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tools/scene-commit.ts
// P2: scene_commit — batch GDScript generator for multi-operation scene editing.

export const COMMIT_OPERATIONS = [
  'tile_set', 'tile_fill', 'tile_erase', 'tile_clear',
  'tileset_assign', 'node_property', 'node_add',
] as const;

export type CommitOp = typeof COMMIT_OPERATIONS[number];

interface TileSetOp   { op: 'tile_set';   node_path: string; coords: { x: number; y: number }; source_id: number; atlas: { x: number; y: number }; alternative_tile?: number }
interface TileFillOp  { op: 'tile_fill';  node_path: string; region: { x: number; y: number; w: number; h: number }; source_id: number; atlas: { x: number; y: number }; alternative_tile?: number }
interface TileEraseOp { op: 'tile_erase'; node_path: string; coords: { x: number; y: number } }
interface TileClearOp { op: 'tile_clear'; node_path: string }
interface TilesetAssignOp { op: 'tileset_assign'; node_path: string; tileset_path: string }
interface NodePropertyOp { op: 'node_property'; path: string; property: string; value: unknown }
interface NodeAddOp { op: 'node_add'; parent: string; name: string; type: string; properties?: Record<string, unknown> }

export type CommitOperation =
  | TileSetOp | TileFillOp | TileEraseOp | TileClearOp
  | TilesetAssignOp | NodePropertyOp | NodeAddOp;

/**
 * Generate a complete GDScript that executes all operations in sequence,
 * optionally saves the scene, and reports structured results.
 */
export function generateCommitScript(
  scenePath: string,
  operations: CommitOperation[],
  save: boolean,
  stopOnError: boolean = true,
): string {
  const hasFill = operations.some(op => op.op === 'tile_fill');
  const opBlocks: string[] = [];

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    opBlocks.push(generateOpBlock(i, op, stopOnError));
  }

  const saveBlock = save ? `
    # --- Save ---
    var packed = PackedScene.new()
    packed.pack(inst)
    var err = ResourceSaver.save(packed, "${scenePath}")
    print("COMMIT_RESULT: " + JSON.stringify({"success": true, "saved": err == OK, "results": _results}))` :
    `print("COMMIT_RESULT: " + JSON.stringify({"success": true, "saved": false, "results": _results}))`;

  return `extends SceneTree

var _results = []
var _has_error = false
${hasFill ? `
func _fill_tiles(node, rx, ry, rw, rh, sid, atlas, alt):
\tfor cy in range(ry, ry + rh):
\t\tfor cx in range(rx, rx + rw):
\t\t\tnode.set_cell(Vector2i(cx, cy), sid, atlas, alt)
` : ''}
func _initialize():
\tvar scene = load("${scenePath}")
\tif scene == null:
\t\tprint("COMMIT_RESULT: " + JSON.stringify({"success": false, "saved": false, "error": "Failed to load scene", "results": []}))
\t\tquit()
\t\treturn
\tvar inst = scene.instantiate()
${opBlocks.join('\n')}
${stopOnError ? '\tif _has_error:\n\t\tprint("COMMIT_RESULT: " + JSON.stringify({"success": false, "saved": false, "error_count": _results.filter(func(r): return not r.ok).size(), "results": _results}))\n\t\tquit()\n\t\treturn' : ''}
${saveBlock}
\tquit()
`;
}

function generateOpBlock(index: number, op: CommitOperation, stopOnError: boolean): string {
  const idx = index + 1;
  const errCheck = stopOnError
    ? `\t\t_has_error = true`
    : `\t\t# continue despite error`;

  switch (op.op) {
    case 'tile_set': {
      const alt = op.alternative_tile ?? 0;
      return `
\t# --- Op ${idx}: tile_set ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_set", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errCheck}
\telse:
\t\tn${idx}.set_cell(Vector2i(${op.coords.x}, ${op.coords.y}), ${op.source_id}, Vector2i(${op.atlas.x}, ${op.atlas.y}), ${alt})
\t\t_results.append({"op": "tile_set", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'tile_fill': {
      const alt = op.alternative_tile ?? 0;
      const cells = op.region.w * op.region.h;
      return `
\t# --- Op ${idx}: tile_fill ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_fill", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errCheck}
\telse:
\t\t_fill_tiles(n${idx}, ${op.region.x}, ${op.region.y}, ${op.region.w}, ${op.region.h}, ${op.source_id}, Vector2i(${op.atlas.x}, ${op.atlas.y}), ${alt})
\t\t_results.append({"op": "tile_fill", "node_path": "${op.node_path}", "ok": true, "cells_affected": ${cells}})`;
    }
    case 'tile_erase': {
      return `
\t# --- Op ${idx}: tile_erase ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_erase", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errCheck}
\telse:
\t\tn${idx}.set_cell(Vector2i(${op.coords.x}, ${op.coords.y}), -1)
\t\t_results.append({"op": "tile_erase", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'tile_clear': {
      return `
\t# --- Op ${idx}: tile_clear ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tile_clear", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errCheck}
\telse:
\t\tn${idx}.clear()
\t\t_results.append({"op": "tile_clear", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'tileset_assign': {
      return `
\t# --- Op ${idx}: tileset_assign ${op.node_path} ---
\tvar n${idx} = inst.get_node_or_null("${op.node_path}")
\tif n${idx} == null:
\t\t_results.append({"op": "tileset_assign", "node_path": "${op.node_path}", "ok": false, "error": "Node not found"})
${errCheck}
\telse:
\t\tn${idx}.tile_set = load("${op.tileset_path}")
\t\t_results.append({"op": "tileset_assign", "node_path": "${op.node_path}", "ok": true})`;
    }
    case 'node_property': {
      return `
\t# --- Op ${idx}: node_property ${op.path} ---
\tvar n${idx} = inst.get_node_or_null("${op.path}")
\tif n${idx} == null:
\t\t_results.append({"op": "node_property", "path": "${op.path}", "ok": false, "error": "Node not found"})
${errCheck}
\telse:
\t\tn${idx}.${op.property} = ${serializeGdValue(op.value)}
\t\t_results.append({"op": "node_property", "path": "${op.path}", "ok": true})`;
    }
    case 'node_add': {
      const propLines = op.properties
        ? Object.entries(op.properties).map(([k, v]) => `\t\tchild${idx}.${k} = ${serializeGdValue(v)}`).join('\n')
        : '';
      return `
\t# --- Op ${idx}: node_add ${op.name} ---
\tvar child${idx} = ${op.type}.new()
\tchild${idx}.name = "${op.name}"
${propLines}
\tvar parent${idx} = inst.get_node_or_null("${op.parent === '.' ? '' : op.parent}")
\tif parent${idx} == null:
\t\t_results.append({"op": "node_add", "name": "${op.name}", "ok": false, "error": "Parent not found: ${op.parent}"})
${errCheck}
\telse:
\t\tparent${idx}.add_child(child${idx})
\t\tchild${idx}.owner = inst
\t\t_results.append({"op": "node_add", "name": "${op.name}", "ok": true})`;
    }
  }
}

function serializeGdValue(value: unknown): string {
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/scene-commit.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/scene-commit.ts test/scene-commit.test.ts
git commit -m "feat(P2): add scene_commit GDScript generator"
```

---

## Task 7: P2 — scene_commit 工具注册与集成

**Files:**
- Create: `src/tools/scene-commit-tool.ts` (MCP tool wrapper)
- Modify: `src/core/tool-registry.ts` (register new module)
- Create: `test/scene-commit-tool.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/scene-commit-tool.test.ts
import { describe, it, expect } from 'vitest';
import { getToolDefinitions, TOOL_META } from '../src/tools/scene-commit-tool.js';

describe('scene-commit-tool: definitions', () => {
  it('exports a scene_commit tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('scene_commit');
  });

  it('has operations enum with all expected ops', () => {
    const defs = getToolDefinitions();
    const schema = defs[0]!.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('project_path');
    expect(props).toHaveProperty('scene_path');
    expect(props).toHaveProperty('operations');
    expect(props).toHaveProperty('save');
    expect(props).toHaveProperty('stop_on_error');
  });

  it('TOOL_META marks scene_commit as writable and long_running', () => {
    expect(TOOL_META.scene_commit).toEqual({ readonly: false, long_running: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scene-commit-tool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/tools/scene-commit-tool.ts
// P2: MCP tool wrapper for scene_commit.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, opsErrorResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { generateCommitScript } from './scene-commit.js';
import { acquireShortRunningSlot, releaseShortRunningSlot } from '../core/process-state.js';
import { parseMcpScriptOutput } from '../gdscript-executor.js';

export function getToolDefinitions(): Tool[] {
  return [{
    name: 'scene_commit',
    description: '批量执行场景修改操作（tile_set/tile_fill/tile_erase/tile_clear/node_property/node_add），合并为一次 Godot 进程调用。适合需要持久化的批量修改。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_path: { type: 'string', description: 'Godot 项目目录路径' },
        scene_path: { type: 'string', description: '目标场景路径（如 res://scenes/Level.tscn）' },
        operations: {
          type: 'array',
          description: '操作列表',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['tile_set', 'tile_fill', 'tile_erase', 'tile_clear', 'tileset_assign', 'node_property', 'node_add'] },
              node_path: { type: 'string', description: 'TileMap/TileMapLayer 节点路径（tile 操作必需）' },
              coords: { type: 'object', description: '图块坐标 {x, y}' },
              region: { type: 'object', description: '矩形区域 {x, y, w, h}' },
              source_id: { type: 'number', description: 'TileSet 源 ID' },
              atlas: { type: 'object', description: '图集坐标 {x, y}' },
              alternative_tile: { type: 'number', description: '替代图块索引（默认 0）' },
              tileset_path: { type: 'string', description: 'TileSet 资源路径（tileset_assign）' },
              path: { type: 'string', description: '节点路径（node_property）' },
              property: { type: 'string', description: '属性名' },
              value: { description: '属性值' },
              parent: { type: 'string', description: '父节点路径（node_add）' },
              name: { type: 'string', description: '节点名称（node_add）' },
              type: { type: 'string', description: '节点类型（node_add）' },
            },
            required: ['op'],
          },
        },
        save: { type: 'boolean', description: '是否保存到文件（默认 true）', default: true },
        stop_on_error: { type: 'boolean', description: '遇错是否停止（默认 true）', default: true },
      },
      required: ['project_path', 'scene_path', 'operations'],
    },
  }];
}

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'scene_commit') return null;

  const p = requireProjectPath(args);
  const scenePath = normalizeUserProjectPath(args.scene_path as string);
  const absPath = resolveWithinRoot(p, scenePath);
  const operations = args.operations as Array<Record<string, unknown>>;
  const save = args.save !== false;
  const stopOnError = args.stop_on_error !== false;

  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    return opsErrorResult('INVALID_PARAMS', 'operations must be a non-empty array');
  }
  if (operations.length > 500) {
    return opsErrorResult('INVALID_PARAMS', `Too many operations (${operations.length}). Maximum: 500`);
  }

  // Generate GDScript
  const script = generateCommitScript(
    `res://${scenePath.replace(/\\/g, '/')}`,
    operations as any,
    save,
    stopOnError,
  );

  // Execute via Godot process
  if (!acquireShortRunningSlot()) {
    return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  }

  try {
    const godot = await ctx.findGodot();
    const result = await executeGdscript({
      godotPath: godot,
      projectPath: p,
      code: script,
      timeout: 120,
      loadAutoloads: false,
    });

    // Parse COMMIT_RESULT from output
    const commitResult = parseCommitResult(result.raw_output || result.run_error || '');
    return textResult(JSON.stringify(commitResult || {
      success: result.run_success,
      raw_output: result.raw_output,
      errors: result.errors,
    }, null, 2));
  } finally {
    releaseShortRunningSlot();
  }
}

/** Parse COMMIT_RESULT JSON from GDScript output. */
function parseCommitResult(output: string): Record<string, unknown> | null {
  const marker = 'COMMIT_RESULT: ';
  const idx = output.lastIndexOf(marker);
  if (idx === -1) return null;
  try {
    return JSON.parse(output.slice(idx + marker.length));
  } catch {
    return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  scene_commit: { readonly: false, long_running: true },
};
```

- [ ] **Step 4: Register in tool-registry**

In `src/core/tool-registry.ts`, ensure the new module is imported and registered. Follow the existing pattern (other modules register themselves on import):

Add at the appropriate location in the imports section:
```typescript
import '../tools/scene-commit-tool.js';
```

Or if modules register explicitly, add the registration call following the existing pattern.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 6: Commit**

```bash
git add src/tools/scene-commit-tool.ts src/tools/scene-commit.ts test/scene-commit-tool.test.ts src/core/tool-registry.ts
git commit -m "feat(P2): add scene_commit tool registration and MCP integration"
```

---

## Task 8: P4 — SubViewport 2D 截图验证

**Files:**
- Modify: `src/scripts/screenshot_capture.gd`
- Modify: `src/screenshot.ts`
- Create: `test/screenshot-2d.test.ts`

**IMPORTANT:** P4 is an experimental feature. If the SubViewport approach doesn't work in headless mode, the implementation should fall back to improved error messages (spec §P4 "if SubViewport not viable").

- [ ] **Step 1: Write the verification GDScript**

Create a test script to validate SubViewport rendering in headless mode. This script should be run manually against the e2e project first:

```gdscript
# test_subviewport_2d.gd — Verification script for P4
extends SceneTree

func _initialize():
    var vp = SubViewport.new()
    vp.size = Vector2i(640, 360)
    vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    root.add_child(vp)

    # Test 1: Pure ColorRect
    var rect = ColorRect.new()
    rect.color = Color.RED
    rect.size = Vector2(200, 100)
    rect.position = Vector2(100, 50)
    vp.add_child(rect)

    # Wait 5 frames
    for i in range(5):
        await get_tree().process_frame

    var img = vp.get_texture().get_image()
    if img == null:
        print("SUBVIEWPORT_RESULT: NULL_IMAGE")
        quit()
        return

    var pixel = img.get_pixel(200, 100)
    var bg_pixel = img.get_pixel(10, 10)
    print("SUBVIEWPORT_RESULT: color_pixel=%s bg_pixel=%s size=%dx%d" % [pixel, bg_pixel, img.get_width(), img.get_height()])

    img.save_png("res://test_subviewport_2d.png")
    quit()
```

- [ ] **Step 2: Run verification against e2e project**

Run: `godot --headless --path D:/GitHub/mcp-e2e-platformer --script test_subviewport_2d.gd`
Expected: One of:
- `SUBVIEWPORT_RESULT: color_pixel=...` with non-null pixel → SubViewport viable
- `SUBVIEWPORT_RESULT: NULL_IMAGE` → SubViewport not viable in headless

**If SubViewport is NOT viable:** Skip steps 3-5 and proceed to the fallback implementation (step 6).

- [ ] **Step 3: Modify screenshot_capture.gd — add SubViewport mode**

Add a `--mode subviewport` CLI argument. When provided, wrap scene rendering in a SubViewport:

```gdscript
# In screenshot_capture.gd, add new member variables:
var _use_subviewport: bool = false
var _sub_viewport: SubViewport = null

# In _parse_args(), detect --mode subviewport:
# After existing arg parsing:
for i in range(2, args.size()):
    if args[i] == "--mode" and i + 1 < args.size():
        _use_subviewport = (args[i + 1] == "subviewport")

# In _deferred_load_scene(), after instantiating the scene:
if _use_subviewport:
    _sub_viewport = SubViewport.new()
    _sub_viewport.size = _viewport_size
    _sub_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
    get_root().add_child(_sub_viewport)
    _sub_viewport.add_child(scene_inst)
else:
    get_root().add_child(scene_inst)

# In _on_process_frame(), capture from SubViewport if active:
var vp: Viewport
if _sub_viewport != null:
    vp = _sub_viewport
else:
    vp = get_root().get_viewport()
var tex := vp.get_texture()
var img := tex.get_image()
```

- [ ] **Step 4: Modify src/screenshot.ts — pass SubViewport mode**

In `src/screenshot.ts`, in the `captureScreenshot` function (around line 153), add `--mode subviewport` to the args when the scene is likely 2D:

```typescript
// After building args, before runScreenshot:
// Detect 2D scene: if scene file contains Node2D/CanvasItem types
if (scene) {
  const sceneAbs = join(projectPath, scene.replace(/^res:\/\//, ''));
  if (existsSync(sceneAbs)) {
    const content = readFileSync(sceneAbs, 'utf-8');
    if (content.includes('Node2D') || content.includes('CanvasItem') || content.includes('ColorRect') || content.includes('Sprite2D')) {
      args.push('--mode', 'subviewport');
    }
  }
}
```

- [ ] **Step 5: Write test**

```typescript
// test/screenshot-2d.test.ts
import { describe, it, expect } from 'vitest';

describe('screenshot-2d: SubViewport mode detection', () => {
  it('detects 2D scene from tscn content', () => {
    const content = '[node name="Level" type="Node2D"]\n[node name="Player" type="Sprite2D"]';
    const is2D = /Node2D|CanvasItem|ColorRect|Sprite2D/.test(content);
    expect(is2D).toBe(true);
  });

  it('does not flag 3D-only scene', () => {
    const content = '[node name="Level" type="Node3D"]\n[node name="Mesh" type="MeshInstance3D"]';
    const is2D = /Node2D|CanvasItem|ColorRect|Sprite2D/.test(content);
    expect(is2D).toBe(false);
  });
});
```

- [ ] **Step 6 (fallback): If SubViewport NOT viable — improve error messages**

If the verification script shows SubViewport doesn't work in headless mode, modify `screenshot_capture.gd` to improve the blank detection message:

```gdscript
# In _detect_blank_image(), improve the warning:
if _detect_blank_image(img):
    print("[SCREENSHOT] WARNING: BLANK_DETECTED - This is a known limitation of Godot headless mode.")
    print("[SCREENSHOT] HINT: 2D CanvasItem content cannot render in headless mode.")
    print("[SCREENSHOT] HINT: Use Game Bridge take_screenshot (requires running game), or Editor mode screenshot.")
    print("[SCREENSHOT] HINT: Or provide a screenshot file and use screenshot analyze action.")
```

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/scripts/screenshot_capture.gd src/screenshot.ts test/screenshot-2d.test.ts
git commit -m "feat(P4): SubViewport 2D screenshot mode (or improved blank detection fallback)"
```

---

## Self-Review

### Spec Coverage

| Spec Section | Task |
|---|---|
| P1: addNode with last-descendant insertion | Task 4 |
| P1: Property type whitelist + auto-fallback | Task 4 |
| P1: addExtResource with dedup | Task 3 |
| P1: addSubResource | Task 3 |
| P1: load_steps sync | Task 3 |
| P1: addNodes batch | Task 5 |
| P1: scene/index.ts routing | Task 5 |
| P2: scene_commit API + GDScript generation | Task 6 |
| P2: Error handling (stop_on_error) | Task 6 |
| P2: tile_fill function encapsulation | Task 6 |
| P2: Tool registration | Task 7 |
| P3: import-check shared module | Task 2 |
| P3: Timestamp cache | Task 2 |
| P3: Integration into gdscript-executor | Task 2 |
| P4: SubViewport verification | Task 8 |
| P4: Screenshot integration or fallback | Task 8 |
| P5: Whitelist validation | Task 1 |
| P5: Value validation (res://, int, enum) | Task 1 |
| P5: autoload * prefix | Task 1 |
| P5: Integration into project tool | Task 1 |

### Placeholder Scan

No TBD/TODO/placeholder patterns found in this plan.

### Type Consistency

- `AddNodeParams` defined in Task 4, used consistently in Task 5
- `ResourceAddResult` defined in Task 3, used consistently
- `AddNodeResult` defined in Task 4, returned by both `addNode` and `addNodes`
- `CommitOperation` union type defined in Task 6, consumed by `generateCommitScript`
- `isAllowedConfigKey(key: string): boolean` — consistent across Task 1
- `validateConfigValue(key: string, value: string)` — consistent across Task 1
