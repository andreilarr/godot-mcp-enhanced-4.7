# C# 脚本支持计划

> 状态：规划中 | 创建：2026-05-25 | 预计工期：分三阶段递进

## 背景

当前所有脚本工具（read/write/edit/validate/execute/generate_test）仅支持 GDScript (.gd)。
Godot 4.x 的 .NET 版本支持 C# (.cs) 脚本，大量用户使用 C# 开发。
需要扩展工具链以支持 C# 脚本的读写、编辑、验证和测试生成。

## 当前架构约束

| 工具 | .gd 支持 | .cs 现状 | 扩展难度 |
|------|---------|---------|---------|
| read_script | 元数据提取 (extends, class_name) | 不支持 | 低 |
| write_script | 写入 + GDScript lint | 不支持 | 低 |
| edit_script | 行编辑 + search/replace + 自动验证回滚 | 不支持 | 中 |
| validate_scripts | Godot headless 解析 | 不支持 | 中 |
| batch_validate | 批量 Godot headless 解析 | 不支持 | 中 |
| generate_test | GUT 测试框架生成 | 不支持 | 高 |
| execute_gdscript | Godot headless 执行 | 不适用 | N/A |
| project_replace | 默认扩展名 ['..gd'] | 不支持 | 低 |

## 阶段一：读写与编辑基础（优先级：高）

### 目标
C# 文件可以被读取、创建和编辑，基础操作体验与 GDScript 一致。

### 1.1 read_script 扩展

**改动文件**: `src/tools/script.ts`

- 检测文件扩展名：`.gd` 走现有逻辑，`.cs` 走 C# 解析
- C# 元数据提取：
  - `namespace` → namespace
  - `public partial class XXX : XXX` → class_name + extends
  - `using` 指令列表
  - 行数、文件大小
- 输出格式与 GDScript 保持一致的结构

```
// GDScript 输出：
{ extends: "CharacterBody2D", class_name: "Player", lines: 120 }

// C# 输出：
{ extends: "CharacterBody2D", class_name: "Player", namespace: "Game", usings: [...], lines: 180 }
```

**验证点**: 读取包含 partial class、泛型、嵌套类的 C# 文件能正确提取元数据。

### 1.2 write_script 扩展

**改动文件**: `src/tools/script.ts`

- `.cs` 文件跳过 GDScript lint
- 可选：添加基础 C# lint（缩进一致性、using 排序）
- 返回信息适配（"C# script written"）

**验证点**: 写入含 Unicode 内容的 C# 文件不乱码。

### 1.3 edit_script 扩展

**改动文件**: `src/tools/script.ts`

- `.cs` 文件支持 search_and_replace 和 line range 两种编辑模式
- 自动验证适配：
  - GDScript: 现有 Godot headless 验证
  - C#: 调用 `dotnet build --no-restore` 验证语法（需要 .csproj 存在）
- 若 `dotnet` 不可用或无 .csproj，跳过验证并给出提示（与现有 `.gd` 以外文件行为一致）

**验证点**:
- 编辑 C# 文件后语法错误能被检测并回滚
- 无 .csproj 时优雅降级

### 1.4 project_replace 扩展

**改动文件**: `src/tools/script.ts`

- `ALLOWED_EXTENSIONS` 添加 `.cs`
- 默认扩展名不变（保持 `['.gd']`），用户需显式传 `extensions: ['.cs']`

## 阶段二：验证与 Lint（优先级：中）

### 目标
C# 文件可以像 GDScript 一样被验证和 lint。

### 2.1 validate_scripts C# 支持

**改动文件**: `src/tools/script.ts`, 新增 `src/tools/csharp-validator.ts`

- 检测项目中是否存在 `.csproj` 文件
- 若存在，扫描 `.cs` 文件并加入验证队列
- 验证策略（按可用性降级）：
  1. **`dotnet build --no-restore`**（需 .csproj + dotnet CLI）— 最可靠
  2. **Godot editor 模式验证**（需编辑器连接）— 走 editor protocol
  3. **基础正则 lint**（零依赖兜底）— 检查括号匹配、缩进一致性
- 验证结果格式与 GDScript 验证保持一致

```
// 统一的验证结果格式
{
  valid: boolean,
  errors: [{ line: number, message: string, rule: string }],
  warnings: [{ line: number, message: string, rule: string }]
}
```

### 2.2 batch_validate C# 支持

**改动文件**: `src/tools/script.ts`

- 扩展默认扫描扩展名为 `['.gd', '.cs']`（仅当项目含 .csproj 时）
- 按扩展名分流到不同验证器
- 汇总结果时区分 GDScript 和 C# 错误

### 2.3 C# Lint 规则

**新增文件**: `src/tools/csharp-lint.ts`

基础 lint 规则（不需要 dotnet）：
- 括号/花括号匹配检查
- using 指令排序
- 行尾分号检查
- 空命名空间检测
- Godot 特有：`[Export]` 属性格式、`_Ready` 等虚函数大小写

## 阶段三：测试与高级功能（优先级：低）

### 目标
支持 C# 测试生成和更高级的工作流。

### 3.1 generate_test C# 支持

**改动文件**: `src/tools/script.ts`

- 检测 .cs 文件，提取 public 方法（正则匹配 `public ... MethodName(`）
- 生成 NUnit 测试代码（Godot 官方推荐的 C# 测试框架）
- 测试模板适配 Godot C# 模式：
  - `[TestFixture]` + `[Test]` 属性
  - 场景树加载方式（`GD.Load<PackedScene>`）
  - 使用 `GodotSharp` 断言或 NUnit Assert

```csharp
// 生成的测试示例
[TestFixture]
public partial class TestPlayer
{
    private Player _target;

    [SetUp]
    public void Setup()
    {
        _target = new Player();
    }

    [TearDown]
    public void Teardown()
    {
        _target?.QueueFree();
    }

    [Test]
    public void Test_Move()
    {
        var result = _target.Move();
        Assert.IsNotNull(result);
    }
}
```

### 3.2 execute_gdscript → execute_script 统一

**不执行 C# 代码片段**。原因：
- C# 需要编译 + .csproj + Godot .NET runtime
- Headless 模式无法直接执行 C# 代码片段
- 这个限制是架构层面的，不是 bug

但可以提供替代方案：
- 检测到 `.cs` 文件时返回明确的提示："C# 执行需要完整项目构建，请使用 `dotnet build` + Godot 运行"
- 新增 `build_project` 工具触发 `dotnet build`（需验证可行性）

## 技术决策

### 依赖检测

新增 `src/core/dotnet-detector.ts`：
- 检测 `dotnet` CLI 是否可用（`which dotnet` / `where dotnet`）
- 检测项目是否为 C# 项目（存在 `.csproj` 或 `.sln`）
- 缓存检测结果，避免重复探测
- 检测 Godot .NET 版本（`godot --version` 判断是否为 .NET 版本）

### 文件扩展名策略

```typescript
function getScriptType(filePath: string): 'gdscript' | 'csharp' | 'unknown' {
  if (filePath.endsWith('.gd')) return 'gdscript';
  if (filePath.endsWith('.cs')) return 'csharp';
  return 'unknown';
}
```

### 工具描述更新

所有相关工具的 description 需要更新：
- `"Read a GDScript (.gd) file"` → `"Read a script file (.gd or .cs)"`
- `"Write or overwrite a GDScript (.gd) file"` → `"Write or overwrite a script file (.gd or .cs)"`

### 不做的事

- **不支持 C# 代码片段执行**：架构限制，不是优先级问题
- **不支持 .vb / .fs**：Godot 官方仅支持 C#
- **不修改 execute_gdscript**：保持原样，C# 不走这条路径
- **不自动安装 .NET SDK**：用户需自行安装

## 测试策略

### 单元测试

- `csharp-lint.test.ts`：C# lint 规则测试
- `script-cs.test.ts`：read/write/edit 对 C# 文件的处理
- `csharp-validator.test.ts`：验证器降级逻辑
- `dotnet-detector.test.ts`：依赖检测逻辑

### 集成测试

- 在含 .csproj 的 Godot C# 项目中验证完整流程
- 验证 dotnet 不可用时工具的优雅降级

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| dotnet CLI 不在 PATH | 验证不可用 | 降级到基础正则 lint |
| .csproj 配置复杂 | build 验证失败 | 仅做语法级验证，不触发完整 build |
| C# 语法多变（ref struct、record 等） | 元数据提取不完整 | 渐进支持，先覆盖常见模式 |
| Windows + macOS 路径差异 | dotnet 检测失败 | 跨平台测试 |

## 文件变更预估

| 阶段 | 新增文件 | 修改文件 | 预估代码量 |
|------|---------|---------|-----------|
| 阶段一 | 0 | script.ts | ~200 行 |
| 阶段二 | csharp-validator.ts, csharp-lint.ts, dotnet-detector.ts | script.ts, validation.ts | ~500 行 |
| 阶段三 | 0 | script.ts | ~300 行 |
