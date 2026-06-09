# MCP 配置简化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使 project_path 参数可选，用户零配置即可使用 godot-mcp-enhanced

**Architecture:** 复用 GodotServer.detectProjectPath()（30s TTL 缓存 + env + cwd 搜索），在 ToolDispatcher.executeToolCall() 的 normalizeArgs 之后、validateCommonArgs 之前注入默认路径。26 个 tool schema 的 required 数组移除 project_path。

**Tech Stack:** TypeScript, Vitest, Node.js fs/path

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/core/path-utils.ts` | 新增 `resolveProjectPath()` — 从 GodotServer 提取的重构函数 |
| 修改 | `src/GodotServer.ts` | 删除 `detectProjectPath()` 私有方法，改用 `resolveProjectPath()` |
| 修改 | `src/core/ToolDispatcher.ts` | `executeToolCall()` 中注入默认 project_path |
| 修改 | 26 个 tool schema 文件 | `required` 数组移除 `project_path` |
| 修改 | `src/core/path-utils.ts` | `resolveProjectPath()` 导出 |
| 创建 | `test/core/resolve-project-path.test.ts` | 7 项测试覆盖新路径 |
| 修改 | `docs/superpowers/specs/2026-06-09-config-simplification-design.md` | 根据审查反馈更新 |

---

### Task 1: 更新设计文档

**Files:**
- Modify: `docs/superpowers/specs/2026-06-09-config-simplification-design.md`

根据工程审查的 3 个修改点更新设计文档：

- [ ] **Step 1: 添加函数复用说明**

在 Section 3A 的"新增文件/函数"之前添加"已有基础设施"子节：

```markdown
**已有基础设施（复用）：**

| 已有代码 | 复用方式 |
|----------|---------|
| `GodotServer.detectProjectPath()` (L184-217) | 提取为独立函数 `resolveProjectPath()` 到 `path-utils.ts`，GodotServer 和 ToolDispatcher 共用 |
| `validateProjectRoot()` (path-utils.ts) | `resolveProjectPath()` 内部使用 |
| `requireProjectPath()` (helpers.ts) | 无需修改 — Dispatcher 层保证值存在 |
| `validateCommonArgs()` (ToolDispatcher.ts) | 无需修改 — 注入点在其之前，保证 project_path 存在 |

将"新增文件/函数"子节中 `src/core/path-utils.ts` 的 `resolveProjectPath()` 说明改为"从 GodotServer.detectProjectPath() 提取"。
```

- [ ] **Step 2: 添加注入点精确说明**

在 Section 3A 的"改动文件"表格之后添加：

```markdown
**注入位置（精确）：**

`ToolDispatcher.executeToolCall()` 中，`normalizeArgs()` 之后、`validateCommonArgs()` 之前：

\```
executeToolCall(name, args, startTime)
  ├── args = normalizeArgs(rawArgs)       // 已有
  ├── ★ if (!args.project_path)           // 新增
  │     args.project_path = resolveProjectPath()
  │     if (!args.project_path) throw Error(...)
  ├── validateCommonArgs(args)            // 已有 — 此时 project_path 一定存在
  ├── validatePathArgs(args)              // 已有
  └── dispatchTool(name, args)            // 已有 — 37 个 handler 零改动
\```

为什么在 validateCommonArgs 之前？因为 `validateCommonArgs` 只在 `'project_path' in args` 时校验类型（缺失时静默跳过），但下游 `requireProjectPath()` 会 throw。Dispatcher 层注入保证了 project_path 存在，validateCommonArgs 校验通过，下游 handler 正常工作。
```

- [ ] **Step 3: 添加测试规划章节**

在 Section 4（不在范围内）之前添加：

```markdown
## 3D. 测试规划

### 新增测试文件

`test/core/resolve-project-path.test.ts` — 7 项测试覆盖 `resolveProjectPath()` 的所有路径：

| # | 测试场景 | 覆盖路径 | 优先级 |
|---|---------|---------|--------|
| T1 | explicitPath 传入 → 直接使用 | 显式参数 | 已有覆盖 |
| T2 | GODOT_PROJECT_PATH 环境变量 → 使用 env 值 | 环境变量 | CRITICAL |
| T3 | 从嵌套子目录 cwd 向上搜索 → 找到 project.godot | cwd 搜索 | CRITICAL |
| T4 | 无环境变量 + cwd 无 project.godot → 抛错 | 全部失败 | CRITICAL |
| T5 | 30s TTL 缓存命中/失效 | 缓存行为 | IMPORTANT |
| T6 | ToolDispatcher 注入后下游 handler 正常执行 | 端到端注入 | IMPORTANT |
| T7 | Schema required 不包含 project_path | 批量验证 | IMPORTANT |
| T8 | 缓存有效期内切换项目 → 文档警告 | ADVISORY（文档说明） |

### 测试策略

- T2-T5：单元测试 `resolveProjectPath()`，mock `existsSync` 和 `process.cwd()`
- T6：在 `test/core/ToolDispatcher.test.ts` 中添加集成测试
- T7：扫描所有 tool schema，断言 required 数组不含 `project_path`
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-09-config-simplification-design.md
git commit -m "docs: 设计文档更新 — 审查反馈（函数复用/注入点/测试规划）"
```

---

### Task 2: 提取 resolveProjectPath() 到 path-utils.ts

**Files:**
- Modify: `src/core/path-utils.ts` (L45 附近，`validateProjectRoot` 之后)
- Test: `test/core/resolve-project-path.test.ts`

- [ ] **Step 1: 写失败测试 `test/core/resolve-project-path.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  return { ...actual, join: actual.join };
});

import { existsSync } from 'fs';
import { join } from 'path';

// Import AFTER mocks are set up
const { resolveProjectPath, _resetProjectPathCache } = await import('../../src/core/path-utils.js');

const mockExists = existsSync as unknown as ReturnType<typeof vi.fn>;

describe('resolveProjectPath', () => {
  const originalEnv = process.env.GODOT_PROJECT_PATH;

  beforeEach(() => {
    _resetProjectPathCache();
    delete process.env.GODOT_PROJECT_PATH;
    mockExists.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.GODOT_PROJECT_PATH = originalEnv;
    else delete process.env.GODOT_PROJECT_PATH;
  });

  // T2: explicit path → use directly (no project.godot check at this layer)
  it('returns explicit path when provided', () => {
    const result = resolveProjectPath('/explicit/path');
    expect(result).toBe('/explicit/path');
    expect(mockExists).not.toHaveBeenCalled();
  });

  // T2: env var → use env value
  it('uses GODOT_PROJECT_PATH env when no explicit path', () => {
    process.env.GODOT_PROJECT_PATH = '/env/project';
    mockExists.mockReturnValue(true); // project.godot exists
    const result = resolveProjectPath();
    expect(result).toBe('/env/project');
  });

  // T2: env var points to invalid dir → warn, fall through to cwd search
  it('falls through to cwd search when env path lacks project.godot', () => {
    process.env.GODOT_PROJECT_PATH = '/bad/path';
    // First call: env path check → false
    // Subsequent calls: cwd search → true at /cwd
    mockExists
      .mockReturnValueOnce(false) // /bad/path/project.godot
      .mockReturnValue(true);     // /cwd/project.godot
    const result = resolveProjectPath();
    expect(result).toBeTruthy();
  });

  // T3: cwd upward search finds project.godot
  it('searches upward from cwd to find project.godot', () => {
    // Simulate: cwd is /a/b/c, project.godot at /a
    const originalCwd = process.cwd;
    process.cwd = () => '/a/b/c';
    mockExists.mockImplementation((p: string) => p === join('/a', 'project.godot'));
    const result = resolveProjectPath();
    expect(result).toBe('/a');
    process.cwd = originalCwd;
  });

  // T4: nothing found → returns undefined
  it('returns undefined when no path resolves', () => {
    mockExists.mockReturnValue(false);
    const result = resolveProjectPath();
    expect(result).toBeUndefined();
  });

  // T5: TTL cache — second call returns cached value
  it('caches result for 30s TTL', () => {
    process.env.GODOT_PROJECT_PATH = '/cached';
    mockExists.mockReturnValue(true);

    const first = resolveProjectPath();
    // Reset mock to track second call
    mockExists.mockClear();
    mockExists.mockReturnValue(false); // Simulate env disappearing
    const second = resolveProjectPath();

    expect(first).toBe('/cached');
    expect(second).toBe('/cached'); // Still cached — no fs call
    expect(mockExists).not.toHaveBeenCalled(); // Cache hit
  });

  // T5: cache expires after TTL
  it('re-resolves after TTL expires', () => {
    process.env.GODOT_PROJECT_PATH = '/cached';
    mockExists.mockReturnValue(true);

    resolveProjectPath(); // Populate cache

    // Advance time past TTL (30s)
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);

    mockExists.mockClear();
    mockExists.mockReturnValue(true);
    resolveProjectPath();

    expect(mockExists).toHaveBeenCalled(); // Cache miss — re-resolved
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/resolve-project-path.test.ts`
Expected: FAIL — `resolveProjectPath` and `_resetProjectPathCache` not exported

- [ ] **Step 3: 实现 resolveProjectPath()**

在 `src/core/path-utils.ts` 的 `validateProjectRoot()` 函数（L45-51）之后添加：

```typescript
// ─── Project path resolution (shared with ToolDispatcher) ────────────────────

/** 30s TTL cache — project path rarely changes mid-session */
let _resolvedProjectPath: string | undefined;
let _resolvedProjectPathTime = 0;
const PROJECT_PATH_CACHE_TTL_MS = 30_000;

/**
 * Resolve project path with priority chain:
 * 1. explicitPath (tool call argument) → use directly, no validation
 * 2. GODOT_PROJECT_PATH env → validate project.godot exists
 * 3. cwd upward search → find project.godot (max 30 levels)
 * 4. None → return undefined (caller decides error handling)
 *
 * Results are cached for 30s (PROJECT_PATH_CACHE_TTL_MS).
 */
export function resolveProjectPath(explicitPath?: string): string | undefined {
  // Priority 1: explicit argument
  if (explicitPath) return explicitPath;

  // Cache check
  const now = Date.now();
  if (_resolvedProjectPathTime > 0 && now - _resolvedProjectPathTime < PROJECT_PATH_CACHE_TTL_MS) {
    return _resolvedProjectPath;
  }

  // Priority 2: GODOT_PROJECT_PATH env
  const envPath = process.env.GODOT_PROJECT_PATH;
  if (envPath) {
    if (existsSync(join(envPath, 'project.godot'))) {
      _resolvedProjectPath = envPath;
      _resolvedProjectPathTime = now;
      return envPath;
    }
    getLogger().warn('godot-mcp', `GODOT_PROJECT_PATH="${envPath}" does not contain project.godot, ignoring`);
  }

  // Priority 3: cwd upward search
  let dir = process.cwd();
  const searchedPaths: string[] = [];
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, 'project.godot'))) {
      _resolvedProjectPath = dir;
      _resolvedProjectPathTime = now;
      return dir;
    }
    searchedPaths.push(dir);
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  getLogger().warn('godot-mcp', `resolveProjectPath: no project.godot found. Searched: ${searchedPaths.join(' → ')}`);
  _resolvedProjectPath = undefined;
  _resolvedProjectPathTime = now;
  return undefined;
}

/** Reset cache state (test-only). */
export function _resetProjectPathCache(): void {
  _resolvedProjectPath = undefined;
  _resolvedProjectPathTime = 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/resolve-project-path.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/path-utils.ts test/core/resolve-project-path.test.ts
git commit -m "feat: 提取 resolveProjectPath() 到 path-utils — 30s TTL + env + cwd 搜索"
```

---

### Task 3: GodotServer 改用 resolveProjectPath()

**Files:**
- Modify: `src/GodotServer.ts` (L179-217 删除私有方法，L115/127/248 调用点改用共享函数)

- [ ] **Step 1: 删除 GodotServer 的私有 detectProjectPath()**

删除 `src/GodotServer.ts` 中以下代码块（L179-217）：

```typescript
  // I-PERF-07: Cache detectProjectPath result (30s TTL — path rarely changes mid-session)
  private _cachedProjectPath: string | undefined;
  private _cachedProjectPathTime = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  private detectProjectPath(): string | undefined {
    const now = Date.now();
    if (this._cachedProjectPathTime > 0 && now - this._cachedProjectPathTime < GodotServer.CACHE_TTL_MS) {
      return this._cachedProjectPath;
    }
    // Allow explicit override via environment variable
    const envPath = process.env.GODOT_PROJECT_PATH;
    if (envPath) {
      if (existsSync(join(envPath, 'project.godot'))) {
        this._cachedProjectPath = envPath;
        this._cachedProjectPathTime = now;
        return envPath;
      }
      getLogger().warn('godot-mcp', `GODOT_PROJECT_PATH="${envPath}" does not contain project.godot, ignoring`);
    }
    // I-06: 增加上限到 30 层 + 添加诊断日志帮助用户定位
    let dir = process.cwd();
    const searchedPaths: string[] = [];
    for (let i = 0; i < 30; i++) {
      if (existsSync(join(dir, 'project.godot'))) {
        this._cachedProjectPath = dir;
        this._cachedProjectPathTime = now;
        return dir;
      }
      searchedPaths.push(dir);
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    getLogger().warn('godot-mcp', `detectProjectPath: no project.godot found. Searched: ${searchedPaths.join(' → ')}`);
    this._cachedProjectPath = undefined;
    this._cachedProjectPathTime = now;
    return undefined;
  }
```

替换为导入（在文件顶部 import 区域添加）：

```typescript
import { resolveProjectPath } from './core/path-utils.js';
```

将 3 处 `this.detectProjectPath()` 调用（L115, L127, L248）改为 `resolveProjectPath()`。

- [ ] **Step 2: 验证编译通过**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `npx vitest run`
Expected: 所有现有测试通过（与 resolveProjectPath 无关的测试不应受影响）

- [ ] **Step 4: Commit**

```bash
git add src/GodotServer.ts
git commit -m "refactor: GodotServer 改用共享 resolveProjectPath() — 删除私有方法"
```

---

### Task 4: ToolDispatcher 注入默认 project_path

**Files:**
- Modify: `src/core/ToolDispatcher.ts` (L188-190，normalizeArgs 和 validateCommonArgs 之间)
- Modify: `test/core/ToolDispatcher.test.ts` (新增测试)

- [ ] **Step 1: 写失败测试**

在 `test/core/ToolDispatcher.test.ts` 末尾添加 describe 块：

```typescript
describe('ToolDispatcher: default project_path injection', () => {
  // T6: 注入后下游 handler 正常执行
  it('injects default project_path when not provided', async () => {
    // Mock resolveProjectPath to return a fixed path
    vi.doMock('../../src/core/path-utils.js', () => ({
      resolveProjectPath: vi.fn().mockReturnValue('/injected/project'),
      _resetProjectPathCache: vi.fn(),
    }));

    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);

    const dispatcher = new ToolDispatcher(createOptions());
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'read_scene' } },
    });

    // The tool handler should have been called with project_path injected
    expect(mockModule.handleTool).toHaveBeenCalledWith(
      'scene',
      expect.objectContaining({ project_path: '/injected/project', action: 'read_scene' }),
      expect.anything(),
    );
    expect(result).toEqual(mockToolResult);
  });

  it('returns error when project_path cannot be resolved', async () => {
    vi.doMock('../../src/core/path-utils.js', () => ({
      resolveProjectPath: vi.fn().mockReturnValue(undefined),
      _resetProjectPathCache: vi.fn(),
    }));

    const dispatcher = new ToolDispatcher(createOptions());
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: 'read_scene' } },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('project_path');
  });

  it('preserves explicit project_path without calling resolveProjectPath', async () => {
    const mockResolve = vi.fn().mockReturnValue('/should-not-be-used');
    vi.doMock('../../src/core/path-utils.js', () => ({
      resolveProjectPath: mockResolve,
      _resetProjectPathCache: vi.fn(),
    }));

    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);

    const dispatcher = new ToolDispatcher(createOptions());
    await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/explicit', action: 'read_scene' } },
    });

    expect(mockModule.handleTool).toHaveBeenCalledWith(
      'scene',
      expect.objectContaining({ project_path: '/explicit' }),
      expect.anything(),
    );
    // resolveProjectPath should NOT be called when explicit path provided
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/core/ToolDispatcher.test.ts`
Expected: FAIL — resolveProjectPath not imported/called in ToolDispatcher

- [ ] **Step 3: 实现 ToolDispatcher 注入**

在 `src/core/ToolDispatcher.ts` 顶部 import 区域添加：

```typescript
import { resolveProjectPath } from './path-utils.js';
```

在 `executeToolCall()` 方法中，L190（`const typeErr = this.validateCommonArgs(args);`）之前插入：

```typescript
      // ── 0.5. Default project_path injection ──
      if (!args.project_path) {
        const resolved = resolveProjectPath();
        if (!resolved) {
          return opsErrorResult(
            COMMON_ERROR_CODES.INVALID_PARAMS,
            'project_path is required but not provided, and no default could be resolved. ' +
            'Set GODOT_PROJECT_PATH env var, run from a Godot project directory, or pass project_path explicitly.',
          );
        }
        args.project_path = resolved;
      }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/ToolDispatcher.test.ts`
Expected: 所有测试 PASS（含新增 3 个注入测试）

- [ ] **Step 5: 运行全量测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/core/ToolDispatcher.ts test/core/ToolDispatcher.test.ts
git commit -m "feat: ToolDispatcher 自动注入默认 project_path — env + cwd 搜索"
```

---

### Task 5: 26 个 tool schema 移除 project_path required

**Files:**
- Modify: 26 个 `src/tools/*.ts` 文件（required 数组移除 `project_path`）

- [ ] **Step 1: 用 sed 脚本批量替换**

使用脚本处理 4 种 required 模式：

```bash
# Pattern 1: ['project_path', 'action'] → ['action'] (19 files)
node -e "
const fs = require('fs');
const path = require('path');
const dir = 'src/tools';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
let count = 0;
for (const f of files) {
  const fp = path.join(dir, f);
  let content = fs.readFileSync(fp, 'utf8');
  const original = content;
  // Pattern: required: ['project_path', 'action'] → required: ['action']
  content = content.replace(/required:\s*\['project_path',\s*'action'\]/g, \"required: ['action']\");
  // Pattern: required: ['action', 'project_path'] → required: ['action']
  content = content.replace(/required:\s*\['action',\s*'project_path'\]/g, \"required: ['action']\");
  // Pattern: required: ['project_path', 'type', 'name'] → required: ['type', 'name']
  content = content.replace(/required:\s*\['project_path',\s*'type',\s*'name'\]/g, \"required: ['type', 'name']\");
  // Pattern: required: ['project_path', 'scope'] → required: ['scope']
  content = content.replace(/required:\s*\['project_path',\s*'scope'\]/g, \"required: ['scope']\");
  // Pattern: required: ['project_path', 'scene_path', 'operations'] → required: ['scene_path', 'operations']
  content = content.replace(/required:\s*\['project_path',\s*'scene_path',\s*'operations'\]/g, \"required: ['scene_path', 'operations']\");
  if (content !== original) {
    fs.writeFileSync(fp, content);
    count++;
    console.log('Modified:', f);
  }
}
console.log('Total modified:', count);
"
```

- [ ] **Step 2: 更新 project_path description**

在同一个脚本或手动搜索替换，将所有 tool schema 中的 project_path description 从硬编码描述改为：

```
description: "Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）"
```

```bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = 'src/tools';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts'));
let count = 0;
for (const f of files) {
  const fp = path.join(dir, f);
  let content = fs.readFileSync(fp, 'utf8');
  const original = content;
  content = content.replace(
    /project_path:\s*\{\s*type:\s*'string',\s*description:\s*'Godot 项目目录路径'/g,
    \"project_path: { type: 'string', description: 'Godot 项目目录路径（可选，默认使用 GODOT_PROJECT_PATH 环境变量或当前目录）'\"
  );
  if (content !== original) {
    fs.writeFileSync(fp, content);
    count++;
    console.log('Updated desc:', f);
  }
}
console.log('Total:', count);
"
```

- [ ] **Step 3: 写 Schema 验证测试**

在 `test/core/resolve-project-path.test.ts` 末尾（或新建 `test/core/schema-required.test.ts`）添加：

```typescript
import { describe, it, expect } from 'vitest';
import { getAllToolDefinitions } from '../../src/core/tool-registry.js';

describe('Tool schema: project_path not required', () => {
  it('no tool has project_path in required array', () => {
    const tools = getAllToolDefinitions();
    const violations: string[] = [];
    for (const tool of tools) {
      const required = (tool.inputSchema as { required?: string[] }).required;
      if (required && required.includes('project_path')) {
        violations.push(tool.name);
      }
    }
    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/core/schema-required.test.ts`
Expected: PASS — 0 violations

- [ ] **Step 5: 运行全量测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/tools/ test/core/schema-required.test.ts
git commit -m "feat: 26 个 tool schema 移除 project_path required — 参数变为可选"
```

---

### Task 6: README 重写（Part B）

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`（如存在）

- [ ] **Step 1: 重写 README 配置章节**

将 README 的安装/配置章节从 git clone 手动流程改为：

```markdown
## 快速开始

### 1 分钟配置（推荐）

#### Claude Code
claude mcp add godot -- npx -y godot-mcp-enhanced

#### Cursor / Cline / 其他
在项目的 `.cursor/mcp.json` 或 MCP 配置中添加：

\```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "godot-mcp-enhanced"]
    }
  }
}
\```

### 一键配置
\```bash
npx godot-mcp-enhanced setup
# 自动检测：Godot 路径 + AI 客户端 + 写入配置
\```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GODOT_PATH` | Godot 可执行文件路径 | 自动搜索（PATH/注册表/Scoop/Downloads） |
| `GODOT_PROJECT_PATH` | 默认项目路径 | 自动检测 cwd（向上搜索 project.godot） |
| `GODOT_MCP_SEARCH_PATHS` | 额外 Godot 搜索目录（分号分隔） | 无 |

> **注意：** 项目路径有 30 秒缓存。切换项目后等待 30 秒或重启 MCP server 使新路径生效。

### 手动配置（高级用户）

<details>
<summary>展开查看手动安装步骤</summary>

\```bash
git clone https://github.com/wgt19861219/godot-mcp-enhanced.git
cd godot-mcp-enhanced
npm install && npm run build
\```

在 MCP 配置中指向 `build/index.js`。

</details>
```

- [ ] **Step 2: 验证 README 渲染正确**

Run: `cat README.md | head -50`（确认 markdown 格式无误）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 配置从 4 步降到 1 行 — npx 零配置"
```

---

### Task 7: 验证 + 清理

- [ ] **Step 1: 编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: 全量测试**

Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 3: lint 检查**

Run: `npx eslint src/`
Expected: 0 errors（或已知 warnings 不增加）

- [ ] **Step 4: 确认 26 个文件全部修改**

Run: `grep -rn "required:.*project_path" src/tools/`
Expected: 0 matches（所有 project_path 已从 required 移除）

- [ ] **Step 5: 最终 Commit（如有遗漏修复）**

```bash
git add -A
git commit -m "chore: 配置简化实施收尾 — 验证通过"
```

---

## 自检清单

### Spec 覆盖度

| 设计文档要求 | 对应 Task |
|-------------|----------|
| resolveProjectPath() 优先级链 | Task 2 |
| Dispatcher 统一注入 | Task 4 |
| Schema required 移除 | Task 5 |
| README 重写 | Task 6 |
| 测试覆盖 | Task 2 + Task 4 + Task 5 |
| 向后兼容 | Task 4 Step 3（显式路径不调用 resolve） |
| 审查修改点 1: 复用 detectProjectPath | Task 2 + Task 3 |
| 审查修改点 2: 注入位置 | Task 4 |
| 审查修改点 3: 测试规划 | Task 1 + Task 2 + Task 4 + Task 5 |
| TODO-1: 测试补全 | Task 2（7 项）+ Task 4（3 项）+ Task 5（1 项） |
| TODO-2: 30s 缓存说明 | Task 6 |

### Placeholder 扫描

无 TBD/TODO/实现后补充等占位符。

### 类型一致性

- `resolveProjectPath(explicitPath?: string): string | undefined` — Task 2 定义，Task 3/4 使用
- `_resetProjectPathCache(): void` — Task 2 定义，测试使用
- ToolDispatcher 中 `args.project_path` 赋值类型为 `string`（resolveProjectPath 返回后已确认非 undefined）
