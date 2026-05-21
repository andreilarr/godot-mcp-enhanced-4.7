# 交付验证系统设计：两层自动化验证框架

> 日期: 2026-05-21
> 状态: Draft
> 来源: 端到端交付流程中反复调试场景的自动化需求

## 问题背景

在使用 MCP 工具进行 Godot 开发时，从需求到交付的流程缺少自动化验证环节：

1. **操作后无反馈** — `add_node`、`edit_node` 等写操作执行后，无法确认结果是否符合预期
2. **脚本验证分散** — `validate_scripts` 检查语法、lint 引擎检查 API、profiler 检查性能，需要分别调用
3. **无交付标准** — 缺少一个"是否可以交付"的综合判断

核心痛点：Claude 每次操作后需要手动截图/查场景树/跑验证来确认结果，反复调试耗时。

## 设计目标

1. **L1 轻量验证** — 写操作后自动快速检查（<2s），结果嵌入工具返回值
2. **L2 深度验证** — 手动调用 `verify_delivery`，四维度全面检查（3-10s）
3. **dev_loop 增强** — 支持验收条件参数，执行后自动验证
4. **只报告不修复** — 验证层返回结构化报告，修复决策交给 Claude

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    Claude (LLM)                      │
│  调用 MCP 工具 → 读取报告 → 决定是否修复             │
└──────────────┬──────────────────────┬────────────────┘
               │                      │
    ┌──────────▼──────────┐  ┌───────▼──────────────┐
    │  Layer 1: 轻量验证    │  │  Layer 2: 深度验证    │
    │  (嵌入工具返回值)     │  │  (verify_delivery)   │
    │                      │  │                       │
    │  add_node → 自动检查  │  │  场景树完整性         │
    │  edit_node → 属性核对 │  │  脚本健壮性           │
    │  write_script → 语法  │  │  性能/资源健康         │
    │  load_sprite → 资源   │  │  自定义行为断言        │
    └──────────┬──────────┘  └───────┬──────────────┘
               │                      │
    ┌──────────▼──────────────────────▼──────────────┐
    │              已有原子能力                        │
    │  execute_gdscript · validate_scripts · profiler │
    │  test_assert · scene_snapshot · error_analyzer  │
    └─────────────────────────────────────────────────┘
```

**两层职责划分：**

| 层 | 触发 | 检查范围 | 耗时 | 用途 |
|---|---|---|---|---|
| L1 轻量 | 写操作后自动 | 单点检查（刚操作的节点/脚本） | <2s | 快速捕获明显错误 |
| L2 深度 | 手动调用 `verify_delivery` | 四维度全面检查 | 3-10s | 交付前终验 |

## L1 轻量验证（嵌入工具返回值）

### 触发方式

在现有写操作工具的返回值中追加 `verification` 字段。由各工具函数末尾调用统一的 `quickVerify()` 函数。

### 涉及工具和检查项

| 工具 | 自动检查内容 | 实现方式 |
|---|---|---|
| `add_node` | 节点存在、类型正确、位置正确 | 执行后生成 GDScript 查询节点 |
| `edit_node` | 属性值已生效 | 读回属性对比期望值 |
| `write_script` / `edit_script` | 无语法错误、无 lint error | 复用现有 `validate_scripts` |
| `load_sprite` | 纹理加载成功 | 查询 texture 属性非空 |
| `ui_build_layout` | 子节点数量、容器类型 | 查询子节点数 |

### 返回值格式

```typescript
interface QuickVerifyResult {
  passed: boolean;
  checks: Array<{
    name: string;       // "node_exists" | "property_match" | "script_valid"
    passed: boolean;
    detail?: string;    // 失败原因
  }>;
}
```

### 性能约束

- L1 验证总耗时不超过 2 秒
- 通过 GDScript 单次执行批量查询（不是每个属性一次调用）
- 新增一个 `verify` 参数（默认 `false`），用户可关闭

### 不做的事

- 不改变现有工具的默认行为（`verify` 默认 false）
- 不做深度检查（那是 L2 的活）

## L2 深度验证（`verify_delivery` 工具）

### 工具签名

```
verify_delivery(project_path, scope, checks?)
```

### scope 参数 — 验证范围

| scope | 说明 |
|---|---|
| `scene` | 指定场景路径，检查该场景树完整性 |
| `script` | 指定脚本路径，检查健壮性 |
| `full` | 扫描整个项目 |

### checks 参数 — 四维度开关

```typescript
checks?: {
  scene_tree?: boolean;     // 场景树状态（默认 true）
  script_health?: boolean;  // 脚本健壮性（默认 true）
  performance?: boolean;    // 性能/资源（默认 true）
  assertions?: Array<{      // 自定义行为断言
    description: string;    // "玩家能移动"
    gdscript: string;       // 执行验证的 GDScript 代码
    expect?: string;        // 期望输出值
  }>;
}
```

### 四维度检查内容

**维度 1 — 场景树完整性**
- 节点引用不悬空（ext_resource 引用的文件存在）
- 脚本附件指向有效 .gd 文件
- 节点层级关系合理（如 Camera 需要 Viewport 祖先）
- 信号连接的目标节点/方法存在

**维度 2 — 脚本健壮性**
- 复用 `validate_scripts`（语法）
- 复用 lint 引擎（已废弃 API、时序陷阱）
- 检查 `preload()`/`load()` 引用的资源是否存在

**维度 3 — 性能/资源健康**
- 复用 `profiler` snapshot（FPS、内存、孤立节点）
- 内存泄漏检测：对比操作前后的 `orphan_node_count`
- 资源引用计数异常

**维度 4 — 自定义行为断言**
- 用户传入 GDScript 代码片段
- 系统包装成 headless 执行脚本
- 比对 `_mcp_output` 输出与 `expect` 值

### 返回格式

```typescript
interface DeliveryReport {
  passed: boolean;
  dimensions: {
    scene_tree:   { passed: boolean; issues: Issue[] };
    script_health: { passed: boolean; issues: Issue[] };
    performance:  { passed: boolean; issues: Issue[] };
    assertions:   { passed: boolean; results: AssertionResult[] };
  };
  summary: string;  // 如 "3/4 通过，性能维度发现孤立节点泄漏"
}

interface Issue {
  severity: "error" | "warning";
  location: string;    // "res://scenes/player.tscn:Player/Sprite2D"
  message: string;
  suggestion: string;
}

interface AssertionResult {
  description: string;
  passed: boolean;
  actual: string;
  expected?: string;
  error?: string;
}
```

### 性能约束

| scope | 耗时 |
|---|---|
| `scene` | 3-5 秒 |
| `script` | 2-3 秒 |
| `full` | 5-10 秒 |
| 自定义断言 | 每个 1-2 秒，最多 10 个 |

## dev_loop 增强

### 新增参数

```typescript
{
  // ... 现有参数不变 ...
  acceptance?: {
    assertions: Array<{
      description: string;    // "角色重力加速度为 980"
      gdscript: string;       // 验证代码，用 _mcp_output("assert_N", value) 输出
      expect: string;         // 期望值（字符串比较）
    }>;
    max_retries?: number;     // 默认 0（只验证一次，不自动重试）
  };
}
```

### 执行流程变化

```
现有:  exec(code) → [validate] → 返回
增强:  exec(code) → [validate] → exec(assertions) → 生成报告 → 返回
```

### 返回值追加

```
现有输出
---
## Acceptance Results
✅ "角色重力加速度为 980" — PASSED (actual: "980")
❌ "敌人朝向玩家" — FAILED (actual: "facing_away", expected: "facing_player")
```

### 设计决策

- `max_retries` 默认 0 — 不自动重试，修复交给 Claude
- 断言代码在独立 GDScript 进程中执行，不污染主代码
- 不自动生成断言代码（Claude 根据上下文自己写）
- 不改变没有 `acceptance` 参数时的行为

## 实现结构

### 新增文件

| 文件 | 职责 |
|---|---|
| `src/tools/delivery.ts` | `verify_delivery` 工具定义 + 四维度检查编排 |
| `src/tools/quick-verify.ts` | `quickVerify()` 函数 + 各工具的 L1 检查模板 |

### 修改文件

| 文件 | 变更内容 |
|---|---|
| `src/tools/workflow.ts` | `dev_loop` 增加 `acceptance` 参数和断言执行逻辑 |
| `src/tools/scene.ts` | `add_node` / `edit_node` 末尾调用 `quickVerify` |
| `src/tools/script.ts` | `write_script` / `edit_script` 末尾调用 `quickVerify` |
| `src/tools/ui-tools.ts` | `ui_build_layout` 末尾调用 `quickVerify` |
| `src/core/tool-registry.ts` | 注册 `verify_delivery` 工具 |

### 复用关系

```
delivery.ts (L2 编排)
  ├── 复用 validate_scripts() → 脚本健壮性
  ├── 复用 lintRules + lintScript() → 已废弃 API 检测
  ├── 复用 executeGdscript() → 场景树查询 + 自定义断言
  ├── 复用 profiler genSnapshot() → 性能数据
  └── 新增 genSceneIntegrityCheck() → 节点引用完整性

quick-verify.ts (L1 轻量)
  ├── 复用 executeGdscript() → 节点存在/属性核对
  └── 复用 validatePath() → 路径安全检查
```

### quickVerify 调用模式

```typescript
// scene.ts 中 add_node 处理末尾
if (input.verify !== false) {
  const verifyResult = await quickVerify('add_node', {
    projectPath, scenePath, nodePath, nodeType, expectedProps
  });
  // 追加到 textResult
}
```

### 不动的文件

- `test-framework.ts` — `test_assert` / `test_stress` 保持原样
- `profiler-ops.ts` — 只被 `delivery.ts` 调用，自身不改
- `recording.ts` — 与本次无关
- `gdscript-lint.ts` — 只被调用，自身不改

## GDScript 代码生成模板

### L1 模板（`quick-verify.ts` 内联）

| 模板 | 用途 | 输出 |
|---|---|---|
| `CHECK_NODE_EXISTS` | 验证节点存在于场景树 | `{exists: bool, type: string}` |
| `CHECK_PROPERTIES` | 批量读回属性值 | `{prop1: value1, prop2: value2}` |
| `CHECK_CHILDREN` | 验证子节点数量和类型 | `{count: int, types: string[]}` |

### L2 模板（`delivery.ts` 内联）

| 模板 | 用途 | 输出 |
|---|---|---|
| `SCENE_INTEGRITY` | 扫描节点引用、脚本附件、信号连接 | `{broken_refs: [], missing_scripts: [], broken_signals: []}` |
| `RESOURCE_CHECK` | 检查 preload/load 引用的文件是否存在 | `{missing_resources: []}` |
| `ASSERTION_WRAPPER` | 包装自定义断言代码 | `{result: value, passed: bool}` |

### 模板设计原则

- 每个模板是纯函数，接收参数返回 GDScript 字符串
- 输出统一走 `_mcp_output()` 协议
- 不引入外部依赖，纯 Godot 内置 API
- 每个模板 < 30 行 GDScript

### L2 断言包装示例

```gdscript
# ASSERTION_WRAPPER
func _initialize():
    _mcp_load_main_scene()
    var _result = {用户断言代码}
    _mcp_output("assert_result", str(_result))
```

## 范围外事项

- 不实现自动修复逻辑
- 不新增 Godot 项目内的 Autoload 插件
- 不合并 `test_assert` / `test_stress` 等已有工具
- 不实现 hook 机制（L1 通过工具内直接调用实现）
