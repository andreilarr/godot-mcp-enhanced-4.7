# Local Review: feat/agent-architecture 审查修复

**Reviewed**: 2026-06-10
**Branch**: feat/agent-architecture (uncommitted on top of bf7379f)
**Decision**: ✅ APPROVE

## Summary

6 项审查修复（1 安全加固 + 3 性能优化 + 2 正确性修复），全部编译通过、2396 测试零回归。修复质量高，每项都精确命中审查报告发现的问题，无过度工程。

## Findings

### CRITICAL — None

### HIGH — None

### MEDIUM

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| M-01 | `health-monitor.ts:84-87` | `RingBuffer.sliceLast()` 先 `toArray()` 再 `slice(-n)` | 对于 `getStats()` 热路径，每次创建完整数组再切片。但窗口大小仅 100，实际影响极小。如需优化可改为从 `(head - n) % capacity` 直接迭代。 |
| M-02 | `validation.ts:107` | `METHOD_REF_RE` 使用 `g` flag 但在函数内手动管理 `lastIndex` | 正确但脆弱——如果未来有人在其他地方复用此正则会引入 bug。建议每次创建新 RegExp 或封装为工厂函数。 |

### LOW

| # | 文件 | 问题 | 说明 |
|---|------|------|------|
| L-01 | `health-monitor.ts:227-229` | `pushRecentFlag` 方法体只剩一行 `push` | 可考虑内联，但作为私有方法保留也可接受（语义清晰）。 |
| L-02 | `instance-router.ts:20` | `instanceMap` 注释写"H-01: O(1) lookup cache" | 审查编号注释有价值（可追溯到审查报告），但长期可考虑移除。 |

## 逐项修复验证

| 编号 | 修复 | 验证结果 |
|------|------|---------|
| H-08 | `GODOT_MCP_UNRESTRICTED`/`SANDBOX` 加入 `dangerousBypassFlags` | ✅ 生产环境（非 `NODE_ENV=development` 且非 `ALLOW_UNSAFE`）设置这两个标志会导致 `process.exit(1)` |
| H-01 | `instance-router.ts` 添加 `instanceMap` + `rebuildMap()` | ✅ 4 处 id 查找改为 `Map.get()`/`Map.has()`，`updateInstances` 时重建 Map，`selectInstanceByProject`/`resolvePort` 保留线性扫描（低频路径） |
| H-12 | `isErrorFalsePositive` 用正则提取 + `Set.has()` | ✅ `METHOD_REF_RE` 提取方法名，`KNOWN_BASE_METHODS.has()` O(1) 查找。行为等价——相同输入返回相同结果 |
| H-04 | `attachFallbackWarning` 创建新 content | ✅ 返回 `{ ...result, content: [新 text block, ...rest] }`，不修改原始 `result.content[0].text` |
| H-02 | 3 个 `Array.shift()` 改为 `RingBuffer` | ✅ 通用 `RingBuffer<T>` 类，构造函数初始化（尊重自定义 opts），`toArray()`/`sliceLast()` 提供数组兼容接口 |
| H-10 | `_parseOpsRemaining` 改为 `ParseBudget` 参数 | ✅ `parseValue`/`parseArrayContent`/`parseDictContent`/`parseTypedValue` 全部接收 `budget` 参数，`parseTscn` 入口 `createBudget()` 创建局部实例 |

## Validation Results

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ Pass — 零错误 |
| Tests (`vitest run`) | ✅ Pass — 143 files, 2396 tests, 0 failures |
| Lint | ⏭️ Skipped (not run in this review) |

## Files Reviewed

| File | Change Type |
|------|------------|
| `src/index.ts` | Modified — H-08 安全绕过标志 |
| `src/core/instance-router.ts` | Modified — H-01 Map 优化 |
| `src/tools/validation.ts` | Modified — H-12 Set.has() 优化 |
| `src/core/ToolDispatcher.ts` | Modified — H-04 content 不可变 |
| `src/core/health-monitor.ts` | Modified — H-02 RingBuffer |
| `src/tscn-parser.ts` | Modified — H-10 budget 参数化 |
