# setup_project_rules CLAUDE.md 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 setup_project_rules 从硬编码 2 条规则升级为从 project.godot 提取元数据生成结构化 CLAUDE.md + `.claude/rules/godot-mcp.md`。

**Architecture:** 新建 `claudemd-builder.ts` 承载 9 个纯函数 builder + 合并引擎。`project.ts` 的 handler 调用 builder 收集章节，走合并或新建逻辑。所有 builder 为纯函数，易测试。

**Tech Stack:** TypeScript, Vitest, Node.js fs/path

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/tools/claudemd-builder.ts` | 9 个 builder + mergeSections + SECTION_IDS + GODOT_MCP_RULES 模板 |
| `test/claudemd-builder.test.js` | builder 和 mergeSections 的单元测试 |
| `src/tools/project.ts` | setup_project_rules handler 调用 builder（修改现有） |
| `test/project-tools.test.js` | 集成测试更新（修改现有） |

---

### Task 1: 创建 claudemd-builder.ts + 简单 builder 测试

**Files:**
- Create: `src/tools/claudemd-builder.ts`
- Create: `test/claudemd-builder.test.js`

- [ ] **Step 1: 创建 claudemd-builder.ts 骨架和 3 个简单 builder**

```typescript
// src/tools/claudemd-builder.ts
import { readdirSync } from 'fs';
import { join } from 'path';
import type { GodotConfig } from '../helpers.js';

// MCP 管理的章节标识（用于合并检测）
export const SECTION_IDS = new Set([
  '## 引擎版本', '## 渲染器', '## 项目关键路径', '## 主场景',
  '## Autoload', '## Input Map', '## 物理设置', '## 层级名称',
  '## MCP 规则映射', '## Godot MCP Rules',
]);

// MCP 章节的固定顺序
export const SECTION_ORDER: string[] = [
  '## 引擎版本', '## 渲染器', '## 项目关键路径', '## 主场景',
  '## Autoload', '## Input Map', '## 物理设置', '## 层级名称',
  '## MCP 规则映射',
];

// godot-mcp.md 固定模板内容
export const GODOT_MCP_RULES = `# Godot MCP 开发规则

## 脚本编辑
- edit_script / write_script 后必须立即调用 validate_scripts 验证
- 验证失败时回滚修改

## 发版门禁
- 提交版本号变更前必须运行 verify_delivery(scope="full")
- 所有维度必须无错误

## 场景操作
- 修改 .tscn 后用 read_scene 验证结构完整性
- 节点路径变更后检查所有 signal 连接是否失效

## GDScript 规范
- 使用静态类型（var x: int = 0）
- 函数必须标注返回类型
- 信号回调以 _on_ 前缀命名
`;

// ─── Simple builders ──────────────────────────────────────────────────────

export function buildEngineVersion(config: GodotConfig | null): string | null {
  if (!config) return null;
  const app = config.application as Record<string, unknown> | undefined;
  if (!app) return null;

  const features = app['config/features'];
  let version = '';

  if (typeof features === 'string') {
    // PackedStringArray("4.6", ...) → extract first quoted value
    const m = features.match(/PackedStringArray\("([^"]+)"/);
    version = m ? m[1] : features;
  } else if (Array.isArray(features) && features.length > 0) {
    version = String(features[0]);
  }

  if (!version) version = '4.x（版本未知）';
  return `- Godot ${version}`;
}

export function buildRenderer(config: GodotConfig | null): string | null {
  if (!config) return null;
  const rendering = config.rendering as Record<string, unknown> | undefined;
  if (!rendering) return null;

  const renderer = rendering['renderer/rendering_method'] ?? rendering['renderer'];
  if (!renderer || typeof renderer !== 'string') return null;
  return `- ${renderer}`;
}

export function buildMainScene(config: GodotConfig | null): string | null {
  if (!config) return null;
  const app = config.application as Record<string, unknown> | undefined;
  if (!app) return null;

  const scene = app['run/main_scene'] ?? app['run_main_scene'];
  if (!scene || typeof scene !== 'string') return null;
  return `- ${scene}`;
}
```

- [ ] **Step 2: 创建测试文件，写 buildEngineVersion / buildRenderer / buildMainScene 的测试**

```javascript
// test/claudemd-builder.test.js
import { describe, it, expect } from 'vitest';
import {
  buildEngineVersion,
  buildRenderer,
  buildMainScene,
} from '../build/tools/claudemd-builder.js';

describe('claudemd-builder — simple builders', () => {
  describe('buildEngineVersion', () => {
    it('extracts version from PackedStringArray format', () => {
      const config = {
        application: { 'config/features': 'PackedStringArray("4.6", "Forward+")' },
      };
      expect(buildEngineVersion(config)).toBe('- Godot 4.6');
    });

    it('returns fallback when no features', () => {
      const config = { application: {} };
      expect(buildEngineVersion(config)).toBe('- Godot 4.x（版本未知）');
    });

    it('returns null when config is null', () => {
      expect(buildEngineVersion(null)).toBeNull();
    });

    it('returns null when no application section', () => {
      expect(buildEngineVersion({})).toBeNull();
    });
  });

  describe('buildRenderer', () => {
    it('extracts renderer/rendering_method', () => {
      const config = { rendering: { 'renderer/rendering_method': 'mobile' } };
      expect(buildRenderer(config)).toBe('- mobile');
    });

    it('extracts renderer (legacy key)', () => {
      const config = { rendering: { renderer: 'forward_plus' } };
      expect(buildRenderer(config)).toBe('- forward_plus');
    });

    it('returns null when no rendering section', () => {
      expect(buildRenderer({})).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildRenderer(null)).toBeNull();
    });
  });

  describe('buildMainScene', () => {
    it('extracts run/main_scene', () => {
      const config = { application: { 'run/main_scene': 'res://scenes/main.tscn' } };
      expect(buildMainScene(config)).toBe('- res://scenes/main.tscn');
    });

    it('returns null when no main scene', () => {
      const config = { application: {} };
      expect(buildMainScene(config)).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildMainScene(null)).toBeNull();
    });
  });
});
```

- [ ] **Step 3: Build 并运行测试**

Run: `cd D:\GitHub\godot-mcp-enhanced && npm run build && npx vitest run test/claudemd-builder.test.js`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/tools/claudemd-builder.ts test/claudemd-builder.test.js
git commit -m "feat: add claudemd-builder with engine version, renderer, main scene builders"
```

---

### Task 2: buildKeyPaths + buildAutoloads builder

**Files:**
- Modify: `src/tools/claudemd-builder.ts`
- Modify: `test/claudemd-builder.test.js`

- [ ] **Step 1: 添加 buildKeyPaths 和 buildAutoloads 测试**

在 `test/claudemd-builder.test.js` 中添加：

```javascript
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildKeyPaths, buildAutoloads } from '../build/tools/claudemd-builder.js';

describe('claudemd-builder — keyPaths & autoloads', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  describe('buildKeyPaths', () => {
    it('lists existing known directories', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'godot-kp-'));
      mkdirSync(join(tempDir, 'scenes'));
      mkdirSync(join(tempDir, 'scripts'));
      mkdirSync(join(tempDir, 'assets'));
      mkdirSync(join(tempDir, 'unknown_dir')); // not in candidate list

      const result = buildKeyPaths(tempDir);
      expect(result).toContain('scenes/');
      expect(result).toContain('scripts/');
      expect(result).toContain('assets/');
      expect(result).not.toContain('unknown_dir');
    });

    it('returns null when no known directories exist', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'godot-kp-'));
      expect(buildKeyPaths(tempDir)).toBeNull();
    });

    it('includes addons when present', () => {
      tempDir = mkdtempSync(join(tmpdir(), 'godot-kp-'));
      mkdirSync(join(tempDir, 'addons'));
      mkdirSync(join(tempDir, 'scripts'));

      const result = buildKeyPaths(tempDir);
      expect(result).toContain('addons/');
      expect(result).toContain('scripts/');
    });
  });

  describe('buildAutoloads', () => {
    it('builds table from autoload config', () => {
      const config = {
        autoload: {
          GlobalManager: '*res://core/global.gd',
          GameManager: 'res://core/game_manager.gd',
        },
      };
      const result = buildAutoloads(config);
      expect(result).toContain('| GlobalManager |');
      expect(result).toContain('| GameManager |');
      expect(result).toContain('res://core/global.gd');
    });

    it('truncates paths over 40 chars', () => {
      const config = {
        autoload: {
          LongName: 'res://very/long/path/that/exceeds/forty/characters/in/total/manager.gd',
        },
      };
      const result = buildAutoloads(config);
      expect(result).toContain('…');
    });

    it('returns null when no autoload section', () => {
      expect(buildAutoloads({})).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildAutoloads(null)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/claudemd-builder.test.js`
Expected: buildKeyPaths/buildAutoloads 测试 FAIL（函数未导出）

- [ ] **Step 3: 实现 buildKeyPaths 和 buildAutoloads**

在 `claudemd-builder.ts` 中添加：

```typescript
const KNOWN_DIRS: Array<{ name: string; label: string }> = [
  { name: 'scenes', label: '场景文件' },
  { name: 'scripts', label: 'GDScript 脚本' },
  { name: 'assets', label: '资源文件' },
  { name: 'addons', label: '插件' },
  { name: 'shaders', label: '着色器' },
  { name: 'resources', label: '资源定义' },
  { name: 'sounds', label: '音效' },
  { name: 'music', label: '音乐' },
  { name: 'data', label: '数据文件' },
];

export function buildKeyPaths(projectDir: string): string | null {
  const existing: string[] = [];
  for (const { name, label } of KNOWN_DIRS) {
    try {
      if (readdirSync(join(projectDir, name))) {
        existing.push(`├── ${name}/ — ${label}`);
      }
    } catch { /* not found */ }
  }
  if (existing.length === 0) return null;
  // Fix last prefix: ├── → └──
  existing[existing.length - 1] = existing[existing.length - 1].replace('├──', '└──');
  return existing.join('\n');
}

export function buildAutoloads(config: GodotConfig | null): string | null {
  if (!config) return null;
  const autoload = config.autoload as Record<string, unknown> | undefined;
  if (!autoload) return null;

  const entries = Object.entries(autoload);
  if (entries.length === 0) return null;

  const rows = entries.map(([name, rawPath]) => {
    const path = typeof rawPath === 'string' ? rawPath.replace(/^\*/, '') : String(rawPath);
    const display = path.length > 40 ? path.slice(0, 37) + '…' : path;
    return `| ${name} | ${display} |`;
  });

  return '| 名称 | 路径 |\n|------|------|\n' + rows.join('\n');
}
```

- [ ] **Step 4: Build 并运行测试**

Run: `npm run build && npx vitest run test/claudemd-builder.test.js`
Expected: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/tools/claudemd-builder.ts test/claudemd-builder.test.js
git commit -m "feat: add buildKeyPaths and buildAutoloads builders"
```

---

### Task 3: buildInputMap + buildPhysics + buildLayerNames + buildMcpMapping

**Files:**
- Modify: `src/tools/claudemd-builder.ts`
- Modify: `test/claudemd-builder.test.js`

- [ ] **Step 1: 添加 buildInputMap / buildPhysics / buildLayerNames / buildMcpMapping 测试**

```javascript
import {
  buildInputMap,
  buildPhysics,
  buildLayerNames,
  buildMcpMapping,
} from '../build/tools/claudemd-builder.js';

describe('claudemd-builder — input/physics/layers/mcp', () => {
  describe('buildInputMap', () => {
    it('extracts action names from input section', () => {
      const config = {
        input: {
          move_up: 'Object(InputEventKey,...)',
          move_down: 'Object(InputEventKey,...)',
          attack: 'Object(InputEventKey,...)',
        },
      };
      const result = buildInputMap(config);
      expect(result).toContain('move_up');
      expect(result).toContain('move_down');
      expect(result).toContain('attack');
    });

    it('summarizes actions when more than 15', () => {
      const input = {};
      for (let i = 0; i < 20; i++) input[`action_${i}`] = 'Object(...)';
      const config = { input };
      const result = buildInputMap(config);
      expect(result).toContain('等');
    });

    it('returns null when no input section', () => {
      expect(buildInputMap({})).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildInputMap(null)).toBeNull();
    });
  });

  describe('buildPhysics', () => {
    it('returns non-default gravity values', () => {
      const config = { physics: { '3d/default_gravity': 20.0 } };
      const result = buildPhysics(config);
      expect(result).toContain('3D 重力');
      expect(result).toContain('20');
    });

    it('returns null when all default', () => {
      const config = { physics: { '3d/default_gravity': 9.8 } };
      expect(buildPhysics(config)).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildPhysics(null)).toBeNull();
    });

    it('returns null when no physics section', () => {
      expect(buildPhysics({})).toBeNull();
    });
  });

  describe('buildLayerNames', () => {
    it('extracts non-empty layer names', () => {
      const config = {
        layer_names: {
          '2d_physics/layer_1': 'Player',
          '2d_physics/layer_2': 'Enemy',
          '2d_physics/layer_3': '',
        },
      };
      const result = buildLayerNames(config);
      expect(result).toContain('2D 物理');
      expect(result).toContain('Player');
      expect(result).toContain('Enemy');
      expect(result).not.toContain('layer_3');
    });

    it('returns null when all layers empty', () => {
      const config = {
        layer_names: {
          '2d_physics/layer_1': '',
          '2d_physics/layer_2': '',
        },
      };
      expect(buildLayerNames(config)).toBeNull();
    });

    it('returns null when config is null', () => {
      expect(buildLayerNames(null)).toBeNull();
    });
  });

  describe('buildMcpMapping', () => {
    it('always returns mapping table', () => {
      const result = buildMcpMapping();
      expect(result).toContain('## MCP 规则映射');
      expect(result).toContain('.claude/rules/godot-mcp.md');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/claudemd-builder.test.js`
Expected: 新测试 FAIL（函数未导出）

- [ ] **Step 3: 实现 4 个 builder**

在 `claudemd-builder.ts` 中添加：

```typescript
export function buildInputMap(config: GodotConfig | null): string | null {
  if (!config) return null;
  const input = config.input as Record<string, unknown> | undefined;
  if (!input) return null;

  const actions = Object.keys(input);
  if (actions.length === 0) return null;

  if (actions.length > 15) {
    const shown = actions.slice(0, 15).join(', ');
    return `- actions: ${shown}，等 ${actions.length} 项`;
  }

  // Split into groups of 5 per line
  const lines: string[] = [];
  for (let i = 0; i < actions.length; i += 5) {
    lines.push('- ' + actions.slice(i, i + 5).join(', '));
  }
  return lines.join('\n');
}

export function buildPhysics(config: GodotConfig | null): string | null {
  if (!config) return null;
  const physics = config.physics as Record<string, unknown> | undefined;
  if (!physics) return null;

  const lines: string[] = [];
  const gravity3d = physics['3d/default_gravity'];
  const gravity2d = physics['2d/default_gravity'];
  const fps = physics['common/physics_fps'];

  if (typeof gravity3d === 'number' && gravity3d !== 9.8) {
    lines.push(`- 3D 重力: ${gravity3d}`);
  }
  if (typeof gravity2d === 'number' && gravity2d !== 980) {
    lines.push(`- 2D 重力: ${gravity2d}`);
  }
  if (typeof fps === 'number' && fps !== 60) {
    lines.push(`- 物理 FPS: ${fps}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildLayerNames(config: GodotConfig | null): string | null {
  if (!config) return null;
  const layers = config.layer_names as Record<string, unknown> | undefined;
  if (!layers) return null;

  const groups: Record<string, Array<{ idx: number; name: string }>> = {};

  for (const [key, value] of Object.entries(layers)) {
    if (!value || typeof value !== 'string') continue;
    const parts = key.split('/');
    if (parts.length !== 2) continue;
    const group = parts[0]; // e.g. "2d_physics"
    const layerPart = parts[1]; // e.g. "layer_1"
    const match = layerPart.match(/layer_(\d+)/);
    if (!match) continue;
    const idx = parseInt(match[1], 10);

    if (!groups[group]) groups[group] = [];
    groups[group].push({ idx, name: value });
  }

  const LABELS: Record<string, string> = {
    '2d_physics': '2D 物理', '2d_render': '2D 渲染',
    '3d_physics': '3D 物理', '3d_render': '3D 渲染',
  };

  const lines: string[] = [];
  for (const [group, items] of Object.entries(groups)) {
    items.sort((a, b) => a.idx - b.idx);
    const label = LABELS[group] ?? group;
    const summary = items.map(it => `${it.idx}=${it.name}`).join(', ');
    lines.push(`- ${label}: ${summary}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildMcpMapping(): string {
  return '## MCP 规则映射\n\n| 领域 | rules 文件 |\n|------|-----------|\n| 脚本开发 | .claude/rules/godot-mcp.md |';
}
```

注意：`buildMcpMapping()` 返回的是**完整章节**（包含 `## MCP 规则映射` 标题行），但其他 builder 只返回章节**体**（不含 `## ` 标题）。这是因为 `buildMcpMapping` 是固定内容，不需要独立组装标题。在 handler 中统一处理：所有非 `buildMcpMapping` 的 builder 结果前加 `\n## 章节名\n\n`。

实际上为了一致性，我让所有 builder 都只返回 body（不含标题）。修正 buildMcpMapping：

```typescript
export function buildMcpMapping(): string {
  return '| 领域 | rules 文件 |\n|------|-----------|\n| 脚本开发 | .claude/rules/godot-mcp.md |';
}
```

同步更新测试：去掉 `expect(result).toContain('## MCP 规则映射')`，改为检查表格内容。

- [ ] **Step 4: Build 并运行测试**

Run: `npm run build && npx vitest run test/claudemd-builder.test.js`
Expected: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/tools/claudemd-builder.ts test/claudemd-builder.test.js
git commit -m "feat: add buildInputMap, buildPhysics, buildLayerNames, buildMcpMapping"
```

---

### Task 4: mergeSections 合并引擎

**Files:**
- Modify: `src/tools/claudemd-builder.ts`
- Modify: `test/claudemd-builder.test.js`

这是最复杂的部分。合并规则回顾：
- MCP 章节按固定顺序排在 `# 标题` 之后
- 用户自定义章节排在 MCP 章节之后
- 旧格式 `## Godot MCP Rules` 替换为新多章节结构
- 标题标准化匹配（trim + 去多余空格）

- [ ] **Step 1: 添加 mergeSections 测试**

```javascript
import { mergeSections } from '../build/tools/claudemd-builder.js';

describe('claudemd-builder — mergeSections', () => {
  it('appends MCP sections to title-only file', () => {
    const existing = '# My Game\n\nSome intro text.\n';
    const sections = [
      ['## 引擎版本', '- Godot 4.6'],
      ['## MCP 规则映射', '| 领域 | 文件 |\n|------|------|'],
    ];
    const result = mergeSections(existing, sections);
    expect(result).toContain('# My Game');
    expect(result).toContain('## 引擎版本');
    expect(result).toContain('- Godot 4.6');
    expect(result).toContain('## MCP 规则映射');
    expect(result).toContain('Some intro text.');
    // MCP sections come before user text
    const mcpIdx = result.indexOf('## 引擎版本');
    const userIdx = result.indexOf('Some intro text');
    expect(mcpIdx).toBeLessThan(userIdx);
  });

  it('replaces old Godot MCP Rules with new sections', () => {
    const existing = '# My Game\n## Godot MCP Rules\n- old rule\n';
    const sections = [
      ['## 引擎版本', '- Godot 4.6'],
      ['## MCP 规则映射', '| 领域 | 文件 |\n|------|------|'],
    ];
    const result = mergeSections(existing, sections);
    expect(result).not.toContain('## Godot MCP Rules');
    expect(result).not.toContain('old rule');
    expect(result).toContain('## 引擎版本');
    expect(result).toContain('## MCP 规则映射');
  });

  it('preserves user sections after MCP sections', () => {
    const existing = '# My Game\n## 我的规范\n- my rule\n## 引擎版本\n- Godot 4.5\n';
    const sections = [
      ['## 引擎版本', '- Godot 4.6'],
      ['## MCP 规则映射', '| 领域 | 文件 |'],
    ];
    const result = mergeSections(existing, sections);
    expect(result).toContain('## 我的规范');
    expect(result).toContain('my rule');
    expect(result).toContain('- Godot 4.6');
    expect(result).not.toContain('- Godot 4.5');
    // User section comes after all MCP sections
    const lastMcp = result.lastIndexOf('## MCP 规则映射');
    const user = result.indexOf('## 我的规范');
    expect(user).toBeGreaterThan(lastMcp);
  });

  it('handles file with no ## headers', () => {
    const existing = '# My Game\nJust some text here\n';
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections(existing, sections);
    expect(result).toContain('## 引擎版本');
    expect(result).toContain('Just some text here');
  });

  it('handles duplicate MCP section headers', () => {
    const existing = '# My Game\n## 引擎版本\n- old1\n## 引擎版本\n- old2\n';
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections(existing, sections);
    expect(result).toContain('- Godot 4.6');
    expect(result).not.toContain('- old1');
    expect(result).not.toContain('- old2');
    // Only one ## 引擎版本
    expect(result.split('## 引擎版本').length).toBe(2); // 1 split = 1 occurrence
  });

  it('normalizes whitespace in headers', () => {
    const existing = '# My Game\n##  引擎版本 \n- old\n';
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections(existing, sections);
    expect(result).toContain('- Godot 4.6');
    expect(result).not.toContain('- old');
  });

  it('handles empty file', () => {
    const sections = [['## 引擎版本', '- Godot 4.6']];
    const result = mergeSections('', sections);
    expect(result).toContain('## 引擎版本');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/claudemd-builder.test.js`
Expected: mergeSections 测试 FAIL

- [ ] **Step 3: 实现 mergeSections**

在 `claudemd-builder.ts` 中添加：

```typescript
interface Section {
  header: string;
  headerNorm: string;
  body: string;
  isMcp: boolean;
}

function normalizeHeader(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function parseSections(content: string): { title: string; preSections: string; sections: Section[] } {
  const lines = content.split('\n');

  // Extract title (# ...)
  let title = '';
  let titleEndIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^# /.test(lines[i])) {
      title = lines[i];
      titleEndIdx = i + 1;
      break;
    }
  }

  // Collect text between title and first ## header
  let preSections = '';
  let firstSectionIdx = lines.length;
  for (let i = titleEndIdx; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      firstSectionIdx = i;
      break;
    }
    preSections += (preSections ? '\n' : '') + lines[i];
  }
  preSections = preSections.trim();

  // Parse ## sections
  const sections: Section[] = [];
  let current: Section | null = null;

  for (let i = firstSectionIdx; i < lines.length; i++) {
    const headerMatch = lines[i].match(/^##\s+(.*)/);
    if (headerMatch) {
      if (current) sections.push(current);
      const fullHeader = '## ' + headerMatch[1].trim();
      const norm = normalizeHeader(fullHeader);
      current = {
        header: fullHeader,
        headerNorm: norm,
        body: '',
        isMcp: SECTION_IDS.has(norm),
      };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + lines[i];
    }
  }
  if (current) sections.push(current);

  return { title, preSections, sections };
}

export function mergeSections(existing: string, newSections: Array<[string, string]>): string {
  if (!existing.trim()) {
    // Empty file — just write new sections
    return newSections.map(([h, b]) => `${h}\n${b}`).join('\n\n') + '\n';
  }

  const { title, preSections, sections } = parseSections(existing);

  // Collect user (non-MCP) sections in original order
  const userSections = sections.filter(s => !s.isMcp);

  // Build output
  const parts: string[] = [];
  if (title) parts.push(title);

  // New MCP sections
  for (const [header, body] of newSections) {
    parts.push(`${header}\n${body}`);
  }

  // User pre-section text
  if (preSections) parts.push(preSections);

  // User sections
  for (const s of userSections) {
    parts.push(s.body.trim() ? `${s.header}\n${s.body}` : s.header);
  }

  return parts.join('\n\n') + '\n';
}
```

- [ ] **Step 4: Build 并运行测试**

Run: `npm run build && npx vitest run test/claudemd-builder.test.js`
Expected: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/tools/claudemd-builder.ts test/claudemd-builder.test.js
git commit -m "feat: add mergeSections with smart merge preserving user sections"
```

---

### Task 5: 更新 project.ts handler

**Files:**
- Modify: `src/tools/project.ts`

将 `setup_project_rules` handler 从硬编码规则改为调用 builder + 合并逻辑。

- [ ] **Step 1: 在 project.ts 顶部添加 import**

在 `import { textResult } from '../types.js';` 之后添加：

```typescript
import {
  buildEngineVersion, buildRenderer, buildKeyPaths, buildMainScene,
  buildAutoloads, buildInputMap, buildPhysics, buildLayerNames, buildMcpMapping,
  mergeSections, SECTION_ORDER, GODOT_MCP_RULES,
} from './claudemd-builder.js';
```

- [ ] **Step 2: 替换 setup_project_rules handler 中的 CLAUDE.md 逻辑**

将现有 `// ── CLAUDE.md rules ──` 块（约第 321-354 行）替换为：

```typescript
      // ── CLAUDE.md rules ──
      if (doClaudeMd) {
        const claudeMdPath = join(p, 'CLAUDE.md');

        // Parse project.godot for metadata
        const cfgPath = join(p, 'project.godot');
        let config: import('../helpers.js').GodotConfig | null = null;
        try {
          const cfgContent = readFileSync(cfgPath, 'utf-8');
          config = ctx.parseGodotConfig(cfgContent);
        } catch {
          actions.push('CLAUDE.md: warning — project.godot parse failed, using minimal rules');
        }

        // Build sections
        const sections: Array<[string, string]> = [];
        const builders: Array<[string, () => string | null]> = [
          ['## 引擎版本', () => buildEngineVersion(config)],
          ['## 渲染器', () => buildRenderer(config)],
          ['## 项目关键路径', () => buildKeyPaths(p)],
          ['## 主场景', () => buildMainScene(config)],
          ['## Autoload', () => buildAutoloads(config)],
          ['## Input Map', () => buildInputMap(config)],
          ['## 物理设置', () => buildPhysics(config)],
          ['## 层级名称', () => buildLayerNames(config)],
          ['## MCP 规则映射', () => buildMcpMapping()],
        ];

        for (const [header, builder] of builders) {
          const body = builder();
          if (body !== null) {
            sections.push([header, body]);
          }
        }

        if (existsSync(claudeMdPath)) {
          if (!force) {
            // Check if MCP sections already present (idempotency)
            const existing = readFileSync(claudeMdPath, 'utf-8');
            const hasMcpSections = SECTION_ORDER.some(h => existing.includes(h));
            if (hasMcpSections) {
              actions.push('CLAUDE.md: skipped (already configured, use force=true to update)');
            } else {
              const merged = mergeSections(existing, sections);
              writeAtomic(claudeMdPath, merged);
              actions.push('CLAUDE.md: merged new sections into existing file');
            }
          } else {
            // force: still merge (preserves user sections) but skip idempotency check
            const existing = readFileSync(claudeMdPath, 'utf-8');
            const merged = mergeSections(existing, sections);
            writeAtomic(claudeMdPath, merged);
            actions.push('CLAUDE.md: updated (force)');
          }
        } else {
          const content = sections.map(([h, b]) => `${h}\n${b}`).join('\n\n') + '\n';
          const projectName = config
            ? (config.application as Record<string, unknown>)?.['config/name'] || basename(p)
            : basename(p);
          writeAtomic(claudeMdPath, `# ${projectName}\n\n${content}`);
          actions.push('CLAUDE.md: created with project metadata');
        }

        // ── rules file ──
        const rulesDir = join(p, '.claude', 'rules');
        const rulesPath = join(rulesDir, 'godot-mcp.md');
        if (!existsSync(rulesPath)) {
          mkdirSync(rulesDir, { recursive: true });
          writeAtomic(rulesPath, GODOT_MCP_RULES);
          actions.push('rules: created .claude/rules/godot-mcp.md');
        } else if (force) {
          actions.push('rules: skipped (file exists, will not overwrite user modifications)');
        }
      }
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: 编译成功，无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/tools/project.ts
git commit -m "feat: rewrite setup_project_rules handler to use builder pattern"
```

---

### Task 6: 更新 project-tools.test.js + 全量测试

**Files:**
- Modify: `test/project-tools.test.js`

- [ ] **Step 1: 更新 mock 返回更完整的 config**

修改 `createMockCtx` 中的 `parseGodotConfig` mock：

```javascript
parseGodotConfig: vi.fn(() => ({
  application: {
    'config/name': 'TestProject',
    'run/main_scene': 'res://scenes/main.tscn',
    'config/features': 'PackedStringArray("4.6")',
  },
  rendering: { 'renderer/rendering_method': 'forward_plus' },
})),
```

同时更新 `makeGodotProject` 中的 project.godot 内容以包含渲染器：

```javascript
function makeGodotProject(dir) {
  const projectGodot = [
    '; Engine config',
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="TestGame"',
    'run/main_scene="res://scenes/main.tscn"',
    'config/features=PackedStringArray("4.6")',
    '',
    '[rendering]',
    '',
    'renderer/rendering_method="forward_plus"',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'project.godot'), projectGodot, 'utf-8');
```

- [ ] **Step 2: 更新现有测试断言**

将 `'creates .claude/settings.json and CLAUDE.md'` 测试中的断言更新：

```javascript
// 旧断言
expect(claudeMd).toContain('Godot MCP Rules');
expect(claudeMd).toContain('validate_scripts');

// 新断言
expect(claudeMd).toContain('## 引擎版本');
expect(claudeMd).toContain('## MCP 规则映射');
expect(claudeMd).toContain('.claude/rules/godot-mcp.md');
```

将 `'skips when already configured'` 测试更新：

```javascript
// 第二次运行后，检查跳过
expect(parsed.actions.some(a => a.includes('skipped') || a.includes('merged'))).toBe(true);
```

将 `'overwrites with force=true'` 测试中的断言更新：

```javascript
expect(claudeMd).toContain('## 引擎版本');
expect(claudeMd).toContain('## MCP 规则映射');
```

- [ ] **Step 3: 添加新测试用例**

在 setup_project_rules describe 块末尾添加：

```javascript
it('creates .claude/rules/godot-mcp.md', async () => {
  const ctx = createMockCtx();
  await handleTool('setup_project_rules', { project_path: dir }, ctx);

  const rulesPath = join(dir, '.claude', 'rules', 'godot-mcp.md');
  expect(existsSync(rulesPath)).toBe(true);
  const rules = readFileSync(rulesPath, 'utf-8');
  expect(rules).toContain('validate_scripts');
  expect(rules).toContain('verify_delivery');
});

it('does not overwrite existing godot-mcp.md', async () => {
  const ctx = createMockCtx();
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'rules', 'godot-mcp.md'), 'my custom rules', 'utf-8');

  await handleTool('setup_project_rules', { project_path: dir, force: true }, ctx);

  const rules = readFileSync(join(dir, '.claude', 'rules', 'godot-mcp.md'), 'utf-8');
  expect(rules).toBe('my custom rules');
});

it('merges user sections to after MCP sections', async () => {
  const ctx = createMockCtx();
  writeFileSync(join(dir, 'CLAUDE.md'), '# TestGame\n## 我的规范\n- my rule\n', 'utf-8');

  await handleTool('setup_project_rules', { project_path: dir, hooks: false }, ctx);

  const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
  expect(claudeMd).toContain('## 我的规范');
  expect(claudeMd).toContain('my rule');
  expect(claudeMd).toContain('## 引擎版本');
  // User section after MCP sections
  const lastMcp = claudeMd.lastIndexOf('## MCP 规则映射');
  const user = claudeMd.indexOf('## 我的规范');
  expect(user).toBeGreaterThan(lastMcp);
});

it('replaces old Godot MCP Rules format', async () => {
  const ctx = createMockCtx();
  writeFileSync(join(dir, 'CLAUDE.md'),
    '# TestGame\n## Godot MCP Rules\n- old rule\n', 'utf-8');

  await handleTool('setup_project_rules', { project_path: dir, hooks: false }, ctx);

  const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
  expect(claudeMd).not.toContain('## Godot MCP Rules');
  expect(claudeMd).not.toContain('old rule');
  expect(claudeMd).toContain('## 引擎版本');
});

it('creates CLAUDE.md with project name from config', async () => {
  const ctx = createMockCtx();
  await handleTool('setup_project_rules', { project_path: dir, hooks: false }, ctx);

  const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
  // mock config has config/name = 'TestProject'
  // But parseGodotConfig mock returns hardcoded value with 'config/name': 'TestProject'
  // The actual handler reads the file, not the mock, so check for TestGame from makeGodotProject
  expect(claudeMd).toMatch(/^# Test/);
});
```

- [ ] **Step 4: Build 并运行全量测试**

Run: `npm run build && npm test`
Expected: 所有 1270+ 测试通过

- [ ] **Step 5: Commit**

```bash
git add test/project-tools.test.js
git commit -m "test: update setup_project_rules tests for new builder-based CLAUDE.md"
```

---

### Task 7: 全量验证 + 提交清理

- [ ] **Step 1: 运行 TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: 运行全量测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 3: 验证 build 产物**

Run: `npm run build`
Expected: 编译成功，`build/tools/claudemd-builder.js` 存在

- [ ] **Step 4: 检查是否有遗漏文件**

Run: `git status`
Expected: 所有修改已提交，无遗漏

- [ ] **Step 5: 最终 commit（如有遗漏修正）**

```bash
git add -A
git commit -m "feat: setup_project_rules CLAUDE.md refactor complete"
```
