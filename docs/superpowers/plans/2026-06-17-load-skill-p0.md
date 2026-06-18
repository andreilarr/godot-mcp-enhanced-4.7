# load_skill P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 enhanced 实现 `load_skill` MCP 工具的 P0 子集——从用户本地知识库目录按关键词检索 SKILL.md,返回带来源标注 + 相关性 score 的内容,缺失库优雅降级。

**Architecture:** 两个文件分工: `load-skill-search.ts`(纯检索逻辑,无 MCP 依赖,可独立单测) + `load-skill.ts`(工具 handler,调检索,符合 enhanced ToolModule 接口)。两级检索(query 词命中 name/description 高分 → 全文 fallback 低分),score 归一化 0-1 降序。注册到现有 `code` 组,标记 offline + 无需 project_path。

**Tech Stack:** TypeScript, Node `fs/promises`, Vitest, MCP SDK(已有)。

**关联 spec:** `docs/superpowers/specs/2026-06-17-godot-ai-kit-design.md` @ 9562c67,§5(load_skill 接口)+ §5.3(P0 子集 L1+L4+L6+L7)+ §9(exit criteria)+ §7(validate_scripts 交叉确认)。

## Global Constraints

(从 spec 抄,所有 task 隐含遵守)

- **P0 范围只含 L1+L4+L6+L7**。**不实现** L2(stage 加权)/L3(截断)/L5(缓存)——这些是套件 v1 前置。stage 参数 P0 不接收(本计划工具签名无 stage)。
- **不调 LLM**(stdio MCP)。超预算/摘要属 L3(v1),P0 返回 snippet(前 200 字符)而非摘要。
- **工具模块模式**: `getToolDefinitions(): Tool[]` + `handleTool(name, args, ctx): Promise<ToolResult | null>`(不认识返回 null)+ `export const TOOL_META`。返回用 `textResult()` / `errorResult()`(src/types.ts)。
- **注册**: `src/core/module-loader.ts` 加 import + 进 `ALL_MODULES`;`src/core/tool-registry.ts` 的 `TOOL_GROUPS.code` / `OFFLINE_TOOLS` / `NO_PROJECT_PATH_TOOLS` 各加 `load_skill`。
- **测试**: `.js` 文件,平铺 `test/`,Vitest,用真实临时目录(`fs.mkdtemp`)不 mock fs。
- **路径安全**: `sanitizePath`(src/core/path-security.ts)是 res:// 专用且 UNWIRED,**不用**。load_skill 用自己的绝对路径校验:拒 `..`、`fs.realpath` 解析、缺失→归入 missing 不报错。
- 每步 commit message 用 conventional + 中文,结尾 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/tools/load-skill-search.ts` | Create | 纯检索:目录扫描 + frontmatter 解析 + 两级检索 + score + 路径校验。export `searchSkills()`、`SkillMatch`、`MissingLibrary`、`SearchResult` |
| `src/tools/load-skill.ts` | Create | ToolModule: `getToolDefinitions()` + `handleTool()` + `TOOL_META`。调 `searchSkills`,包装成 textResult/errorResult,L6 降级 |
| `src/core/module-loader.ts` | Modify | 加 `import * as loadSkill` + 进 `ALL_MODULES` |
| `src/core/tool-registry.ts` | Modify | `TOOL_GROUPS.code.tools` / `OFFLINE_TOOLS` / `NO_PROJECT_PATH_TOOLS` 各加 `'load_skill'` |
| `test/load-skill-search.test.js` | Create | 检索核心单测(真实临时目录) |
| `test/load-skill.test.js` | Create | handler 单测(真实临时目录) |

---

## Task 1: 检索核心 — searchSkills()(L1 两级检索 + L7 score + 路径校验)

**Files:**
- Create: `src/tools/load-skill-search.ts`
- Test: `test/load-skill-search.test.js`

**Interfaces:**
- Produces: `searchSkills(libraries: string[], query: string, limit?: number): Promise<SearchResult>`,其中 `SearchResult = { matches: SkillMatch[]; missing: MissingLibrary[] }`,`SkillMatch = { source; path; name; description; score; snippet }`,`MissingLibrary = { path; reason }`。Task 2 的 handler 依赖这些类型名。

- [ ] **Step 1: Write the failing test**

Create `test/load-skill-search.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { searchSkills } from '../src/tools/load-skill-search.js';

describe('load-skill-search', () => {
  let libDir;

  beforeAll(async () => {
    libDir = await mkdtemp(join(tmpdir(), 'skill-lib-'));
    // GodotPrompter 风格: skills/<name>/SKILL.md
    await mkdir(join(libDir, 'skills', 'platformer-movement'), { recursive: true });
    await writeFile(
      join(libDir, 'skills', 'platformer-movement', 'SKILL.md'),
      '---\nname: platformer-movement\ndescription: Platformer jump and coyote time\n---\n# Platformer Movement\nUse coyote time for forgiving jumps.'
    );
    // gd-agentic 风格: references/*.md (无 frontmatter)
    await mkdir(join(libDir, 'references'), { recursive: true });
    await writeFile(
      join(libDir, 'references', 'never-rules.md'),
      '# NEVER Rules\n\nNever read input in _process. Use _unhandled_input.'
    );
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  it('L1a 高精度: query 词命中 name/description', async () => {
    const { matches } = await searchSkills([libDir], 'platformer coyote');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe('platformer-movement');
    expect(matches[0].score).toBeGreaterThan(0.5);
  });

  it('L1b 全文 fallback: 无 name/desc 命中时匹配正文', async () => {
    const { matches } = await searchSkills([libDir], 'unhandled_input');
    const names = matches.map(m => m.name);
    expect(names).toContain('never-rules'); // 正文含 "unhandled_input"
  });

  it('L7 结果按 score 降序', async () => {
    const { matches } = await searchSkills([libDir], 'coyote');
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].score).toBeGreaterThanOrEqual(matches[i].score);
    }
  });

  it('L4 source/path 标注', async () => {
    const { matches } = await searchSkills([libDir], 'platformer');
    expect(matches[0].source).toBe(require('path').basename(libDir));
    expect(matches[0].path).toContain('platformer-movement');
  });

  it('无匹配返回空 matches', async () => {
    const { matches } = await searchSkills([libDir], 'zzz_no_such_term_zzz');
    expect(matches).toEqual([]);
  });

  it('L6 缺失目录进 missing,不抛错', async () => {
    const { matches, missing } = await searchSkills(
      [join(libDir, 'does-not-exist')], 'test'
    );
    expect(matches).toEqual([]);
    expect(missing.length).toBe(1);
    expect(missing[0].reason).toMatch(/not found|traversal|not absolute/);
  });

  it('limit 截断结果数', async () => {
    const { matches } = await searchSkills([libDir], 'coyote', 1);
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/load-skill-search.test.js`
Expected: FAIL — `Cannot find module '../src/tools/load-skill-search.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/tools/load-skill-search.ts`:

```typescript
import { promises as fs } from 'fs';
import { join, basename, isAbsolute, relative } from 'path';

export interface SkillMatch {
  source: string;
  path: string;
  name: string;
  description: string;
  score: number;
  snippet: string;
}

export interface MissingLibrary {
  path: string;
  reason: string;
}

export interface SearchResult {
  matches: SkillMatch[];
  missing: MissingLibrary[];
}

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

function parseSkill(content: string, fallbackName: string): ParsedSkill {
  let name = fallbackName;
  let description = '';
  let body = content;
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fm) {
    const frontmatter = fm[1];
    body = fm[2];
    const nm = frontmatter.match(/^name:\s*(.+)$/m);
    if (nm) name = nm[1].trim();
    const dm = frontmatter.match(/^description:\s*(.+)$/m);
    if (dm) description = dm[1].trim();
  }
  return { name, description, body };
}

function scoreMatch(query: string, name: string, description: string, body: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  const b = body.toLowerCase();
  let total = 0;
  for (const term of terms) {
    let s = 0;
    if (n.includes(term)) s = Math.max(s, 1.0);
    if (d.includes(term)) s = Math.max(s, 0.6);
    if (b.includes(term)) s = Math.max(s, 0.3);
    total += s;
  }
  return total / terms.length;
}

async function* walkMd(dir: string): AsyncGenerator<string> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMd(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

function validateLibraryPath(p: string): { ok: true } | { ok: false; reason: string } {
  if (!p || typeof p !== 'string' || p.trim() === '') return { ok: false, reason: 'empty path' };
  if (p.includes('..')) return { ok: false, reason: 'traversal detected' };
  if (!isAbsolute(p)) return { ok: false, reason: 'not absolute path' };
  return { ok: true };
}

export async function searchSkills(
  libraries: string[],
  query: string,
  limit = 10
): Promise<SearchResult> {
  const matches: SkillMatch[] = [];
  const missing: MissingLibrary[] = [];
  const q = (query ?? '').trim();

  for (const lib of libraries) {
    const v = validateLibraryPath(lib);
    if (!v.ok) {
      missing.push({ path: lib, reason: v.reason });
      continue;
    }
    let real: string;
    try {
      real = await fs.realpath(lib);
    } catch {
      missing.push({ path: lib, reason: 'not found' });
      continue;
    }
    const source = basename(real);
    for await (const filePath of walkMd(real)) {
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }
      const { name, description, body } = parseSkill(content, basename(filePath, '.md'));
      const score = q ? scoreMatch(q, name, description, body) : 0;
      if (score > 0) {
        matches.push({
          source,
          path: relative(real, filePath) || filePath,
          name,
          description,
          score: Math.round(score * 100) / 100,
          snippet: body.slice(0, 200).trim(),
        });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return { matches: matches.slice(0, limit), missing };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/load-skill-search.test.js`
Expected: PASS — 全部 7 个 it 通过。

- [ ] **Step 5: Commit**

```bash
git -C D:/GitHub/godot-mcp-enhanced add src/tools/load-skill-search.ts test/load-skill-search.test.js
git -C D:/GitHub/godot-mcp-enhanced commit -m "feat(load_skill): 检索核心 searchSkills(L1 两级检索+L7 score)" -m "P0 子集 L1+L7。两级检索(name/desc 高分→全文 fallback)、score 归一化降序、缺失库进 missing 不报错。spec @ 9562c67 §5.1/§5.3。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 工具 handler — load_skill ToolModule(L4 来源 + L6 降级)

**Files:**
- Create: `src/tools/load-skill.ts`
- Test: `test/load-skill.test.js`

**Interfaces:**
- Consumes: Task 1 的 `searchSkills()`、`SkillMatch`、`MissingLibrary`。
- Produces: `getToolDefinitions()` / `handleTool()` / `TOOL_META`,符合 `ToolModule`(src/core/tool-registry.ts)。Task 3 的 module-loader import `* as loadSkill from '../tools/load-skill.js'`。

- [ ] **Step 1: Write the failing test**

Create `test/load-skill.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/load-skill.js';

describe('load_skill tool', () => {
  let libDir;

  beforeAll(async () => {
    libDir = await mkdtemp(join(tmpdir(), 'skill-lib-'));
    await mkdir(join(libDir, 'skills', 'jump'), { recursive: true });
    await writeFile(
      join(libDir, 'skills', 'jump', 'SKILL.md'),
      '---\nname: jump\ndescription: Coyote time jump\n---\n# Jump\nAdd coyote time.'
    );
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  it('getToolDefinitions 含 load_skill 且 query 必填', () => {
    const defs = getToolDefinitions();
    expect(defs.map(d => d.name)).toContain('load_skill');
    expect(defs[0].inputSchema.required).toContain('query');
  });

  it('TOOL_META.readonly === true', () => {
    expect(TOOL_META.load_skill).toBeDefined();
    expect(TOOL_META.load_skill.readonly).toBe(true);
  });

  it('handleTool 检索返回 matches(含 source+score)+ total_matches', async () => {
    const result = await handleTool('load_skill', { query: 'coyote', libraries: [libDir] }, {});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_matches).toBeGreaterThan(0);
    expect(parsed.matches[0].score).toBeGreaterThan(0);
    expect(parsed.matches[0].source).toBeDefined();
    expect(parsed.matches[0].path).toBeDefined();
  });

  it('L6 缺失库进 missing_libraries,不 isError', async () => {
    const result = await handleTool(
      'load_skill',
      { query: 'x', libraries: [join(libDir, 'nope')] },
      {}
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.missing_libraries.length).toBe(1);
  });

  it('空 query 返回 isError', async () => {
    const result = await handleTool('load_skill', { libraries: [libDir] }, {});
    expect(result.isError).toBe(true);
  });

  it('未知工具名返回 null', async () => {
    const result = await handleTool('not_load_skill', {}, {});
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/load-skill.test.js`
Expected: FAIL — `Cannot find module '../src/tools/load-skill.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/tools/load-skill.ts`:

```typescript
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult, errorResult, getErrorMessage } from '../types.js';
import { searchSkills } from './load-skill-search.js';

const TOOL_NAMES = ['load_skill'] as const;

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'load_skill',
      description:
        '从本地知识库(GodotPrompter/gd-agentic 等)按关键词检索 SKILL.md。两级检索:name/description 高精度→全文 fallback。返回带来源标注(source/path)和相关性 score 的匹配。缺失库进 missing_libraries 不报错。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '检索关键词(必填)' },
          libraries: {
            type: 'array',
            items: { type: 'string' },
            description: '知识库目录绝对路径数组。省略时读 GODOT_SKILL_LIBRARIES 环境变量(逗号分隔)',
          },
          limit: { type: 'number', description: '返回上限(默认 10)' },
        },
        required: ['query'],
      },
    },
  ];
}

function resolveLibraries(args: Record<string, unknown>): string[] {
  const explicit = args.libraries;
  if (Array.isArray(explicit)) return explicit.filter(s => typeof s === 'string');
  const env = process.env.GODOT_SKILL_LIBRARIES;
  if (env) return env.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  const query = args.query as string;
  if (!query || !String(query).trim()) {
    return errorResult('query is required');
  }

  const libraries = resolveLibraries(args);
  if (libraries.length === 0) {
    return errorResult(
      'No skill libraries configured. Pass `libraries` (absolute paths) or set GODOT_SKILL_LIBRARIES env (comma-separated).'
    );
  }

  const limit = (args.limit as number) || 10;

  try {
    const { matches, missing } = await searchSkills(libraries, String(query), limit);
    const result: Record<string, unknown> = {
      total_matches: matches.length,
      matches,
      missing_libraries: missing,
    };
    if (missing.length > 0) {
      result.note = `${missing.length} library(ies) unavailable. Check missing_libraries for details.`;
    }
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return errorResult(`load_skill failed: ${getErrorMessage(err)}`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  load_skill: { readonly: true, long_running: false },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/load-skill.test.js`
Expected: PASS — 全部 6 个 it 通过。

- [ ] **Step 5: Commit**

```bash
git -C D:/GitHub/godot-mcp-enhanced add src/tools/load-skill.ts test/load-skill.test.js
git -C D:/GitHub/godot-mcp-enhanced commit -m "feat(load_skill): 工具 handler(L4 来源标注+L6 缺失降级)" -m "ToolModule:getToolDefinitions/handleTool/TOOL_META。L4 每结果标 source/path,L6 缺失库进 missing_libraries 不报错。spec @ 9562c67 §5.1 L4/L6。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 注册集成 — module-loader + tool-registry(code 组/offline/no-project-path)+ validate_scripts 交叉确认

**Files:**
- Modify: `src/core/module-loader.ts`(advancedProxy import 后加 loadSkill import;ALL_MODULES 加 loadSkill)
- Modify: `src/core/tool-registry.ts`(code 组 tools;OFFLINE_TOOLS;NO_PROJECT_PATH_TOOLS)
- Test: 新增 `test/load-skill-registration.test.js`

**Interfaces:**
- Consumes: Task 2 的 `load_skill` ToolModule。
- Produces: `load_skill` 在 `full` profile 可见、`isOfflineCapable('load_skill')===true`、`skipProjectPath('load_skill')===true`、注册后 `getAllToolNames()` 含 `load_skill`。

- [ ] **Step 1: Write the failing test**

Create `test/load-skill-registration.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  TOOL_GROUPS,
  isOfflineCapable,
  skipProjectPath,
  resolveProfile,
  clearRegistry,
  getAllToolNames,
} from '../src/core/tool-registry.js';
import { registerAllModules } from '../src/core/module-loader.js';

describe('load_skill registration', () => {
  it('TOOL_GROUPS.code 含 load_skill', () => {
    expect(TOOL_GROUPS.code.tools).toContain('load_skill');
  });

  it('resolveProfile(full) 含 load_skill', () => {
    expect(resolveProfile('full').has('load_skill')).toBe(true);
  });

  it('isOfflineCapable(load_skill) === true', () => {
    expect(isOfflineCapable('load_skill')).toBe(true);
  });

  it('skipProjectPath(load_skill) === true', () => {
    expect(skipProjectPath('load_skill')).toBe(true);
  });

  it('registerAllModules 后 getAllToolNames 含 load_skill', () => {
    clearRegistry();
    registerAllModules();
    expect(getAllToolNames()).toContain('load_skill');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/load-skill-registration.test.js`
Expected: FAIL — `TOOL_GROUPS.code.tools` 不含 `load_skill`、`isOfflineCapable` false 等。

- [ ] **Step 3a: 改 module-loader.ts 注册**

在 `src/core/module-loader.ts` 的 `import * as advancedProxy from '../tools/advanced-proxy.js';` 后加:

```typescript
import * as loadSkill from '../tools/load-skill.js';
```

在 `ALL_MODULES` 数组末尾 `advancedProxy,` 后加 `loadSkill,`:

```typescript
const ALL_MODULES = [
  runtime, screenshot, project, scene, script, validation, docs,
  physicsOps, audioOps, tilemapOps, materialOps,
  gameBridge, workflow, animationOps, animationTrack, profilerOps,
  animtreeOps, navigationOps, particlesOps,
  signalOps, uiOps, editorSync,
  manageTools, instanceTools, advancedProxy, loadSkill,
];
```

- [ ] **Step 3b: 改 tool-registry.ts 三处**

`code` 组:
```typescript
code:       { description: '代码工具', tools: ['docs', 'load_skill'], requires: [] },
```

`OFFLINE_TOOLS` 加 `'load_skill'`:
```typescript
export const OFFLINE_TOOLS = new Set([
  'project', 'script', 'validation', 'confirm_and_execute',
  'manage_tools', 'godot_advanced_tool', 'load_skill',
]);
```

`NO_PROJECT_PATH_TOOLS` 加 `'load_skill'`(并补注释):
```typescript
const NO_PROJECT_PATH_TOOLS = new Set([
  'docs',
  'manage_tools',
  'confirm_and_execute',
  'godot_advanced_tool',
  'godot_list_instances',
  'godot_list_dynamic_routes',
  'godot_select_instance',
  'load_skill', // 读用户本地知识库路径(libraries 参数),不操作 Godot 项目
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/load-skill-registration.test.js`
Expected: PASS — 全部 5 个 it 通过。

- [ ] **Step 5: validate_scripts 交叉确认(spec §7)**

validate_scripts 已知不一致(§7 标"最致命"),不单凭它下结论。跑三路交叉确认:

```bash
# 路径 1: TypeScript 编译(权威)
cd D:/GitHub/godot-mcp-enhanced && npx tsc --noEmit

# 路径 2: 全量测试(功能)
cd D:/GitHub/godot-mcp-enhanced && npm test
```

路径 3(validate_scripts L015 lint,供交叉参考,已知可能不一致):用 MCP 工具调 `validate_scripts(scripts=["src/tools/load-skill.ts","src/tools/load-skill-search.ts"])`。

Expected:
- 路径 1: tsc 无 error
- 路径 2: 全部测试通过(含新增 3 个测试文件 + 现有 ~950 测试零回归)
- 路径 3: 无 L015 报错;若与路径 1/2 矛盾,记为已知不一致(spec §7),以编译+测试为准放行

若三路任一失败:**不 commit**,回到对应 Task 修复。

- [ ] **Step 6: Commit**

```bash
git -C D:/GitHub/godot-mcp-enhanced add src/core/module-loader.ts src/core/tool-registry.ts test/load-skill-registration.test.js
git -C D:/GitHub/godot-mcp-enhanced commit -m "feat(load_skill): 注册集成(code 组+offline+无 project_path)" -m "module-loader 注册 load_skill;tool-registry 加入 code 组/OFFLINE_TOOLS/NO_PROJECT_PATH_TOOLS。三路交叉确认(tsc+npm test+validate_scripts)通过。spec @ 9562c67 §7。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Exit Criteria(spec §9 enhanced 侧判据)

P0 完成的客观判据(本计划交付):
- [ ] `load_skill` 工具在 `full` profile 可见、offline 可用、不需 project_path
- [ ] L1 两级检索(name/desc 高分→全文 fallback)、L4 source/path 标注、L6 缺失降级、L7 score 降序——全部有测试覆盖
- [ ] tsc --noEmit 通过、npm test 全绿(零回归)
- [ ] 不含 L2(stage)/L3(截断)/L5(缓存)——v1 才实现

(套件侧"概念+架构两阶段调通 load_skill"是**计划 2 套件 MVP** 的验证,不在本计划范围。)

---

## Self-Review

**1. Spec coverage:**
- §5.1 L1(两级检索)→ Task 1 `scoreMatch` + 测试 L1a/L1b ✓
- §5.1 L4(来源标注)→ Task 1/2 `source`/`path` 字段 + 测试 ✓
- §5.1 L6(缺失降级)→ Task 1/2 `missing`/`missing_libraries` + 测试 ✓
- §5.1 L7(score)→ Task 1 `scoreMatch` 归一化 + 测试降序 ✓
- §5.3 P0 范围(L1+L4+L6+L7)→ 全覆盖;L2/L3/L5 明确不实现 ✓
- §9 exit criteria → 本计划 Exit Criteria 节 ✓
- §7 validate_scripts 交叉确认 → Task 3 Step 5 三路确认 ✓
- §5.2 签名偏离:`libraries: string[]`(非 spec 的 `library_path: string`)——因 P0 需同时扫两家,spec §5.2 注明"套件侧需求,enhanced 实现为准",允许 ✓

**2. Placeholder scan:** 无 TBD/TODO;每步含完整代码或精确命令。Task 3 Step 5 路径 3 的 validate_scripts 是 MCP 工具调用描述(执行者用 MCP 调或 CLI 等效),非占位符。

**3. Type consistency:**
- `SkillMatch`/`MissingLibrary`/`SearchResult`(Task 1 定义)↔ Task 2 handler 使用的字段名(source/path/name/description/score/snippet;path/reason)一致 ✓
- `searchSkills(libraries, query, limit)` 签名 Task 1/Task 2 调用一致 ✓
- `handleTool(name, args, ctx)` / `getToolDefinitions()` / `TOOL_META` 与 docs.ts、tool-registry.ts 的 ToolModule 接口一致 ✓
- Task 3 引用 `TOOL_GROUPS.code.tools` / `OFFLINE_TOOLS` / `NO_PROJECT_PATH_TOOLS` / `getAllToolNames` / `clearRegistry` 与 tool-registry.ts 真实导出名一致 ✓

无问题,计划可执行。
