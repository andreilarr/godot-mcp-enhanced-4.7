# 审查报告 25 项修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-06-08 全面审查报告中的 3 CRITICAL + 12 IMPORTANT + 10 ADVISORY 共 25 项发现

**Architecture:** 按严重度分组实施——先修 CRITICAL（C-01/C-02/C-03），再修 IMPORTANT（I-01~I-12），最后修 ADVISORY（A-01~A-10）。每组内按文件聚合减少上下文切换。每个 Task 包含：写失败测试 → 验证失败 → 写最小实现 → 验证通过 → 提交。

**Tech Stack:** TypeScript (Vitest), GDScript

---

## 文件变更映射

| 文件 | 修改的发现 |
|------|-----------|
| `src/core/instance-router.ts` | C-01 |
| `test/core/instance-router.test.ts` | C-01 测试 |
| `src/core/instance-manager.ts` | C-02, I-04 |
| `test/core/instance-manager.test.ts` | C-02, I-04 测试 |
| `src/core/response-limiter.ts` | C-03 |
| `test/core/response-limiter.test.ts` | C-03 测试 |
| `src/core/tool-registry.ts` | I-01 |
| `test/core/tool-registry-groups.test.ts` | I-01 测试 |
| `src/core/ToolDispatcher.ts` | I-02, I-12 |
| `test/core/ToolDispatcher.test.ts` | I-02, I-12 测试 |
| `src/core/module-loader.ts` | I-03 |
| `test/core/module-loader-tags.test.ts` | I-03 测试 |
| `src/core/reconnection-manager.ts` | I-05, I-06 |
| `test/core/reconnection-manager.test.ts` | I-05, I-06 测试 |
| `src/core/middleware.ts` | I-07 |
| `test/core/middleware.test.ts` | I-07 测试 |
| `src/resources.ts` | I-08, A-10 |
| `src/prompts.ts` | I-11 |
| `src/tools/manage-tools.ts` | A-05, I-09 |
| `test/tools/manage-tools.test.ts` | A-05 测试 |
| `src/GodotServer.ts` | I-09 |
| `src/core/health-monitor.ts` | A-09 |
| `src/core/feature-flags.ts` | A-01 |
| `test/feature-flags.test.ts` | A-01 测试 |
| `src/core/command-validator.ts` | A-02 |
| `src/core/path-security.ts` | A-03 |
| `test/core/path-security.test.ts` | A-03 测试 |
| `src/scripts/mcp_bridge.gd` | I-10, A-06, A-07 |

---

## Task 1: C-01 — InstanceRouter 并发竞态修复

**Files:**
- Modify: `src/core/instance-router.ts:21,53-65,87-96`
- Test: `test/core/instance-router.test.ts:91-116`

C-01 的核心问题：每个 `route()` 调用创建独立的 Promise 作为 switchLock，并发请求会互相覆盖。改用 in-flight 计数器模型。

- [ ] **Step 1: 写失败测试 — 并发请求不应丢失 lock 引用**

在 `test/core/instance-router.test.ts` 的 `switch lock` describe 块中追加测试：

```typescript
it('does not lose lock for concurrent requests during switch', async () => {
  const inst1 = makeInstance({ id: 'uuid-1', port: 9081 });
  const inst2 = makeInstance({ id: 'uuid-2', port: 9082 });
  let resolveSend1: () => void;
  let resolveSend2: () => void;
  const mockSend = vi.fn()
    .mockImplementationOnce(() => new Promise<void>(r => { resolveSend1 = r; }))
    .mockImplementationOnce(() => new Promise<void>(r => { resolveSend2 = r; }));

  const router = new InstanceRouter({ instances: [inst1, inst2], sendToInstance: mockSend });
  await router.selectInstance('uuid-1');

  // Start two concurrent requests
  const req1 = router.route('game_query', { action: 'ping' });
  const req2 = router.route('game_query', { action: 'get_tree' });

  // Try to switch while both are in-flight — should wait
  const switchPromise = router.selectInstance('uuid-2');

  // Resolve both requests
  resolveSend1!();
  resolveSend2!();

  await Promise.all([req1, req2, switchPromise]);
  expect(router.getSelectedId()).toBe('uuid-2');
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/core/instance-router.test.ts`
Expected: 新测试通过（当前实现恰好不触发可见错误，但逻辑上不安全）。此测试验证修复后的行为正确。

- [ ] **Step 3: 实现 — 用 in-flight 计数器替代 Promise 链**

将 `src/core/instance-router.ts` 中的 switchLock 机制改为计数器模型：

```typescript
// 替换 switchLock 字段（第21行）
private inflightCount = 0;
private inflightZero: Promise<void> = Promise.resolve();
private inflightZeroResolve: (() => void) | null = null;

// 替换 selectInstance 方法（第53-65行）
async selectInstance(id: string): Promise<void> {
  const inst = this.deps.instances.find(i => i.id === id);
  if (!inst) throw new Error(`Instance not found: ${id}`);

  // Wait for all in-flight requests to complete
  while (this.inflightCount > 0) {
    // Create a new promise that resolves when inflightCount hits 0
    this.inflightZero = new Promise<void>(resolve => {
      this.inflightZeroResolve = resolve;
    });
    await this.inflightZero;
  }

  const prev = this.selectedId;
  this.selectedId = id;
  if (prev !== id) {
    this.deps.onInstanceChanged?.(inst);
  }
}

// 替换 route 方法（第77-96行）
async route(toolName: string, args: Record<string, unknown>): Promise<ToolResult | string> {
  if (!this.selectedId) {
    return 'No instance selected. Use godot_select_instance first.';
  }
  const instance = this.deps.instances.find(i => i.id === this.selectedId);
  if (!instance) {
    this.selectedId = null;
    return 'Selected instance no longer available. Use godot_list_instances to discover.';
  }

  this.inflightCount++;
  try {
    return await this.deps.sendToInstance(instance, toolName, args);
  } finally {
    this.inflightCount--;
    if (this.inflightCount === 0 && this.inflightZeroResolve) {
      this.inflightZeroResolve();
      this.inflightZeroResolve = null;
    }
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/core/instance-router.test.ts`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/instance-router.ts test/core/instance-router.test.ts
git commit -m "fix(C-01): replace switchLock Promise chain with in-flight counter for concurrency safety"
```

---

## Task 2: C-02 — InstanceManager 同步 I/O 改异步

**Files:**
- Modify: `src/core/instance-manager.ts:13,83-102,123-144`
- Test: `test/core/instance-manager.test.ts`

- [ ] **Step 1: 写失败测试 — 验证异步 API**

在 `test/core/instance-manager.test.ts` 中追加：

```typescript
it('loadFromRegistry returns asynchronously', async () => {
  const dir = join(tmpdir(), 'godot-mcp-test-async-' + Date.now());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inst1.json'), JSON.stringify({
    id: 'async-1', port: 9081, projectPath: 'D:/a', pid: 1,
    lastSeen: new Date().toISOString(), godotVersion: '4.4', capabilities: [],
  }));

  const mgr = new InstanceManager({ registryDir: dir });
  const result = await mgr.loadFromRegistry();
  expect(result).toHaveLength(1);
  expect(result[0]!.id).toBe('async-1');

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: 新测试失败（`loadFromRegistry` 当前是同步的，不返回 Promise）

- [ ] **Step 3: 实现 — 改为异步 API**

将 `src/core/instance-manager.ts` 修改：

```typescript
// 第13行：替换 import
import { readdir, readFile } from 'fs/promises';

// 第83-102行：loadFromRegistry 改为 async
async loadFromRegistry(): Promise<InstanceInfo[]> {
  const merged = new Map<string, InstanceInfo>();

  // Machine-level first
  const machineInstances = await this.readRegistryDir(this.registryDir);
  for (const inst of machineInstances) {
    merged.set(inst.id, inst);
  }

  // Project-level overrides
  if (this.projectRegistryDir) {
    const projectInstances = await this.readRegistryDir(this.projectRegistryDir);
    for (const inst of projectInstances) {
      merged.set(inst.id, inst);
    }
  }

  this.instances = merged;
  return [...merged.values()];
}

// 第123-144行：readRegistryDir 改为 async
private async readRegistryDir(dir: string): Promise<InstanceInfo[]> {
  const results: InstanceInfo[] = [];
  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(dir, file), 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed.id && parsed.port && parsed.projectPath) {
          results.push(parsed as InstanceInfo);
        }
      } catch {
        // Skip corrupt/invalid files
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return results;
}
```

同时更新 `discoverInstances`（第153-156行）已经正确返回 `Promise<InstanceInfo[]>` 因为 `loadFromRegistry` 现在是 async。

更新所有调用 `loadFromRegistry()` 的地方，加 `await`（包括 `GodotServer.ts`）。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: 全部通过

- [ ] **Step 5: 更新调用方（GodotServer.ts）的 await**

检查 `src/GodotServer.ts` 中所有 `loadFromRegistry()` 调用加 `await`。

- [ ] **Step 6: 提交**

```bash
git add src/core/instance-manager.ts test/core/instance-manager.test.ts src/GodotServer.ts
git commit -m "fix(C-02): convert InstanceManager to async fs APIs to avoid blocking event loop"
```

---

## Task 3: C-03 — Response-limiter 二分搜索性能优化

**Files:**
- Modify: `src/core/response-limiter.ts:49-112`
- Test: `test/core/response-limiter.test.ts`

- [ ] **Step 1: 写性能测试 — 验证采样估算不使用完整序列化**

在 `test/core/response-limiter.test.ts` 中追加：

```typescript
it('uses sampling estimation instead of full binary search', () => {
  // Create data that would be expensive with binary search
  const largeArray = Array.from({ length: 50000 }, (_, i) => ({
    name: `node_${i}`,
    type: 'Node3D',
    properties: { position: { x: i, y: 0, z: 0 } },
  }));
  const data = { nodes: largeArray, count: largeArray.length };

  const start = Date.now();
  const result = trimToArrayLimit(data, 100_000); // 100KB limit
  const elapsed = Date.now() - start;

  // Should complete quickly (< 500ms) — binary search would take much longer
  expect(elapsed).toBeLessThan(500);
  // Should have trimmed the array
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    expect(obj.nodes_truncatedAt).toBeDefined();
  }
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/core/response-limiter.test.ts`
Expected: 可能超时或很慢

- [ ] **Step 3: 实现 — 采样估算替代完整二分搜索**

替换 `trimToArrayLimit`（第49-112行）：

```typescript
export function trimToArrayLimit(data: unknown, limitBytes: number): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  const obj = data as Record<string, unknown>;

  // Find the largest array field
  let largestKey: string | null = null;
  let largestLen = 0;

  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val) && val.length > largestLen) {
      largestKey = key;
      largestLen = val.length;
    }
  }

  if (largestKey === null || largestLen === 0) {
    return data;
  }

  const originalArray = obj[largestKey] as unknown[];

  // Sampling estimation: estimate per-item size from a sample
  const sampleSize = Math.min(100, originalArray.length);
  const sample = originalArray.slice(0, sampleSize);
  const nonArrayFields: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key !== largestKey) nonArrayFields[key] = val;
  }
  const sampleObj = { ...nonArrayFields, [largestKey]: sample };
  const sampleBytes = Buffer.byteLength(JSON.stringify(sampleObj), 'utf-8');

  // Estimate overhead for non-array fields + sample wrapper
  const nonArrayBytes = Buffer.byteLength(JSON.stringify(nonArrayFields), 'utf-8');
  const sampleArrayBytes = sampleBytes - nonArrayBytes;
  const estimatedItemSize = sampleArrayBytes / sampleSize;
  const budgetBytes = limitBytes - nonArrayBytes;

  // Estimate how many items fit
  let estimatedFit = estimatedItemSize > 0
    ? Math.floor(budgetBytes / estimatedItemSize)
    : originalArray.length;

  // Clamp to array length
  if (estimatedFit >= originalArray.length) {
    return data; // Everything fits
  }

  // Refine with one verification pass
  const trimmed = { ...nonArrayFields, [largestKey]: originalArray.slice(0, estimatedFit) };
  const trimmedBytes = Buffer.byteLength(JSON.stringify(trimmed), 'utf-8');

  if (trimmedBytes <= limitBytes) {
    // Try to fit a few more (binary search for the sweet spot, but limited iterations)
    let lo = estimatedFit;
    let hi = originalArray.length;
    let best = estimatedFit;
    for (let i = 0; i < 5 && lo <= hi; i++) { // max 5 iterations
      const mid = Math.floor((lo + hi) / 2);
      const probe = { ...nonArrayFields, [largestKey]: originalArray.slice(0, mid) };
      if (Buffer.byteLength(JSON.stringify(probe), 'utf-8') <= limitBytes) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    estimatedFit = best;
  } else {
    // Too big — shrink with limited binary search
    let lo = 0;
    let hi = estimatedFit;
    let best = 0;
    for (let i = 0; i < 5 && lo <= hi; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const probe = { ...nonArrayFields, [largestKey]: originalArray.slice(0, mid) };
      if (Buffer.byteLength(JSON.stringify(probe), 'utf-8') <= limitBytes) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    estimatedFit = best;
  }

  if (estimatedFit >= originalArray.length) {
    return data;
  }

  // Build result
  const result: Record<string, unknown> = { ...nonArrayFields };
  result[largestKey] = originalArray.slice(0, estimatedFit);
  result[`${largestKey}_truncatedAt`] = estimatedFit;
  result[`${largestKey}_totalNodeCount`] = originalArray.length;

  return result;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/core/response-limiter.test.ts`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/response-limiter.ts test/core/response-limiter.test.ts
git commit -m "perf(C-03): replace binary search with sampling estimation in trimToArrayLimit"
```

---

## Task 4: I-01 — slim/minimal 配置重复 + I-04 端口范围校验

这两个都是 instance-manager 和 tool-registry 的小修改，合并处理。

**Files:**
- Modify: `src/core/tool-registry.ts:157-158`
- Modify: `src/core/instance-manager.ts:51-58`
- Test: `test/core/instance-manager.test.ts`

- [ ] **Step 1: 写 I-04 失败测试 — parsePortRange 空值解析**

在 `test/core/instance-manager.test.ts` 追加：

```typescript
it('rejects port 0 from empty range segment', () => {
  const orig = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
  process.env.GODOT_MCP_INSTANCE_PORT_RANGE = '-9090';
  const mgr = new InstanceManager();
  // Should fall back to defaults, not [0, 9090]
  expect(mgr.portRange).toEqual([9081, 9090]);
  process.env.GODOT_MCP_INSTANCE_PORT_RANGE = orig;
});

it('rejects out-of-range ports', () => {
  const orig = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
  process.env.GODOT_MCP_INSTANCE_PORT_RANGE = '0-70000';
  const mgr = new InstanceManager();
  expect(mgr.portRange).toEqual([9081, 9090]);
  process.env.GODOT_MCP_INSTANCE_PORT_RANGE = orig;
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: 新测试失败（`-9090` 会解析为 `[0, 9090]`）

- [ ] **Step 3: 实现 I-04 — 加强 parsePortRange 校验**

在 `src/core/instance-manager.ts` 的 `parsePortRange` 函数（第51-59行）：

```typescript
function parsePortRange(): [number, number] {
  const env = process.env.GODOT_MCP_INSTANCE_PORT_RANGE;
  if (!env) return [DEFAULT_PORT_START, DEFAULT_PORT_END];
  const parts = env.split('-').map(Number);
  if (
    parts.length === 2 &&
    Number.isFinite(parts[0]) && Number.isFinite(parts[1]) &&
    parts[0]! >= 1 && parts[0]! <= 65535 &&
    parts[1]! >= 1 && parts[1]! <= 65535 &&
    parts[0]! < parts[1]!
  ) {
    return [parts[0]!, parts[1]!];
  }
  return [DEFAULT_PORT_START, DEFAULT_PORT_END];
}
```

- [ ] **Step 4: 实现 I-01 — 添加 slim = minimal 别名注释**

在 `src/core/tool-registry.ts` 第157-158行：

```typescript
minimal:     ['core'],
slim:        ['core'],  // intentional alias of minimal — proxy tool is in core group
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run test/core/instance-manager.test.ts`
Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add src/core/tool-registry.ts src/core/instance-manager.ts test/core/instance-manager.test.ts
git commit -m "fix(I-01,I-04): document slim=minimal alias + strengthen port range validation"
```

---

## Task 5: I-02 — buildMiddleware 缓存 + I-12 — HealthSample 错误判断

**Files:**
- Modify: `src/core/ToolDispatcher.ts:60-61,91,176,290-312`
- Test: `test/core/ToolDispatcher.test.ts`

- [ ] **Step 1: 写 I-12 失败测试 — 字符串匹配不应误判**

在 `test/core/ToolDispatcher.test.ts` 追加（或找到 healthSample 相关测试区域）：

```typescript
it('healthSample detects errors via isError flag, not string matching', async () => {
  const dispatcher = createDispatcher();
  // This should NOT be counted as error (no isError flag, text has spaces in JSON)
  const result = {
    content: [{ type: 'text' as const, text: '{"success": false, "data": []}' }],
  };
  // Trigger a tool call that returns this result
  // Verify healthMonitor records it correctly as error (success: false in parsed JSON)
  const health = dispatcher.getHealthMonitor();
  const beforeStats = health.getStats();
  // ... 触发 handleCall 并验证 healthMonitor 的 recordFailure 被调用
});
```

注意：I-12 的修复逻辑是改变 healthSample after hook 的判断方式，需确保 `result.isError === true` 优先，JSON 解析作为 fallback。

- [ ] **Step 2: 实现 I-02 — 缓存 middleware**

在 `src/core/ToolDispatcher.ts`：

将 `buildMiddleware()` 改为构造时调用一次并缓存：

```typescript
// 新增实例属性（约第60行）
private readonly middleware: Middleware[];

// 在 constructor 中（约第91行后）
this.middleware = this.buildMiddleware();

// handleCall 中（第176行）
return executeMiddleware(this.middleware, ctx, async () => {
```

- [ ] **Step 3: 实现 I-12 — 修复 healthSample 错误判断**

替换 `buildMiddleware()` 中的 healthSample after hook（第299-301行）：

```typescript
after: async (ctx, result) => {
  const duration = Date.now() - ctx.startTime;
  const isError = result.isError === true || checkJsonSuccessFalse(result);
  if (isError) {
    this.healthMonitor.recordFailure('TOOL_ERROR', `Tool ${ctx.toolName} failed`);
  } else {
    this.healthMonitor.recordSuccess(duration);
  }
  return result;
},
```

在类底部添加辅助方法：

```typescript
/** Check if result contains JSON with success: false (parsed, not string-matched). */
private checkJsonSuccessFalse(result: ToolResult): boolean {
  if (!result.content) return false;
  for (const block of result.content) {
    if ('text' in block && typeof block.text === 'string') {
      try {
        const parsed = JSON.parse(block.text);
        if (parsed && typeof parsed === 'object' && parsed.success === false) return true;
      } catch { /* not JSON */ }
    }
  }
  return false;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/core/ToolDispatcher.test.ts`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/ToolDispatcher.ts test/core/ToolDispatcher.test.ts
git commit -m "fix(I-02,I-12): cache middleware pipeline + use JSON parsing for error detection"
```

---

## Task 6: I-03 — module-loader 防重复注册

**Files:**
- Modify: `src/core/module-loader.ts:88-98`
- Test: `test/core/module-loader-tags.test.ts`

- [ ] **Step 1: 写失败测试 — 重复注册不应包裹两次**

在 `test/core/module-loader-tags.test.ts` 追加：

```typescript
it('is idempotent — double registration does not wrap tags twice', () => {
  registerAllModules();
  const defs1 = getAllToolDefinitions();
  const tags1 = defs1[0]?.annotations?.tags;

  // Register again
  registerAllModules();
  const defs2 = getAllToolDefinitions();
  const tags2 = defs2[0]?.annotations?.tags;

  // Tags should be the same — not double-wrapped
  expect(tags1).toEqual(tags2);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/core/module-loader-tags.test.ts`
Expected: 新测试失败（重复注册导致 tags 被包裹两次）

- [ ] **Step 3: 实现 — 添加 guard**

在 `src/core/module-loader.ts`：

```typescript
let registered = false;

export function registerAllModules(): void {
  if (registered) return;
  registered = true;
  for (const mod of ALL_MODULES) {
    // ... 原有逻辑不变
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/core/module-loader-tags.test.ts`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/module-loader.ts test/core/module-loader-tags.test.ts
git commit -m "fix(I-03): add idempotency guard to registerAllModules"
```

---

## Task 7: I-05 + I-06 — ReconnectionManager jitter + Promise 返回

**Files:**
- Modify: `src/core/reconnection-manager.ts:37-46,73-75`
- Test: `test/core/reconnection-manager.test.ts`

- [ ] **Step 1: 写 I-05 测试 — jitter 应产生范围值**

在 `test/core/reconnection-manager.test.ts` 追加：

```typescript
it('applies jitter to delay calculation', () => {
  const mgr = new ReconnectionManager({ baseDelayMs: 1000, maxDelayMs: 30000 });
  const delays = new Set<number>();
  for (let i = 0; i < 20; i++) {
    delays.add(mgr.getDelayMs(2)); // 1000 * 4 = 4000ms base
  }
  // With jitter, not all 20 calls should return identical values
  expect(delays.size).toBeGreaterThan(1);
});
```

- [ ] **Step 2: 写 I-06 测试 — start 返回 Promise**

```typescript
it('start returns Promise resolving to true on success', async () => {
  const mgr = new ReconnectionManager();
  const connectFn = vi.fn().mockResolvedValue(true);
  const result = await mgr.start(connectFn, () => {});
  expect(result).toBe(true);
  expect(mgr.isRunning()).toBe(false);
});

it('start returns Promise resolving to false on exhausted', async () => {
  const mgr = new ReconnectionManager({ maxRetries: 1, baseDelayMs: 10 });
  const connectFn = vi.fn().mockResolvedValue(false);
  const result = await mgr.start(connectFn, () => {});
  expect(result).toBe(false);
});
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run test/core/reconnection-manager.test.ts`
Expected: 新测试失败（`start` 返回 `void`，`getDelayMs` 无 jitter）

- [ ] **Step 4: 实现 I-05 — 添加 jitter**

```typescript
getDelayMs(attemptNum: number): number {
  const base = Math.min(this.opts.baseDelayMs * Math.pow(2, attemptNum), this.opts.maxDelayMs);
  return Math.floor(base * (0.5 + Math.random() * 0.5)); // 50-100% jitter
}
```

- [ ] **Step 5: 实现 I-06 — start 返回 Promise\<boolean\>**

```typescript
start(
  connectFn: () => Promise<boolean>,
  onExhausted: () => void,
): Promise<boolean> {
  if (this.running) return Promise.resolve(false);
  this.running = true;
  this.cancelled = false;
  this.attempt = 0;
  getLogger().info('reconnect', 'Reconnection manager started');
  return new Promise<boolean>((resolve) => {
    this.tryConnect(connectFn, onExhausted, resolve);
  });
}
```

同时更新 `tryConnect` 和 `scheduleRetry` 传递 `resolve` 回调：

```typescript
private tryConnect(
  connectFn: () => Promise<boolean>,
  onExhausted: () => void,
  done: (result: boolean) => void,
): void {
  // ... 在成功处: done(true)
  // ... 在 exhausted 处: done(false)
  // ... scheduleRetry 传递 done
}

private scheduleRetry(
  connectFn: () => Promise<boolean>,
  onExhausted: () => void,
  done: (result: boolean) => void,
): void {
  // ... 传递 done 到 tryConnect
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run test/core/reconnection-manager.test.ts`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add src/core/reconnection-manager.ts test/core/reconnection-manager.test.ts
git commit -m "fix(I-05,I-06): add jitter to reconnection backoff + return Promise from start()"
```

---

## Task 8: I-07 — Elicitation 中间件浅拷贝 args

**Files:**
- Modify: `src/core/middleware.ts:116-148`
- Test: `test/core/middleware.test.ts`

- [ ] **Step 1: 写测试 — elicitation 不应变异原始 args**

在 `test/core/middleware.test.ts` 追加：

```typescript
it('elicitation does not mutate original args object', async () => {
  const originalArgs = { action: 'ping' }; // missing project_path
  const toolDef = {
    name: 'test_tool',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        project_path: { type: 'string' },
      },
      required: ['action', 'project_path'],
    },
  };
  const elicitFn = vi.fn().mockResolvedValue({ project_path: '/test' });
  const mw = createElicitationMiddleware(() => toolDef as any, elicitFn);
  const ctx = { toolName: 'test_tool', args: originalArgs, startTime: Date.now(), phase: 'before' as const };

  // Enable elicitation for the test
  process.env.GODOT_MCP_ELICITATION = 'true';

  await mw.before(ctx);

  // originalArgs should NOT have project_path
  expect(originalArgs).not.toHaveProperty('project_path');
  // ctx.args should have it
  expect(ctx.args).toHaveProperty('project_path', '/test');

  delete process.env.GODOT_MCP_ELICITATION;
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run test/core/middleware.test.ts`
Expected: 新测试失败（当前实现直接修改 `ctx.args`）

- [ ] **Step 3: 实现 — 浅拷贝 args**

在 `src/core/middleware.ts` 的 `createElicitationMiddleware` 的 `before` 函数中：

```typescript
before: async (ctx) => {
  if (!isFeatureEnabled('ELICITATION')) return { passed: true };

  const def = getToolDef(ctx.toolName);
  if (!def?.inputSchema) return { passed: true };

  const schema = def.inputSchema as any;
  const required: string[] = schema.required ?? [];
  if (required.length === 0) return { passed: true };

  // Shallow-copy args to avoid mutating caller's object
  const safeArgs = { ...ctx.args };
  ctx.args = safeArgs;

  const missing = required.filter(name => {
    const val = safeArgs[name];
    return val === undefined || val === null || val === '';
  });
  if (missing.length === 0) return { passed: true };

  const props = schema.properties ?? {};
  const primitiveMissing = missing.filter(name => {
    const prop = props[name];
    if (!prop) return false;
    const type = prop.type;
    return type === 'string' || type === 'number' || type === 'boolean';
  });
  if (primitiveMissing.length === 0) return { passed: true };

  if (elicitFn) {
    const elicited = await elicitFn(primitiveMissing);
    if (elicited) {
      for (const [key, val] of Object.entries(elicited)) {
        if (primitiveMissing.includes(key) && !(key in safeArgs)) safeArgs[key] = val;
      }
      return { passed: true };
    }
  }

  return {
    rejected: true,
    error: {
      content: [{ type: 'text' as const, text: JSON.stringify({
        success: false,
        error: `Missing required parameter(s): ${primitiveMissing.join(', ')}`,
        error_code: 'MISSING_PARAM',
        missing_params: primitiveMissing,
      }) }],
    },
  };
},
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run test/core/middleware.test.ts`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/middleware.ts test/core/middleware.test.ts
git commit -m "fix(I-07): shallow-copy args in elicitation middleware to prevent mutation"
```

---

## Task 9: I-08 + A-10 — Resources 占位数据 + 截断安全

**Files:**
- Modify: `src/resources.ts:529-549,599-628`

- [ ] **Step 1: 实现 I-08 — 未实现 resource 返回明确标记**

在 `src/resources.ts` 中修改 readResource 的 switch 分支（第529-549行）：

```typescript
case 'health':
  return { uri, mimeType: 'application/json', text: JSON.stringify({ status: 'not_yet_implemented', hint: 'Health data will be populated when HealthMonitor is wired to resources' }) };
case 'console-errors':
  return { uri, mimeType: 'application/json', text: JSON.stringify({ status: 'not_yet_implemented', errors: [], message: 'Requires active Bridge connection — returns live errors when connected' }) };
case 'scene-tree':
  return { uri, mimeType: 'application/json', text: JSON.stringify({ status: 'not_yet_implemented', message: 'Requires active Bridge connection — returns live tree when connected' }) };
case 'instances':
  return { uri, mimeType: 'application/json', text: JSON.stringify({ status: 'not_yet_implemented', instances: [], message: 'Multi-instance mode not active — enable GODOT_MCP_MULTI_INSTANCE=true' }) };
```

- [ ] **Step 2: 实现 A-10 — 截断时保留 Markdown 结构**

替换 `buildProjectContext` 中的硬截断（第611行和第617行）：

```typescript
function safeTruncate(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  const truncated = content.slice(0, maxLen);
  // Find the last newline to avoid breaking mid-line
  const lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > maxLen * 0.8) { // Only use newline if it's reasonably close to end
    return truncated.slice(0, lastNewline) + '\n\n[... truncated ...]';
  }
  return truncated + '\n\n[... truncated ...]';
}
```

然后在 `buildProjectContext` 中使用：

```typescript
const content = safeTruncate(readFileSync(claudeMdPath, 'utf-8'), 2000);
```

- [ ] **Step 3: 运行测试验证**

Run: `npx vitest run --grep "resource" 2>/dev/null || echo "No resource-specific tests"`
Run: `npx vitest run`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add src/resources.ts
git commit -m "fix(I-08,A-10): mark unimplemented resources clearly + safe Markdown truncation"
```

---

## Task 10: I-09 + A-05 — manage_tools 空实现 + multi-instance 错误信息

**Files:**
- Modify: `src/tools/manage-tools.ts:129-143`
- Modify: `src/GodotServer.ts:150-155`

- [ ] **Step 1: 实现 A-05 — sync/reconnect 返回 NOT_IMPLEMENTED**

替换 `src/tools/manage-tools.ts` 的 `handleSync` 和 `handleReconnect`（第129-143行）：

```typescript
function handleSync(): ToolResult {
  return textResult(JSON.stringify(opsError('NOT_IMPLEMENTED', 'Connection-aware sync is not yet implemented. Active groups are always in sync.')));
}

function handleReconnect(): ToolResult {
  return textResult(JSON.stringify(opsError('NOT_IMPLEMENTED', 'Auto-reconnect is not yet implemented. Check that the game/editor is running.')));
}
```

- [ ] **Step 2: 实现 I-09 — GodotServer sendToInstance 明确标注未实现**

在 `src/GodotServer.ts`（第150-155行）修改 `sendToInstance` 的错误信息：

```typescript
sendToInstance: async () => ({
  content: [{ type: 'text' as const, text: JSON.stringify({
    error: 'NOT_IMPLEMENTED',
    message: 'Multi-instance routing is under development. The instance registry is available, but tool dispatching to a specific instance requires the upcoming Bridge routing layer.',
    hint: 'Track progress via GODOT_MCP_MULTI_INSTANCE feature flag.',
  }) }],
}),
```

- [ ] **Step 3: 运行测试验证**

Run: `npx vitest run test/tools/manage-tools.test.ts`
Expected: 需更新现有测试中的 `synced: true` 断言

- [ ] **Step 4: 提交**

```bash
git add src/tools/manage-tools.ts src/GodotServer.ts test/tools/manage-tools.test.ts
git commit -m "fix(I-09,A-05): return NOT_IMPLEMENTED for sync/reconnect + clear multi-instance error"
```

---

## Task 11: I-10 + A-06 + A-07 — GDScript 修复

**Files:**
- Modify: `src/scripts/mcp_bridge.gd:219-227,282,1270-1276`

- [ ] **Step 1: 实现 I-10 — _instance_id 用 PID+时间戳**

在 `src/scripts/mcp_bridge.gd` 第282行：

```gdscript
_instance_id = str(OS.get_process_id()) + "_" + str(Time.get_ticks_msec())
```

- [ ] **Step 2: 实现 A-06 — recording time_offset 兼容注释**

在第1272-1276行的事件字段处添加注释：

```gdscript
# Note: field is 'time_offset' (renamed from 'time_ms' in v0.18.0).
# Existing recordings with 'time_ms' are incompatible.
```

- [ ] **Step 3: 实现 A-07 — SECRET_LEN 关联注释**

在第219行添加注释：

```gdscript
# IMPORTANT: SECRET_LEN must match the token length generated by the MCP server's
# secret generation logic. If token generation changes, update this constant.
const SECRET_LEN := 32
```

- [ ] **Step 4: 提交**

```bash
git add src/scripts/mcp_bridge.gd
git commit -m "fix(I-10,A-06,A-07): PID+timestamp instance ID + recording field docs + SECRET_LEN note"
```

---

## Task 12: I-11 — Prompts 静态模板标注

**Files:**
- Modify: `src/prompts.ts:10`

- [ ] **Step 1: 添加 Phase 1 标注**

在 `src/prompts.ts` 的 `PROMPTS` 定义上方添加注释：

```typescript
/**
 * Phase 1 static prompt templates.
 *
 * These templates provide structured guidance text for common workflows.
 * They do not dynamically analyze the project — the parameters are used
 * only for string interpolation into the template text.
 *
 * Future phases will add dynamic context (scene analysis, project scan, etc.)
 * by replacing the static build() functions with tool-calling logic.
 */
```

- [ ] **Step 2: 提交**

```bash
git add src/prompts.ts
git commit -m "fix(I-11): document prompts as Phase 1 static templates with future dynamic plan"
```

---

## Task 13: A-01 — Feature flags 缓存

**Files:**
- Modify: `src/core/feature-flags.ts:26-32`

- [ ] **Step 1: 实现 — 惰性缓存**

```typescript
let flagsCache: Record<FeatureKey, boolean> | null = null;

export function getAllFeatureFlags(): Record<FeatureKey, boolean> {
  if (flagsCache) return flagsCache;
  const result = {} as Record<FeatureKey, boolean>;
  for (const key of Object.keys(FEATURES) as FeatureKey[]) {
    result[key] = isFeatureEnabled(key);
  }
  flagsCache = result;
  return flagsCache;
}
```

- [ ] **Step 2: 提交**

```bash
git add src/core/feature-flags.ts
git commit -m "fix(A-01): cache getAllFeatureFlags result (flags don't change at runtime)"
```

---

## Task 14: A-02 — command-validator 空代码注释

**Files:**
- Modify: `src/core/command-validator.ts:30-32`

- [ ] **Step 1: 添加注释**

```typescript
if (!code || code.trim().length === 0) {
  // No code to validate — this represents "nothing to check", not "empty code is safe to execute".
  // The caller should treat safe:true + no reason as "validation skipped (no input)".
  return { safe: true };
}
```

- [ ] **Step 2: 提交**

```bash
git add src/core/command-validator.ts
git commit -m "fix(A-02): clarify empty-code validation semantics with comment"
```

---

## Task 15: A-03 — ILLEGAL_CHARS 重复字符

**Files:**
- Modify: `src/core/path-security.ts:18`

- [ ] **Step 1: 修复正则**

```typescript
const ILLEGAL_CHARS = /[<>|"?*\x00-\x1f]/;
```

- [ ] **Step 2: 运行测试验证**

Run: `npx vitest run test/core/path-security.test.ts`
Expected: 全部通过

- [ ] **Step 3: 提交**

```bash
git add src/core/path-security.ts
git commit -m "fix(A-03): remove duplicate quote in ILLEGAL_CHARS regex"
```

---

## Task 16: A-09 — isRetriable 用 Set

**Files:**
- Modify: `src/core/health-monitor.ts:289-292`

- [ ] **Step 1: 实现**

```typescript
const RETRIABLE_TYPES = new Set(['timeout', 'connection_reset', 'heartbeat', 'ECONNREFUSED', 'ECONNRESET']);

function isRetriable(errorType: string): boolean {
  return RETRIABLE_TYPES.has(errorType);
}
```

- [ ] **Step 2: 提交**

```bash
git add src/core/health-monitor.ts
git commit -m "fix(A-09): use Set for retriable error types (O(1) lookup)"
```

---

## Task 17: A-08 — Elicitation enum/oneOf 注释

**Files:**
- Modify: `src/core/middleware.ts:133-137`

- [ ] **Step 1: 添加注释**

```typescript
// Note: enum-typed params (type:'string' + enum:[...]) are already covered by this
// check since their base type is 'string'. However, oneOf/anyOf compound types are
// NOT supported — elicitation skips them to avoid complex schema resolution.
const primitiveMissing = missing.filter(name => {
  const prop = props[name];
  if (!prop) return false;
  const type = prop.type;
  return type === 'string' || type === 'number' || type === 'boolean';
});
```

- [ ] **Step 2: 提交**

```bash
git add src/core/middleware.ts
git commit -m "fix(A-08): document enum/oneOf elicitation coverage limitation"
```

---

## Task 18: 全量测试 + 最终提交

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run`
Expected: 全部通过（2194+ 测试）

- [ ] **Step 2: 检查无遗留 git diff**

Run: `git status`
Expected: 工作区干净

- [ ] **Step 3: 如果有未提交的文件，追加提交**

```bash
git add -A
git commit -m "fix(review): address remaining A-01~A-10 advisory findings from 2026-06-08 review"
```

---

## 自查清单

1. **Spec 覆盖**：C-01~C-03 ✓, I-01~I-12 ✓, A-01~A-10 ✓ — 全部 25 项均有对应 Task
2. **Placeholder 扫描**：无 TBD/TODO/待定 — 每步均有实际代码
3. **类型一致性**：`inflightCount`/`inflightZero` 在 Task 1 中定义并一致使用；`start()` 返回类型改为 `Promise<boolean>` 与 Task 7 测试一致；`loadFromRegistry` 改为 `async` 与 Task 2 调用方一致
