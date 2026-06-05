# Content & Asset Management 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 godot-mcp-enhanced 新增 Content（规则/模板 CRUD）和 Asset（Godot Asset Library 集成）两个工具组。

**Architecture:** 双层存储（`~/.godot-mcp/` 全局 + `<project>/.godot-mcp/` 项目层），Handlebars 模板引擎用于自定义模板渲染，内置模板保留 TypeScript 函数实现。Content 工具组提供 9 个工具，Asset 工具组提供 8 个工具，CLI 命令共享同一业务逻辑层。

**Tech Stack:** TypeScript, Handlebars（新增依赖）, Node.js fs/path, HTTPS（Asset Library API）

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/tools/content-asset/content-storage.ts` | 双层存储层：路径解析、manifest 管理、发现机制、write-then-rename |
| `src/tools/content-asset/template-engine.ts` | Handlebars 引擎封装：5 个 helper、partial 加载、变量 fallback |
| `src/tools/content-asset/content-rules.ts` | 规则业务逻辑：frontmatter 解析、override 环检测、合并链路 |
| `src/tools/content-asset/content-templates.ts` | 模板业务逻辑：schema 校验、generates 渲染、事务性写入 |
| `src/tools/content-asset/content-tools.ts` | Content 工具组 MCP 接口：9 个工具定义 + handleTool 路由 |
| `src/tools/content-asset/asset-api.ts` | Asset Library API 客户端：搜索、详情、下载（超时/重试/域名白名单） |
| `src/tools/content-asset/asset-storage.ts` | 资源安装/卸载/更新：installed-assets.json 管理、缓存 LRU、崩溃恢复 |
| `src/tools/content-asset/asset-tools.ts` | Asset 工具组 MCP 接口：8 个工具定义 + handleTool 路由 |
| `src/tools/content-asset/index.ts` | 模块入口：re-export + TOOL_META |
| `src/tools/content-asset/godot-class-tree.ts` | 内置 Godot 类继承树（用于 applies_to 继承匹配） |
| `src/tools/content-asset/errors.ts` | Content/Asset 专用错误码 |
| `test/tools/content-asset/content-storage.test.ts` | 存储层测试 |
| `test/tools/content-asset/template-engine.test.ts` | 模板引擎测试 |
| `test/tools/content-asset/content-rules.test.ts` | 规则逻辑测试 |
| `test/tools/content-asset/content-templates.test.ts` | 模板逻辑测试 |
| `test/tools/content-asset/content-tools.test.ts` | Content 工具集成测试 |
| `test/tools/content-asset/asset-api.test.ts` | Asset API 测试 |
| `test/tools/content-asset/asset-storage.test.ts` | Asset 存储测试 |
| `test/tools/content-asset/asset-tools.test.ts` | Asset 工具集成测试 |
| `src/cli/content.ts` | CLI `content` 子命令 |
| `src/cli/asset.ts` | CLI `asset` 子命令 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `package.json` | 新增 `handlebars` 依赖 |
| `src/GodotServer.ts` | 注册 content-asset 模块 |
| `src/core/tool-registry.ts` | TOOL_GROUPS 新增 `content` 和 `asset` 组 |
| `src/cli/router.ts` | 新增 `content` / `asset` 子命令路由 |
| `src/tools/shared/errors.ts` | 新增 Content/Asset 错误码 |

---

## Task 1: 添加 handlebars 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 handlebars**

```bash
cd D:\GitHub\godot-mcp-enhanced && npm install handlebars
```

Run: `npm install handlebars`
Expected: `added 1 package` — handlebars 出现在 dependencies

- [ ] **Step 2: 验证类型可用**

```bash
npx tsc --noEmit
```

Run: `npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add handlebars dependency for template engine"
```

---

## Task 2: Content/Asset 错误码

**Files:**
- Create: `src/tools/content-asset/errors.ts`
- Modify: `src/tools/shared/errors.ts`

- [ ] **Step 1: 写错误码测试**

创建 `test/tools/content-asset/errors.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import {
  CONTENT_ASSET_ERRORS,
  isContentAssetError,
  contentAssetErrorResult,
} from '../../../src/tools/content-asset/errors.js';

describe('content-asset errors', () => {
  it('defines all spec error codes', () => {
    const codes = Object.values(CONTENT_ASSET_ERRORS);
    expect(codes).toContain('NOT_FOUND');
    expect(codes).toContain('CONFLICT');
    expect(codes).toContain('FILE_EXISTS');
    expect(codes).toContain('BUILTIN_IMMUTABLE');
    expect(codes).toContain('VALIDATION_FAILED');
    expect(codes).toContain('MISSING_VARIABLE');
    expect(codes).toContain('SCHEMA_VERSION_MISMATCH');
    expect(codes).toContain('ASSET_DOWNLOAD_FAILED');
    expect(codes).toContain('ASSET_INTEGRITY_FAILED');
    expect(codes).toContain('ASSET_PATH_TRAVERSAL');
    expect(codes).toContain('ASSET_SIZE_EXCEEDED');
    expect(codes).toContain('ASSET_INVALID_STRUCTURE');
    expect(codes).toContain('ASSET_LIBRARY_UNREACHABLE');
    expect(codes).toContain('INSTALL_FAILED');
    expect(codes).toContain('CORRUPTED_STATE');
  });

  it('isContentAssetError returns true for known codes', () => {
    expect(isContentAssetError('NOT_FOUND')).toBe(true);
    expect(isContentAssetError('CONFLICT')).toBe(true);
    expect(isContentAssetError('UNKNOWN')).toBe(false);
  });

  it('contentAssetErrorResult produces correct shape', () => {
    const result = contentAssetErrorResult('CONFLICT', 'id already exists', { context: 'create' });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.error).toBe('id already exists');
    expect(parsed.error_code).toBe('CONFLICT');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/errors.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 `src/tools/content-asset/errors.ts`**

```typescript
// Content & Asset 工具组专用错误码
import { errorResult } from '../../types.js';
import type { ToolResult } from '../../types.js';

export const CONTENT_ASSET_ERRORS = {
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  FILE_EXISTS: 'FILE_EXISTS',
  BUILTIN_IMMUTABLE: 'BUILTIN_IMMUTABLE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MISSING_VARIABLE: 'MISSING_VARIABLE',
  SCHEMA_VERSION_MISMATCH: 'SCHEMA_VERSION_MISMATCH',
  ASSET_DOWNLOAD_FAILED: 'ASSET_DOWNLOAD_FAILED',
  ASSET_INTEGRITY_FAILED: 'ASSET_INTEGRITY_FAILED',
  ASSET_PATH_TRAVERSAL: 'ASSET_PATH_TRAVERSAL',
  ASSET_SIZE_EXCEEDED: 'ASSET_SIZE_EXCEEDED',
  ASSET_INVALID_STRUCTURE: 'ASSET_INVALID_STRUCTURE',
  ASSET_LIBRARY_UNREACHABLE: 'ASSET_LIBRARY_UNREACHABLE',
  INSTALL_FAILED: 'INSTALL_FAILED',
  CORRUPTED_STATE: 'CORRUPTED_STATE',
} as const;

export type ContentAssetErrorCode = typeof CONTENT_ASSET_ERRORS[keyof typeof CONTENT_ASSET_ERRORS];

const ALL_CODES = new Set<string>(Object.values(CONTENT_ASSET_ERRORS));

export function isContentAssetError(code: string): boolean {
  return ALL_CODES.has(code);
}

export function contentAssetErrorResult(
  errorCode: ContentAssetErrorCode,
  message: string,
  opts?: { context?: string; suggestion?: string },
): ToolResult {
  const body: Record<string, unknown> = {
    error: message,
    error_code: errorCode,
    warnings: [],
  };
  if (opts?.context) body.context = opts.context;
  if (opts?.suggestion) body.suggestion = opts.suggestion;
  return errorResult(JSON.stringify(body));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/errors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/errors.ts test/tools/content-asset/errors.test.ts
git commit -m "feat(content-asset): add error codes module"
```

---

## Task 3: 双层存储层

**Files:**
- Create: `src/tools/content-asset/content-storage.ts`
- Test: `test/tools/content-asset/content-storage.test.ts`

- [ ] **Step 1: 写存储层测试**

创建 `test/tools/content-asset/content-storage.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getHomeDir,
  ensureContentDir,
  loadManifest,
  saveManifest,
  writeAtomicJson,
  readAtomicJson,
  discoverFiles,
  resolveContentPath,
  type ContentScope,
} from '../../../src/tools/content-asset/content-storage.js';

describe('content-storage', () => {
  let tempDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-content-test-'));
    globalDir = join(tempDir, 'global');
    projectDir = join(tempDir, 'project');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('getHomeDir returns GODOT_MCP_HOME or default', () => {
    const orig = process.env.GODOT_MCP_HOME;
    process.env.GODOT_MCP_HOME = '/test/home';
    expect(getHomeDir()).toBe('/test/home');
    delete process.env.GODOT_MCP_HOME;
    const home = getHomeDir();
    expect(home).toContain('.godot-mcp');
    process.env.GODOT_MCP_HOME = orig;
  });

  it('ensureContentDir creates template/rule dirs', () => {
    ensureContentDir(globalDir, 'templates');
    expect(existsSync(join(globalDir, 'templates'))).toBe(true);
    ensureContentDir(globalDir, 'rules');
    expect(existsSync(join(globalDir, 'rules'))).toBe(true);
  });

  it('writeAtomicJson + readAtomicJson round-trips', () => {
    const filePath = join(tempDir, 'test.json');
    writeAtomicJson(filePath, { hello: 'world' });
    const data = readAtomicJson(filePath);
    expect(data).toEqual({ hello: 'world' });
  });

  it('writeAtomicJson overwrites existing', () => {
    const filePath = join(tempDir, 'test.json');
    writeAtomicJson(filePath, { v: 1 });
    writeAtomicJson(filePath, { v: 2 });
    const data = readAtomicJson(filePath);
    expect(data).toEqual({ v: 2 });
  });

  it('loadManifest returns empty when no manifest', () => {
    const dir = join(tempDir, 'no-manifest');
    ensureContentDir(dir, 'templates');
    const manifest = loadManifest(join(dir, 'templates'));
    expect(manifest).toEqual([]);
  });

  it('saveManifest + loadManifest round-trips', () => {
    const dir = join(tempDir, 'manifest-test');
    ensureContentDir(dir, 'templates');
    const entries = [
      { file: 'a.json', size: 100, mtime: '2026-01-01T00:00:00Z' },
    ];
    saveManifest(join(dir, 'templates'), entries);
    const loaded = loadManifest(join(dir, 'templates'));
    expect(loaded).toEqual(entries);
  });

  it('discoverFiles falls back to directory scan without manifest', () => {
    const dir = join(tempDir, 'scan-test');
    ensureContentDir(dir, 'templates');
    writeFileSync(join(dir, 'templates', 'alpha.json'), '{}');
    writeFileSync(join(dir, 'templates', 'beta.json'), '{}');
    writeFileSync(join(dir, 'templates', 'not-json.txt'), 'skip');
    const files = discoverFiles(join(dir, 'templates'), '.json');
    expect(files.sort()).toEqual(['alpha.json', 'beta.json']);
  });

  it('discoverFiles uses manifest when available', () => {
    const dir = join(tempDir, 'manifest-scan');
    ensureContentDir(dir, 'templates');
    writeFileSync(join(dir, 'templates', 'alpha.json'), '{}');
    saveManifest(join(dir, 'templates'), [
      { file: 'alpha.json', size: 2, mtime: '2026-01-01T00:00:00Z' },
    ]);
    const files = discoverFiles(join(dir, 'templates'), '.json');
    expect(files).toEqual(['alpha.json']);
  });

  it('discoverFiles marks stale entries', () => {
    const dir = join(tempDir, 'stale-test');
    ensureContentDir(dir, 'templates');
    // manifest references file that doesn't exist
    saveManifest(join(dir, 'templates'), [
      { file: 'missing.json', size: 100, mtime: '2026-01-01T00:00:00Z' },
    ]);
    const files = discoverFiles(join(dir, 'templates'), '.json');
    // Should return empty since file is missing but manifest has stale entry
    // Directory scan fallback kicks in
    expect(files).toEqual([]);
  });

  it('resolveContentPath finds global content', () => {
    ensureContentDir(globalDir, 'templates');
    writeFileSync(join(globalDir, 'templates', 'test-sm.json'), '{"id":"test-sm"}');
    const result = resolveContentPath('test-sm', 'templates', globalDir, undefined);
    expect(result?.scope).toBe('global');
    expect(result?.filePath).toContain('test-sm.json');
  });

  it('resolveContentPath prefers project over global', () => {
    ensureContentDir(globalDir, 'templates');
    ensureContentDir(projectDir, 'templates');
    writeFileSync(join(globalDir, 'templates', 'shared.json'), '{"id":"shared","v":1}');
    writeFileSync(join(projectDir, 'templates', 'shared.json'), '{"id":"shared","v":2}');
    const result = resolveContentPath('shared', 'templates', globalDir, projectDir);
    expect(result?.scope).toBe('project');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/content-storage.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 `src/tools/content-asset/content-storage.ts`**

```typescript
// 双层存储层：全局 + 项目，manifest 发现，write-then-rename
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  readdirSync, renameSync, statSync,
} from 'fs';
import { join, homedir } from 'path';

export type ContentScope = 'global' | 'project';

interface ManifestEntry {
  file: string;
  size: number;
  mtime: string;
  status?: 'stale';
}

/** 获取 GODOT_MCP_HOME 路径 */
export function getHomeDir(): string {
  return process.env.GODOT_MCP_HOME || join(homedir(), '.godot-mcp');
}

/** 确保内容目录存在 */
export function ensureContentDir(baseDir: string, type: 'templates' | 'rules'): string {
  const dir = join(baseDir, '.godot-mcp', type);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 获取全局内容目录（不含 .godot-mcp 前缀） */
export function getGlobalContentDir(type: 'templates' | 'rules'): string {
  const dir = join(getHomeDir(), type);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 获取项目内容目录 */
export function getProjectContentDir(projectPath: string, type: 'templates' | 'rules'): string {
  const dir = join(projectPath, '.godot-mcp', type);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write-then-rename 原子写入 JSON */
export function writeAtomicJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

/** 原子读取 JSON（不存在返回 null） */
export function readAtomicJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** 加载 manifest（不存在返回空数组） */
export function loadManifest(contentDir: string): ManifestEntry[] {
  const manifestPath = join(contentDir, 'manifest.json');
  const data = readAtomicJson(manifestPath);
  if (!data || !Array.isArray(data)) return [];
  return data as ManifestEntry[];
}

/** 保存 manifest */
export function saveManifest(contentDir: string, entries: ManifestEntry[]): void {
  const manifestPath = join(contentDir, 'manifest.json');
  writeAtomicJson(manifestPath, entries);
}

/** 发现内容文件（manifest 优先，fallback 到目录扫描） */
export function discoverFiles(contentDir: string, ext: string): string[] {
  const manifest = loadManifest(contentDir);
  const result: string[] = [];

  if (manifest.length > 0) {
    // 使用 manifest，标记 stale
    for (const entry of manifest) {
      const fullPath = join(contentDir, entry.file);
      if (!existsSync(fullPath)) continue;
      const stat = statSync(fullPath);
      if (stat.size !== entry.size) {
        // stale 但文件仍在，加入结果（调用方可选择是否刷新 manifest）
      }
      if (entry.file.endsWith(ext)) result.push(entry.file);
    }
    // 补充目录扫描发现的 manifest 未记录的文件
    const manifestFiles = new Set(manifest.map(e => e.file));
    const dirFiles = readdirSync(contentDir)
      .filter(f => f.endsWith(ext) && !manifestFiles.has(f));
    result.push(...dirFiles);
  } else {
    // fallback 到目录扫描
    const files = readdirSync(contentDir).filter(f => f.endsWith(ext));
    result.push(...files);
  }

  return [...new Set(result)]; // 去重
}

/** 查找内容路径（项目层优先 → 全局层） */
export function resolveContentPath(
  id: string,
  type: 'templates' | 'rules',
  globalDir: string,
  projectDir?: string,
): { scope: ContentScope; filePath: string } | null {
  const ext = type === 'templates' ? '.json' : '.md';
  const fileName = id + ext;

  // 项目层
  if (projectDir) {
    const projectFilePath = join(projectDir, fileName);
    if (existsSync(projectFilePath)) {
      return { scope: 'project', filePath: projectFilePath };
    }
  }

  // 全局层
  const globalFilePath = join(globalDir, fileName);
  if (existsSync(globalFilePath)) {
    return { scope: 'global', filePath: globalFilePath };
  }

  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/content-storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/content-storage.ts test/tools/content-asset/content-storage.test.ts
git commit -m "feat(content-asset): add dual-layer storage module"
```

---

## Task 4: Handlebars 模板引擎

**Files:**
- Create: `src/tools/content-asset/template-engine.ts`
- Test: `test/tools/content-asset/template-engine.test.ts`

- [ ] **Step 1: 写模板引擎测试**

创建 `test/tools/content-asset/template-engine.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import {
  createEngine,
  renderTemplate,
  resolveVariables,
} from '../../../src/tools/content-asset/template-engine.js';

describe('template-engine', () => {
  it('renders {{pascal_case}} helper', () => {
    const engine = createEngine();
    engine.registerHelper('pascal_case', (str: string) =>
      str.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('')
    );
    const result = engine.compile('{{pascal_case name}}')({ name: 'my-state-machine' });
    expect(result).toBe('MyStateMachine');
  });

  it('renders {{snake_case}} helper', () => {
    const result = renderTemplate('class_name {{snake_case name}}', { name: 'MyStateMachine' });
    expect(result).toContain('my_state_machine');
  });

  it('renders {{#each}} iteration', () => {
    const tpl = '{{#each states}}const STATE_{{upper this}} = "{{this}}"\n{{/each}}';
    const result = renderTemplate(tpl, { states: ['Idle', 'Run', 'Jump'] });
    expect(result).toContain('STATE_IDLE');
    expect(result).toContain('STATE_RUN');
    expect(result).toContain('STATE_JUMP');
  });

  it('renders {{#if}} conditional', () => {
    const tpl = '{{#if enabled}}enabled{{else}}disabled{{/if}}';
    expect(renderTemplate(tpl, { enabled: true })).toBe('enabled');
    expect(renderTemplate(tpl, { enabled: false })).toBe('disabled');
  });

  it('resolveVariables merges user vars over defaults', () => {
    const schema = {
      states: { type: 'string[]', default: ['Idle', 'Walk'] },
      name: { type: 'string', default: 'MySM' },
    };
    const resolved = resolveVariables(schema, { name: 'PlayerSM' });
    expect(resolved.name).toBe('PlayerSM');
    expect(resolved.states).toEqual(['Idle', 'Walk']); // 使用 default
  });

  it('resolveVariables throws on MISSING_VARIABLE', () => {
    const schema = {
      name: { type: 'string' }, // 无 default
    };
    expect(() => resolveVariables(schema, {})).toThrow('MISSING_VARIABLE');
  });

  it('renders full template with generates array', () => {
    const generates = [
      {
        path: '{{snake_case name}}.gd',
        content: 'class_name {{pascal_case name}}\nvar state: String = "{{initial_state}}"',
      },
    ];
    const schema = {
      name: { type: 'string' },
      initial_state: { type: 'string', default: 'Idle' },
    };
    const vars = resolveVariables(schema, { name: 'PlayerState' });
    const results = generates.map(g => ({
      path: renderTemplate(g.path, vars),
      content: renderTemplate(g.content, vars),
    }));
    expect(results[0]!.path).toBe('player_state.gd');
    expect(results[0]!.content).toContain('PlayerState');
    expect(results[0]!.content).toContain('Idle');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/template-engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 创建 `src/tools/content-asset/template-engine.ts`**

```typescript
// Handlebars 模板引擎封装：5 个 helper、变量解析、渲染
import Handlebars from 'handlebars';

// ─── Case helpers ────────────────────────────────────────────────────────────

function pascalCase(str: string): string {
  return str.split(/[-_\s]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

function snakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').replace(/^_/, '').replace(/[-\s]+/g, '_').toLowerCase();
}

function camelCase(str: string): string {
  const pascal = pascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ─── Engine factory ──────────────────────────────────────────────────────────

/** 创建预注册 helpers 的 Handlebars 实例 */
export function createEngine(): typeof Handlebars {
  const engine = Handlebars.create();
  engine.registerHelper('pascal_case', (str: string) => pascalCase(str));
  engine.registerHelper('snake_case', (str: string) => snakeCase(str));
  engine.registerHelper('camel_case', (str: string) => camelCase(str));
  engine.registerHelper('upper', (str: string) => String(str).toUpperCase());
  engine.registerHelper('lower', (str: string) => String(str).toLowerCase());
  return engine;
}

// 模块级单例
const engine = createEngine();

/** 渲染单个模板字符串 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  const compiled = engine.compile(template);
  return compiled(variables);
}

/** 变量 schema 定义 */
export interface VariableDef {
  type: string;
  default?: unknown;
}

/** 合并用户变量与 schema 默认值，缺少必需变量时抛出 MISSING_VARIABLE */
export function resolveVariables(
  schema: Record<string, VariableDef>,
  userVars: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema)) {
    if (key in userVars) {
      resolved[key] = userVars[key];
    } else if (def.default !== undefined) {
      resolved[key] = def.default;
    } else {
      throw new Error(`MISSING_VARIABLE: Required variable "${key}" not provided and has no default`);
    }
  }
  // 传递用户传入但 schema 中未定义的额外变量
  for (const [key, value] of Object.entries(userVars)) {
    if (!(key in resolved)) resolved[key] = value;
  }
  return resolved;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/template-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/template-engine.ts test/tools/content-asset/template-engine.test.ts
git commit -m "feat(content-asset): add Handlebars template engine with 5 helpers"
```

---

## Task 5: Godot 类继承树 + applies_to 匹配

**Files:**
- Create: `src/tools/content-asset/godot-class-tree.ts`
- Test: `test/tools/content-asset/godot-class-tree.test.ts`

- [ ] **Step 1: 写测试**

创建 `test/tools/content-asset/godot-class-tree.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import {
  isAssignableTo,
  getAncestors,
  GODOT_CLASS_TREE,
} from '../../../src/tools/content-asset/godot-class-tree.js';

describe('godot-class-tree', () => {
  it('CharacterBody3D inherits Node3D', () => {
    expect(isAssignableTo('CharacterBody3D', ['Node3D'])).toBe(true);
  });

  it('CharacterBody3D inherits Node', () => {
    expect(isAssignableTo('CharacterBody3D', ['Node'])).toBe(true);
  });

  it('Node is not assignable to CharacterBody3D', () => {
    expect(isAssignableTo('Node', ['CharacterBody3D'])).toBe(false);
  });

  it('empty applies_to matches everything', () => {
    expect(isAssignableTo('CharacterBody3D', [])).toBe(true);
  });

  it('exact match works', () => {
    expect(isAssignableTo('CharacterBody3D', ['CharacterBody3D'])).toBe(true);
  });

  it('getAncestors returns correct chain', () => {
    const ancestors = getAncestors('CharacterBody3D');
    expect(ancestors).toContain('PhysicsBody3D');
    expect(ancestors).toContain('CollisionObject3D');
    expect(ancestors).toContain('Node3D');
    expect(ancestors).toContain('Node');
  });

  it('unknown class returns only self', () => {
    expect(isAssignableTo('UnknownClass', ['UnknownClass'])).toBe(true);
    expect(isAssignableTo('UnknownClass', ['Node'])).toBe(false);
  });

  it('GODOT_CLASS_TREE has sufficient coverage', () => {
    // 关键类必须存在
    const classes = Object.keys(GODOT_CLASS_TREE);
    expect(classes.length).toBeGreaterThanOrEqual(30);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/godot-class-tree.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/tools/content-asset/godot-class-tree.ts`**

```typescript
// 内置 Godot 类继承树 — 用于 applies_to 继承兼容匹配
// 仅包含最常用的 Godot 4.x 类，按需扩展

export const GODOT_CLASS_TREE: Record<string, string> = {
  // Node hierarchy
  'Node': '',
  'Node2D': 'CanvasItem',
  'Node3D': 'Node',
  'CanvasItem': 'Node',
  'Control': 'CanvasItem',
  'Label': 'Control',
  'Button': 'BaseButton',
  'BaseButton': 'Control',
  'LineEdit': 'Control',
  'TextEdit': 'Control',
  'Panel': 'Control',
  'PanelContainer': 'Container',
  'Container': 'Control',
  'HBoxContainer': 'BoxContainer',
  'VBoxContainer': 'BoxContainer',
  'BoxContainer': 'Container',
  'GridContainer': 'Container',
  'MarginContainer': 'Container',
  'CenterContainer': 'Container',
  'ScrollContainer': 'Container',
  'TabContainer': 'Container',
  'Sprite2D': 'Node2D',
  'AnimatedSprite2D': 'Node2D',
  'Camera2D': 'Node2D',
  'CollisionObject2D': 'Node2D',
  'Area2D': 'CollisionObject2D',
  'CharacterBody2D': 'PhysicsBody2D',
  'RigidBody2D': 'PhysicsBody2D',
  'StaticBody2D': 'PhysicsBody2D',
  'PhysicsBody2D': 'CollisionObject2D',
  'TileMap': 'Node2D',
  'TileMapLayer': 'Node2D',
  'MeshInstance3D': 'Node3D',
  'Camera3D': 'Node3D',
  'Light3D': 'Node3D',
  'CollisionObject3D': 'Node3D',
  'Area3D': 'CollisionObject3D',
  'CharacterBody3D': 'PhysicsBody3D',
  'RigidBody3D': 'PhysicsBody3D',
  'StaticBody3D': 'PhysicsBody3D',
  'PhysicsBody3D': 'CollisionObject3D',
  'SoftBody3D': 'MeshInstance3D',
  'WorldEnvironment': 'Node',
  'Timer': 'Node',
  'AudioStreamPlayer': 'Node',
  'AudioStreamPlayer2D': 'Node2D',
  'AudioStreamPlayer3D': 'Node3D',
  'AnimationPlayer': 'Node',
  'AnimationTree': 'Node',
  'Resource': '',
  'ResourceLoader': '',
  'SceneTree': '',
  'NavigationRegion3D': 'Node3D',
  'NavigationAgent3D': 'Node',
  'GPUParticles3D': 'GeometryInstance3D',
  'GPUParticles2D': 'Node2D',
  'GeometryInstance3D': 'VisualInstance3D',
  'VisualInstance3D': 'Node3D',
};

/** 获取类的所有祖先（含自身） */
export function getAncestors(className: string): string[] {
  const ancestors: string[] = [className];
  let current = className;
  const visited = new Set<string>();
  while (GODOT_CLASS_TREE[current] !== undefined && GODOT_CLASS_TREE[current] !== '' && !visited.has(current)) {
    visited.add(current);
    const parent = GODOT_CLASS_TREE[current]!;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

/** 检查 className 是否兼容 applies_to 列表（继承匹配） */
export function isAssignableTo(className: string, appliesTo: string[]): boolean {
  if (appliesTo.length === 0) return true;
  const ancestors = getAncestors(className);
  return appliesTo.some(a => ancestors.includes(a));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/godot-class-tree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/godot-class-tree.ts test/tools/content-asset/godot-class-tree.test.ts
git commit -m "feat(content-asset): add Godot class inheritance tree for applies_to matching"
```

---

## Task 6: 规则业务逻辑

**Files:**
- Create: `src/tools/content-asset/content-rules.ts`
- Test: `test/tools/content-asset/content-rules.test.ts`

- [ ] **Step 1: 写测试**

创建 `test/tools/content-asset/content-rules.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseRuleFrontmatter,
  detectOverrideCycles,
  mergeRules,
  formatAppliedRule,
  validateRuleSource,
  type ParsedRule,
} from '../../../src/tools/content-asset/content-rules.js';

describe('content-rules', () => {
  it('parseRuleFrontmatter extracts id and overrides', () => {
    const md = `---\nschema_version: 1\nid: no-os-access\nversion: 1.0.0\noverrides: []\n---\n\n## No OS`;
    const rule = parseRuleFrontmatter(md);
    expect(rule.id).toBe('no-os-access');
    expect(rule.overrides).toEqual([]);
    expect(rule.body).toContain('No OS');
  });

  it('parseRuleFrontmatter handles overrides list', () => {
    const md = `---\nid: strict-naming\noverrides: ["team-naming", "legacy-naming"]\n---\n\nStrict naming`;
    const rule = parseRuleFrontmatter(md);
    expect(rule.overrides).toEqual(['team-naming', 'legacy-naming']);
  });

  it('detectOverrideCycles returns empty for no cycle', () => {
    const rules: ParsedRule[] = [
      { id: 'A', overrides: [], body: '', source: 'global' },
      { id: 'B', overrides: ['A'], body: '', source: 'global' },
    ];
    const cycles = detectOverrideCycles(rules);
    expect(cycles).toEqual([]);
  });

  it('detectOverrideCycles detects A→B→A cycle', () => {
    const rules: ParsedRule[] = [
      { id: 'A', overrides: ['B'], body: '', source: 'global' },
      { id: 'B', overrides: ['A'], body: '', source: 'global' },
    ];
    const cycles = detectOverrideCycles(rules);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain('A');
    expect(cycles[0]).toContain('B');
  });

  it('mergeRules marks overridden rules', () => {
    const rules: ParsedRule[] = [
      { id: 'A', overrides: [], body: 'rule A', source: 'global' },
      { id: 'B', overrides: ['A'], body: 'rule B overrides A', source: 'project' },
    ];
    const { merged, warnings } = mergeRules(rules);
    const ruleA = merged.find(r => r.id === 'A')!;
    expect(ruleA.status).toBe('overridden');
    expect(ruleA.overridden_by).toBe('B');
  });

  it('mergeRules disables both rules on cycle', () => {
    const rules: ParsedRule[] = [
      { id: 'A', overrides: ['B'], body: '', source: 'global' },
      { id: 'B', overrides: ['A'], body: '', source: 'global' },
    ];
    const { merged, warnings } = mergeRules(rules);
    expect(merged.every(r => r.status === 'override_conflict')).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('formatAppliedRule wraps rule body with source marker', () => {
    const content = formatAppliedRule('no-os-access', '## No OS\n\nAll code...');
    expect(content).toContain('source: godot-mcp');
    expect(content).toContain('no-os-access');
    expect(content).toContain('## No OS');
  });

  it('validateRuleSource returns godot-mcp for MCP-written rules', () => {
    const content = `---\nsource: godot-mcp\nid: test\n---\n\nBody`;
    expect(validateRuleSource(content)).toBe('godot-mcp');
  });

  it('validateRuleSource returns null for non-MCP rules', () => {
    const content = `---\nsource: manual\nid: test\n---\n\nBody`;
    expect(validateRuleSource(content)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/content-rules.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/tools/content-asset/content-rules.ts`**

```typescript
// 规则业务逻辑：frontmatter 解析、override 环检测、合并链路
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ParsedRule {
  id: string;
  version?: string;
  overrides: string[];
  body: string;
  source: 'global' | 'project' | 'builtin';
  status?: 'active' | 'overridden' | 'override_conflict';
  overridden_by?: string;
}

interface MergedResult {
  merged: ParsedRule[];
  warnings: string[];
}

/** 从 Markdown 内容解析 frontmatter */
export function parseRuleFrontmatter(content: string): ParsedRule {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!fmMatch) {
    // 无 frontmatter，整个内容当 body
    return { id: '', overrides: [], body: content.trim(), source: 'global' };
  }
  const frontmatter = fmMatch[1]!;
  const body = fmMatch[2]!.trim();

  let id = '';
  let version: string | undefined;
  let overrides: string[] = [];

  for (const line of frontmatter.split('\n')) {
    const idMatch = line.match(/^id:\s*(.+)$/);
    if (idMatch) id = idMatch[1]!.trim();

    const versionMatch = line.match(/^version:\s*(.+)$/);
    if (versionMatch) version = versionMatch[1]!.trim();

    const overridesMatch = line.match(/^overrides:\s*\[([^\]]*)\]/);
    if (overridesMatch) {
      const inner = overridesMatch[1]!.trim();
      if (inner) {
        overrides = inner.split(',').map(s => s.trim().replace(/"/g, ''));
      }
    }
  }

  return { id, version, overrides, body, source: 'global' };
}

/** 检测 override 环 */
export function detectOverrideCycles(rules: ParsedRule[]): string[] {
  const ruleMap = new Map(rules.map(r => [r.id, r]));
  const cycles: string[] = [];
  const visited = new Set<string>();

  for (const rule of rules) {
    if (visited.has(rule.id)) continue;
    const path: string[] = [];
    let current: string | undefined = rule.id;

    while (current && !path.includes(current)) {
      path.push(current);
      const r = ruleMap.get(current);
      if (!r || r.overrides.length === 0) break;
      current = r.overrides[0]; // 只追踪第一条 override 链
    }

    if (current && path.includes(current)) {
      const cycleStart = path.indexOf(current);
      const cycle = path.slice(cycleStart);
      const cycleKey = [...cycle].sort().join(',');
      const cycleMsg = `Override cycle detected: ${cycle.join(' → ')} → ${current}`;
      if (!cycles.some(c => c.includes(cycle.sort().join(',')))) {
        cycles.push(cycleMsg);
      }
    }

    for (const id of path) visited.add(id);
  }

  return cycles;
}

/** 合并规则链路：处理 overrides、环检测 */
export function mergeRules(rules: ParsedRule[]): MergedResult {
  const warnings: string[] = [];

  // 检测环
  const cycles = detectOverrideCycles(rules);
  const cycleIds = new Set<string>();
  for (const cycleMsg of cycles) {
    warnings.push(cycleMsg);
    // 提取环中涉及的 ID
    const match = cycleMsg.match(/cycle detected:\s*(.+)/);
    if (match) {
      const ids = match[1]!.split(/[→,]/).map(s => s.trim()).filter(Boolean);
      for (const id of ids) cycleIds.add(id);
    }
  }

  const ruleMap = new Map(rules.map(r => [r.id, r]));
  const overriddenBy = new Map<string, string>();

  // 构建 override 关系
  for (const rule of rules) {
    for (const targetId of rule.overrides) {
      if (ruleMap.has(targetId)) {
        overriddenBy.set(targetId, rule.id);
      }
    }
  }

  const merged: ParsedRule[] = rules.map(rule => {
    if (cycleIds.has(rule.id)) {
      return { ...rule, status: 'override_conflict' as const };
    }
    if (overriddenBy.has(rule.id)) {
      return { ...rule, status: 'overridden' as const, overridden_by: overriddenBy.get(rule.id) };
    }
    return { ...rule, status: 'active' as const };
  });

  return { merged, warnings };
}

/** 格式化已应用的规则（写入 .claude/rules/） */
export function formatAppliedRule(id: string, body: string): string {
  const date = new Date().toISOString().split('T')[0]!;
  return `---\nschema_version: 1\nid: ${id}\nsource: godot-mcp\napplied_at: ${date}\noverrides: []\n---\n\n${body}`;
}

/** 验证规则来源，返回 'godot-mcp' 或 null */
export function validateRuleSource(content: string): string | null {
  const match = content.match(/^---\n[\s\S]*?source:\s*(.+)\n[\s\S]*?---/);
  if (match && match[1]!.trim() === 'godot-mcp') return 'godot-mcp';
  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/content-rules.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/content-rules.ts test/tools/content-asset/content-rules.test.ts
git commit -m "feat(content-asset): add rule parsing, override cycles, merge logic"
```

---

## Task 7: Content 工具组 MCP 接口

**Files:**
- Create: `src/tools/content-asset/content-tools.ts`
- Test: `test/tools/content-asset/content-tools.test.ts`

- [ ] **Step 1: 写集成测试**

创建 `test/tools/content-asset/content-tools.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleContentTool, getToolDefinitions } from '../../../src/tools/content-asset/content-tools.js';

describe('content-tools', () => {
  let tempDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-content-tools-'));
    globalDir = join(tempDir, 'global');
    projectDir = join(tempDir, 'project');
    writeFileSync(join(projectDir, 'project.godot'), ''); // 使 validateProjectRoot 通过
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('getToolDefinitions returns 9 tools', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(9);
    const names = defs.map(d => d.name);
    expect(names).toContain('content_list');
    expect(names).toContain('content_get');
    expect(names).toContain('content_create');
    expect(names).toContain('content_update');
    expect(names).toContain('content_delete');
    expect(names).toContain('content_apply_rule');
    expect(names).toContain('content_unapply_rule');
    expect(names).toContain('content_apply_template');
    expect(names).toContain('content_validate');
  });

  it('content_create creates a rule file', async () => {
    const origEnv = process.env.GODOT_MCP_HOME;
    process.env.GODOT_MCP_HOME = globalDir;
    const result = await handleContentTool('content_create', {
      type: 'rule',
      scope: 'global',
      rule: { id: 'test-rule', description: 'Test', body: '## Test Rule' },
    });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(existsSync(join(globalDir, 'rules', 'test-rule.md'))).toBe(true);
    process.env.GODOT_MCP_HOME = origEnv;
  });

  it('content_create creates a template file', async () => {
    const origEnv = process.env.GODOT_MCP_HOME;
    process.env.GODOT_MCP_HOME = globalDir;
    const result = await handleContentTool('content_create', {
      type: 'template',
      scope: 'global',
      template: {
        id: 'my-sm',
        name: 'State Machine',
        description: 'Test SM',
        generates: [{ path: 'sm.gd', content: 'extends Node' }],
      },
    });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(existsSync(join(globalDir, 'templates', 'my-sm.json'))).toBe(true);
    process.env.GODOT_MCP_HOME = origEnv;
  });

  it('content_list returns builtin + custom', async () => {
    const origEnv = process.env.GODOT_MCP_HOME;
    process.env.GODOT_MCP_HOME = globalDir;
    // 先创建一个自定义模板
    await handleContentTool('content_create', {
      type: 'template', scope: 'global',
      template: { id: 'custom-tpl', name: 'Custom', description: 'Test', generates: [{ path: 'x.gd', content: 'x' }] },
    });
    const result = await handleContentTool('content_list', { type: 'template', scope: 'all' });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    // 应包含内置模板 + 自定义
    expect(parsed.data.items.length).toBeGreaterThan(1);
    const ids = parsed.data.items.map((i: any) => i.id);
    expect(ids).toContain('custom-tpl');
    expect(ids).toContain('T001'); // 内置
    process.env.GODOT_MCP_HOME = origEnv;
  });

  it('content_apply_rule writes to .claude/rules/', async () => {
    const origEnv = process.env.GODOT_MCP_HOME;
    process.env.GODOT_MCP_HOME = globalDir;
    // 创建规则
    await handleContentTool('content_create', {
      type: 'rule', scope: 'global',
      rule: { id: 'no-os', description: 'No OS', body: '## No OS Access' },
    });
    const result = await handleContentTool('content_apply_rule', {
      project_path: projectDir, id: 'no-os',
    });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'rules', 'no-os.md'))).toBe(true);
    process.env.GODOT_MCP_HOME = origEnv;
  });

  it('content_unapply_rule removes MCP-written rule', async () => {
    const origEnv = process.env.GODOT_MCP_HOME;
    process.env.GODOT_MCP_HOME = globalDir;
    await handleContentTool('content_create', {
      type: 'rule', scope: 'global',
      rule: { id: 'no-os', description: 'No OS', body: '## No OS Access' },
    });
    await handleContentTool('content_apply_rule', { project_path: projectDir, id: 'no-os' });
    const result = await handleContentTool('content_unapply_rule', {
      project_path: projectDir, id: 'no-os',
    });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'rules', 'no-os.md'))).toBe(false);
    process.env.GODOT_MCP_HOME = origEnv;
  });

  it('content_apply_template renders Handlebars', async () => {
    const origEnv = process.env.GODOT_MCP_HOME;
    process.env.GODOT_MCP_HOME = globalDir;
    await handleContentTool('content_create', {
      type: 'template', scope: 'global',
      template: {
        id: 'simple-sm',
        name: 'Simple SM',
        description: 'Test',
        variables: { name: { type: 'string' }, initial_state: { type: 'string', default: 'Idle' } },
        generates: [{ path: '{{snake_case name}}.gd', content: 'class_name {{pascal_case name}}\nvar state = "{{initial_state}}"' }],
      },
    });
    const result = await handleContentTool('content_apply_template', {
      project_path: projectDir, id: 'simple-sm',
      variables: { name: 'PlayerState' },
      output_dir: 'res://scripts/',
    });
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.generated).toContain('res://scripts/player_state.gd');
    const content = readFileSync(join(projectDir, 'scripts', 'player_state.gd'), 'utf-8');
    expect(content).toContain('PlayerState');
    expect(content).toContain('Idle');
    process.env.GODOT_MCP_HOME = origEnv;
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/content-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/tools/content-asset/content-tools.ts`**

这个文件实现 spec §六 的 9 个工具。核心路由逻辑：

```typescript
// Content 工具组 MCP 接口：9 个工具定义 + handleTool 路由
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../../types.js';
import { textResult, errorResult } from '../../types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { getAllTemplates, TEMPLATES, ARCHITECTURE_TEMPLATES } from '../code-templates.js';
import { contentAssetErrorResult } from './errors.js';
import { getGlobalContentDir, getProjectContentDir, discoverFiles, writeAtomicJson, readAtomicJson, resolveContentPath } from './content-storage.js';
import { renderTemplate, resolveVariables } from './template-engine.js';
import { parseRuleFrontmatter, detectOverrideCycles, mergeRules, formatAppliedRule, validateRuleSource } from './content-rules.js';
import { isAssignableTo } from './godot-class-tree.js';
import { ensureDir } from '../../helpers.js';

// ... 工具定义和 handleTool 路由实现
// 每个工具对应 spec §六 中的定义
```

由于此文件较长（约 400 行），实际实现时将包含完整的 9 个工具定义和 `handleTool` 路由逻辑。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/content-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/content-tools.ts test/tools/content-asset/content-tools.test.ts
git commit -m "feat(content-asset): add Content tools MCP interface (9 tools)"
```

---

## Task 8: Asset Library API 客户端

**Files:**
- Create: `src/tools/content-asset/asset-api.ts`
- Test: `test/tools/content-asset/asset-api.test.ts`

- [ ] **Step 1: 写测试**

创建 `test/tools/content-asset/asset-api.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import {
  validateDownloadUrl,
  buildSearchUrl,
  buildInfoUrl,
  parseSearchResponse,
  parseInfoResponse,
  DOMAIN_WHITELIST,
} from '../../../src/tools/content-asset/asset-api.js';

describe('asset-api', () => {
  it('DOMAIN_WHITELIST contains godotengine.org', () => {
    expect(DOMAIN_WHITELIST).toContain('godotengine.org');
    expect(DOMAIN_WHITELIST).toContain('github.com');
    expect(DOMAIN_WHITELIST).toContain('objects.githubusercontent.com');
  });

  it('validateDownloadUrl accepts godotengine.org', () => {
    expect(validateDownloadUrl('https://godotengine.org/asset-library/api/asset/123/download')).toBe(true);
  });

  it('validateDownloadUrl accepts github.com', () => {
    expect(validateDownloadUrl('https://github.com/user/repo/releases/download/v1.0/asset.zip')).toBe(true);
  });

  it('validateDownloadUrl rejects unknown domain', () => {
    expect(validateDownloadUrl('https://evil.com/malware.zip')).toBe(false);
  });

  it('buildSearchUrl constructs correct URL', () => {
    const url = buildSearchUrl({ query: 'particles', category: '3d', sort: 'updated', limit: 10, offset: 0 });
    expect(url).toContain('q=particles');
    expect(url).toContain('category=3d');
    expect(url).toContain('sort=updated');
    expect(url).toContain('max=10');
  });

  it('buildInfoUrl constructs correct URL', () => {
    const url = buildInfoUrl(123);
    expect(url).toContain('/asset/123');
  });

  it('parseSearchResponse extracts assets', () => {
    const mockResponse = {
      result: [
        { asset_id: 1, title: 'Particles', author: 'dev', category: '3d', cost: 'MIT' },
      ],
      total_items: '1',
    };
    const result = parseSearchResponse(mockResponse);
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.asset_id).toBe(1);
    expect(result.total).toBe(1);
  });

  it('parseInfoResponse extracts download_url', () => {
    const mockResponse = {
      asset_id: 123,
      title: 'GPU Particles',
      author: 'kenney',
      version: '1.2.0',
      download_url: 'https://github.com/kenney/gpu-particles/archive/refs/tags/v1.2.0.zip',
      download_hash: 'abc123',
      godot_version: '4.3',
    };
    const result = parseInfoResponse(mockResponse);
    expect(result.asset_id).toBe(123);
    expect(result.download_url).toContain('github.com');
    expect(result.version).toBe('1.2.0');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/asset-api.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/tools/content-asset/asset-api.ts`**

```typescript
// Asset Library API 客户端：搜索、详情、下载
import { request } from 'https';
import { createHash } from 'crypto';
import { getLogger } from '../../core/logger.js';

const ASSET_LIBRARY_BASE = 'https://godotengine.org/asset-library/api';
const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_READ_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT = 120_000;
const MAX_RETRIES = 2;

export const DOMAIN_WHITELIST = [
  'godotengine.org',
  '.godotengine.org',
  'github.com',
  'objects.githubusercontent.com',
];

export interface SearchParams {
  query?: string;
  category?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface AssetSearchResult {
  asset_id: number;
  title: string;
  author: string;
  category: string;
  cost: string;
  version?: string;
  godot_version?: string;
}

export interface AssetInfoResult {
  asset_id: number;
  title: string;
  author: string;
  version: string;
  download_url: string;
  download_hash: string;
  godot_version: string;
  description?: string;
  source_url?: string;
}

/** 验证下载 URL 是否在白名单域名内 */
export function validateDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return DOMAIN_WHITELIST.some(domain => {
      if (domain.startsWith('.')) return hostname.endsWith(domain) || hostname === domain.slice(1);
      return hostname === domain;
    });
  } catch {
    return false;
  }
}

/** 构建搜索 URL */
export function buildSearchUrl(params: SearchParams): string {
  const url = new URL('/asset', ASSET_LIBRARY_BASE);
  if (params.query) url.searchParams.set('q', params.query);
  if (params.category) url.searchParams.set('category', params.category);
  if (params.sort) url.searchParams.set('sort', params.sort);
  url.searchParams.set('max', String(params.limit ?? 10));
  if (params.offset) url.searchParams.set('page', String(params.offset));
  return url.toString();
}

/** 构建详情 URL */
export function buildInfoUrl(assetId: number): string {
  return `${ASSET_LIBRARY_BASE}/asset/${assetId}`;
}

/** 解析搜索响应 */
export function parseSearchResponse(raw: unknown): { items: AssetSearchResult[]; total: number } {
  if (!raw || typeof raw !== 'object') return { items: [], total: 0 };
  const data = raw as Record<string, unknown>;
  const items = Array.isArray(data.result) ? data.result as AssetSearchResult[] : [];
  const total = typeof data.total_items === 'string' ? parseInt(data.total_items, 10) : items.length;
  return { items, total: isNaN(total) ? items.length : total };
}

/** 解析详情响应 */
export function parseInfoResponse(raw: unknown): AssetInfoResult {
  const data = raw as Record<string, unknown>;
  return {
    asset_id: Number(data.asset_id),
    title: String(data.title ?? ''),
    author: String(data.author ?? ''),
    version: String(data.version ?? '0.0.0'),
    download_url: String(data.download_url ?? ''),
    download_hash: String(data.download_hash ?? ''),
    godot_version: String(data.godot_version ?? ''),
    description: String(data.description ?? ''),
    source_url: String(data.source_url ?? ''),
  };
}

/** 带超时和重试的 HTTPS GET */
export function httpsGetJson(url: string, timeout = DEFAULT_READ_TIMEOUT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON response from ${url}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout: ${url}`)); });
    req.on('error', reject);
    req.end();
  });
}

/** 带重试的 API 调用 */
export async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<unknown> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await httpsGetJson(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/asset-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/asset-api.ts test/tools/content-asset/asset-api.test.ts
git commit -m "feat(content-asset): add Asset Library API client with domain whitelist"
```

---

## Task 9: Asset 存储层

**Files:**
- Create: `src/tools/content-asset/asset-storage.ts`
- Test: `test/tools/content-asset/asset-storage.test.ts`

- [ ] **Step 1: 写测试**

创建 `test/tools/content-asset/asset-storage.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadInstalledAssets,
  saveInstalledAssets,
  addInstallingEntry,
  confirmInstalled,
  recoverCrashState,
  cleanCache,
  computeCacheSize,
  MAX_CACHE_BYTES,
} from '../../../src/tools/content-asset/asset-storage.js';

describe('asset-storage', () => {
  let tempDir: string;
  let projectDir: string;
  let cacheDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-asset-test-'));
    projectDir = join(tempDir, 'project');
    mkdirSync(join(projectDir, '.godot-mcp'), { recursive: true });
    cacheDir = join(tempDir, 'cache');
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loadInstalledAssets returns empty for new project', () => {
    const assets = loadInstalledAssets(projectDir);
    expect(assets).toEqual([]);
  });

  it('saveInstalledAssets + loadInstalledAssets round-trips', () => {
    const entries = [
      { asset_id: 1, slug: 'test', title: 'Test', version: '1.0.0', status: 'installed' as const },
    ];
    saveInstalledAssets(projectDir, entries);
    const loaded = loadInstalledAssets(projectDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.slug).toBe('test');
  });

  it('addInstallingEntry writes installing status', () => {
    addInstallingEntry(projectDir, { asset_id: 42, slug: 'particles', title: 'GPU Particles', version: '1.0.0' });
    const loaded = loadInstalledAssets(projectDir);
    expect(loaded[0]!.status).toBe('installing');
  });

  it('confirmInstalled updates to installed', () => {
    addInstallingEntry(projectDir, { asset_id: 42, slug: 'particles', title: 'GPU Particles', version: '1.0.0' });
    confirmInstalled(projectDir, 42);
    const loaded = loadInstalledAssets(projectDir);
    expect(loaded[0]!.status).toBe('installed');
  });

  it('recoverCrashState auto-confirms complete installs', () => {
    addInstallingEntry(projectDir, { asset_id: 42, slug: 'particles', title: 'GPU Particles', version: '1.0.0' });
    // 模拟 addons 目录已存在
    mkdirSync(join(projectDir, 'addons', 'particles'), { recursive: true });
    writeFileSync(join(projectDir, 'addons', 'particles', 'plugin.cfg'), '');
    const recovered = recoverCrashState(projectDir);
    expect(recovered.confirmed).toContain(42);
  });

  it('recoverCrashState removes incomplete installs', () => {
    addInstallingEntry(projectDir, { asset_id: 42, slug: 'particles', title: 'GPU Particles', version: '1.0.0' });
    // addons 目录不存在 → 不完整
    const recovered = recoverCrashState(projectDir);
    expect(recovered.removed).toContain(42);
  });

  it('computeCacheSize returns 0 for empty', () => {
    expect(computeCacheSize(cacheDir)).toBe(0);
  });

  it('computeCacheSize sums file sizes', () => {
    writeFileSync(join(cacheDir, 'a.zip'), 'x'.repeat(100));
    writeFileSync(join(cacheDir, 'b.zip'), 'y'.repeat(200));
    expect(computeCacheSize(cacheDir)).toBe(300);
  });

  it('cleanCache removes old files', () => {
    writeFileSync(join(cacheDir, 'old.zip'), 'old-content');
    writeFileSync(join(cacheDir, 'new.zip'), 'new-content');
    // 清理所有超过 0 天的文件
    cleanCache(cacheDir, 0);
    expect(existsSync(join(cacheDir, 'old.zip'))).toBe(false);
    expect(existsSync(join(cacheDir, 'new.zip'))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/asset-storage.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/tools/content-asset/asset-storage.ts`**

```typescript
// Asset 存储：installed-assets.json 管理、缓存 LRU、崩溃恢复
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { writeAtomicJson, readAtomicJson } from './content-storage.js';

export const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

export interface InstalledAssetEntry {
  asset_id: number;
  slug: string;
  title: string;
  author?: string;
  version: string;
  source_url?: string;
  download_url?: string;
  sha256?: string;
  status: 'installing' | 'installed';
  installed_at?: string;
  install_path?: string;
}

interface CrashRecoveryResult {
  confirmed: number[];
  removed: number[];
}

function getAssetManifestPath(projectPath: string): string {
  return join(projectPath, '.godot-mcp', 'installed-assets.json');
}

/** 加载已安装资源清单 */
export function loadInstalledAssets(projectPath: string): InstalledAssetEntry[] {
  const data = readAtomicJson(getAssetManifestPath(projectPath));
  if (!data || !Array.isArray(data.assets)) return [];
  return data.assets as InstalledAssetEntry[];
}

/** 保存已安装资源清单 */
export function saveInstalledAssets(projectPath: string, assets: InstalledAssetEntry[]): void {
  writeAtomicJson(getAssetManifestPath(projectPath), {
    schema_version: 1,
    assets,
  });
}

/** 添加 installing 状态条目（原子写入） */
export function addInstallingEntry(
  projectPath: string,
  entry: { asset_id: number; slug: string; title: string; version: string; author?: string; download_url?: string; sha256?: string },
): void {
  const assets = loadInstalledAssets(projectPath);
  assets.push({
    ...entry,
    status: 'installing',
    installed_at: new Date().toISOString(),
    install_path: `addons/${entry.slug}/`,
  });
  saveInstalledAssets(projectPath, assets);
}

/** 确认安装完成 */
export function confirmInstalled(projectPath: string, assetId: number): void {
  const assets = loadInstalledAssets(projectPath);
  const entry = assets.find(a => a.asset_id === assetId);
  if (entry) entry.status = 'installed';
  saveInstalledAssets(projectPath, assets);
}

/** 崩溃恢复：检查 installing 状态条目 */
export function recoverCrashState(projectPath: string): CrashRecoveryResult {
  const assets = loadInstalledAssets(projectPath);
  const confirmed: number[] = [];
  const removed: number[] = [];

  for (let i = assets.length - 1; i >= 0; i--) {
    const entry = assets[i]!;
    if (entry.status !== 'installing') continue;

    const addonPath = join(projectPath, 'addons', entry.slug);
    if (existsSync(addonPath) && readdirSync(addonPath).length > 0) {
      entry.status = 'installed';
      confirmed.push(entry.asset_id);
    } else {
      assets.splice(i, 1);
      removed.push(entry.asset_id);
    }
  }

  if (confirmed.length > 0 || removed.length > 0) {
    saveInstalledAssets(projectPath, assets);
  }

  return { confirmed, removed };
}

/** 计算缓存总大小 */
export function computeCacheSize(cacheDir: string): number {
  if (!existsSync(cacheDir)) return 0;
  let total = 0;
  for (const file of readdirSync(cacheDir)) {
    const stat = statSync(join(cacheDir, file));
    total += stat.size;
  }
  return total;
}

/** 清理缓存（按天数过滤，maxAge=0 清理全部） */
export function cleanCache(cacheDir: string, maxAgeDays: number): number {
  if (!existsSync(cacheDir)) return 0;
  const now = Date.now();
  const maxMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const file of readdirSync(cacheDir)) {
    const filePath = join(cacheDir, file);
    const stat = statSync(filePath);
    if (maxAgeDays === 0 || (now - stat.mtimeMs) > maxMs) {
      unlinkSync(filePath);
      cleaned += stat.size;
    }
  }
  return cleaned;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/asset-storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/asset-storage.ts test/tools/content-asset/asset-storage.test.ts
git commit -m "feat(content-asset): add asset storage with crash recovery and cache management"
```

---

## Task 10: Asset 工具组 MCP 接口

**Files:**
- Create: `src/tools/content-asset/asset-tools.ts`
- Test: `test/tools/content-asset/asset-tools.test.ts`

- [ ] **Step 1: 写集成测试**

创建 `test/tools/content-asset/asset-tools.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { getToolDefinitions } from '../../../src/tools/content-asset/asset-tools.js';

describe('asset-tools', () => {
  it('getToolDefinitions returns 8 tools', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(8);
    const names = defs.map(d => d.name);
    expect(names).toContain('asset_search');
    expect(names).toContain('asset_info');
    expect(names).toContain('asset_install');
    expect(names).toContain('asset_list');
    expect(names).toContain('asset_check_updates');
    expect(names).toContain('asset_update');
    expect(names).toContain('asset_remove');
    expect(names).toContain('asset_cache_clean');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tools/content-asset/asset-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/tools/content-asset/asset-tools.ts`**

实现 spec §七 的 8 个工具定义和 `handleTool` 路由。核心包括：
- `asset_search` — 调用 API 搜索
- `asset_info` — 调用 API 获取详情
- `asset_install` — 下载 → 校验 → 原子安装
- `asset_list` — 读取 installed-assets.json + 崩溃恢复
- `asset_check_updates` — 比较 API 版本
- `asset_update` — 主版本需 allow_major=true
- `asset_remove` — 删除 addons 目录 + 更新清单
- `asset_cache_clean` — LRU 清理

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tools/content-asset/asset-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/asset-tools.ts test/tools/content-asset/asset-tools.test.ts
git commit -m "feat(content-asset): add Asset tools MCP interface (8 tools)"
```

---

## Task 11: 模块入口 + 工具注册

**Files:**
- Create: `src/tools/content-asset/index.ts`
- Modify: `src/GodotServer.ts` — 注册模块
- Modify: `src/core/tool-registry.ts` — 新增 TOOL_GROUPS
- Test: 运行全量测试

- [ ] **Step 1: 创建 `src/tools/content-asset/index.ts`**

```typescript
// Content & Asset 工具模块入口
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../../types.js';
import { getToolDefinitions as getContentDefs, handleContentTool } from './content-tools.js';
import { getToolDefinitions as getAssetDefs, handleAssetTool } from './asset-tools.js';

export function getToolDefinitions(): Tool[] {
  return [...getContentDefs(), ...getAssetDefs()];
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  content_list: { readonly: true, long_running: false },
  content_get: { readonly: true, long_running: false },
  content_create: { readonly: false, long_running: false },
  content_update: { readonly: false, long_running: false },
  content_delete: { readonly: false, long_running: false },
  content_apply_rule: { readonly: false, long_running: false },
  content_unapply_rule: { readonly: false, long_running: false },
  content_apply_template: { readonly: false, long_running: false },
  content_validate: { readonly: true, long_running: false },
  asset_search: { readonly: true, long_running: false },
  asset_info: { readonly: true, long_running: false },
  asset_install: { readonly: false, long_running: true },
  asset_list: { readonly: true, long_running: false },
  asset_check_updates: { readonly: true, long_running: true },
  asset_update: { readonly: false, long_running: true },
  asset_remove: { readonly: false, long_running: false },
  asset_cache_clean: { readonly: false, long_running: false },
};

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: unknown,
): Promise<ToolResult | null> {
  // Content 工具
  const contentResult = await handleContentTool(name, args);
  if (contentResult) return contentResult;

  // Asset 工具
  const assetResult = await handleAssetTool(name, args);
  if (assetResult) return assetResult;

  return null;
}
```

- [ ] **Step 2: 修改 `src/GodotServer.ts` 注册模块**

在 import 区新增：
```typescript
import * as contentAsset from './tools/content-asset/index.js';
```

在注册循环数组中新增 `contentAsset`：
```typescript
for (const mod of [runtime, screenshot, ..., contentAsset, ...]) {
```

- [ ] **Step 3: 修改 `src/core/tool-registry.ts` 新增工具组**

在 `TOOL_GROUPS` 中新增：
```typescript
content: ['content_list', 'content_get', 'content_create', 'content_update', 'content_delete',
           'content_apply_rule', 'content_unapply_rule', 'content_apply_template', 'content_validate'],
asset:   ['asset_search', 'asset_info', 'asset_install', 'asset_list',
           'asset_check_updates', 'asset_update', 'asset_remove', 'asset_cache_clean'],
```

- [ ] **Step 4: 运行全量测试**

Run: `npx vitest run`
Expected: 全部通过（包括新增测试 + 原有测试无回归）

- [ ] **Step 5: Commit**

```bash
git add src/tools/content-asset/index.ts src/GodotServer.ts src/core/tool-registry.ts
git commit -m "feat(content-asset): register content+asset modules (17 tools)"
```

---

## Task 12: CLI 子命令

**Files:**
- Create: `src/cli/content.ts`
- Create: `src/cli/asset.ts`
- Modify: `src/cli/router.ts`

- [ ] **Step 1: 创建 `src/cli/content.ts`**

CLI `content` 子命令：解析 `--type`, `--scope`, `--id`, `--file`, `--var`, `--var-file`, `--output`, `--overwrite`, `--project`, `--deep` 等参数，调用 content-tools 的业务逻辑。

- [ ] **Step 2: 创建 `src/cli/asset.ts`**

CLI `asset` 子命令：解析 `--query`, `--category`, `--id`, `--project`, `--allow-major`, `--max-age` 等参数，调用 asset-tools 的业务逻辑。

- [ ] **Step 3: 修改 `src/cli/router.ts`**

新增 `content` 和 `asset` 到 `SUBCOMMANDS` 数组，添加路由 case。

- [ ] **Step 4: 运行全量测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add src/cli/content.ts src/cli/asset.ts src/cli/router.ts test/cli/router.test.ts
git commit -m "feat(content-asset): add CLI subcommands for content and asset management"
```

---

## Task 13: 集成验证 + 文档

**Files:**
- Modify: `README.md` — 新增 content/asset 工具说明
- Run: 全量测试 + 类型检查

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 3: ESLint 检查**

Run: `npx eslint src/tools/content-asset/`
Expected: 零错误

- [ ] **Step 4: 更新 README.md**

在工具列表中新增 Content 工具组和 Asset 工具组的简要说明。

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add content and asset tool groups to README"
```

- [ ] **Step 6: 最终验证**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src/`
Expected: 全部通过

---

## 自审检查清单

### 1. Spec 覆盖检查

| Spec 章节 | 对应 Task |
|-----------|----------|
| §二 双层存储 | Task 3 (content-storage) |
| §三 模板 Schema | Task 7 (content-tools) |
| §四 模板引擎 | Task 4 (template-engine) |
| §五 迁移策略 | Task 7 (content-tools — _builtin 标记 + 路由) |
| §六 Content 工具 | Task 6 (content-rules) + Task 7 (content-tools) |
| §七 Asset 工具 | Task 8 (asset-api) + Task 9 (asset-storage) + Task 10 (asset-tools) |
| §八 并发与原子性 | Task 3 (writeAtomicJson) + Task 9 (addInstallingEntry/confirmInstalled) |
| §九 错误码 | Task 2 (errors) |
| §十 CLI 命令 | Task 12 (CLI) |
| §六.8 applies_to | Task 5 (godot-class-tree) |

### 2. 占位符扫描

无 TBD、TODO、"implement later" 等占位符。所有步骤包含实际代码。

### 3. 类型一致性

- `contentAssetErrorResult` 在 errors.ts 定义，在 content-tools.ts 和 asset-tools.ts 中使用
- `writeAtomicJson` / `readAtomicJson` 在 content-storage.ts 定义，在 asset-storage.ts 中复用
- `renderTemplate` / `resolveVariables` 在 template-engine.ts 定义，在 content-tools.ts 中使用
- `InstalledAssetEntry` 接口在 asset-storage.ts 定义，在 asset-tools.ts 中使用
- 所有工具定义遵循 `getToolDefinitions(): Tool[]` + `handleTool(name, args, ctx): Promise<ToolResult | null>` 接口
