# I-07: 运行时类型验证层 设计文档 v2

**日期：** 2026-05-30
**状态：** 待实施
**关联：** I-01 ToolDispatcher 提取（已完成）

---

## 背景与问题

当前 MCP 工具的参数校验分散在各工具模块内部，入口层（ToolDispatcher.handleCall）不检查参数类型。传入 `project_path=123`（数字）或 `action={}`（对象）不会在入口处被拦截，而是透传到 GDScript 层才报错，导致：

1. 错误信息不友好（GDScript 层面报错难以理解）
2. 浪费一次 Godot 进程调用（headless 启动开销）
3. 每个工具模块重复编写相同的类型检查代码

## 目标

在 ToolDispatcher 入口层添加轻量参数类型校验，拦截明显类型错误，返回结构化错误响应。

## 范围约束

- **只校验真正的公共参数**：project_path、action（scene_path/method 非真正公共参数，由各模块处理）
- **只校验类型**：存在但类型错误时报错，缺失不报错（由各模块自行处理）
- **零新依赖、零新文件**：内联为 ToolDispatcher 私有方法
- **复用现有基础设施**：错误码用 `INVALID_PARAMS`，响应格式用 `opsErrorResult()`
- **不改变现有模块**：各工具模块内部的校验逻辑保持不变（防御性编程）

## 方案

### 实现：ToolDispatcher 私有方法

将校验逻辑内联为 `ToolDispatcher` 的私有方法，与已有的 `validatePathArgs()` 风格一致：

```typescript
private validateCommonArgs(args: Record<string, unknown>): ToolResult | null {
  // project_path: 存在时必须是非空字符串
  if ('project_path' in args) {
    const v = args.project_path;
    if (typeof v !== 'string' || v.trim() === '') {
      return opsErrorResult('INVALID_PARAMS', `project_path must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`);
    }
  }
  // action: 存在时必须是非空字符串
  if ('action' in args) {
    const v = args.action;
    if (typeof v !== 'string' || v.trim() === '') {
      return opsErrorResult('INVALID_PARAMS', `action must be a non-empty string, got: ${typeof v === 'string' ? '""' : JSON.stringify(v)}`);
    }
  }
  return null;
}
```

### 校验规则

| 参数 | 规则 | 错误码 |
|------|------|--------|
| `project_path` | 存在 → 必须是非空字符串（trim 后检查） | `INVALID_PARAMS` |
| `action` | 存在 → 必须是非空字符串（trim 后检查） | `INVALID_PARAMS` |

- 返回 `null` 表示通过
- 返回 `opsErrorResult(...)` 表示失败
- 多参数同时错误时返回第一个
- `null`/`undefined` 值不在 `in` 检查范围内（参数缺失不报错）

### 插入位置

在 `ToolDispatcher.handleCall()` 管道中，`normalizeArgs` 之后、`ReadOnlyGuard` 之前：

```
normalizeArgs(rawArgs)           // 已有
  ↓
validateCommonArgs(args)         // 新增（内联私有方法）
  ↓
ReadOnlyGuard.check(name)        // 已有
  ↓
confirm_and_execute / confirm / dispatch  // 已有
```

### 错误响应格式

复用 `opsErrorResult()`，与 22 个工具模块格式一致：

```json
{
  "content": [{
    "type": "text",
    "text": "{\"error\":{\"code\":\"INVALID_PARAMS\",\"message\":\"project_path must be a non-empty string, got: 123\"}}"
  }],
  "isError": true
}
```

### 双层校验说明

入口层 `validateCommonArgs` 校验类型（"这个值是字符串吗？"），dispatch 层 `validatePathArgs` 校验路径安全（"这个路径在白名单里吗？"）。两者互补，不冲突。

## 文件变动

| 文件 | 动作 | 估计行数 |
|------|------|----------|
| `src/core/ToolDispatcher.ts` | 添加私有方法 + handleCall 中调用 + import opsErrorResult | +20 行 |
| `test/core/ToolDispatcher.test.ts` | 补充 15 个校验用例 | +120 行 |

**零新文件。**

## 测试覆盖（15 个用例）

基础类型校验（6 个）：

1. T1: project_path=123（数字）→ INVALID_PARAMS
2. T2: project_path={}（对象）→ INVALID_PARAMS
3. T3: project_path="  "（纯空白）→ INVALID_PARAMS
4. T4: action=[]（数组）→ INVALID_PARAMS
5. T5: action=null → INVALID_PARAMS
6. T6: action="  "（纯空白）→ INVALID_PARAMS

合法值通过（3 个）：

7. T7: 全部合法字符串 → null（通过）
8. T8: 参数完全缺失 → null（不报错）
9. T9: 多参数同时错误 → 返回第一个

边界值（3 个）：

10. T10: project_path=null → INVALID_PARAMS
11. T11: project_path=undefined（缺失）→ null（不报错）
12. T12: action=undefined（缺失）→ null（不报错）

集成路径（3 个）：

13. T13: confirm_and_execute 路径带 project_path=123 → 在 guard 前拦截
14. T14: editor 模式传入 project_path=123 → 在 editorExec 前拦截
15. T15: camelCase 传入 `{projectPath: 123}` → normalizeArgs 后被拦截

## 不做的事

- 不校验参数值的有效性（如 action 是否匹配枚举值）— 由各模块处理
- 不校验 scene_path/method（非真正公共参数）— 由各模块处理
- 不校验工具特有参数（如 node_path、animation_name 等）
- 不引入 schema 验证库（ajv、zod 等）
- 不修改各工具模块的现有校验逻辑
- 不新建独立文件（内联为私有方法）
