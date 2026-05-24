# 测试基础设施全面升级设计

**日期**: 2026-05-24
**版本**: v0.14.0
**状态**: 设计中（审查修订版）

## 目标

1. 防回归 — 加覆盖率工具 + 补关键测试
2. CI 可靠性 — 集成测试不依赖本地 Godot，CI 全跑
3. 全面覆盖 — 补齐无测试文件，行覆盖率 80%+
4. 测试质量 — 加 snapshot + property-based testing

## 决策：为什么选 Vitest 而非继续用 node:test

Node 20+ 的 node:test 已支持 `--experimental-test-coverage`、`mock.fn()`、describe/it，理论上可以不迁移。选择 Vitest 的理由：

| 方面 | node:test | Vitest | 决策依据 |
|------|-----------|--------|---------|
| 覆盖率报告 | text only（V8 需 --experimental flag） | text + lcov + html 开箱即用 | 需要上传 lcov 到 Codecov |
| Snapshot 测试 | 无内置，需自建或第三方 | 内置 toMatchSnapshot() | 核心需求，避免自建成本 |
| Mock API | 基础 mock.fn() | vi.mock() hoisting + vi.spyOn + vi.fn | executor 级别 mock 需要模块级拦截 |
| Watch 模式 | --watch（基础） | vitest（HMR + 智能重跑） | 提升开发体验 |
| 错误信息 | 基础堆栈 | diff 高亮 + 源码映射 | 调试效率 |
| 依赖成本 | 零 | +3 devDependencies | 可接受（devOnly） |

**核心动机**：snapshot 测试内置 + lcov 覆盖率报告 + 模块级 mock hoisting。这三项用 node:test 需要自建或拼凑多个工具。

**风险对冲**：迁移期间如遇兼容性问题，node:test 测试仍然可以并行运行（两套 test script 保留至迁移完成）。

## 第一段：测试框架迁移（node:test → Vitest）

### 安装依赖

```
vitest          — 测试框架
@vitest/coverage-v8 — 覆盖率
fast-check      — property-based testing
```

### 配置文件

新建 `vitest.config.ts`：
- **`globals: true`** — 必须显式开启，否则删除 node:test import 后所有测试报 `describe is not defined`
- 测试文件匹配 `test/**/*.test.{js,ts}`
- 覆盖率：v8 provider，reporter: text + lcov + html
- include: src/（覆盖率统计范围）

### Import 路径策略

当前测试从 `build/` 导入编译产物：
```js
import { parseMcpMarkers } from '../build/gdscript-executor.js';
```

迁移后**保持从 `build/` 导入**，理由：
- Vitest 的 TypeScript 支持用于 vitest.config.ts 本身，不用于运行时转译
- 避免调整 tsconfig.json 的 module/moduleResolution 设置
- 保持与当前构建流程一致

### 迁移规则

| node:test | Vitest |
|-----------|--------|
| `import { describe, it } from 'node:test'` | 删除（Vitest 全局注入） |
| `import assert from 'node:assert/strict'` | `import { expect } from 'vitest'` |
| `assert.strictEqual(a, b)` | `expect(a).toBe(b)` |
| `assert.deepStrictEqual(a, b)` | `expect(a).toEqual(b)` |
| `assert.throws(fn, /regex/)` | `expect(fn).toThrow(/regex/)` |
| `assert.ok(x)` | `expect(x).toBeTruthy()` |
| 手动 mock 对象 | `vi.fn()` / `vi.spyOn()` / `vi.mock()` |

### 迁移文件数量

- `test/*.test.js`: 39 个
- `test/integration/*.test.js`: 5 个
- `test/helpers/*.js`: 3 个（2 个依赖全局 it/afterEach，需确认 Vitest globals 可用后验证）
- **合计: 47 个文件需处理**

### 集成测试特殊处理

5 个集成测试文件有全局污染需清理：
```js
// 当前 test/integration/gdscript-execution.test.js:11-12
globalThis.it = it;
globalThis.afterEach = afterEach;
```
Vitest 全局注入 describe/it/afterEach，这些行直接删除。

`ensureGodot()` 和 `itIfGodot()` 函数替换为 mock（见第二段）。

### package.json scripts

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "test:integration": "vitest run test/integration"
}
```

### CI 更新

```yaml
- run: npx vitest run --coverage
# 可选：上传覆盖率
- uses: codecov/codecov-action@v4
  with:
    files: ./coverage/lcov.info
```

### 不改动

- 保持现有 `test/*.test.js` 文件结构不变
- `test/helpers/` 文件保留，逐步改造
- 测试逻辑和断言内容不变，只改调用方式
- **新增** snapshot 和 fixture 子目录（`test/__snapshots__/`、`test/fixtures/godot-responses/`）

## 第二段：Godot Mock 层（Executor 级别）

### 架构决策

**不 mock `child_process.spawn`**，改为在 `gdscript-executor.ts` 的导出接口级别 mock。

理由：
- spawn 是底层实现细节，重构会断裂 mock
- 模拟完整 ChildProcess 接口（Readable 流 + 事件 + kill）复杂度高
- executor 级别 mock 只需返回结构化结果，简单可靠

### Mock 层设计

```
测试代码 → vi.mock('gdscript-executor') → 返回预设结果 → 测试断言
```

创建 `test/helpers/godot-mock.ts`：

```ts
// 注意：vi.mock() 路径相对于此文件（test/helpers/），不是相对于导入它的测试文件。
// 如果移动此文件，路径需同步更新。

// 顶层声明默认 mock — vi.mock() 会被 hoisting 提升到模块顶部
vi.mock('../../build/gdscript-executor.js', () => ({
  executeGdscript: vi.fn(() => Promise.resolve({
    success: true, exitCode: 0, stdout: '', stderr: '',
  })),
  // 其他导出函数按需 mock
}));

// 导出 mock 引用，供测试中按需覆盖
export { executeGdscript } from '../../build/gdscript-executor.js';
```

测试中按需覆盖默认行为：
```ts
import { executeGdscript } from './helpers/godot-mock.js';
import { expect, it, vi } from 'vitest';

it('handles failure', async () => {
  vi.mocked(executeGdscript).mockResolvedValueOnce({
    success: false, exitCode: 1, stdout: '', stderr: 'Parse error',
  });
  // ... 测试逻辑
});
```

### 预设场景

`test/fixtures/godot-responses/` 目录存放典型响应 JSON：
- `success.json` — 正常执行结果
- `parse-error.json` — 编译错误
- `runtime-error.json` — 运行时错误
- `empty-scene.json` — 空场景树
- `complex-scene-tree.json` — 复杂场景树

### 集成测试改造

每个 `itIfGodot()` 测试的具体改造：
1. 删除 `itIfGodot()` 包裹，改为普通 `it()`
2. import mock 引用：`import { executeGdscript } from './helpers/godot-mock.js'`
3. 在 it() 内用 `vi.mocked(executeGdscript).mockResolvedValueOnce(...)` 设定预期返回
4. 删除 `ensureGodot()` / `getGodotPath()` 调用
5. 删除 `globalThis.it = it` / `globalThis.afterEach = afterEach`
6. 断言从检查真实 Godot 输出改为检查 mock 返回值

保留标记：需要真实 Godot 的端到端测试标记 `it.skipIf(!hasGodot)('e2e: ...')`，仅本地手动跑。

## 第三段：覆盖率 + 补测试

### 覆盖率目标

- 整体行覆盖率 80%+
- 安全相关模块（guard、auth）90%+

### 无测试文件清单（22 个）

经核实，以下源文件没有对应的测试文件：

**第一梯队（核心模块）**：
| 文件 | 原因 |
|------|------|
| `GodotServer.ts` | 核心服务器逻辑，MCP 连接管理 |
| `index.ts` | 入口点，工具注册和初始化 |
| `core/editor-auth.ts` | 认证逻辑，安全相关 |
| `core/godot-finder.ts` | Godot 路径查找，多平台逻辑 |
| `core/process-state.ts` | 进程生命周期管理 |

**第二梯队（工具模块）**：
| 文件 | 原因 |
|------|------|
| `tools/animtree.ts` | AnimationTree 状态机 |
| `tools/animation-shared.ts` | 动画共享逻辑 |
| `tools/animation-track.ts` | 动画轨道操作 |
| `tools/batch-tools.ts` | 批量操作 |
| `tools/navigation.ts` | 导航寻路（godot-ops.test.js 有部分覆盖） |
| `tools/particles.ts` | 粒子系统 |
| `tools/profiler-ops.ts` | 性能分析 |
| `tools/project.ts` | 项目管理 |
| `tools/spatial-ops.ts` | 3D 空间查询 |
| `tools/runtime.ts` | 运行时操作 |

**第三梯队（辅助模块）**：
| 文件 | 原因 |
|------|------|
| `tools/deprecated-properties.ts` | 废弃属性映射 |
| `tools/docs.ts` | 文档查询 |
| `tools/test-framework.ts` | 测试框架工具 |
| `tools/validation.ts` | 验证逻辑（validation-filter.test.js 有部分覆盖） |
| `resources.ts` | 资源管理 |
| `screenshot.ts` | 截图功能 |
| `tools/screenshot.ts` | 工具层截图 |

**注意**：`types.ts` 纯类型定义文件，不含运行时代码，不纳入覆盖目标。

### 补测策略

- 每个文件至少覆盖：正常路径、边界输入、错误处理
- 已有测试的文件如果覆盖率低于 80% 也补充
- 不追求 100%，80% 是底线
- GodotServer.ts 需重点测试 MCP 连接生命周期和错误恢复

## 第四段：测试质量提升

### Snapshot Testing

目标模块（4 个）：
| 模块 | Snapshot 内容 |
|------|-------------|
| `tscn-parser.ts` | 典型 .tscn 文件解析结果 |
| `tscn-editor.ts` | 编辑操作前后对比（添加/删除节点、修改属性） |
| `tscn-parser-instance.test.js` | 实例化场景解析结果 |
| `godot-docs.ts` | 文档缓存结构 |

- 使用 `expect(result).toMatchSnapshot()`
- snapshot 文件放在 `test/__snapshots__/`

### Property-Based Testing

依赖：`fast-check` 库

目标模块：
| 模块 | 测试属性 |
|------|---------|
| `guard.ts` | 随机路径字符串，验证永远不越界 |
| `tscn-parser.ts` | 解析任意字符串不崩溃（fuzz） |
| `gdscript-lint.ts` | lint 规则对任意代码不抛异常 |
| `validation-filter.ts` | 输入过滤对任意输入不崩溃 |

CI 环境 200 次，本地 1000 次：
```ts
fc.assert(property, { numRuns: process.env.CI ? 200 : 1000 });
```

### 不做的事

- 不引入 E2E 测试框架（项目是 MCP server 不是 Web 应用）
- 不加性能基准测试（不在本次范围）

## 风险与缓解措施

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Vitest ESM 兼容性问题 | 中 | CI 红灯 | 迁移期间保留 node:test 作为 fallback |
| Mock 与真实 Godot 行为不一致 | 高 | 虚假通过 | 保留 e2e 标记测试，定期本地用真实 Godot 跑 |
| Snapshot 频繁漂移 | 中 | 维护负担 | snapshot 仅用于稳定接口（tscn 格式），不在迭代频繁的模块使用 |
| 迁移期间 CI 中断 | 中 | 阻塞合并 | 分阶段：先迁移 + 验证 → 再补测试 → 最后 snapshot/property |
| 覆盖率目标未达 80% | 低 | 推迟交付 | 优先补核心模块，工具模块按梯队递进 |

### 分阶段交付策略

1. **阶段 1**：Vitest 迁移 + CI 验证（确保绿灯）
2. **阶段 2**：Mock 层 + 集成测试改造
3. **阶段 3**：补测 22 个文件（按梯队顺序）
4. **阶段 4**：Snapshot + Property-based 测试

每个阶段独立 PR，可回滚。

## 工作量估算（修订）

| 任务 | 预估 | 说明 |
|------|------|------|
| Vitest 配置 + 47 文件迁移 | 4-5h | import 替换 + globalThis 清理 + CI 验证 |
| Godot Mock 层 | 2-3h | executor 级别 mock，比 spawn 级别简单 |
| 补测 22 文件（第一梯队 5 个） | 3-4h | 核心模块，需仔细 mock |
| 补测 22 文件（第二梯队 10 个） | 4-5h | 工具模块 |
| 补测 22 文件（第三梯队 7 个） | 2-3h | 辅助模块，逻辑简单 |
| Snapshot 测试 | 1-2h | 4 个模块 |
| Property-based 测试 | 1-2h | 4 个模块 |
| **总计** | **17-24h** | 分 4 个阶段交付 |

## 验收标准

1. `vitest run` 全部通过（0 失败）
2. `vitest run --coverage` 行覆盖率 ≥ 80%
3. CI 绿灯（Node 20 + 22）
4. 集成测试不再依赖本地 Godot
5. Snapshot 测试至少 4 个模块覆盖
6. Property-based 测试至少 4 个模块覆盖
7. 每个阶段独立 PR，可独立回滚
8. `vitest run` 在 60 秒内完成（CI 环境）
