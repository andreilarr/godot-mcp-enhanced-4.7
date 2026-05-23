# v0.14.0 质量加固 + IK 框架 MVP 设计

> 日期: 2026-05-23
> 版本: v0.14.0
> 前置: v0.13.0 (d0b3b88)
> 策略: 方案 B — 质量加固与 IK 新功能并行推进

---

## 1. 目标

v0.14.0 是质量与新能力并重的版本：

- **质量加固**: 核心模块测试补全、安全加固、大文件重构、CI 集成
- **IK MVP**: Godot 4.6 IK 框架工具集最小可用版本
- **交付标准**: 774 现有测试 + ~40 新测试全部通过，tsc 编译无错误

---

## 2. 质量加固

### 2.1 核心测试补全

优先给无测试的核心模块补单测，复用 `test/helpers/tool-context.js` mock 框架。

| 模块 | 关键测试点 | 预估用例 |
|------|-----------|---------|
| `scene.ts` | read_scene、add_node、edit_node、remove_node、quick_scene、batch_add_nodes | 8-10 |
| `script.ts` | read_script、write_script lint 输出、edit_script search_and_replace、project_replace | 6-8 |
| `validation.ts` | validate_project、validate_scripts、run_and_verify 参数校验 | 4-5 |
| `navigation.ts` | nav_create_region、nav_query_path、nav_create_agent 参数校验 | 4-5 |
| `tscn-parser.ts` | parent="." 多层嵌套、空场景、unique_id 丢弃验证、instance 解析 | 4-5 |

测试范围：参数校验 + GDScript 生成代码正确性，不依赖 Godot 运行时。

### 2.2 安全加固

| 项目 | 当前问题 | 修复方案 |
|------|---------|---------|
| `validateIdentifier` 长度 | 无上限，可传入超长字符串 | 加 `name.length <= 64` 限制 |
| `validateIdentifier` 覆盖 | 部分入口未校验 | grep 确认所有 `args.name`/`args.type` 入口 |
| `script.ts` 超时边界 | timeout 参数无限制 | 限制范围 [5, 120] 秒 |

### 2.3 代码重构

拆分大文件，原文件保留为 barrel re-export：

| 文件 | 当前行数 | 拆分方案 |
|------|---------|---------|
| `ui-tools.ts` | 1583 | `ui-controls.ts`（create/set/layout）+ `ui-theme.ts`（theme/draw）+ `ui-build.ts`（build_layout） |
| `scene.ts` | 1024 | `scene-read.ts`（read/query/inspect）+ `scene-write.ts`（add/edit/remove/save） |

拆分原则：
- 不破坏外部导入（barrel re-export）
- 不改变工具名称和参数接口
- 拆分后立即运行全量测试验证

### 2.4 CI 集成

GitHub Actions 工作流：

```yaml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
```

触发条件：push to master + 所有 PR。

---

## 3. IK 框架工具集 MVP

### 3.1 工具清单

| 工具名 | 功能 | GDScript 核心 |
|--------|------|--------------|
| `ik_modifier_create` | 创建 IK 修改器节点 | `NodeType.new()` + `parent.add_child()` |
| `ik_modifier_get` | 读取 IK 节点属性（bones、influence、chain 等） | 属性读取 + `_mcp_output` |
| `ik_modifier_set` | 设置 IK 参数 | 属性写入 |
| `ik_list_bones` | 列出 Skeleton3D 骨骼 | `skeleton.get_bone_count()` + `get_bone_name()` |

### 3.2 IK 节点类型白名单

可实例化的具体类型：
- `TwoBoneIK3D` — 关键属性: setting_count, influence, mutable_bone_axes
- `FABRIK3D` — 链式 IK
- `CCDIK3D` — 实时快速求解
- `SplineIK3D` — 样条曲线
- `JacobianIK3D` — 雅可比迭代

不可实例化（排除）：
- `SkeletonModifier3D` — 基类
- `IKModifier3D` — 抽象类

### 3.3 设计原则

- 复用 `node_create_3d` 模式（白名单 + `validateIdentifier`）
- IK 节点通常挂载到 Skeleton3D 下，parent 校验不强制（允许延迟挂载）
- headless 兼容性：5 种 IK 类型已在 Godot 4.6 兼容性报告中验证可实例化
- 运行时操作，不持久化（与其他 node_create_3d 系列一致）

### 3.4 ik_modifier_get 返回结构

```json
{
  "type": "TwoBoneIK3D",
  "active": true,
  "influence": 1.0,
  "setting_count": 1,
  "skeleton_path": "root/Player/Skeleton3D",
  "bones": {
    "0": { "name": "Hips", "editable": false }
  }
}
```

### 3.5 ik_modifier_set 可写属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `active` | bool | 是否启用 |
| `influence` | float 0-1 | 影响权重 |
| `setting_count` | int | TwoBoneIK3D 专用 |

属性通过 `properties` 参数传入，复用现有基本类型校验。

---

## 4. v0.15.0 方向（仅记录，不展开设计）

| 功能 | 优先级 | 说明 |
|------|--------|------|
| mesh_to_collision | P1 | 一键从 MeshInstance3D 生成 CollisionShape3D |
| unique_id 解析 | P2 | tscn parser 扩展 ParsedNode.unique_id 字段 |
| 端到端可靠性 | P1 | headless→editor 行为差异文档化、Game Bridge 自动化测试 |

---

## 5. 交付标准

- [ ] 现有 774 测试 + 新增 ~40 测试全部通过
- [ ] `tsc --noEmit` 零错误
- [ ] 4 个 IK 工具在 headless 模式下可创建/读取/设置 IK 节点
- [ ] `ui-tools.ts` 和 `scene.ts` 完成拆分，barrel re-export 无破坏
- [ ] GitHub Actions CI 绿色
- [ ] validateIdentifier 有长度限制 + 覆盖所有入口
- [ ] script.ts timeout 参数有边界校验

---

## 6. 工作顺序

1. 安全加固（validateIdentifier、timeout 边界）— 先建护栏
2. 核心测试补全（scene、script、validation、navigation、tscn-parser）
3. 代码重构（ui-tools.ts、scene.ts 拆分）
4. IK 工具集 MVP（创建、读取、设置、骨骼列表）
5. CI 集成（GitHub Actions）
6. 版本发布（更新 package.json、CHANGELOG）
