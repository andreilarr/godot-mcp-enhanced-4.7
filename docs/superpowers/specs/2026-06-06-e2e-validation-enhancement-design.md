# E2E 验证 + DX 修复 + 功能增强设计

## 目标

基于 P1-P5 实施完成后的关键发现，按 **验证→DX→增强** 三阶段推进：
1. 用内置测试项目对 P1-P5 做真实 Godot 进程验证，暴露实际 gap
2. 修复开发体验问题（Scope Warning 误报、GateGuard 频繁阻断）
3. 补全功能增强（P1 类型扩展、P2 edit_node、P3 warmup 集成）

## 约束

- 不修改 GDScript 插件（`addons/` 下的代码不动）
- 不降低安全等级，只减少合法批量操作的摩擦
- 不添加新 MCP 工具，只扩展现有工具能力
- 验证测试 CI 友好：Godot 不在 PATH 时自动 skip

## 关键发现（P1-P5 实施总结）

1. **P4 SubViewport 不可行**：headless dummy renderer 返回 null textures，已改用 BLANK_DETECTED + hint
2. **P1 纯文件操作可用但有类型限制**：只支持 string/number/boolean/object，缺少 Rect2/Vector2/Color
3. **P2 scene_commit 已集成但未端到端验证**：GDScript 生成器和工具注册完成，未用真实 Godot 运行
4. **P3 import warmup 代码就绪但未集成**：需要接入首次 run_project/launch_editor 流程
5. **开发体验问题**：Scope Warning 27 文件误报、GateGuard Fact-Forcing Gate 每次阻断

---

## 第一阶段：E2E 验证

### 测试项目结构

```
test/e2e-scene/
├── project.godot              # 最小项目配置（rendering_mode=forward_plus）
├── scenes/
│   ├── test_2d.tscn           # 2D：TileMapLayer + ColorRect + Label
│   └── test_3d.tscn           # 3D：Node3D + MeshInstance3D(CubeMesh) + Camera3D
├── tilesets/
│   └── test_tiles.tres        # 简单 TileSet（2x2 纯色图块 atlas）
└── scripts/
    └── test_helper.gd         # 辅助脚本（属性验证等）
```

### 验证矩阵

| 优化 | 验证方式 | 预期结果 | 失败则 |
|------|---------|---------|--------|
| P1 addNode 3D | `add_node` 向 test_3d.tscn 添加 Node3D 子节点 + save_scene | .tscn 文件出现新节点 | 记录 gap，后续修复 |
| P1 addNode 2D | `add_node` 向 test_2d.tscn 添加 Sprite2D 子节点 + save_scene | .tscn 包含 type="Sprite2D" 新节点 | 同上 |
| P1 batch | `batch_add_nodes` 一次添加 5 个节点 | 全部写入 .tscn | 同上 |
| P1 resources | `read_scene` 读取 test_3d.tscn 资源引用 | 返回正确资源路径 | 同上 |
| P2 tile ops | `scene_commit` 批量 tile_set + tile_fill | COMMIT_RESULT: success=true | 同上 |
| P2 node prop | `scene_commit` node_property 操作（含类型推断） | 属性值正确修改 | 同上 |
| P3 import | 首次 executeGdscript 前自动触发 `--import` | .godot/imported/ 目录生成 | 同上 |
| P3 skip | 二次调用检测到已导入（时间戳未变） | 跳过预热，直接执行 | 同上 |
| P4 2D blank | `screenshot capture` 对 test_2d.tscn | BLANK_DETECTED + 4 行 hint | 验证 hint 完整性 |
| P4 3D ok | `screenshot capture` 对 test_3d.tscn | 正常 PNG 输出 | 记录 3D 截图 gap |
| P5 profiles | `validate_scripts` 验证 .gd 语法 | 全部通过 | 修语法 |

### 验证测试文件

文件：`test/e2e-p1-p5.test.ts`

```typescript
// 结构伪代码
describe('E2E: P1-P5 validation', { timeout: 60_000 }, () => {
  const projectPath = resolve(__dirname, 'e2e-scene');
  let godotPath: string | null = null;

  beforeAll(async () => {
    godotPath = await findGodot(); // 复用已有的 findGodot 逻辑
    if (!godotPath) return; // skip 所有测试
  });

  // P1 测试组
  it('P1-addNode-3D: writes Node3D to test_3d.tscn', async () => {
    // 1. 通过 tscn-editor addNode 向 test_3d.tscn 添加 Node3D 子节点
    // 2. save_scene 后验证 .tscn 文件包含新节点定义
  });

  it('P1-addNode-2D: writes Sprite2D to test_2d.tscn', async () => {
    // 1. 通过 tscn-editor addNode 向 test_2d.tscn 添加 Sprite2D 子节点
    // 2. save_scene 后验证 .tscn 包含 type="Sprite2D" 新节点
  });

  it('P1-batch: creates multiple nodes', async () => { /* batch_add_nodes 5 个节点 */ });
  it('P1-resources: reads resource references', async () => { /* read_scene 资源路径 */ });

  // P2 测试组
  it('P2-scene_commit: tile operations', async () => {
    // 1. 生成 tile_set + tile_fill 操作
    // 2. 通过 executeGdscript 执行
    // 3. 解析 COMMIT_RESULT: success=true
  });

  it('P2-scene_commit: node_property with type inference', async () => {
    // node_property 传入 { x: 10, y: 0, z: 5 }
    // 验证自动推断为 Vector3 并正确序列化
  });

  // P3 测试组
  it('P3-import: warmup generates .godot/imported/', async () => {
    // 首次 executeGdscript 前自动触发 --import
    // 验证 .godot/imported/ 目录存在
  });

  it('P3-skip: second call skips warmup', async () => {
    // 二次调用，时间戳未变
    // 验证不重新触发 --import
  });

  // P4 测试组
  it('P4-screenshot: 2D blank detection', async () => {
    // 截图 test_2d.tscn
    // 验证 godotOutput 包含 BLANK_DETECTED + 4 行 HINT
  });

  it('P4-screenshot: 3D success', async () => {
    // 截图 test_3d.tscn
    // 验证 PNG 文件存在且 > 0 bytes
  });

  // P5 测试组
  it('P5-validate: scripts pass', async () => { ... });
});
```

**CI 友好**：`findGodot()` 返回 null 时所有测试 skip，不 fail。

---

## 第二阶段：DX 修复

### DX-1：Scope Warning 子系统感知

**问题**：当前 scope check 只看修改文件总数（> N 就警告），不考虑修改是否集中在同一子系统。

**方案**：
- 计算修改文件的"子系统分布"——同一 tool 目录（`src/tools/`）、同一 test 目录（`test/`）、同一 GDScript 目录（`src/scripts/`）内的修改算一组
- 如果 >80% 的修改集中在 2 个子系统内，不触发 warning
- 触发阈值：修改分布在 5+ 个不同子目录且总计 > 15 个文件

**修改文件**：scope check hook 实现

### DX-2：GateGuard 批量任务豁免

**问题**：执行计划时每个 Write/Edit 都触发 Fact-Forcing Gate，即使是连续实施同一 task。

**方案**：
- 检测用户指令中的"执行计划"模式（`/superpowers:executing-plans`、`/superpowers:subagent-driven-development`、task 编号）
- 识别后，在同一 plan 执行周期内只要求一次事实
- 会话内维护 `{ planActive: true, planId: string, factsProvided: boolean }` 状态

**修改文件**：GateGuard hook 配置

### DX-3：会话任务上下文记忆

**问题**：连续修改时每次都需要重新说明上下文。

**方案**：
- 在会话内存中记录 `{ currentPlan, currentTask, filesModified }` 
- 后续 Write/Edit 自动关联到该上下文
- 任务完成后（task 标记 completed）清除

**不做的事**：
- 不修改 GateGuard 核心安全逻辑
- 不降低安全等级

---

## 第三阶段：功能增强

### 增强 1：P1 属性类型扩展

**当前**：`tscn-editor.ts` 的属性序列化只支持 string/number/boolean/object。

**扩展**：

| Godot 类型 | JS 输入格式 | 序列化为 |
|-----------|------------|---------|
| Rect2 | `{ x, y, w, h }` | `Rect2(x, y, w, h)` |
| Rect2i | `{ x, y, w, h }` + `_type: "Rect2i"` | `Rect2i(x, y, w, h)` |
| Vector2 | `{ x, y }` + `_type: "Vector2"` | `Vector2(x, y)` |
| Vector2i | `{ x, y }` + `_type: "Vector2i"` | `Vector2i(x, y)` |
| Vector3 | `{ x, y, z }` | `Vector3(x, y, z)` |
| Color | `{ r, g, b, a }` | `Color(r, g, b, a)` |
| Array | `[1, 2, 3]` | `[1, 2, 3]` |

**检测规则**：object 类型值检查键名模式自动推断类型。
- 有 `w, h` 且有 `x, y` → Rect2
- 有 `x, y, z` → Vector3
- 有 `x, y` 且无 `w, h` → **Vector2**（浮点数更通用；需要 Vector2i 时必须传 `_type: "Vector2i"`）
- 有 `r, g, b` → Color
- 显式 `_type` 字段优先

**Array 限制**：首版只支持通用变体数组（`Array`）。Godot 的强类型数组（PackedInt32Array、PackedFloat32Array、PackedVector2Array 等）不自动推断，需要 `_type` 显式指定。未指定 `_type` 的数组统一序列化为 `[1, 2, 3]`（Godot 通用 Array 字面量）。

**修改文件**：`src/tscn-editor.ts` 的属性序列化函数

### 增强 2：P2 scene_commit 的 node_property 支持类型推断

**当前**：scene_commit 的 `node_property` 操作直接传递原始值，不支持 Godot 类型（Vector2/Vector3/Rect2/Color）。

**改动**：扩展 `node_property` 的 GDScript 生成，使其支持增强 1 中的类型推断规则。当 value 是 object 且匹配 Vector2/Vector3/Rect2/Color 模式时，自动生成对应的 Godot 构造函数调用。

```typescript
// 操作定义（与现有 node_property 相同，value 支持类型推断）
{
  op: "node_property",
  path: "root/Player",
  property: "position",
  value: { x: 10, y: 0, z: 5 }  // 自动推断为 Vector3
}
```

**GDScript 生成（类型推断后）**：

```gdscript
var _n = get_node_or_null("root/Player")
if _n == null:
    _has_error = true
    _error_msg = "Node not found: root/Player"
elif "position" in _n:
    _n.set("position", Vector3(10, 0, 5))
    _cells_affected += 1
else:
    _has_error = true
    _error_msg = "Property not found: position on root/Player"
```

**设计决策**：不新增 `edit_node` 操作。`node_property` 已有完整的 path/property/value 参数，添加类型推断后能力等价于 `edit_node`。两个操作做同一件事违反 DRY。

**修改文件**：`src/tools/scene-commit.ts` 的 `generateCommitScript`

### 增强 3：P3 import warmup 集成

**当前**：P3 的 `--headless --import` 预热代码已写好但未接入启动流程。

**方案**：
- 在 `executeGdscript()` 首次调用某个 `projectPath` 时，先执行 `godot --headless --import --path <project>` 预热
- 使用时间戳缓存（`Map<projectPath, number>`），记录上次预热的 `getLatestMtime` 时间戳
- 每次执行前对比当前 `getLatestMtime` 与缓存值，仅当有新资源时重新预热
- 这确保会话内新增的 PNG/OGG 等资源也能被 Godot 导入系统感知
- 预热超时 15s，失败不阻塞（降级为正常启动）

**注意**：不使用布尔缓存（`Map<string, boolean>`），因为布尔缓存无法捕获会话内新增资源。

**修改文件**：`src/gdscript-executor.ts`

---

## 实施顺序

1. **阶段 1**（验证）：创建测试项目 + 验证测试 → 暴露 gap → 修复 gap
2. **阶段 2**（DX）：DX-1 → DX-2 → DX-3
3. **阶段 3**（增强）：增强 1 → 增强 2 → 增强 3

每个阶段独立提交，验证通过后才进入下一阶段。

## 成功标准

- [ ] P1-P5 全部通过 E2E 验证（真实 Godot 进程，含 P3 import warmup）
- [ ] Scope Warning 不再对计划内修改误报
- [ ] GateGuard 批量任务只要求一次事实
- [ ] addNode/edit_node 支持 Vector2/Vector3/Rect2/Color 类型（含类型推断）
- [ ] scene_commit 的 node_property 支持类型推断（非新增 edit_node）
- [ ] import warmup 使用时间戳缓存，可感知新增资源
- [ ] 全量测试不回归（当前 ~1976 tests）
