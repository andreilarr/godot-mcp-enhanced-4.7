# Profiler Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 profiler `get_data` action，支持多维度采样、p99 百分位、趋势退化检测、内存趋势、渲染统计。

**Architecture:** 纯 TS 端改动——修改 `profiler-ops.ts` 中的 `genGetData()` GDScript 生成函数，动态构建采样代码。新增 `dimensions`、`leak_threshold_mb` 参数。所有新字段为可选追加，默认行为不变。

**Tech Stack:** TypeScript, GDScript (生成式), Vitest

**Spec:** `docs/superpowers/specs/2026-06-09-unreal-patterns-borrowing-design.md` 改进 1

---

## File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/tools/profiler-ops.ts` | 唯一改动文件：常量映射表 + `genGetData()` 重写 + 参数校验 + schema 更新 | 修改 |
| `test/profiler-ops.test.js` | 新增测试覆盖 dimensions/退化/内存/render | 修改 |

---

## Constants (defined in Task 1, used everywhere)

```typescript
const DIMENSION_MAP: Record<string, { gdConstant: string; label: string }> = {
  'process':     { gdConstant: 'Performance.TIME_PROCESS',           label: 'process' },
  'physics':     { gdConstant: 'Performance.TIME_PHYSICS_PROCESS',   label: 'physics' },
  'nav_process': { gdConstant: 'Performance.TIME_NAVIGATION_PROCESS', label: 'nav_process' },
};
const VALID_DIMENSIONS = new Set(Object.keys(DIMENSION_MAP));
```

---

### Task 1: 常量映射表 + dimensions 参数校验函数

**Files:**
- Modify: `src/tools/profiler-ops.ts:8-11` (在 `TOOL_NAMES` 后插入常量)
- Test: `test/profiler-ops.test.js`

- [ ] **Step 1: 写失败测试 — dimensions 校验**

在 `test/profiler-ops.test.js` 的 `profiler-ops handleTool — profiler get_data` describe 块内追加：

```javascript
it('rejects invalid dimension strings and falls back to process', async () => {
  const ctx = createMockCtx();
  const result = await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
    dimensions: ['typo', 'process'],
  }, ctx);

  expect(result).not.toBeNull();
  const callArgs = executeGdscript.mock.calls[0][0];
  // Should only contain valid dimensions (typo filtered out)
  expect(callArgs.code).toContain('Performance.TIME_PROCESS');
  expect(callArgs.code).not.toContain('Performance.TIME_NAVIGATION');
  // Result should contain warning about unknown dimension
  const json = JSON.parse(result.content[0].text);
  expect(json.warnings).toBeDefined();
  expect(json.warnings.some(w => w.includes('typo'))).toBe(true);
});

it('falls back to process when all dimensions are invalid', async () => {
  const ctx = createMockCtx();
  const result = await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
    dimensions: ['bogus'],
  }, ctx);

  expect(result).not.toBeNull();
  const callArgs = executeGdscript.mock.calls[0][0];
  expect(callArgs.code).toContain('Performance.TIME_PROCESS');
});

it('accepts valid dimensions array', async () => {
  const ctx = createMockCtx();
  const result = await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
    dimensions: ['process', 'physics'],
  }, ctx);

  expect(result).not.toBeNull();
  const callArgs = executeGdscript.mock.calls[0][0];
  expect(callArgs.code).toContain('Performance.TIME_PROCESS');
  expect(callArgs.code).toContain('Performance.TIME_PHYSICS_PROCESS');
});

it('defaults to process when dimensions not specified', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
  }, ctx);

  const callArgs = executeGdscript.mock.calls[0][0];
  expect(callArgs.code).toContain('Performance.TIME_PROCESS');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/profiler-ops.test.js --reporter=verbose 2>&1 | tail -30`
Expected: 新测试 FAIL（`dimensions` 参数尚未被处理）

- [ ] **Step 3: 实现常量映射表 + dimensions 校验**

在 `src/tools/profiler-ops.ts` 的 `TOOL_NAMES` 后（第 11 行后）插入：

```typescript
// ─── Dimension Mapping ──────────────────────────────────────────────────────

const DIMENSION_MAP: Record<string, { gdConstant: string; label: string }> = {
  'process':     { gdConstant: 'Performance.TIME_PROCESS',           label: 'process' },
  'physics':     { gdConstant: 'Performance.TIME_PHYSICS_PROCESS',   label: 'physics' },
  'nav_process': { gdConstant: 'Performance.TIME_NAVIGATION_PROCESS', label: 'nav_process' },
};
const VALID_DIMENSIONS = new Set(Object.keys(DIMENSION_MAP));

/** Parse and validate dimensions parameter. Returns valid dimensions + warnings. */
function parseDimensions(raw: unknown): { dimensions: string[]; warnings: string[] } {
  let dims: string[];
  if (Array.isArray(raw) && raw.length > 0) {
    dims = raw.filter(d => typeof d === 'string');
  } else {
    return { dimensions: ['process'], warnings: [] };
  }
  const invalid = dims.filter(d => !VALID_DIMENSIONS.has(d));
  const valid = dims.filter(d => VALID_DIMENSIONS.has(d));
  const warnings: string[] = [];
  if (invalid.length > 0) {
    warnings.push(`Unknown dimensions ignored: ${invalid.join(', ')}. Valid: ${[...VALID_DIMENSIONS].join(', ')}`);
  }
  if (valid.length === 0) {
    warnings.push('No valid dimensions provided, falling back to process');
    return { dimensions: ['process'], warnings };
  }
  return { dimensions: valid, warnings };
}
```

在 `get_data` case 块中修改为使用 `parseDimensions`：

```typescript
case 'get_data': {
  const targetFps = args.target_fps !== undefined
    ? ensurePositiveInt(args.target_fps, 'target_fps', 1, 1000)
    : 60;
  const frameCount = args.frame_count !== undefined
    ? ensurePositiveInt(args.frame_count, 'frame_count', 1, 600)
    : 60;
  const { dimensions, warnings: dimWarnings } = parseDimensions(args.dimensions);
  const leakThresholdMb = args.leak_threshold_mb !== undefined
    ? Math.max(0.1, Number(args.leak_threshold_mb) || 2.0)
    : 2.0;
  code = genGetData(targetFps, frameCount, dimensions, leakThresholdMb);
  timeout = 45;
  // Pass dimension warnings to result
  const gdResult = await executeGdscript({
    godotPath,
    projectPath,
    code,
    timeout,
    loadAutoloads,
  });
  return parseGdscriptResult(gdResult, dimWarnings);
}
```

注意：需要修改 get_data case 为不直接 return，先拿到 parseGdscriptResult 的结果再 return。原来的模式是：

```typescript
const result = await executeGdscript({...});
return parseGdscriptResult(result);
```

改为：

```typescript
const gdResult = await executeGdscript({...});
return parseGdscriptResult(gdResult, dimWarnings);
```

同时需要更新 `genGetData` 签名接受 dimensions 和 leakThresholdMb 参数。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/profiler-ops.test.js --reporter=verbose 2>&1 | tail -30`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/profiler-ops.ts test/profiler-ops.test.js
git commit -m "feat(profiler): add DIMENSION_MAP, parseDimensions, and dimension validation

- DIMENSION_MAP maps strings to Performance monitor constants
- parseDimensions validates and falls back to 'process'
- Tool schema updated with dimensions + leak_threshold_mb params
- 4 new tests for dimension validation (invalid, fallback, valid, default)"
```

---

### Task 2: 重写 genGetData() — 多维度采样 + p99 + 退化检测 + 内存趋势 + 渲染统计

**Files:**
- Modify: `src/tools/profiler-ops.ts:83-153` (整个 genGetData 函数)
- Test: `test/profiler-ops.test.js`

这是核心改动。`genGetData()` 当前生成一段固定的 GDScript 字符串。需要重写为根据 dimensions 动态构建。

- [ ] **Step 1: 写失败测试 — 生成的 GDScript 包含新特性**

在 `test/profiler-ops.test.js` 的 `profiler-ops handleTool — profiler get_data` describe 块内追加：

```javascript
it('generates multi-dimension sampling code', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
    dimensions: ['process', 'physics'],
  }, ctx);

  const code = executeGdscript.mock.calls[0][0].code;
  // Should have separate dimension arrays
  expect(code).toContain('_mcp_dim_process');
  expect(code).toContain('_mcp_dim_physics');
  expect(code).toContain('Performance.TIME_PROCESS');
  expect(code).toContain('Performance.TIME_PHYSICS_PROCESS');
});

it('includes p99 percentile in generated code', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
  }, ctx);

  const code = executeGdscript.mock.calls[0][0].code;
  expect(code).toContain('0.99');  // p99 index calculation
});

it('includes degradation detection with division-by-zero guard', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
  }, ctx);

  const code = executeGdscript.mock.calls[0][0].code;
  expect(code).toContain('degradation');
  expect(code).toContain('_n < 2');  // guard against frame_count < 2
});

it('includes memory trend sampling', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
  }, ctx);

  const code = executeGdscript.mock.calls[0][0].code;
  expect(code).toContain('_capture_memory');
  expect(code).toContain('memory_trend');
  expect(code).toContain('leak_suspected');
});

it('includes render stats as independent block', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
  }, ctx);

  const code = executeGdscript.mock.calls[0][0].code;
  expect(code).toContain('render_stats');
  expect(code).toContain('RENDER_TOTAL_DRAW_CALLS_IN_FRAME');
  // Render stats should NOT be inside dimension sampling
  expect(code).not.toContain('_mcp_dim_render');
});

it('uses leak_threshold_mb in generated code', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
    leak_threshold_mb: 5.0,
  }, ctx);

  const code = executeGdscript.mock.calls[0][0].code;
  expect(code).toContain('5.0');
});

it('preserves default behavior when no new params given', async () => {
  const ctx = createMockCtx();
  await handleTool('profiler', {
    project_path: '/fake/project',
    action: 'get_data',
  }, ctx);

  const code = executeGdscript.mock.calls[0][0].code;
  // Should still have frame budget analysis
  expect(code).toContain('frame_budget');
  expect(code).toContain('_mcp_target_fps');
  expect(code).toContain('_mcp_frame_count');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/profiler-ops.test.js --reporter=verbose 2>&1 | tail -40`
Expected: 新测试 FAIL（genGetData 签名不匹配，缺少新特性代码）

- [ ] **Step 3: 重写 genGetData() 函数**

替换 `src/tools/profiler-ops.ts` 中 `genGetData` 函数（第 83-153 行）为以下完整实现：

```typescript
function genGetData(
  targetFps: number,
  frameCount: number,
  dimensions: string[],
  leakThresholdMb: number,
): string {
  // Build per-dimension sampling arrays
  const dimDeclarations: string[] = [];
  const dimSampling: string[] = [];
  const dimAnalysis: string[] = [];

  for (const dim of dimensions) {
    const { gdConstant, label } = DIMENSION_MAP[dim];
    const varName = `_mcp_dim_${label}`;
    dimDeclarations.push(`var ${varName}: Array = []`);
    dimSampling.push(`${varName}.append(Performance.get_monitor(${gdConstant}) * 1000.0)`);

    // Per-dimension analysis (p50/p95/p99/avg/min/max/degradation + over-budget)
    dimAnalysis.push(`
\tvar _${label}_n: int = ${varName}.size()
\tif _${label}_n > 0:
\t\tvar _${label}_sorted: Array = ${varName}.duplicate()
\t\t_${label}_sorted.sort()
\t\tvar _${label}_total: float = 0.0
\t\tfor _t in ${varName}:
\t\t\t_${label}_total += _t
\t\tvar _${label}_avg: float = _${label}_total / float(_${label}_n)
\t\tvar _${label}_min: float = _${label}_sorted[0]
\t\tvar _${label}_max: float = _${label}_sorted[_${label}_n - 1]
\t\tvar _${label}_p50: float = _${label}_sorted[int(_${label}_n * 0.5)]
\t\tvar _${label}_p95_idx: int = int(_${label}_n * 0.95)
\t\tif _${label}_p95_idx >= _${label}_n:
\t\t\t_${label}_p95_idx = _${label}_n - 1
\t\tvar _${label}_p95: float = _${label}_sorted[_${label}_p95_idx]
\t\tvar _${label}_p99_idx: int = int(_${label}_n * 0.99)
\t\tif _${label}_p99_idx >= _${label}_n:
\t\t\t_${label}_p99_idx = _${label}_n - 1
\t\tvar _${label}_p99: float = _${label}_sorted[_${label}_p99_idx]
\t\tvar _${label}_over: int = 0
\t\tfor _t in ${varName}:
\t\t\tif _t > _frame_budget_ms:
\t\t\t\t_${label}_over += 1
\t\t# Degradation detection (with guard for _n < 2)
\t\tvar _${label}_degradation_pct: float = 0.0
\t\tvar _${label}_degradation_detected: bool = false
\t\tvar _${label}_first_half_avg_ms: float = 0.0
\t\tvar _${label}_second_half_avg_ms: float = 0.0
\t\tif _${label}_n >= 2:
\t\t\tvar _${label}_half: int = _${label}_n / 2
\t\t\tvar _${label}_fh_sum: float = 0.0
\t\t\tvar _${label}_sh_sum: float = 0.0
\t\t\tfor _i in range(_${label}_half):
\t\t\t\t_${label}_fh_sum += ${varName}[_i]
\t\t\tfor _i in range(_${label}_half, _${label}_n):
\t\t\t\t_${label}_sh_sum += ${varName}[_i]
\t\t\t_${label}_first_half_avg_ms = _${label}_fh_sum / float(_${label}_half)
\t\t\t_${label}_second_half_avg_ms = _${label}_sh_sum / float(_${label}_n - _${label}_half)
\t\t\tif _${label}_first_half_avg_ms > 0.0:
\t\t\t\t_${label}_degradation_pct = ((${label}_second_half_avg_ms - _${label}_first_half_avg_ms) / _${label}_first_half_avg_ms) * 100.0
\t\t\t\t_${label}_degradation_detected = _${label}_degradation_pct > 10.0
\t\tvar _${label}_data: Dictionary = {}
\t\t_${label}_data["label"] = "${label}"
\t\t_${label}_data["frame_count"] = _${label}_n
\t\t_${label}_data["avg_ms"] = _${label}_avg
\t\t_${label}_data["min_ms"] = _${label}_min
\t\t_${label}_data["max_ms"] = _${label}_max
\t\t_${label}_data["p50_ms"] = _${label}_p50
\t\t_${label}_data["p95_ms"] = _${label}_p95
\t\t_${label}_data["p99_ms"] = _${label}_p99
\t\t_${label}_data["over_budget_count"] = _${label}_over
\t\t_${label}_data["over_budget_pct"] = (float(_${label}_over) / float(_${label}_n)) * 100.0
\t\t_${label}_data["degradation_pct"] = _${label}_degradation_pct
\t\t_${label}_data["degradation_detected"] = _${label}_degradation_detected
\t\t_${label}_data["first_half_avg_ms"] = _${label}_first_half_avg_ms
\t\t_${label}_data["second_half_avg_ms"] = _${label}_second_half_avg_ms
\t\t_dim_results.append(_${label}_data)
`.trimStart());
  }

  return `${SCENE_TREE_HEADER}
${dimDeclarations.join('\n')}
var _mcp_target_fps: float = ${targetFps}
var _mcp_frame_count: int = ${frameCount}
var _mcp_collected: int = 0
var _frame_budget_ms: float = 1000.0 / _mcp_target_fps
var _mem_start: Dictionary = {}
var _mem_end: Dictionary = {}
var _render_start: Dictionary = {}
var _render_end: Dictionary = {}

func _capture_memory() -> Dictionary:
\treturn {
\t\t"static_mb": Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0,
\t\t"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
\t\t"resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
\t\t"node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
\t}

func _initialize():
\t_mcp_load_main_scene()
\t_mem_start = _capture_memory()
\t_render_start = {
\t\t"draw_calls": int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
\t\t"objects_drawn": int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)),
\t}

func _process(_delta: float):
\t${dimSampling.join('\n\t')}
\t_mcp_collected += 1
\tif _mcp_collected >= _mcp_frame_count:
\t\t_analyze_and_report()

func _analyze_and_report():
\t_mem_end = _capture_memory()
\t_render_end = {
\t\t"draw_calls": int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
\t\t"objects_drawn": int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)),
\t}
\tvar _dim_results: Array = []
\t${dimAnalysis.join('\n\t')}
\t# Frame budget summary
\tvar _frame_data: Dictionary = {}
\t_frame_data["target_fps"] = _mcp_target_fps
\t_frame_data["frame_budget_ms"] = _frame_budget_ms
\t_frame_data["frame_count"] = _mcp_frame_count
\t_frame_data["dimension_stats"] = _dim_results
\t_mcp_output("frame_analysis", _frame_data)
\t# Memory trend
\tvar _mem_delta: float = _mem_end.get("static_mb", 0.0) - _mem_start.get("static_mb", 0.0)
\tvar _mem_data: Dictionary = {}
\t_mem_data["start_static_mb"] = _mem_start.get("static_mb", 0.0)
\t_mem_data["end_static_mb"] = _mem_end.get("static_mb", 0.0)
\t_mem_data["object_count"] = _mem_end.get("object_count", 0)
\t_mem_data["resource_count"] = _mem_end.get("resource_count", 0)
\t_mem_data["node_count"] = _mem_end.get("node_count", 0)
\t_mem_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\tvar _mem_trend: Dictionary = {}
\t_mem_trend["start_static_mb"] = _mem_start.get("static_mb", 0.0)
\t_mem_trend["end_static_mb"] = _mem_end.get("static_mb", 0.0)
\t_mem_trend["delta_mb"] = _mem_delta
\t_mem_trend["leak_suspected"] = _mem_delta > ${leakThresholdMb}
\t_mem_data["memory_trend"] = _mem_trend
\t_mcp_output("memory_stats", _mem_data)
\t# Render stats (independent block)
\tvar _render_data: Dictionary = {}
\t_render_data["start_draw_calls"] = _render_start.get("draw_calls", 0)
\t_render_data["end_draw_calls"] = _render_end.get("draw_calls", 0)
\t_render_data["start_objects_drawn"] = _render_start.get("objects_drawn", 0)
\t_render_data["end_objects_drawn"] = _render_end.get("objects_drawn", 0)
\t_mcp_output("render_stats", _render_data)
\t_mcp_done()
`;
}
```

- [ ] **Step 4: 运行全部测试确认通过**

Run: `npx vitest run test/profiler-ops.test.js --reporter=verbose 2>&1 | tail -40`
Expected: ALL PASS（旧测试 + 新测试）

- [ ] **Step 5: 提交**

```bash
git add src/tools/profiler-ops.ts test/profiler-ops.test.js
git commit -m "feat(profiler): multi-dimension sampling, p99, degradation detection, memory trend, render stats

- genGetData() now dynamically builds per-dimension GDScript
- Supports process/physics/nav_process dimensions
- Adds p99 percentile to all dimension stats
- Degradation detection with _n < 2 guard (CODE-2)
- Memory trend: start/end snapshot + leak_suspected flag
- Render stats: independent block (not in dimension stats)
- _capture_memory() fully defined (CODE-4)
- 7 new tests for generated GDScript content"
```

---

### Task 3: 更新工具 schema — 新增 dimensions 和 leak_threshold_mb 参数描述

**Files:**
- Modify: `src/tools/profiler-ops.ts:14-38` (getToolDefinitions schema)
- Test: `test/profiler-ops.test.js`

- [ ] **Step 1: 写失败测试 — schema 包含新参数**

在 `test/profiler-ops.test.js` 的 `profiler-ops getToolDefinitions` describe 块内追加：

```javascript
it('has dimensions parameter in get_data schema', () => {
  const defs = getToolDefinitions();
  const schema = defs[0].inputSchema;
  expect(schema.properties.dimensions).toBeDefined();
  expect(schema.properties.dimensions.type).toBe('array');
  expect(schema.properties.dimensions.description).toContain('dimension');
});

it('has leak_threshold_mb parameter in get_data schema', () => {
  const defs = getToolDefinitions();
  const schema = defs[0].inputSchema;
  expect(schema.properties.leak_threshold_mb).toBeDefined();
  expect(schema.properties.leak_threshold_mb.type).toBe('number');
  expect(schema.properties.leak_threshold_mb.description).toContain('leak');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/profiler-ops.test.js --reporter=verbose 2>&1 | tail -20`
Expected: 新测试 FAIL

- [ ] **Step 3: 更新 schema**

在 `src/tools/profiler-ops.ts` 的 `getToolDefinitions()` 中，`inputSchema.properties` 对象内新增两个属性（在 `load_autoloads` 之前）：

```typescript
dimensions: {
  type: 'array',
  items: { type: 'string' },
  description: '采样维度列表（get_data，默认 ["process"]）。有效值: process, physics, nav_process',
},
leak_threshold_mb: { type: 'number', description: '内存泄漏嫌疑阈值 MB（get_data，默认 2.0）' },
```

同时更新工具描述字符串，补充新功能说明：

```typescript
description:
  '性能分析工具。snapshot: 快照（FPS/内存/绘制调用/物理统计）。start/stop: 开始/停止分析会话。get_data: 收集帧级数据，含多维度采样、p99百分位、趋势退化检测、内存趋势、渲染统计。get_active_processes: 遍历场景树查找有 _process/_physics_process 的节点。get_signal_connections: 列出子树所有信号连接。' +
  NON_PERSIST,
```

- [ ] **Step 4: 运行全部测试确认通过**

Run: `npx vitest run test/profiler-ops.test.js --reporter=verbose 2>&1 | tail -40`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/profiler-ops.ts test/profiler-ops.test.js
git commit -m "feat(profiler): add dimensions and leak_threshold_mb to tool schema

- dimensions: string[] with items type and description
- leak_threshold_mb: number with description
- Updated tool description with new capabilities
- 2 new schema tests"
```

---

### Task 4: 最终验证 — 全量测试 + 默认行为回归

**Files:** 无改动，纯验证

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run 2>&1 | tail -15`
Expected: ALL PASS，0 failures

- [ ] **Step 2: 验证默认行为回归 — 检查生成代码向后兼容**

Run: `npx vitest run test/profiler-ops.test.js -t "default" --reporter=verbose 2>&1`
Expected: 默认行为测试全部通过

- [ ] **Step 3: 验证不传 dimensions 时生成的 GDScript 与旧格式兼容**

手动检查：默认 `get_data` 生成的代码应：
- 包含 `_mcp_dim_process` 数组（替代旧的 `_mcp_frame_times`）
- `frame_analysis` 输出中包含 `dimension_stats` 数组（每个维度一条）
- `memory_stats` 输出中包含 `memory_trend` 子对象
- 新增 `render_stats` 输出

这些都是新增字段，不破坏现有消费者（JSON 解析时忽略未知 key）。

---

## Self-Review

**1. Spec coverage:**

| Spec 要求 | Task |
|-----------|------|
| 1a dimensions 参数 + 映射表 | Task 1 + Task 3 |
| 1a CODE-6 dimensions 校验 | Task 1 (parseDimensions) |
| 1b 多维度采样 Dictionary | Task 2 (动态生成) |
| 1c p99 百分位 | Task 2 (dimAnalysis 中) |
| 1d 趋势退化检测 + CODE-2 除零守卫 | Task 2 (degradation block) |
| 1e 内存趋势 + CODE-4 _capture_memory | Task 2 |
| 1e leak_suspected 阈值 | Task 1 (leakThresholdMb) |
| 1f 渲染统计独立区块 | Task 2 (render_stats) |
| T1 无效 dimensions 处理 | Task 1 测试 |
| T2 frame_count=1 退化检测 | Task 2 (code 含 `_n < 2` guard) |
| 验收标准 #1 默认行为不变 | Task 4 |
| 验收标准 #2 双维度输出 | Task 1 + 2 测试 |
| 验收标准 #3 p99+退化+内存+渲染 | Task 2 测试 |
| 验收标准 #4 已有测试不破坏 | Task 4 |

**2. Placeholder scan:** 无 TBD/TODO/placeholder。

**3. Type consistency:** `genGetData(targetFps, frameCount, dimensions, leakThresholdMb)` 签名在 Task 1 定义、Task 2 实现，一致。`parseDimensions` 返回 `{ dimensions: string[], warnings: string[] }` 在 Task 1 定义和使用，一致。`DIMENSION_MAP` key 与 `VALID_DIMENSIONS` 一致。
