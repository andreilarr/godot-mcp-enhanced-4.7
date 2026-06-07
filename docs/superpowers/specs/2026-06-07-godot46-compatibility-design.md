# Godot 4.6+ 片段模式兼容性修复设计

> 日期：2026-06-07
> 状态：已批准
> 范围：全面兼容性 + 运行时提示

## 背景

Godot 4.6+ 中 `extends SceneTree` 的脚本行为变更：

1. `get_tree()` 不可用 — SceneTree 自身就是树，`get_tree()` 是 `Node` 的方法
2. `var root` 与 `SceneTree.root` 冲突 — GDScript 不允许重定义父类属性
3. `quit()` 可直接调用 — SceneTree 自身有 `quit()` 方法

E2E 实测中，`execute_gdscript` 片段模式（默认 `extends SceneTree`）在 Godot 4.6.2/4.6.3 上触发上述错误。

## 方案选择

| 方案 | 思路 | 结论 |
|------|------|------|
| A. 最小兼容层 | 修改 MCP 辅助函数用 `self.root`，运行时提示 | ✅ 采用 |
| B. 自动转换层 | 文本替换用户代码中的 `get_tree()` | ❌ 无 AST 不可靠 |
| C. 版本检测 + 双模式 | 运行时检测版本选择模板 | ❌ `self.root` 全版本可用 |

方案 A 的核心优势：`self.root` 在 Godot 4.4+ 均可用，不需要版本分支。

## 改动清单

### 1. GD_MCP_GET_ROOT 模板简化

**文件**：`src/tools/shared/gdscript-templates.ts` 第 15-27 行

```gdscript
# 修改前（12 行）
func _mcp_get_root() -> Node:
    if _mcp_root != null:
        return _mcp_root
    if root != null:
        _mcp_root = root
        return _mcp_root
    var ml: Variant = Engine.get_main_loop()
    if ml != null and ml is SceneTree and ml.root != null:
        _mcp_root = ml.root
        return _mcp_root
    return null

# 修改后（7 行）
func _mcp_get_root() -> Node:
    if _mcp_root != null:
        return _mcp_root
    # Godot 4.6+: self.root is required (extends SceneTree — root is native property)
    if self.root != null:
        _mcp_root = self.root
        return _mcp_root
    return null
```

**理由**：
- `self.root` 消除与 `SceneTree.root` 的歧义
- 去掉 `Engine.get_main_loop()` 中间层：在 `extends SceneTree` 中 `self` 就是主循环，如果 `self.root` 为 null 说明场景树未初始化，此时 `Engine.get_main_loop()` 也无有效引用

### 2. SCENE_TREE_HEADER 注释强化

**文件**：`src/tools/shared/gdscript-templates.ts` 第 84 行

`var _mcp_root` 上方添加注释说明命名约束（避免与 `SceneTree.root` 冲突）。

其余部分无需修改：
- `_mcp_load_scene` 通过 `_mcp_get_root()` 间接访问，改动已在第 1 项覆盖
- `_mcp_done` 中 `Engine.get_main_loop() == self` 是身份判断，`quit(0)` 是 SceneTree 自身方法，均正确
- 变量声明带 `_mcp_` 前缀，天然不与 SceneTree 属性冲突

### 3. wrapSnippet() 注释强化

**文件**：`src/gdscript-executor.ts` 第 359 行

`var _mcp_root: Node = null` 上方添加注释说明命名约束。

### 4. 运行时兼容性提示

**文件**：`src/error-analyzer.ts`

在错误分析流程中增加两条关键词组合匹配：

| 检测目标 | 匹配模式 | 提示内容 |
|----------|----------|----------|
| `get_tree()` 不可用 | 同时包含 `get_tree` 和 `not found` | "在 extends SceneTree 脚本中，请使用 self.root 代替 get_tree().root，使用 quit() 代替 get_tree().quit()" |
| `var root` 冲突 | 同时包含 `root` 和 `redefined` | "变量名 'root' 与 SceneTree.root 冲突，请改用其他名称如 scene_root 或 _root" |

匹配使用关键词组合（非完整字符串），应对 Godot 小版本措辞差异。

实现方式：`analyzeOutput()` 返回结果增加 `compatibilityHint` 字段，调用方拼接到最终错误消息。

原则：
- 只检测已发生的错误并给出建议
- 不做文本替换
- 不侵入成功执行路径
- 不依赖 Godot 版本号

### 5. 测试覆盖

**文件**：`test/gdscript-executor.test.js`

| 测试用例 | 验证内容 |
|----------|----------|
| `wrapSnippet 不使用裸 root` | `_mcp_get_root` 函数体包含 `self.root` 而非裸 `root` |
| `wrapSnippet 不包含 Engine.get_main_loop` | `_mcp_get_root` 中已去掉中间变量 |
| `SCENE_TREE_HEADER 使用 self.root` | 头部模板中 `_mcp_get_root` 使用 `self.root` |
| `wrapSnippetAsNode 使用 get_tree().quit()` | autoload 模式下 `get_tree().quit()` 仍存在（Node 上下文正确） |
| `错误提示匹配 get_tree 兼容性` | 模拟含 `get_tree` + `not found` 的错误输出 |
| `错误提示匹配 root 冲突` | 模拟含 `root` + `redefined` 的错误输出 |

## 不改动的部分

| 文件/函数 | 原因 |
|-----------|------|
| `wrapSnippetAsNode()` | `extends Node` 上下文中 `get_tree()` 正确 |
| `injectHelpers()` | `quit(0)` + `Engine.get_main_loop() == self` 守卫正确 |
| `classifyLines()` | 与兼容性无关 |

## 影响范围

- 净增约 70 行，全部在 MCP 自身代码
- 零破坏性：`self.root` 向后兼容 Godot 4.4/4.5
- 不改变用户代码路径，仅修改 MCP 辅助函数模板
