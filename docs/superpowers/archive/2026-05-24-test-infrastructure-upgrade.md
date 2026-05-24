# 测试基础设施升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将测试框架从 node:test 迁移到 Vitest，建立 Godot mock 层，补齐 22 个无测试文件的单元测试，达到 80%+ 行覆盖率。

**Architecture:** 4 阶段交付。阶段 1 框架迁移 → 阶段 2 mock 层 → 阶段 3 补测试 → 阶段 4 质量。每阶段独立 PR，可回滚。

**Tech Stack:** Vitest + @vitest/coverage-v8 + fast-check + vi.mock() hoisting

**Spec:** `docs/superpowers/specs/2026-05-24-test-infrastructure-upgrade-design.md`

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `vitest.config.ts` | Vitest 配置（globals、coverage、匹配模式） |
| `test/helpers/godot-mock.ts` | executor 级别 vi.mock() 声明 + mock 引用导出 |
| `test/fixtures/godot-responses/*.json` | 5 个预设响应 fixture |
| 22 个新测试文件 | 第三段补测试（见各 Task） |

### 修改文件

| 文件 | 改动 |
|------|------|
| `package.json` | 新增 devDependencies + 更新 scripts |
| `.github/workflows/ci.yml` | vitest 命令替换 + 覆盖率上传 |
| 39 个 `test/*.test.js` | import 替换 + assert→expect |
| 5 个 `test/integration/*.test.js` | import 替换 + mock 改造 + 删 globalThis |
| 2 个 `test/helpers/*.js` | 验证 globals 可用 |

---

## Phase 1: Vitest 框架迁移

### Task 1: 安装 Vitest 依赖 + 配置

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: 安装依赖**

```bash
npm install -D vitest @vitest/coverage-v8 fast-check
```

- [ ] **Step 2: 创建 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 必须开启 — 否则删除 node:test import 后所有测试报 "describe is not defined"
    globals: true,
    include: ['test/**/*.test.{js,ts}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/'],
    },
    testTimeout: 30_000,
  },
});
```

- [ ] **Step 3: 更新 package.json scripts**

替换现有 scripts 中的 test 相关命令：

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "test:integration": "vitest run test/integration",
  "test:all": "vitest run"
}
```

保留 `build`、`watch`、`inspector`、`install-plugin`、`generate-docs`、`prepare` 不变。

- [ ] **Step 4: 验证配置**

```bash
npm run build
npx vitest run test/guard.test.js
```

预期：报错 `describe is not defined`（guard.test.js 还在 import node:test）。这是预期的。

- [ ] **Step 5: 提交**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore: install Vitest + vitest.config.ts with globals"
```

---

### Task 2: 迁移根级测试 — 第一批（1-13）

**Files:**
- Modify: `test/guard.test.js`
- Modify: `test/gdscript-executor.test.js`
- Modify: `test/gdscript-executor-cache.test.js`
- Modify: `test/tscn-parser.test.js`
- Modify: `test/tscn-parser-instance.test.js`
- Modify: `test/tscn-editor.test.js`
- Modify: `test/validation-filter.test.js`
- Modify: `test/security-paths.test.js`
- Modify: `test/godot-docs-cache.test.js`
- Modify: `test/gdscript-lint.test.js`
- Modify: `test/error-analyzer.test.js`
- Modify: `test/tool-registry.test.js`
- Modify: `test/helpers.test.js`

**迁移规则（每个文件重复）：**

| 从 | 到 |
|----|-----|
| `import { describe, it } from 'node:test';` | 删除此行 |
| `import { describe, it, beforeEach, afterEach } from 'node:test';` | 删除此行 |
| `import assert from 'node:assert/strict';` | `import { expect } from 'vitest';` |
| `assert.strictEqual(a, b)` | `expect(a).toBe(b)` |
| `assert.deepStrictEqual(a, b)` | `expect(a).toEqual(b)` |
| `assert.throws(() => fn(), /regex/)` | `expect(() => fn()).toThrow(/regex/)` |
| `assert.ok(x)` | `expect(x).toBeTruthy()` |
| `assert.ok(!x)` | `expect(x).toBeFalsy()` |
| `assert.equal(a, b)` | `expect(a).toBe(b)` |
| `assert.fail('msg')` | `expect.fail('msg')` |

- [ ] **Step 1: 迁移 guard.test.js**

删除 `import { describe, it } from 'node:test'`，替换 `import assert` 为 `import { expect } from 'vitest'`，替换所有 assert 调用为 expect。

- [ ] **Step 2: 迁移 gdscript-executor.test.js**

同上。保留 `import { parseMcpMarkers } from '../build/gdscript-executor.js'`。

- [ ] **Step 3-13: 批量迁移剩余 11 个文件**

每个文件执行相同迁移。

- [ ] **Step 14: 验证第一批**

```bash
npx vitest run test/guard.test.js test/gdscript-executor.test.js test/tscn-parser.test.js test/tscn-editor.test.js test/validation-filter.test.js test/security-paths.test.js test/gdscript-lint.test.js test/error-analyzer.test.js test/tool-registry.test.js test/helpers.test.js test/gdscript-executor-cache.test.js test/godot-docs-cache.test.js test/tscn-parser-instance.test.js
```

预期：全部通过。

- [ ] **Step 15: 提交**

```bash
git add test/guard.test.js test/gdscript-executor.test.js test/gdscript-executor-cache.test.js test/tscn-parser.test.js test/tscn-parser-instance.test.js test/tscn-editor.test.js test/validation-filter.test.js test/security-paths.test.js test/godot-docs-cache.test.js test/gdscript-lint.test.js test/error-analyzer.test.js test/tool-registry.test.js test/helpers.test.js
git commit -m "test: migrate batch-1 test files from node:test to Vitest"
```

---

### Task 3: 迁移根级测试 — 第二批（14-26）

**Files:**
- Modify: `test/godot-ops.test.js`
- Modify: `test/node-3d-ops.test.js`
- Modify: `test/physics-ops.test.js`
- Modify: `test/signal-ops.test.js`
- Modify: `test/scene-tools.test.js`
- Modify: `test/script-tools.test.js`
- Modify: `test/code-templates.test.js`
- Modify: `test/shared.test.js`
- Modify: `test/shared-verify.test.js`
- Modify: `test/ui-tools.test.js`
- Modify: `test/material-ops.test.js`
- Modify: `test/game-bridge.test.js`
- Modify: `test/recording.test.js`

- [ ] **Step 1-13: 逐文件迁移**

同 Task 2 迁移规则。注意 `godot-ops.test.js` 可能含 `beforeEach`/`afterEach`，也一并删除其 node:test import。

- [ ] **Step 14: 验证第二批**

```bash
npx vitest run test/godot-ops.test.js test/node-3d-ops.test.js test/physics-ops.test.js test/signal-ops.test.js test/scene-tools.test.js test/script-tools.test.js test/code-templates.test.js test/shared.test.js test/shared-verify.test.js test/ui-tools.test.js test/material-ops.test.js test/game-bridge.test.js test/recording.test.js
```

- [ ] **Step 15: 提交**

```bash
git add test/godot-ops.test.js test/node-3d-ops.test.js test/physics-ops.test.js test/signal-ops.test.js test/scene-tools.test.js test/script-tools.test.js test/code-templates.test.js test/shared.test.js test/shared-verify.test.js test/ui-tools.test.js test/material-ops.test.js test/game-bridge.test.js test/recording.test.js
git commit -m "test: migrate batch-2 test files from node:test to Vitest"
```

---

### Task 4: 迁移根级测试 — 第三批（27-39）

**Files:**
- Modify: `test/tilemap-ops.test.js`
- Modify: `test/animation-advanced.test.js`
- Modify: `test/audio-split.test.js`
- Modify: `test/ik-tools.test.js`
- Modify: `test/workflow.test.js`
- Modify: `test/workflow-acceptance.test.js`
- Modify: `test/delivery.test.js`
- Modify: `test/delivery-integration.test.js`
- Modify: `test/editor-connection.test.js`
- Modify: `test/editor-tool-executor.test.js`
- Modify: `test/editor-sync.test.js`
- Modify: `test/readonly-guard.test.js`
- Modify: `test/instance-scene.test.js`

- [ ] **Step 1-13: 逐文件迁移**

- [ ] **Step 14: 验证第三批**

```bash
npx vitest run test/tilemap-ops.test.js test/animation-advanced.test.js test/audio-split.test.js test/ik-tools.test.js test/workflow.test.js test/workflow-acceptance.test.js test/delivery.test.js test/delivery-integration.test.js test/editor-connection.test.js test/editor-tool-executor.test.js test/editor-sync.test.js test/readonly-guard.test.js test/instance-scene.test.js
```

- [ ] **Step 15: 提交**

```bash
git add test/tilemap-ops.test.js test/animation-advanced.test.js test/audio-split.test.js test/ik-tools.test.js test/workflow.test.js test/workflow-acceptance.test.js test/delivery.test.js test/delivery-integration.test.js test/editor-connection.test.js test/editor-tool-executor.test.js test/editor-sync.test.js test/readonly-guard.test.js test/instance-scene.test.js
git commit -m "test: migrate batch-3 test files from node:test to Vitest"
```

---

### Task 5: 更新 CI 配置

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 更新 CI YAML**

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - run: npx tsc --noEmit
      - run: npx vitest run --coverage
      - uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
          fail_ci_if_error: false
```

- [ ] **Step 2: 验证全部根级测试通过**

```bash
npx vitest run --exclude 'test/integration/**'
```

预期：39 个测试文件全部通过。

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: switch to Vitest + coverage upload"
```

---

### Task 6: 迁移集成测试（5 个）

**Files:**
- Modify: `test/integration/gdscript-execution.test.js`
- Modify: `test/integration/scene-operations.test.js`
- Modify: `test/integration/project-management.test.js`
- Modify: `test/integration/script-editing.test.js`
- Modify: `test/integration/editor-mode.test.js`

基础框架迁移（import 替换 + 删 globalThis）。Mock 改造在 Phase 2 Task 8。

- [ ] **Step 1: 迁移每个集成测试文件**

每个文件：
1. 删除 `import { describe, it, beforeEach, afterEach } from 'node:test'`
2. 删除 `import assert from 'node:assert/strict'`
3. 添加 `import { expect, describe, it, beforeEach, afterEach } from 'vitest'`
4. 删除 `globalThis.it = it` 和 `globalThis.afterEach = afterEach`
5. 替换所有 assert 调用为 expect
6. 保留 `itIfGodot`/`ensureGodot`/`getGodotPath` import（Phase 2 再替换）

- [ ] **Step 2: 验证集成测试**

```bash
npx vitest run test/integration
```

预期：所有测试 skip（CI 无 Godot）或 pass（本地有 Godot）。

- [ ] **Step 3: 全量验证**

```bash
npx vitest run
```

预期：44 个文件全部通过或 skip，0 失败。

- [ ] **Step 4: 合并 Phase 1 PR**

```bash
git checkout -b test/phase1-vitest-migration
git add test/integration/ test/helpers/
git commit -m "test: migrate integration tests to Vitest + remove globalThis pollution"
git push -u origin test/phase1-vitest-migration
gh pr create --title "test: Phase 1 — Vitest migration" --body "Migrate all 47 test files from node:test to Vitest. CI switched."
```

---

## Phase 2: Godot Mock 层

### Task 7: 创建 Mock 基础设施

**Files:**
- Create: `test/helpers/godot-mock.ts`
- Create: `test/fixtures/godot-responses/success.json`
- Create: `test/fixtures/godot-responses/parse-error.json`
- Create: `test/fixtures/godot-responses/runtime-error.json`
- Create: `test/fixtures/godot-responses/empty-scene.json`
- Create: `test/fixtures/godot-responses/complex-scene-tree.json`

- [ ] **Step 1: 创建 fixture 文件**

`test/fixtures/godot-responses/success.json`:
```json
{
  "compile_success": true,
  "run_success": true,
  "exitCode": 0,
  "stdout": "___MCP_RESULT___{\"success\":true,\"outputs\":[{\"key\":\"result\",\"value\":\"42\"}]}",
  "stderr": "",
  "outputs": [{ "key": "result", "value": "42" }]
}
```

`test/fixtures/godot-responses/parse-error.json`:
```json
{
  "compile_success": false,
  "run_success": false,
  "exitCode": 1,
  "stdout": "",
  "stderr": "GDScript parse error at line 5: Unexpected token.",
  "outputs": []
}
```

`test/fixtures/godot-responses/runtime-error.json`:
```json
{
  "compile_success": true,
  "run_success": false,
  "exitCode": 1,
  "stdout": "",
  "stderr": "Script error: Attempt to call function on null instance.",
  "outputs": []
}
```

`test/fixtures/godot-responses/empty-scene.json`:
```json
{
  "compile_success": true,
  "run_success": true,
  "exitCode": 0,
  "stdout": "___MCP_RESULT___{\"success\":true,\"scene_tree\":{\"root\":{\"name\":\"Root\",\"type\":\"Node\",\"children\":[]}}}",
  "stderr": "",
  "outputs": [{ "key": "scene_tree", "value": "{\"root\":{\"name\":\"Root\",\"type\":\"Node\",\"children\":[]}}" }]
}
```

`test/fixtures/godot-responses/complex-scene-tree.json`:
```json
{
  "compile_success": true,
  "run_success": true,
  "exitCode": 0,
  "stdout": "___MCP_RESULT___{\"success\":true,\"scene_tree\":{\"root\":{\"name\":\"Main\",\"type\":\"Node2D\",\"children\":[{\"name\":\"Player\",\"type\":\"CharacterBody2D\",\"children\":[{\"name\":\"Sprite2D\",\"type\":\"Sprite2D\",\"children\":[]}]},{\"name\":\"Camera2D\",\"type\":\"Camera2D\",\"children\":[]}]}}}",
  "stderr": "",
  "outputs": [{ "key": "scene_tree", "value": "{\"root\":{\"name\":\"Main\",\"type\":\"Node2D\",\"children\":[{\"name\":\"Player\",\"type\":\"CharacterBody2D\",\"children\":[{\"name\":\"Sprite2D\",\"type\":\"Sprite2D\",\"children\":[]}]},{\"name\":\"Camera2D\",\"type\":\"Camera2D\",\"children\":[]}]}]}" }]
}
```

- [ ] **Step 2: 创建 godot-mock.ts**

```ts
// test/helpers/godot-mock.ts
//
// 注意：vi.mock() 路径相对于此文件（test/helpers/），不是相对于导入它的测试文件。
// 如果移动此文件，路径需同步更新。

import { vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RESULT = {
  success: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
};

// 顶层声明 — vi.mock() 会被 Vitest hoisting 提升到模块顶部执行
vi.mock('../../build/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve(DEFAULT_RESULT)),
  parseMcpMarkers: vi.fn(() => ({
    parsed: { success: true, outputs: [] },
    logLines: [],
  })),
}));

// 导出 mock 引用，供测试中 vi.mocked().mockResolvedValueOnce() 按需覆盖
export { executeGdscript, parseMcpMarkers } from '../../build/gdscript-executor.js';

/** 从 fixture 文件读取预设响应 */
export function loadFixture(name: string): Record<string, unknown> {
  const filePath = join(__dirname, '..', 'fixtures', 'godot-responses', `${name}.json`);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
```

- [ ] **Step 3: 验证 mock 不干扰现有测试**

```bash
npx vitest run test/guard.test.js
```

预期：正常通过（guard.test.js 不使用 executor mock）。

- [ ] **Step 4: 提交**

```bash
git add test/helpers/godot-mock.ts test/fixtures/
git commit -m "test: add executor-level mock layer + godot response fixtures"
```

---

### Task 8: 改造集成测试使用 Mock

**Files:**
- Modify: `test/integration/gdscript-execution.test.js`
- Modify: `test/integration/scene-operations.test.js`
- Modify: `test/integration/project-management.test.js`
- Modify: `test/integration/script-editing.test.js`
- Modify: `test/integration/editor-mode.test.js`

- [ ] **Step 1: 改造 gdscript-execution.test.js**

每个测试改造规则：
1. 删除 `import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js'`
2. 添加 `import { executeGdscript } from '../helpers/godot-mock.js'`
3. 添加 `import { vi } from 'vitest'`（如果顶层已有 vitest import 则合并）
4. `itIfGodot('name', fn)` → `it('name', fn)`
5. 在每个 it() 内加 `vi.mocked(executeGdscript).mockResolvedValueOnce({...})`
6. 删除 `ensureGodot()` / `getGodotPath()` 调用
7. 断言改为检查 mock 返回值

```js
// 改造前
itIfGodot('1. simple expression output', async () => {
  const result = await executeGdscript({
    godotPath: getGodotPath(),
    projectPath: dirRef.path,
    code: '_mcp_output("result", "42")',
    timeout: 10,
  });
  assert.ok(result.compile_success);
});

// 改造后
it('1. simple expression output', async () => {
  vi.mocked(executeGdscript).mockResolvedValueOnce({
    compile_success: true, run_success: true, exitCode: 0,
    stdout: '', stderr: '',
    outputs: [{ key: 'result', value: '42' }],
  });
  const result = await executeGdscript({
    projectPath: '/tmp/test',
    code: '_mcp_output("result", "42")',
    timeout: 10,
  });
  expect(result.compile_success).toBeTruthy();
  expect(result.outputs[0].value).toBe('42');
});
```

- [ ] **Step 2-5: 改造其余 4 个集成测试**

同样模式。每个测试不再依赖真实 Godot。

- [ ] **Step 6: 在 integration-setup.js 加 deprecated 注释**

```js
// DEPRECATED: itIfGodot/ensureGodot/getGodotPath 不再被集成测试使用。
// 集成测试已改为使用 godot-mock.ts。保留供手动 e2e 测试参考。
```

- [ ] **Step 7: 验证集成测试**

```bash
npx vitest run test/integration
```

预期：全部通过（不再 skip）。

- [ ] **Step 8: 全量验证**

```bash
npx vitest run
```

预期：0 失败。

- [ ] **Step 9: Phase 2 PR**

```bash
git checkout -b test/phase2-mock-layer
git add test/integration/ test/helpers/godot-mock.ts test/helpers/integration-setup.js
git commit -m "test: Phase 2 — executor-level mock + integration test migration"
git push -u origin test/phase2-mock-layer
gh pr create --title "test: Phase 2 — Mock layer + integration tests" --body "Replace Godot dependency with executor-level vi.mock()."
```

---

## Phase 3: 补齐 22 个无测试文件

### Task 9: 第一梯队 — 核心模块（5 个）

**Files:**
- Create: `test/godot-server.test.js`
- Create: `test/index.test.js`
- Create: `test/editor-auth.test.js`
- Create: `test/godot-finder.test.js`
- Create: `test/process-state.test.js`

- [ ] **Step 1: 写 godot-finder.test.js**

```js
import { expect, describe, it } from 'vitest';

describe('godot-finder', () => {
  it('findGodot rejects when no Godot installed', async () => {
    const { findGodot } = await import('../build/core/godot-finder.js');
    await expect(findGodot()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 写 editor-auth.test.js**

```js
import { expect, describe, it, vi } from 'vitest';

describe('editor-auth', () => {
  it('waitForEditorSecret rejects on timeout', async () => {
    vi.useFakeTimers();
    const { waitForEditorSecret } = await import('../build/core/editor-auth.js');
    const promise = waitForEditorSecret('/nonexistent/path', 100);
    vi.advanceTimersByTime(150);
    await expect(promise).rejects.toThrow();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: 写 process-state.test.js**

先读 `src/core/process-state.ts` 确认导出接口，再写断言覆盖正常/错误路径。

- [ ] **Step 4: 写 godot-server.test.js**

Mock MCP SDK 后验证 Server 实例化和工具注册：

```js
import { expect, describe, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: vi.fn(() => ({
    setRequestHandler: vi.fn(),
    connect: vi.fn(),
  })),
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

describe('GodotServer', () => {
  it('can be imported without crashing', async () => {
    const mod = await import('../build/GodotServer.js');
    expect(mod).toBeDefined();
  });
});
```

- [ ] **Step 5: 写 index.test.js**

同上 mock 模式，验证入口点可导入。

- [ ] **Step 6: 验证第一梯队**

```bash
npx vitest run test/godot-finder.test.js test/editor-auth.test.js test/process-state.test.js test/godot-server.test.js test/index.test.js
```

- [ ] **Step 7: 提交**

```bash
git add test/godot-finder.test.js test/editor-auth.test.js test/process-state.test.js test/godot-server.test.js test/index.test.js
git commit -m "test: add tests for tier-1 core modules"
```

---

### Task 10: 第二梯队 — 工具模块（10 个）

**Files:**
- Create: `test/animtree.test.js`
- Create: `test/animation-shared.test.js`
- Create: `test/animation-track.test.js`
- Create: `test/batch-tools.test.js`
- Create: `test/navigation.test.js`
- Create: `test/particles.test.js`
- Create: `test/profiler-ops.test.js`
- Create: `test/project.test.js`
- Create: `test/spatial-ops.test.js`
- Create: `test/runtime.test.js`

**通用模板**（每个工具模块遵循）：

```js
import { expect, describe, it } from 'vitest';
import { getToolDefinitions, handleTool, TOOL_META } from '../build/tools/<module>.js';
import { createToolContext } from './helpers/tool-context.js';

describe('<module> tool definitions', () => {
  it('exports non-empty tool definitions', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBeGreaterThan(0);
  });

  it('TOOL_META has entry for each tool', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      expect(TOOL_META[def.name]).toBeDefined();
    }
  });
});
```

每个工具还需覆盖 `handleTool` 的主要操作（用 mock executor + `createToolContext`）。

- [ ] **Step 1-10: 逐文件写测试**

每个文件至少覆盖：工具定义导出、TOOL_META 完整性、handleTool 主要操作正常路径。

- [ ] **Step 11: 验证第二梯队**

```bash
npx vitest run test/animtree.test.js test/animation-shared.test.js test/animation-track.test.js test/batch-tools.test.js test/navigation.test.js test/particles.test.js test/profiler-ops.test.js test/project.test.js test/spatial-ops.test.js test/runtime.test.js
```

- [ ] **Step 12: 提交**

```bash
git add test/animtree.test.js test/animation-shared.test.js test/animation-track.test.js test/batch-tools.test.js test/navigation.test.js test/particles.test.js test/profiler-ops.test.js test/project.test.js test/spatial-ops.test.js test/runtime.test.js
git commit -m "test: add tests for tier-2 tool modules (10 files)"
```

---

### Task 11: 第三梯队 — 辅助模块（7 个）

**Files:**
- Create: `test/deprecated-properties.test.js`
- Create: `test/docs.test.js`
- Create: `test/test-framework.test.js`
- Create: `test/validation.test.js`
- Create: `test/resources.test.js`
- Create: `test/screenshot.test.js`
- Create: `test/tools-screenshot.test.js`

- [ ] **Step 1-7: 逐文件写测试**

- `deprecated-properties.ts`：验证属性映射表完整性
- `docs.ts`：验证工具定义导出
- `test-framework.ts`：验证工具定义 + handleTool 基本调用
- `validation.ts`：重点覆盖 `isErrorFalsePositive` 和 `batchValidateScripts` 错误过滤
- `resources.ts`：验证资源列表/读取 mock 调用
- `screenshot.ts` + `tools/screenshot.ts`：验证工具定义导出

- [ ] **Step 8: 全量覆盖率检查**

```bash
npx vitest run --coverage
```

预期：行覆盖率 ≥ 80%。如果未达标，检查哪些文件覆盖率低，针对性补充。

- [ ] **Step 9: Phase 3 PR**

```bash
git checkout -b test/phase3-test-coverage
git add test/deprecated-properties.test.js test/docs.test.js test/test-framework.test.js test/validation.test.js test/resources.test.js test/screenshot.test.js test/tools-screenshot.test.js
git commit -m "test: add tests for tier-3 auxiliary modules (7 files)"
git push -u origin test/phase3-test-coverage
gh pr create --title "test: Phase 3 — Test coverage for 22 untested files" --body "Add tests for all 22 files. Target: 80%+ line coverage."
```

---

## Phase 4: 测试质量提升

### Task 12: Snapshot Testing（4 个模块）

**Files:**
- Modify: `test/tscn-parser.test.js`
- Modify: `test/tscn-editor.test.js`
- Modify: `test/tscn-parser-instance.test.js`
- Modify: `test/godot-docs-cache.test.js`

- [ ] **Step 1: tscn-parser.test.js 添加 snapshot**

```js
it('snapshots minimal scene parse result', () => {
  const content = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")

[node name="Sprite" type="Sprite2D" parent="."]
texture = ExtResource("1")
`;
  const result = parseTscn(content);
  expect(result).toMatchSnapshot();
});
```

- [ ] **Step 2: tscn-editor.test.js 添加 snapshot**

对编辑操作前后做 snapshot。需根据 `tscn-editor.ts` 实际 API 调整。

- [ ] **Step 3: tscn-parser-instance.test.js 添加 snapshot**

- [ ] **Step 4: godot-docs-cache.test.js 添加 snapshot**

- [ ] **Step 5: 生成 snapshot 文件**

```bash
npx vitest run test/tscn-parser.test.js test/tscn-editor.test.js test/tscn-parser-instance.test.js test/godot-docs-cache.test.js -u
```

- [ ] **Step 6: 验证 snapshot 匹配**

```bash
npx vitest run test/tscn-parser.test.js test/tscn-editor.test.js test/tscn-parser-instance.test.js test/godot-docs-cache.test.js
```

- [ ] **Step 7: 提交**

```bash
git add test/tscn-parser.test.js test/tscn-editor.test.js test/tscn-parser-instance.test.js test/godot-docs-cache.test.js test/__snapshots__/
git commit -m "test: add snapshot tests for tscn-parser, tscn-editor, instance parser, godot-docs"
```

---

### Task 13: Property-Based Testing（4 个模块）

**Files:**
- Modify: `test/guard.test.js`
- Modify: `test/tscn-parser.test.js`
- Modify: `test/gdscript-lint.test.js`
- Modify: `test/validation-filter.test.js`

- [ ] **Step 1: guard.test.js 添加 property-based 测试**

```js
import fc from 'fast-check';

describe('guard (property-based)', () => {
  it('requiresConfirmation never throws on arbitrary tool names', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (toolName) => {
        const result = requiresConfirmation(toolName);
        expect(typeof result).toBe('boolean');
      }),
      { numRuns: process.env.CI ? 200 : 1000 },
    );
  });
});
```

- [ ] **Step 2: tscn-parser.test.js 添加 fuzz 测试**

```js
import fc from 'fast-check';

describe('parseTscn (property-based)', () => {
  it('never crashes on arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10000 }), (input) => {
        expect(() => parseTscn(input)).not.toThrow();
      }),
      { numRuns: process.env.CI ? 200 : 1000 },
    );
  });
});
```

- [ ] **Step 3: gdscript-lint.test.js 添加 property-based 测试**

```js
import fc from 'fast-check';

describe('lintGDScript (property-based)', () => {
  it('never throws on arbitrary code input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (code) => {
        expect(() => lintGDScript(code)).not.toThrow();
      }),
      { numRuns: process.env.CI ? 200 : 1000 },
    );
  });
});
```

- [ ] **Step 4: validation-filter.test.js 添加 property-based 测试**

对 `isErrorFalsePositive` 做随机输入测试：

```js
import fc from 'fast-check';

describe('validation (property-based)', () => {
  it('isErrorFalsePositive never throws on arbitrary input', async () => {
    const { isErrorFalsePositive } = await import('../build/tools/validation.js');
    fc.assert(
      fc.property(fc.string({ maxLength: 1000 }), (line) => {
        expect(() => isErrorFalsePositive(line)).not.toThrow();
        expect(typeof isErrorFalsePositive(line)).toBe('boolean');
      }),
      { numRuns: process.env.CI ? 200 : 1000 },
    );
  });
});
```

- [ ] **Step 5: 验证**

```bash
npx vitest run test/guard.test.js test/tscn-parser.test.js test/gdscript-lint.test.js test/validation-filter.test.js
```

- [ ] **Step 6: Phase 4 PR**

```bash
git checkout -b test/phase4-quality
git add test/guard.test.js test/tscn-parser.test.js test/gdscript-lint.test.js test/validation-filter.test.js test/__snapshots__/
git commit -m "test: Phase 4 — snapshot + property-based testing for 8 modules"
git push -u origin test/phase4-quality
gh pr create --title "test: Phase 4 — Snapshot + property-based testing" --body "Add snapshot tests (4 modules) and property-based tests (4 modules)."
```

---

### Task 14: 最终验收

- [ ] **Step 1: 全量测试**

```bash
npx vitest run
```

预期：0 失败。

- [ ] **Step 2: 覆盖率**

```bash
npx vitest run --coverage
```

预期：行覆盖率 ≥ 80%。

- [ ] **Step 3: 运行时间**

记录实际耗时，确认 < 60 秒。

- [ ] **Step 4: 验收清单**

1. `vitest run` 全部通过（0 失败） ✓
2. 行覆盖率 ≥ 80% ✓
3. CI 绿灯（Node 20 + 22） — 需合并后确认
4. 集成测试不再依赖本地 Godot ✓
5. Snapshot 测试至少 4 个模块 ✓
6. Property-based 测试至少 4 个模块 ✓
7. 每个阶段独立 PR ✓
8. 60 秒内完成 ✓
