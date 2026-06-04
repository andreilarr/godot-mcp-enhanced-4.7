# 审查修复完整批次 — 实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审查报告全部 10 个 IMPORTANT + 4 个高价值 ADVISORY 发现

**Architecture:** 每个修复独立成任务，按依赖顺序排列。先修基础设施（I-01/I-02/I-06），再修工具层（I-04/A-12/A-13/A-14/A-18），最后补文档（I-03/I-05）。每个任务含测试→实现→验证→提交四步。

**Tech Stack:** TypeScript (strict), Vitest, Node.js

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/GodotServer.ts` | I-01: 注册 editorConn 断连处理器 |
| 修改 | `src/core/ToolDispatcher.ts` | I-02: confirm_and_execute TOOL_META 注册 |
| 修改 | `src/core/tool-registry.ts` | I-02: metaRegistry 注册入口 |
| 修改 | `src/tools/script.ts` | I-04: project_replace 原子写入 |
| 修改 | `src/guard.ts` | I-05: consumeToken 调用者绑定 |
| 修改 | `src/core/process-state.ts` | I-06: setRunningProcess(null) 日志警告 |
| 修改 | `src/tools/scene.ts` | A-12: requireString(scene_path) + A-13: acquireShortRunningSlot + A-14: spawn 移入 Promise |
| 修改 | `src/tools/batch-tools.ts` | A-18: runSingleVerify settled 保护 |
| 修改 | `README.md` | I-03: Bridge 多用户限制文档 |

---

## Task 1: I-01 — Editor 重连耗尽后自动降级 headless

**Files:**
- Modify: `src/GodotServer.ts:174-218`

**分析：** `EditorConnection.scheduleReconnect()` 在重连耗尽时调用 `fireDisconnect()`。`GodotServer.run()` 创建 `editorConn` 后没有注册 `onDisconnect` 处理器，导致重连耗尽后 Dispatcher 仍处于 editor 模式。

- [ ] **Step 1: 编写测试**

在 `test/GodotServer.test.js` 中添加测试：

```javascript
test('I-01: editor reconnect exhaustion degrades to headless', async () => {
  // 构造: editorConn 连接成功后，模拟重连耗尽
  // 验证: dispatcher.connectionMode 变为 'headless'
  // 验证: dispatcher._editorFallback 为 true
  // 验证: editorExecutor 被销毁 (setEditorExecutor(null))
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/GodotServer.test.js --reporter=verbose 2>&1 | head -40`
Expected: FAIL — dispatcher 仍为 editor 模式

- [ ] **Step 3: 实现**

在 `GodotServer.run()` 的 `editorConn.connect()` 成功后，注册 disconnect 处理器：

```typescript
// 在 this.dispatcher?.setEditorExecutor(this.editorExecutor); 之后添加:
this.editorConn.addOnDisconnectHandler(() => {
  if (!this.editorConn?.isConnected()) {
    console.error('[FALLBACK] Editor reconnect attempts exhausted — degrading to headless mode.');
    this.dispatcher?.markEditorFallback();
    this.connectionMode = 'headless';
    this.dispatcher?.setConnectionMode('headless');
    this.dispatcher?.setEditorExecutor(null);
    this.editorConn = null;
  }
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/GodotServer.test.js --reporter=verbose`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/GodotServer.ts test/GodotServer.test.js
git commit -m "fix(I-01): editor reconnect exhaustion auto-degrades to headless"
```

---

## Task 2: I-02 — confirm_and_execute 注册 TOOL_META

**Files:**
- Modify: `src/core/ToolDispatcher.ts:76-91`
- Modify: `src/core/tool-registry.ts:31-47`

**分析：** `confirm_and_execute` 在 `getFilteredTools()` 内联添加，但不在 `metaRegistry` 中。`ReadOnlyGuard` 对未知工具 deny-by-default。

- [ ] **Step 1: 编写测试**

在 `test/tool-registry.test.js` 或 `test/ToolDispatcher.test.js` 中添加：

```javascript
test('I-02: confirm_and_execute is registered in metaRegistry as readonly', () => {
  // 验证 isKnownTool('confirm_and_execute') === true
  // 验证 isReadOnly('confirm_and_execute') === true
});

test('I-02: confirm_and_execute passes ReadOnlyGuard in read-only mode', () => {
  // 构造 readOnly=true 的 dispatcher
  // 验证 getFilteredTools() 包含 confirm_and_execute
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/tool-registry.test.js test/ToolDispatcher.test.js --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — isKnownTool 返回 false

- [ ] **Step 3: 实现**

在 `ToolDispatcher` 构造器中调用新方法注册内联工具元数据。修改 `tool-registry.ts` 添加 `registerInlineTool` 函数：

`src/core/tool-registry.ts` 添加:
```typescript
/** Register an inline tool's metadata (for tools not in a ToolModule). */
export function registerInlineTool(name: string, meta: Omit<ToolMeta, 'name'>): void {
  metaRegistry.set(name, { name, ...meta });
}
```

`src/core/ToolDispatcher.ts` 构造器末尾添加:
```typescript
// 注册内联工具元数据
import { registerInlineTool } from './tool-registry.js';
registerInlineTool('confirm_and_execute', { readonly: true, long_running: false });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/tool-registry.test.js test/ToolDispatcher.test.js --reporter=verbose`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/tool-registry.ts src/core/ToolDispatcher.ts test/tool-registry.test.js test/ToolDispatcher.test.js
git commit -m "fix(I-02): register confirm_and_execute TOOL_META for read-only mode"
```

---

## Task 3: I-04 — project_replace 原子写入

**Files:**
- Modify: `src/tools/script.ts:793-817`

**分析：** `project_replace` 循环中逐文件 `writeFileSync`，中途失败无法回滚。项目中 `scene.ts` 和 `game-bridge.ts` 已使用 temp+rename 模式。

- [ ] **Step 1: 编写测试**

在 `test/script.test.js` 中添加：

```javascript
test('I-04: project_replace uses atomic write (temp+rename)', async () => {
  // 设置: 创建 3 个 .gd 文件含搜索文本
  // 调用 project_replace
  // 验证: 所有文件正确修改
  // 验证: 无残留 .tmp 文件
});

test('I-04: project_replace rolls back on mid-batch failure', async () => {
  // 设置: 创建 3 个文件，第 2 个设为只读（写入失败）
  // 调用 project_replace
  // 验证: 第 1 个文件保持原内容（回滚）
  // 验证: 无残留 .tmp 文件
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/script.test.js --reporter=verbose -t "I-04" 2>&1 | tail -30`
Expected: FAIL 或 SKIP（功能不存在）

- [ ] **Step 3: 实现**

修改 `script.ts` 中 `project_replace` 的写入逻辑，替换直接 `writeFileSync` 为两阶段写入：

```typescript
// 替换原有的 for 循环内写入逻辑:

// Phase 1: 收集所有变更到内存
const pendingWrites: Array<{ filePath: string; finalContent: string; originalContent: string }> = [];

for (const filePath of matchedFiles) {
  // ... 原有的 size check 和 content normalization ...
  if (!normalized.includes(normalizedSearch)) { unchangedFiles.push(relOf(filePath)); continue; }
  const count = normalized.split(normalizedSearch).length - 1;
  totalReplacements += count;
  if (!dryRun) {
    const newContent = normalized.split(normalizedSearch).join(normalizedReplace);
    const finalContent = hasCRLF ? newContent.split('\n').join('\r\n') : newContent;
    pendingWrites.push({ filePath, finalContent, originalContent: content });
  }
  changedFiles.push(relOf(filePath));
}

// Phase 2: 原子写入 — 先写 .tmp 再 rename
if (!dryRun && pendingWrites.length > 0) {
  const tmpFiles: string[] = [];
  try {
    for (const pw of pendingWrites) {
      const tmpPath = pw.filePath + '.tmp';
      writeFileSync(tmpPath, pw.finalContent, 'utf-8');
      tmpFiles.push(tmpPath);
    }
    // 全部 tmp 写入成功，批量 rename
    for (let i = 0; i < pendingWrites.length; i++) {
      renameSync(tmpFiles[i], pendingWrites[i].filePath);
    }
  } catch (writeErr) {
    // 回滚: 删除残留 tmp 文件（已 rename 的不回退，因 rename 是原子的）
    for (const tmp of tmpFiles) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    }
    return opsErrorResult('ATOMIC_WRITE_FAILED', `Batch write failed: ${(writeErr as Error).message}. ${pendingWrites.length} files may be partially updated.`);
  }
}
```

需要在文件顶部确保 import: `import { renameSync, unlinkSync } from 'fs';`（`writeFileSync` 和 `existsSync` 已导入）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/script.test.js --reporter=verbose -t "I-04"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/script.ts test/script.test.js
git commit -m "fix(I-04): project_replace atomic write with temp+rename"
```

---

## Task 4: I-05 — 确认令牌添加调用者绑定注释

**Files:**
- Modify: `src/guard.ts:90-98`

**分析：** `consumeToken()` 仅验证 token 值，不验证调用者。MCP 协议通常是单客户端连接，实际风险低。添加 JSDoc 注释说明此限制 + 未来扩展点。

- [ ] **Step 1: 实现**

在 `guard.ts` 的 `PendingToken` 接口添加注释，`consumeToken` 添加 JSDoc：

```typescript
interface PendingToken {
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: number;
  // FUTURE: Add clientId field for multi-client isolation.
  // Currently MCP is single-client, so token-to-caller binding is unnecessary.
}

/**
 * Consume a pending confirmation token.
 *
 * SECURITY NOTE: This function validates the token value but does NOT verify
 * the caller's identity. In the current single-client MCP architecture this
 * is safe. If multi-client support is added, PendingToken needs a `clientId`
 * field and this function must verify it matches the current caller.
 */
export function consumeToken(token: string): { toolName: string; args: Record<string, unknown> } | null {
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: all tests pass

- [ ] **Step 3: 提交**

```bash
git add src/guard.ts
git commit -m "docs(I-05): document token caller-binding limitation for future multi-client"
```

---

## Task 5: I-06 — setRunningProcess(null) 添加日志警告

**Files:**
- Modify: `src/core/process-state.ts:151-168`

**分析：** `setRunningProcess(null)` 无条件清除 busy 状态，可绕过 acquire/release 语义。在单线程 Node.js 下通常安全，但 MCP 允许并行工具调用时存在风险。

- [ ] **Step 1: 实现**

在 `setRunningProcess` 中，当 `proc === null` 且 `_processBusy === true` 时添加 console.warn：

```typescript
export function setRunningProcess(proc: ChildProcess | null): void {
  if (_processBusy && proc !== null) {
    throw new Error('Cannot replace process while another operation is using it');
  }
  // Clearing the process always clears busy state
  if (proc === null) {
    if (_processBusy) {
      console.warn(
        '[process-state] setRunningProcess(null) called while process is busy (owner: %s). ' +
        'This bypasses acquire/release semantics. Consider using releaseShortRunningSlot() or setProcessBusy(false) instead.',
        _busyOwner || '(unknown)',
      );
    }
    _processBusy = false;
    _busyOwner = '';
  }
  // ... rest unchanged
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: all tests pass

- [ ] **Step 3: 提交**

```bash
git add src/core/process-state.ts
git commit -m "fix(I-06): warn when setRunningProcess(null) bypasses acquire/release semantics"
```

---

## Task 6: A-12 — scene_path 添加 requireString 校验

**Files:**
- Modify: `src/tools/scene.ts:90` 及多处

**分析：** `read_scene`、`edit_node`、`remove_node` 中 `args.scene_path as string` 未校验是否为字符串。`undefined` 传入后行为未定义。其他 action 如 `add_node` 通过 `normalizeUserProjectPath` 间接处理，但 `read_scene` 和 `edit_node`/`remove_node` 缺少保护。

- [ ] **Step 1: 编写测试**

在 `test/scene.test.js` 中添加：

```javascript
test('A-12: read_scene rejects undefined/empty scene_path', async () => {
  const result = await handleTool('scene', { action: 'read_scene', project_path: '/tmp/test' }, mockCtx);
  expect(result.content[0].text).toMatch(/scene_path.*must be a non-empty string/i);
});

test('A-12: edit_node rejects non-string scene_path', async () => {
  const result = await handleTool('scene', { action: 'edit_node', project_path: '/tmp/test', scene_path: 123, node_path: 'root/Node', properties: { x: 1 } }, mockCtx);
  expect(result.content[0].text).toMatch(/scene_path.*must be a non-empty string/i);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/scene.test.js --reporter=verbose -t "A-12" 2>&1 | tail -20`
Expected: FAIL — undefined 未被拦截

- [ ] **Step 3: 实现**

在 `scene.ts` 中添加 `requireString` 辅助函数（如尚未存在），然后在 `read_scene`、`edit_node`、`remove_node` 的 switch case 开头添加校验：

```typescript
// 在 switch (action) 内部，各 case 开头添加:
case 'read_scene': {
  const spErr = requireString(args.scene_path, 'scene_path');
  if (spErr) return spErr;
  // ... existing code
}

case 'edit_node': {
  const spErr = requireString(args.scene_path, 'scene_path');
  if (spErr) return spErr;
  // ... existing code
}

case 'remove_node': {
  const spErr = requireString(args.scene_path, 'scene_path');
  if (spErr) return spErr;
  // ... existing code
}
```

`requireString` 辅助函数（如 scene.ts 中不存在则添加）:
```typescript
function requireString(value: unknown, name: string): ToolResult | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return opsErrorResult(COMMON_ERROR_CODES.INVALID_PARAMS, `${name} must be a non-empty string, got: ${value === undefined ? 'undefined' : typeof value}`);
  }
  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/scene.test.js --reporter=verbose -t "A-12"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/scene.ts test/scene.test.js
git commit -m "fix(A-12): validate scene_path as non-empty string in read/edit/remove"
```

---

## Task 7: A-13 — edit_node/remove_node 添加 acquireShortRunningSlot

**Files:**
- Modify: `src/tools/scene.ts:513, 556`

**分析：** `edit_node` 和 `remove_node` 启动 Godot 进程但未调用 `acquireShortRunningSlot()`，而 `create_scene`/`add_node`/`save_scene` 都有此保护。

- [ ] **Step 1: 编写测试**

在 `test/scene.test.js` 中添加：

```javascript
test('A-13: edit_node acquires short-running slot', async () => {
  // Mock acquireShortRunningSlot to track calls
  // Call edit_node with valid args
  // Verify slot was acquired and released
});

test('A-13: remove_node rejects when concurrency limit reached', async () => {
  // Fill all 3 short-running slots
  // Call remove_node
  // Verify CONCURRENCY_LIMIT error
  // Release slots
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/scene.test.js --reporter=verbose -t "A-13" 2>&1 | tail -20`
Expected: FAIL — edit_node/remove_node 未调用 slot

- [ ] **Step 3: 实现**

在 `edit_node` 和 `remove_node` 的 case 开头添加：

```typescript
case 'edit_node': {
  if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  // ... existing code，但在每个 return 点前添加 releaseShortRunningSlot()
```

注意：`edit_node` 和 `remove_node` 使用 `executeGdscript()` 而非直接 spawn，需要在 `executeGdscript` 调用后释放 slot。最简洁方式是用 try/finally：

```typescript
case 'edit_node': {
  if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  try {
    // ... existing edit_node code ...
  } finally {
    releaseShortRunningSlot();
  }
}
```

同样处理 `remove_node`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/scene.test.js --reporter=verbose -t "A-13"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/scene.ts test/scene.test.js
git commit -m "fix(A-13): edit_node/remove_node acquire short-running slot for concurrency control"
```

---

## Task 8: A-14 — scene.ts spawn 移入 Promise 构造器内

**Files:**
- Modify: `src/tools/scene.ts:168-209`

**分析：** `spawn()` 在 `new Promise()` 构造器外执行，同步异常（如 EACCES）不在 Promise 内被捕获，`releaseShortRunningSlot()` 不会执行。查看代码，`spawn` 实际上在 `return new Promise(...)` 块内部（line 168-209），所以这个问题已经被修复了。

但仔细看代码结构：`create_scene`/`add_node`/`save_scene`/`load_sprite` 共用一个 case 块。参数准备在 Promise 外（lines 115-167），`spawn` 在 Promise 内（line 169）。`ctx.findGodot()` 在 Promise 外（line 119），如果 `findGodot` 抛异常，`acquireShortRunningSlot` 已经被获取但不会释放。

修复：将 `findGodot` 调用也纳入 try/catch 或将其移到 Promise 内。

- [ ] **Step 1: 实现**

将 `findGodot()` 调用用 try/catch 包裹，确保异常时释放 slot：

```typescript
case 'create_scene':
case 'add_node':
case 'save_scene':
case 'load_sprite': {
  if (!acquireShortRunningSlot()) return opsErrorResult('CONCURRENCY_LIMIT', 'too many concurrent headless operations (max 3). Please wait and retry.');
  const p = requireProjectPath(args);
  let godot: string;
  try {
    godot = await ctx.findGodot();
  } catch (e) {
    releaseShortRunningSlot();
    throw e;  // 已有此代码，确认无误
  }
  // ... rest unchanged (spawn already inside Promise)
```

实际上查看代码，**此修复已存在**（lines 116-123）。需要验证的是 `quick_scene` 和其他 action 是否有同样问题。

检查 `quick_scene`（line 212+）：`findGodot` 在 line 275，也在 Promise 构造器前。但 `quick_scene` 没有使用 `acquireShortRunningSlot()`，所以不存在 slot 泄漏问题。

**结论：** A-14 已在当前代码中修复（lines 119-123 的 try/catch）。标记为已验证。

- [ ] **Step 2: 运行全量测试确认**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: all tests pass

- [ ] **Step 3: 提交（仅文档确认）**

无需代码变更。在测试中添加回归测试确保行为正确：

```javascript
test('A-14: spawn failure releases short-running slot', async () => {
  // Mock findGodot to throw
  // Call create_scene
  // Verify slot was released
});
```

```bash
git add test/scene.test.js
git commit -m "test(A-14): regression test for spawn failure slot release"
```

---

## Task 9: A-18 — batch-tools runSingleVerify 添加 settled 保护

**Files:**
- Modify: `src/tools/batch-tools.ts:281-329`

**分析：** `setTimeout` 回调和 `proc.on('close')` 可能同时触发 `resolve`，缺少 settled 标志。Promise 只会 resolve 一次（第二次调用被忽略），但 `forceKillTree` 可能被重复调用，且逻辑不清晰。

- [ ] **Step 1: 编写测试**

在 `test/batch-tools.test.js` 中添加：

```javascript
test('A-18: runSingleVerify settled guard prevents double resolve', async () => {
  // Mock spawn that emits close immediately after timeout fires
  // Verify: only one resolve call, no crash
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/batch-tools.test.js --reporter=verbose -t "A-18" 2>&1 | tail -20`

- [ ] **Step 3: 实现**

添加 `settled` 标志保护所有 resolve 路径：

```typescript
function runSingleVerify(
  godot: string,
  projectPath: string,
  scene: string,
  timeoutSec: number,
  captureTree: boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const sceneArg = `res://${scene.replace(/\\/g, '/')}`;
    const proc = spawn(godot, ['--headless', '--path', projectPath, sceneArg], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });

    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (!proc.killed) forceKillTree(proc);
      resolve({ scene, status: 'timed_out' });
    }, timeoutSec * 1000);

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const analysis = analyzeOutput(out.split('\n'));
      const result: Record<string, unknown> = {
        scene,
        status: code === 0 && !analysis.hasErrors ? 'passed' : 'failed',
        error_count: analysis.errors.length,
        errors: analysis.errors.map(e => e.message).slice(0, 10),
      };
      if (captureTree) {
        const treeMatch = out.match(/=== Scene Tree ===([\s\S]*?)===/);
        if (treeMatch) result.tree = { raw: treeMatch[1].trim() };
      }
      resolve(result);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ scene, status: 'error', errors: [err.message] });
    });
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/batch-tools.test.js --reporter=verbose -t "A-18"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/batch-tools.ts test/batch-tools.test.js
git commit -m "fix(A-18): runSingleVerify settled guard prevents double resolve"
```

---

## Task 10: I-03 — Bridge TCP 多用户限制文档标注

**Files:**
- Modify: `README.md` 安全说明部分
- Modify: `.claude/rules/godot-mcp-bridge.md`

**分析：** Bridge 使用 TCP + 共享密钥绑定 127.0.0.1。单用户安全，但多用户共享系统上 localhost 不提供隔离。

- [ ] **Step 1: 实现**

在 `.claude/rules/godot-mcp-bridge.md` 的"常见陷阱"部分添加：

```markdown
- **多用户环境不安全**：Bridge 使用 TCP 绑定 127.0.0.1 + 共享密钥认证。在单用户本地开发环境下足够安全，但在多用户共享系统（如远程开发服务器）上，localhost 通信可被同一机器上的其他用户嗅探。如需多用户隔离，考虑使用 Unix Domain Socket（仅文件权限控制访问）。
```

在 `README.md` 的安全部分添加类似说明（如已有可略过）。

- [ ] **Step 2: 提交**

```bash
git add .claude/rules/godot-mcp-bridge.md README.md
git commit -m "docs(I-03): document Bridge TCP localhost multi-user isolation limitation"
```

---

## Task 11: 全量验证 + 提交推送

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: all 1731+ tests pass

- [ ] **Step 2: 运行 ESLint**

Run: `npx eslint src/ 2>&1 | tail -10`
Expected: 0 errors, 0 warnings

- [ ] **Step 3: TypeScript 编译检查**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: no errors

- [ ] **Step 4: 推送**

```bash
git push origin master
```

---

## 修复覆盖总结

| 编号 | 问题 | 任务 | 类型 |
|------|------|------|------|
| I-01 | Editor 重连耗尽不降级 | Task 1 | 代码 |
| I-02 | confirm_and_execute 缺 TOOL_META | Task 2 | 代码 |
| I-03 | Bridge TCP 多用户文档 | Task 10 | 文档 |
| I-04 | project_replace 原子写入 | Task 3 | 代码 |
| I-05 | 令牌无调用者绑定 | Task 4 | 文档注释 |
| I-06 | setRunningProcess(null) 警告 | Task 5 | 代码 |
| A-12 | scene_path requireString | Task 6 | 代码 |
| A-13 | edit/remove 并发限制 | Task 7 | 代码 |
| A-14 | spawn Promise 外（已修复） | Task 8 | 回归测试 |
| A-18 | batch-tools settled 保护 | Task 9 | 代码 |
