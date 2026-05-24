# v0.10.0 场景深度编辑 + 编辑器实时同步设计文档

> **版本**: v0.10.0 | **日期**: 2026-05-16 | **状态**: 审核修订完成

## 版本说明

当前 package.json 为 0.9.0，实际统计 118 个工具定义（26 个模块）。v0.10.0 聚焦两个方向：
- P1：场景实例化（补齐 Godot 核心场景复用工作流）
- P2：编辑器实时场景树同步（让 Editor 模式成为首选工作方式）

零新依赖，工具数 118 → ~124。

## 目标

- AI 代理能通过 MCP 在目标场景中实例化其他 .tscn 场景，设置实例属性，脱离实例链接
- 编辑器模式下场景树变更实时同步到 MCP 客户端，无需 headless 重新加载
- 所有新功能遵循现有 GDScript 代码生成 + headless 执行模式

---

## P1 — 场景实例化（3 工具 + 1 增强）

### 工具清单

| 工具 | 职责 | 实现方式 |
|------|------|---------|
| `instance_scene` | 在目标场景中实例化 .tscn 作为子节点，支持初始属性覆盖 | GDScript |
| `set_instance_property` | 修改已实例化节点的属性覆盖（不影响原始场景） | GDScript |
| `detach_instance` | 将实例节点脱离为独立节点（断开与原始场景的链接） | GDScript |
| `read_scene` 增强 | 检测实例节点，标记来源路径 | .tscn 解析 |

### instance_scene

**参数：**

```typescript
{
  project_path: string;      // Godot 项目目录
  scene_path: string;        // 目标场景（被插入的位置）
  instance_path: string;     // 要实例化的场景文件（res://scenes/player.tscn）
  parent_node_path?: string; // 父节点路径（默认 root）
  node_name?: string;        // 实例节点名称（默认用场景文件名）
  properties?: Record<string, unknown>; // 初始属性覆盖
}
```

**GDScript 核心逻辑：**

1. `load(instance_path)` 加载 PackedScene
2. `.instantiate()` 创建实例
3. 设置 node_name（如果提供）
4. 应用 properties 覆盖（过 `_is_safe_property` + `_is_safe_value` 安全校验）
5. `parent.add_child(instance, true)` 添加到场景树
6. `save_scene()` 持久化

**安全约束：**
- `instance_path` 和 `scene_path` 过 `_sanitize_res_path()` 路径净化
- properties 中的属性名过 `_is_safe_property()` 黑名单检查
- properties 中的值过 `_is_safe_value()` 类型白名单检查
- `instance_path` 必须以 `.tscn` 结尾且是有效的 PackedScene
- **循环引用保护（M2）**：GDScript 中维护 `_visited` 集合，`instance_path` 不能等于 `scene_path`（自引用），递归实例化深度上限 10 层

```gdscript
# 循环检测（嵌入 instance_scene 的 GDScript 中）
var _visited_instances: Dictionary = {}
func _check_circular(scene_a: String, scene_b: String, depth: int) -> bool:
    if scene_a == scene_b:
        return true  # 自引用
    if depth > 10:
        return true  # 超过深度限制
    return false
```

### set_instance_property

**参数：**

```typescript
{
  project_path: string;
  scene_path: string;
  node_path: string;   // 实例节点路径
  property: string;    // 属性名
  value: unknown;      // 属性值
}
```

**安全约束：**
- 复用 `_is_safe_property()` + `_is_safe_value()` 校验（与 `edit_node` 一致）

**实例节点校验（M1 差异化）：**

与 `edit_node` 不同，本工具在执行前验证目标节点确实是实例节点：

```gdscript
# GDScript 校验逻辑
var target = _mcp_get_scene_node(scene_path, node_path)
if target == null:
    _output_error("Node not found: " + node_path)
    return
# 检查是否为实例节点：通过检查 .tscn 文件中是否有 instance=ExtResource
var owner_scene = target.owner
if owner_scene:
    var inst_state = target.get_property_list().filter(func(p): return p.name == "scene_file_path")
    # 实例节点的 owner 是根节点，且非根节点自身
var is_instance = (target.owner != null and target != target.owner and target.owner == root)
if not is_instance:
    _output_error("NODE_NOT_INSTANCE: node is not an instanced scene")
    return
```

如果目标不是实例节点，返回 `NODE_NOT_INSTANCE` 错误。这提供了与 `edit_node` 的真正差异化。

### detach_instance

**参数：**

```typescript
{
  project_path: string;
  scene_path: string;
  node_path: string;  // 要脱离的实例节点
}
```

**实现方式：.tscn 文本编辑（而非运行时拆解-重建）**

运行时方案需要处理子节点 script 引用、资源引用、信号连接、Group、嵌套实例等复杂情况，极易出错。改为直接编辑 .tscn 文本文件，这是 Godot 编辑器"Make Local"操作的等价实现。

**算法（TS 侧）：**

1. 读取目标 .tscn 文件内容
2. 解析 `[ext_resource]` 表，建立 `id → path` 映射
3. 在节点定义中找到 `instance=ExtResource(N)` 匹配目标 node_path 的 `[node]` 段
4. 读取源场景 .tscn（instance_path 从 ext_resource 表获取）
5. 从源场景提取完整子树节点定义
6. 重映射源场景中的 ext_resource ID 到目标场景（避免 ID 冲突）
7. 将目标 .tscn 中的单行实例引用替换为展开的子树定义
8. 保留目标 .tscn 中已有的属性覆盖行（`property = value`）
9. 写回 .tscn 文件

**关键处理：**

- **嵌套实例**：源场景中可能也有 `instance=ExtResource(...)` 的节点——这些应保持为实例引用，只展开目标层级的实例
- **ext_resource ID 重映射**：源场景的 ext_resource 条目需要合并到目标场景，ID 重新编号
- **属性覆盖合并**：目标 .tscn 中实例节点后面可能有覆盖行（如 `position = Vector2(100, 200)`），这些要保留
- **子资源引用**：源场景中的 `[sub_resource]` 也需要合并到目标场景

**安全约束：**
- node_path 必须指向实际存在的实例节点（检查 .tscn 中有 `instance=ExtResource(N)`)
- 源场景文件必须存在且可解析
- 写入前备份目标文件内容（失败时回滚）

**不适用运行时方案的原因（H1/H5 总结）：**
- 运行时需要手动复制 script/资源/信号/Group/嵌套实例，遗漏任一项即出错
- BLOCKED_PROPERTIES 处理复杂（owner/name 由树管理需跳过，script 需保留）
- .tscn 文本编辑由 Godot 的序列化格式保证正确性，与编辑器"Make Local"一致

### read_scene 增强

在 `tscn-parser.ts` 中增强节点解析：

- 检测 .tscn 中的 `instance=ExtResource(N)` 行
- 解析对应的 `[ext_resource path="res://xxx.tscn" type="PackedScene"]`
- 在返回的节点数据中添加 `instance_of: "res://scenes/player.tscn"` 字段

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/tools/scene.ts` | 新增 3 个工具的 GDScript 生成 + 工具定义 + handleTool 分支 |
| `src/tscn-parser.ts` | 增强：检测 instance 节点，解析来源路径 |
| `addons/mcp_bridge/commands/scene_commands.gd` | 新增 3 个编辑器命令（同参数格式） |
| `src/GodotServer.ts` | 无变更（scene.ts 已注册） |

### 错误码

```typescript
const INSTANCE_ERROR_CODES = {
  INVALID_INSTANCE_PATH: 'INVALID_INSTANCE_PATH',
  NOT_A_PACKED_SCENE: 'NOT_A_PACKED_SCENE',
  NODE_NOT_INSTANCE: 'NODE_NOT_INSTANCE',
  INSTANCE_LOAD_FAILED: 'INSTANCE_LOAD_FAILED',
};
```

---

## P2 — 编辑器实时场景树同步（3 工具）

### 架构变更

当前 EditorConnection 是纯请求-响应模式。实时同步需要增加**服务端推送通道**：Godot 编辑器插件主动发通知给 TS 侧。

### 新增工具

| 工具 | 职责 | 可用模式 |
|------|------|---------|
| `editor_sync_start` | 启动场景树监听，插件连接 SceneTree 信号 | 仅 editor |
| `editor_sync_stop` | 停止监听，断开信号连接 | 仅 editor |
| `editor_get_scene_tree` | 获取编辑器当前场景树完整快照 | 仅 editor |

### 推送事件格式

插件检测到场景树变化后，通过 WebSocket 发送通知（单向推送，非请求-响应）：

```json
{
  "jsonrpc": "2.0",
  "method": "scene_tree_changed",
  "params": {
    "type": "node_added | node_removed",
    "path": "root/Level/Player",
    "node_type": "CharacterBody3D"
  }
}
```

首版仅支持 `node_added` 和 `node_removed` 两种事件。`node_renamed`、`property_changed`、`node_moved` 留后续版本——rename 检测需要逐节点信号连接，大场景下有性能问题（>500 节点时连接数过多）。客户端可通过定期调用 `editor_get_scene_tree` 快照 diff 来检测 rename。

### EditorConnection 变更

当前只有 `request()` 方法。新增：

```typescript
// 通知监听器注册
onNotification(method: string, handler: (params: unknown) => void): void;
offNotification(method: string, handler?: (params: unknown) => void): void;

// 内部：WebSocket onmessage 中区分响应和通知
// 响应有 id 字段 → resolve pending request
// 通知无 id 字段，有 method 字段 → dispatch to handlers
```

### EditorToolExecutor 变更

```typescript
// sync 工具路由
if (toolName === 'editor_sync_start') {
  this.conn.onNotification('scene_tree_changed', this.handleTreeChange);
  return this.conn.request('editor_sync_start', {});
}
if (toolName === 'editor_sync_stop') {
  this.conn.offNotification('scene_tree_changed', this.handleTreeChange);
  return this.conn.request('editor_sync_stop', {});
}
```

**WebSocket 断连清理（M3）：**

EditorConnection 在 `ws.on('close')` 中触发清理：

```typescript
// EditorConnection 构造函数中
this.ws.on('close', () => {
  // 清理所有 pending requests（已有逻辑）
  // 新增：清理所有 notification handlers
  this.notificationHandlers.clear();
  // 新增：通知 executor sync 已断开
  this.onDisconnect?.();
});

// EditorToolExecutor 注册 disconnect callback
this.conn.onDisconnect = () => {
  this.syncActive = false;
};
```

### 插件侧：sync_commands.gd

使用 SceneTree 级信号（`node_added`/`node_removed`），**不使用逐节点信号**（避免大场景性能问题和内存泄漏）。

通过路径缓存字典解决 `node_removed` 时 `get_path()` 可能失败的问题（H3）：

```gdscript
extends Node

var _command_handler: Node
var _syncing: bool = false
var _node_paths: Dictionary = {}  # { instance_id (int): path (String) }

func _register_commands() -> void:
    _command_handler.register_command("editor_sync_start", _start_sync)
    _command_handler.register_command("editor_sync_stop", _stop_sync)
    _command_handler.register_command("editor_get_scene_tree", _get_scene_tree)

func _start_sync(params: Dictionary, request_id: int) -> Dictionary:
    if _syncing:
        return {"success": false, "error": "Sync already active"}
    _syncing = true
    _node_paths.clear()
    # 递归遍历已有节点，缓存路径
    _cache_paths_recursive(get_tree().root)
    get_tree().connect("node_added", _on_node_added)
    get_tree().connect("node_removed", _on_node_removed)
    return {"success": true}

func _stop_sync(params: Dictionary, request_id: int) -> Dictionary:
    if not _syncing:
        return {"success": false, "error": "Sync not active"}
    _syncing = false
    get_tree().disconnect("node_added", _on_node_added)
    get_tree().disconnect("node_removed", _on_node_removed)
    _node_paths.clear()
    return {"success": true}

func _cache_paths_recursive(node: Node) -> void:
    if node:
        _node_paths[node.get_instance_id()] = str(node.get_path())
        for child in node.get_children():
            _cache_paths_recursive(child)

func _on_node_added(node: Node) -> void:
    var path = str(node.get_path())
    _node_paths[node.get_instance_id()] = path
    _command_handler.send_notification("scene_tree_changed", {
        "type": "node_added",
        "path": path,
        "node_type": node.get_class()
    })

func _on_node_removed(node: Node) -> void:
    # 从缓存取路径（node_removed 时 get_path() 可能失效）
    var id = node.get_instance_id()
    var path = _node_paths.get(id, "<removed>")
    _node_paths.erase(id)
    _command_handler.send_notification("scene_tree_changed", {
        "type": "node_removed",
        "path": path,
        "node_type": node.get_class()
    })

func _get_scene_tree(params: Dictionary, request_id: int) -> Dictionary:
    var root = get_tree().current_scene
    if not root:
        return {"success": false, "error": "No current scene"}
    return {"success": true, "tree": _serialize_tree(root, 0, 5)}

func _serialize_tree(node: Node, depth: int, max_depth: int) -> Dictionary:
    var result = {
        "name": str(node.name),
        "type": node.get_class(),
        "path": str(node.get_path())
    }
    if depth < max_depth:
        var children = []
        for child in node.get_children():
            children.append(_serialize_tree(child, depth + 1, max_depth))
        result["children"] = children
    return result
```

**设计要点：**
- `_node_paths` 字典缓存所有节点的路径，以 `instance_id` 为 key
- `node_removed` 时从缓存取路径，避免 `get_path()` 失败（H3）
- `_stop_sync` 只需断开 2 个 SceneTree 级信号 + 清空字典，无需逐节点清理（H2）
- `_cache_paths_recursive` 递归遍历替代 `get_nodes_in_group("")`（C1）
- 无逐节点信号连接，大场景无性能问题（M4）

`command_handler.gd` 需新增 `send_notification()` 方法：向 WebSocket 客户端发送非请求-响应通知。

### 降级策略

- 编辑器未连接 → 返回 `EDITOR_NOT_CONNECTED`，提示用 headless 的 `query_scene_tree` 替代
- WebSocket 断连 → 自动停止 sync，清理监听器
- headless 模式下这些工具返回错误（运行时拒绝，不静默失败）
- `LITE_TOOLS` 不包含这 3 个工具

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/core/EditorConnection.ts` | 新增 `onNotification`/`offNotification` + 区分通知/响应 |
| `src/core/EditorToolExecutor.ts` | sync 工具路由 + 通知处理 |
| `src/tools/editor-sync.ts`（新建） | 3 个工具定义 + headless 降级逻辑 |
| `addons/mcp_bridge/commands/sync_commands.gd`（新建） | SceneTree 信号监听 + 推送 + 快照 |
| `addons/mcp_bridge/command_handler.gd` | 新增 `send_notification()` 方法 |
| `src/GodotServer.ts` | 注册 editor-sync 模块 |

### 错误码

```typescript
const SYNC_ERROR_CODES = {
  EDITOR_NOT_CONNECTED: 'EDITOR_NOT_CONNECTED',
  SYNC_ALREADY_ACTIVE: 'SYNC_ALREADY_ACTIVE',
  SYNC_NOT_ACTIVE: 'SYNC_NOT_ACTIVE',
};
```

---

## 不做的事

- 场景继承（inheritance）— 复杂度高，留 v0.11.0
- 通用资源管理（.tres）— 现有 material-ops/theme 已覆盖主要场景
- 属性编辑器（editor 层面）— 用户已有 `edit_node`/`set_instance_property`
- 节点拖拽重排序 — 收益低
- UndoRedo 增强 — 现有 scene_commands.gd 已有基础 undo
- `property_changed` 事件检测 — 首版只做 node_added/removed/renamed 三种

---

## 新增文件汇总

```
src/tools/editor-sync.ts          — P2 编辑器同步工具（~200 行）
addons/mcp_bridge/commands/sync_commands.gd       — P2 场景树信号监听（~150 行）
test/instance-scene.test.js       — P1 实例化测试（~300 行）
test/editor-sync.test.js          — P2 同步测试（~200 行）
```

## 修改文件汇总

```
src/tools/scene.ts                — P1 新增 3 工具
src/tscn-parser.ts                — P1 instance 检测
addons/mcp_bridge/commands/scene_commands.gd      — P1 新增 3 命令
src/core/EditorConnection.ts      — P2 通知通道
src/core/EditorToolExecutor.ts    — P2 sync 路由
addons/mcp_bridge/command_handler.gd     — P2 send_notification
src/GodotServer.ts                — P2 注册 editor-sync
package.json                      — version: 0.10.0
```

## 零新依赖

所有功能通过 GDScript 代码生成 + WebSocket 通知实现，不引入新 npm 包。

## 测试策略

| 阶段 | 新增用例 | 重点 |
|------|---------|------|
| P1 | ~25 | 实例化创建/属性覆盖/脱离、路径安全、属性白名单 |
| P2 | ~15 | 同步启停、通知格式、降级、EditorConnection 通知解析 |
| 总计 | ~40 | |

## 工具数变化

118 → 124（+3 实例化 +3 编辑器同步，read_scene 增强不算新工具）
