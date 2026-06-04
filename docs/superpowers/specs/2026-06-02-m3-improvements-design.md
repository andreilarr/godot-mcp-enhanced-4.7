# M3 评估改进设计

> 日期: 2026-06-02
> 来源: M3 评估报告 feedback_godot_mcp_evaluation_m3.md
> 状态: 设计阶段

## 概述

M3 评估（88 提交 / 4000+ 行）发现 6 条改进建议，本文档定义每条的详细设计。

涉及文件：
- `src/screenshot.ts` — 截图捕获模块
- `src/scripts/screenshot_capture.gd` — GDScript 截图脚本
- `src/tools/script.ts` — edit_script 工具（路径解析 + smart indent）
- `src/tools/validation.ts` — 验证工具（.tres 检查 + 级联删除信息）
- `.claude/rules/` — 规则文件（2D 验证标准化）

---

## #1 截图降级提示（双层检测）

### 问题
Headless 模式下 2D 项目截图完全空白（ColorRect/TextureRect/_draw() 不渲染），但工具返回"成功"。

### 设计

#### GDScript 侧（screenshot_capture.gd）
在 `_on_process_frame()` 成功保存 PNG 后，添加空白检测：

```gdscript
func _detect_blank_image(img: Image) -> bool:
    var w := img.get_width()
    var h := img.get_height()
    if w == 0 or h == 0:
        return true

    var sample_count := 0
    var uniform_count := 0
    var first_color: Color = img.get_pixel(0, 0)

    var step := maxi(1, (w * h) / 100)  # 采样约 100 个像素
    for i in range(0, w * h, step):
        var x := i % w
        var y := i / w
        var c := img.get_pixel(x, y)
        sample_count += 1
        if abs(c.r - first_color.r) < 0.01 and abs(c.g - first_color.g) < 0.01 and abs(c.b - first_color.b) < 0.01 and abs(c.a - first_color.a) < 0.01:
            uniform_count += 1

    return sample_count > 0 and float(uniform_count) / float(sample_count) > 0.95
```

如果检测到空白，在输出中打印：
```
[SCREENSHOT] WARNING: BLANK_DETECTED - captured image appears to be uniform (possible 2D rendering limitation)
```

#### TS 侧（screenshot.ts）
在 `captureScreenshot()` 返回 `success: true` 后：
1. 检查 `godotOutput` 是否包含 `BLANK_DETECTED`
2. 检查文件大小是否 < 5KB（小文件疑似空白）
3. 如果任一条件成立，在返回文本中附加降级警告：

```
⚠ Screenshot may be blank (2D rendering limitation in headless mode).
For 2D projects, consider using screenshot(action=analyze) with a user-provided screenshot instead.
```

### 影响范围
- `src/scripts/screenshot_capture.gd` — 添加 `_detect_blank_image()` 函数
- `src/screenshot.ts` — 检查输出并附加警告

### 测试
- 单元测试：空白图片检测（全白、全透明、渐变图）
- 集成测试：截图返回包含 BLANK_DETECTED 时的警告格式

---

## #2 edit_script 统一路径解析

### 问题
`script_path` 参数接受 `res://xxx`、相对路径、绝对路径，但当前 `resolveWithinRoot` 只处理相对路径。`res://` 开头的路径会报文件不存在。

### 设计

在 `edit_script` handler 的路径解析处（当前 `const fullPath = resolveWithinRoot(projectPath, scriptPath)` 之前），添加预处理函数：

```typescript
function normalizeScriptPath(scriptPath: string, projectPath: string): string {
  // res:// 前缀：去掉 res:// 后交给 resolveWithinRoot
  if (scriptPath.startsWith('res://')) {
    return resolveWithinRoot(projectPath, scriptPath.slice(6));
  }
  // 绝对路径：检查是否在项目根目录内
  if (isAbsolute(scriptPath)) {
    const normalized = resolve(scriptPath);
    if (!normalized.startsWith(resolve(projectPath))) {
      throw new Error(`Script path is outside project root: ${scriptPath}`);
    }
    return normalized;
  }
  // 相对路径：保持现有逻辑
  return resolveWithinRoot(projectPath, scriptPath);
}
```

同时扩展 `read_script` 和 `write_script` 使用相同函数，确保三个操作的路径解析一致。

`normalizeScriptPath` 提取到 `src/helpers.ts` 或 `src/tools/shared.ts`。

### 影响范围
- `src/tools/script.ts` — 修改 `read_script`、`write_script`、`edit_script` 三个 case 的路径解析
- `src/tools/shared.ts` — 新增 `normalizeScriptPath()` 工具函数

### 测试
- 单元测试：三种路径格式的解析结果
- 边界情况：`res://` 无效路径、绝对路径在项目外

---

## #3 级联删除检测（丰富错误信息）

### 问题
`validateAndRevert` 回滚时只报 `⚠️ Edit REVERTED due to GDScript parse error`，不显示具体的未声明标识符和引用位置。

### 设计

Godot 的验证错误输出格式为：
```
<path>:<line> - Parse Error: <message>
```

在 `validateAndRevert` 中解析 Godot 错误输出，提取结构化信息：

```typescript
interface ParseErrorDetail {
  line: number;
  message: string;
  type: 'parse_error' | 'script_error';
  identifier?: string;  // 从消息中提取的标识符名称
}

function parseGodotErrors(rawErrors: string[]): ParseErrorDetail[] {
  const details: ParseErrorDetail[] = [];
  for (const err of rawErrors) {
    const match = err.match(/:(\d+)\s*-\s*(Parse Error|Script Error):\s*(.*)/);
    if (match) {
      const detail: ParseErrorDetail = {
        line: parseInt(match[1]),
        message: match[3],
        type: match[2] === 'Parse Error' ? 'parse_error' : 'script_error',
      };
      // 提取标识符
      const identMatch = match[3].match(/identifier "([^"]+)"/i)
        || match[3].match(/"(\w+)" not declared/i)
        || match[3].match(/Unexpected identifier:\s*"(\w+)"/i);
      if (identMatch) {
        detail.identifier = identMatch[1];
      }
      details.push(detail);
    }
  }
  return details;
}
```

修改回滚消息格式：
```
⚠️ Edit REVERTED due to GDScript parse error:
  Line 15: identifier "MAX_SPEED" not declared in current scope
  Line 23: Unexpected identifier: "calc_damage"

Original file restored. Please fix the edit content and retry.
```

### 影响范围
- `src/tools/script.ts` — 修改 `validateAndRevert` 函数，添加 `parseGodotErrors` 和格式化逻辑

### 测试
- 单元测试：解析 Godot 错误输出格式
- 单元测试：标识符提取（identifier "xxx" / "xxx" not declared / Unexpected identifier）

---

## #4 .tres 资源文件检查扩展

### 问题
当前 `validateSceneFile` 只检查基本结构（header、重复 ID），不检查引用的资源文件是否实际存在。

### 设计

扩展 `validateSceneFile`，对 `.tres` 文件添加额外检查：

1. **引用资源存在性检查**：
   ```typescript
   // 检查 ext_resource path="res://xxx" 的文件是否存在
   const extResourceRegex = /\[ext_resource[^]]*path="([^"]+)"/g;
   while ((match = extResourceRegex.exec(content)) !== null) {
     const resPath = match[1];
     const absPath = resolve(projectPath, resPath.replace('res://', ''));
     if (!existsSync(absPath)) {
       warnings.push(`Referenced resource not found: ${resPath} in ${relPath}`);
     }
   }
   ```

2. **Shader 引用检查**：
   ```typescript
   // 检查 shader = "res://xxx" 是否存在
   const shaderRegex = /shader\s*=\s*"([^"]+\.gdshader)"/g;
   ```

3. **Texture 引用检查**：
   ```typescript
   // 检查 texture = ExtResource("xxx") 是否在上方定义
   ```

注意：资源存在性检查需要 `projectPath` 参数，当前 `validateSceneFile` 已接收但未使用。改动保持向后兼容——如果 `projectPath` 为空则跳过存在性检查。

### 影响范围
- `src/tools/validation.ts` — 扩展 `validateSceneFile` 函数

### 测试
- 单元测试：引用存在/不存在的资源文件
- 单元测试：Shader 引用检查

---

## #5 2D 视觉验证标准化（规则文档）

### 问题
Headless 模式下 2D 截图是已知限制，但没有标准化的替代工作流。

### 设计

在 `.claude/rules/godot-mcp-core.md` 中添加 2D 截图说明段落：

```markdown
## 2D 项目截图限制

Headless 模式下 2D 场景（CanvasItem 子类）的截图可能完全空白。
这是 Godot headless 渲染器的已知限制。

**推荐工作流**：
1. 用 `screenshot(action=capture)` 尝试截图
2. 如果返回 BLANK_DETECTED 警告，使用以下替代方案：
   - 用户手动截图（F5 运行后截图）
   - `screenshot(action=analyze)` 分析用户提供的截图
   - Bridge `take_screenshot`（如果游戏正在运行）
3. 3D 场景不受此限制影响
```

### 影响范围
- `.claude/rules/godot-mcp-core.md` — 添加 2D 截图限制段落
- `.claude/rules/godot-mcp-ui.md` — 可选：添加 UI 验证替代方案

### 测试
- 无代码测试，文档变更通过人工审阅

---

## #6 smart indent 自动检测缩进风格

### 问题
当前 smart indent 只支持 tab 缩进检测（`/^(\t*)/`），用空格缩进的文件会得到错误的 indentDelta。

### 设计

在 smart indent 逻辑中，先检测文件的实际缩进风格：

```typescript
function detectIndentStyle(lines: string[]): { type: 'tab' | 'space'; size: number } {
  let tabCount = 0;
  let spaceCount = 0;
  let spaceSizes: number[] = [];

  const sampleLines = lines.slice(0, 100);  // 只扫描前 100 行
  for (const line of sampleLines) {
    if (line.trim().length === 0) continue;
    const leadingMatch = line.match(/^(\s+)/);
    if (!leadingMatch) continue;

    const leading = leadingMatch[1];
    if (leading.includes('\t')) {
      tabCount++;
    } else if (leading.includes(' ')) {
      spaceCount++;
      // 检测空格缩进大小（2/4/8）
      spaceSizes.push(leading.length);
    }
  }

  if (tabCount > spaceCount) {
    return { type: 'tab', size: 1 };
  }
  // 计算最常见的空格缩进大小
  const sizeCounts = new Map<number, number>();
  for (const s of spaceSizes) {
    sizeCounts.set(s, (sizeCounts.get(s) || 0) + 1);
  }
  const commonSize = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 4;
  // 推断单个缩进级别（GCD of observed sizes）
  const indentSize = commonSize <= 2 ? 2 : (commonSize <= 4 ? 4 : 8);

  return { type: 'space', size: indentSize };
}
```

修改 smart indent 逻辑，根据检测结果使用 tab 或空格：

```typescript
if (indentMode === 'smart') {
  const indentStyle = detectIndentStyle(lines);

  if (indentStyle.type === 'tab') {
    // 保持现有 tab 逻辑
    // ... (不变)
  } else {
    // 空格缩进逻辑
    const originalLine = lines[startLine - 1] || '';
    const originalBaseIndent = (originalLine.match(/^( *)/) || ['',''])[1].length;

    const newNonEmptyLines = newLines.filter(l => l.trim() !== '');
    let newMinIndent = Infinity;
    for (const nl of newNonEmptyLines) {
      const spaces = (nl.match(/^( *)/) || ['',''])[1].length;
      if (spaces < newMinIndent) newMinIndent = spaces;
    }
    if (newMinIndent === Infinity) newMinIndent = 0;

    const indentDelta = originalBaseIndent - newMinIndent;
    adjustedLines = newLines.map(line => {
      if (line.trim() === '') return line;
      const currentSpaces = (line.match(/^( *)/) || ['',''])[1].length;
      if (indentDelta > 0) {
        return ' '.repeat(indentDelta) + line;
      } else if (indentDelta < 0) {
        const toRemove = Math.min(-indentDelta, currentSpaces);
        return line.substring(toRemove);
      }
      return line;
    });
  }
}
```

### 影响范围
- `src/tools/script.ts` — 添加 `detectIndentStyle()` 函数，修改 smart indent 分支

### 测试
- 单元测试：tab 缩进检测（现有行为不变）
- 单元测试：空格缩进检测（2空格 / 4空格）
- 单元测试：混合缩进文件的 fallback 行为

---

## 实施顺序

按风险从低到高：

1. **#5 2D 规则文档** — 纯文档，零风险
2. **#2 路径解析统一** — 纯 TS，影响 3 个 case
3. **#6 smart indent 修复** — 纯 TS，影响 edit_script
4. **#3 级联删除信息** — 纯 TS，影响 validateAndRevert
5. **#4 .tres 检查扩展** — 纯 TS，影响 validateSceneFile
6. **#1 截图降级提示** — 跨 TS+GDScript，最大改动

预估总工作量：~300 行新增代码 + ~80 行修改。
