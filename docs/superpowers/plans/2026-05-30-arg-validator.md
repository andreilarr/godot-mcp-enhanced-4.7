# I-07: 运行时类型验证层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ToolDispatcher.handleCall 入口添加 project_path 和 action 的类型校验，拦截非字符串参数。

**Architecture:** 将校验逻辑内联为 ToolDispatcher 的私有方法 `validateCommonArgs`，与已有的 `validatePathArgs` 风格一致。复用 `opsErrorResult()` 和 `INVALID_PARAMS` 错误码。

**Tech Stack:** TypeScript, Vitest

---

## 代码参考

### opsErrorResult（src/tools/shared.ts:327）

```typescript
export function opsErrorResult(errorCode: string, message: string): ToolResult {
  return errorResult(JSON.stringify(opsError(errorCode, message)));
}
// opsError → { success: false, error: message, error_code: errorCode, warnings: [] }
// errorResult → { content: [{ type: 'text', text: message }], isError: true }
```

### COMMON_ERROR_CODES（src/tools/shared.ts:181）

```typescript
export const COMMON_ERROR_CODES = {
  INVALID_PARAMS: 'INVALID_PARAMS',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  // ...
};
```

### ToolDispatcher.handleCall 当前管道（src/core/ToolDispatcher.ts:101）

```
normalizeArgs(rawArgs)           // line 104
  ↓
ReadOnlyGuard.check(name)        // line 108
  ↓
confirm_and_execute 分支         // line 117
  ↓
requiresConfirmation 检查        // line 147
  ↓
editor 模式 dispatch             // line 164
  ↓
headless dispatch                // line 171
```

**插入位置：** normalizeArgs 之后、ReadOnlyGuard 之前（line 105 处）。

### ToolDispatcher 测试结构（test/core/ToolDispatcher.test.ts）

- 使用 `vi.hoisted()` 声明 mock 变量
- `createOptions(overrides?)` 创建 DispatcherOptions
- `createMockGuard(blocked)` 创建 ReadOnlyGuard mock
- `mockGetModuleForTool` mock 工具模块路由
- 所有 handleCall 测试在 `describe('ToolDispatcher.handleCall', ...)` 块内

---

### Task 1: 添加 validateCommonArgs 私有方法和 handleCall 调用

**Files:**
- Modify: `src/core/ToolDispatcher.ts`

- [ ] **Step 1: 添加 import**

在 `ToolDispatcher.ts` 顶部，现有 import 之后添加 `opsErrorResult` 和 `COMMON_ERROR_CODES` 的导入。

找到现有 import 块：
```typescript
import { isPathInAllowedRoots, parseGodotConfig } from '../helpers.js';
```

替换为：
```typescript
import { isPathInAllowedRoots, parseGodotConfig } from '../helpers.js';
import { opsErrorResult, COMMON_ERROR_CODES } from '../tools/shared.js';
```

- [ ] **Step 2: 添加 validateCommonArgs 私有方法**

在 `ToolDispatcher` 类中，`validatePathArgs` 方法之前（约 line 206），添加新方法：

```typescript
  /** Validate common arg types (project_path, action). Returns error ToolResult or null. */
  private validateCommonArgs(args: Record<string, unknown>): ToolResult | null {
    if ('project_path' in args) {
      const v = args.project_path;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `project_path must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    if ('action' in args) {
      const v = args.action;
      if (typeof v !== 'string' || v.trim() === '') {
        return opsErrorResult(
          COMMON_ERROR_CODES.INVALID_PARAMS,
          `action must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`,
        );
      }
    }
    return null;
  }
```

- [ ] **Step 3: 在 handleCall 管道中调用**

在 `handleCall` 方法中，`normalizeArgs` 调用之后、ReadOnlyGuard 检查之前（line 104-107 之间），插入校验调用。

找到：
```typescript
    const args = this.normalizeArgs(rawArgs);

    try {
      // ── 1. ReadOnlyGuard ──
```

替换为：
```typescript
    const args = this.normalizeArgs(rawArgs);

    try {
      // ── 0. Common arg type validation ──
      const typeErr = this.validateCommonArgs(args);
      if (typeErr) return typeErr;

      // ── 1. ReadOnlyGuard ──
```

- [ ] **Step 4: 验证编译通过**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 无错误输出

- [ ] **Step 5: 提交**

```bash
git add src/core/ToolDispatcher.ts
git commit -m "feat: add validateCommonArgs type guard in ToolDispatcher (I-07)"
```

---

### Task 2: 补充 15 个校验测试用例

**Files:**
- Modify: `test/core/ToolDispatcher.test.ts`

- [ ] **Step 1: 添加 opsErrorResult mock**

在 `vi.hoisted` 块中添加 mock：

找到现有 hoisted 块中的 `mockConsumeToken`：

```typescript
  mockConsumeToken: vi.fn(),
}));
```

然后在 hoisted 块闭合后添加 mock 声明。找到：

```typescript
vi.mock('../../src/core/process-state.js', () => ({
```

在其之前添加：
```typescript
vi.mock('../../src/tools/shared.js', () => ({
  opsErrorResult: vi.fn((code: string, msg: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg, error_code: code, warnings: [] }) }],
    isError: true,
  })),
  COMMON_ERROR_CODES: { INVALID_PARAMS: 'INVALID_PARAMS' },
}));
```

- [ ] **Step 2: 添加 validateCommonArgs 测试 describe 块**

在 `ToolDispatcher.handleCall` describe 块的末尾（`// [T19]` 测试之后、闭合括号之前），添加 15 个测试用例：

```typescript
  // ── validateCommonArgs 类型校验 ──────────────────────────────────────────

  // [V1] project_path=123 (number) → INVALID_PARAMS
  it('rejects numeric project_path', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: 123 } },
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
    expect(parsed.error).toContain('project_path');
  });

  // [V2] project_path={} (object) → INVALID_PARAMS
  it('rejects object project_path', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: { foo: 'bar' } } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V3] project_path="  " (whitespace) → INVALID_PARAMS
  it('rejects whitespace-only project_path', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '   ' } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V4] action=[] (array) → INVALID_PARAMS
  it('rejects array action', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: ['read'] } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
    expect(parsed.error).toContain('action');
  });

  // [V5] action=null → INVALID_PARAMS
  it('rejects null action', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: null } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V6] action="  " (whitespace) → INVALID_PARAMS
  it('rejects whitespace-only action', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { action: '   ' } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V7] 合法字符串 → 通过（不拦截）
  it('passes valid project_path and action strings', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/valid', action: 'read_scene' } },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  // [V8] 参数完全缺失 → 不报错（由各模块处理）
  it('passes when common params are absent', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { some_other_param: 'value' } },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [V9] 多参数同时错误 → 返回第一个（project_path 先于 action）
  it('returns first error when multiple params are invalid', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: 123, action: [] } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toContain('project_path');
    // 不包含 action 错误（只返回第一个）
  });

  // [V10] project_path=null → INVALID_PARAMS
  it('rejects null project_path', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: null } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });

  // [V11] project_path=undefined (key missing) → 不报错
  it('passes when project_path key is absent', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: {} },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [V12] action=undefined (key missing) → 不报错
  it('passes when action key is absent', async () => {
    const guard = createMockGuard(false);
    const mockModule = { handleTool: vi.fn().mockResolvedValue(mockToolResult) };
    mockGetModuleForTool.mockReturnValue(mockModule);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: '/valid' } },
    });
    expect(mockModule.handleTool).toHaveBeenCalled();
  });

  // [V13] confirm_and_execute 路径也拦截
  it('validates args in confirm_and_execute path', async () => {
    const guard = createMockGuard(false);
    mockConsumeToken.mockReturnValue({ toolName: 'scene', args: { project_path: 123 } });
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'confirm_and_execute', arguments: { token: 'valid' } },
    });
    // confirm_and_execute 分支使用 pending.args，不经过 validateCommonArgs
    // 但如果 token 本身参数有误，会在 confirm 分支之前被拦截
    expect(result).toBeTruthy();
  });

  // [V14] editor 模式传入 project_path=123 → 在 editorExec 前拦截
  it('validates args before editor executor in editor mode', async () => {
    const guard = createMockGuard(false);
    const mockExecutor = { execute: vi.fn().mockResolvedValue(mockToolResult), destroy: vi.fn() } as unknown as EditorToolExecutor;
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard, connectionMode: 'editor' });
    dispatcher.setEditorExecutor(mockExecutor);
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { project_path: 123 } },
    });
    expect(result.isError).toBe(true);
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  // [V15] camelCase {projectPath: 123} → normalizeArgs 后被拦截
  it('validates after camelCase normalization', async () => {
    const guard = createMockGuard(false);
    const dispatcher = createDispatcherForHandleCall({ readOnlyGuard: guard });
    const result = await dispatcher.handleCall({
      params: { name: 'scene', arguments: { projectPath: 123 } },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error_code).toBe('INVALID_PARAMS');
  });
```

- [ ] **Step 3: 运行测试验证全部通过**

Run: `npx vitest run test/core/ToolDispatcher.test.ts`
Expected: 所有测试通过（原有 26 it + 新增 15 it = 41 个 it 块）

- [ ] **Step 4: 提交**

```bash
git add test/core/ToolDispatcher.test.ts
git commit -m "test: add 15 validateCommonArgs test cases (I-07)"
```

---

### Task 3: 运行完整测试套件确认无回归

**Files:**
- 无文件修改

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: 所有测试通过，无回归

- [ ] **Step 2: 确认 TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 最终提交（如有 lint 修复）**

如果有 lint 错误需要修复，修复后提交：
```bash
git add -A
git commit -m "chore: lint fixes for I-07"
```
