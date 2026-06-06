# DEFAULT_SKIP_DIRS 修复设计 — addons/tools 默认扫描

**日期**: 2026-06-06
**状态**: 待审批
**优先级**: P0

## 背景

`src/helpers.ts:424` 定义的 `DEFAULT_SKIP_DIRS = ['.godot', '.import', 'addons', 'tools']`
导致所有使用 `scanFiles()` 默认参数的下游工具自动跳过 `addons/` 和 `tools/` 目录。

这对使用 Asset Library 插件的项目造成严重影响：

- `list_files` 漏掉 addons 中的所有文件
- `get_project_info` 的 file_stats 不准确（如 `.gd: 1` 而实际有 40+）
- `validate_scripts` 默认只扫描项目根目录脚本
- `validate_project` 间接通过 `collectFilesByExt` 也受影响

`.godot` 和 `.import` 是构建缓存/导入缓存，跳过合理。
但 `addons` 和 `tools` 是用户代码目录，属于项目的一部分，默认跳过属于过度保守。

## 设计决策

### 决策 1：默认扫描 addons/tools

从 `DEFAULT_SKIP_DIRS` 移除 `'addons'` 和 `'tools'`。
所有使用默认值的工具立刻包含这两个目录。

### 决策 2：verify_delivery 保持跳过 addons

`src/tools/delivery.ts` 维护独立的 `SKIP_DIRS`，继续跳过 addons。
原因：第三方插件代码不可控，不应阻塞交付质量门禁。

### 决策 3：collectFilesByExt 默认参数同步

`validation.ts` 的 `collectFilesByExt` 有独立的默认参数列表，
需与全局常量同步，否则改了常量但该函数仍跳过 addons/tools。

## 改动清单

### 文件 1: `src/helpers.ts`（1 行）

```typescript
// Before:
export const DEFAULT_SKIP_DIRS = ['.godot', '.import', 'addons', 'tools'];
// After:
export const DEFAULT_SKIP_DIRS = ['.godot', '.import'];
```

### 文件 2: `src/tools/validation.ts`（1 行，行 144）

```typescript
// Before:
function collectFilesByExt(projectPath: string, extensions: string[], excludeDirs: string[] = ['.godot', '.import', 'addons', 'tools']): string[] {
// After:
function collectFilesByExt(projectPath: string, extensions: string[], excludeDirs: string[] = ['.godot', '.import']): string[] {
```

### 文件 3: `src/tools/delivery.ts`（1 行注释，行 19）

```typescript
// Before:
const SKIP_DIRS = new Set(['.godot', '.import', 'addons']);
// After:
// 交付检查跳过 addons：第三方插件代码不纳入交付质量门禁
const SKIP_DIRS = new Set(['.godot', '.import', 'addons']);
```

## 受影响的调用点

### 自动生效（无需改动）

| 调用点 | 文件:行 | 说明 |
|--------|---------|------|
| `get_project_info` → `scanFiles()` | `project.ts:104` | 未传 skipDirs，使用新默认值 |
| `list_files` → `scanFiles()` | `project.ts:126` | 同上 |
| `validate_scripts` → `collectFilesByExt()` | `validation.ts:729` | 默认参数已改 |
| `run_and_verify` → `collectFilesByExt()` | `validation.ts:510` | 同上 |
| `.gdshader/.cs/.tscn` 收集 | `validation.ts:787,829,858` | 同上 |

### 不受影响

| 调用点 | 文件:行 | 原因 |
|--------|---------|------|
| `resources.ts` `scanForResources` | `resources.ts:423` | 使用独立的 FORBIDDEN_DIRS（不含 addons） |
| `resources.ts` `countFiles` | `resources.ts:538` | 同上 |
| `validate_project` | `validation.ts:580` | 使用用户传入的 excludePaths + .godot/.import |
| `delivery.ts` 所有调用 | `delivery.ts:253,292,464` | 使用独立的 SKIP_DIRS（含 addons） |

## 测试影响

**无需修改现有测试**：

- `delivery.test.js` 的两处 "skips addons" 断言仍成立（delivery 保持跳过 addons）
- `project-tools.test.js` 的 `list_files`/`get_project_info` 测试不含 addons 目录，不受影响
- `validation-tools.test.js` 没有断言 addons 被跳过
- `helpers.test.js` 中没有 scanFiles 的单元测试

**建议补充**（独立 PR）：为 `scanFiles` 添加回归测试，验证默认行为包含 addons/tools。

## 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| addons 中大量文件导致扫描变慢 | 低 | scanFiles 已有 maxDepth=15 限制 |
| addons 中含语法错误的 .gd 文件阻塞 validate_scripts | 中 | 用户可通过 `scripts` 参数显式指定要验证的文件 |
| addons 中含无效 .tscn 文件阻塞 validate_project | 低 | validate_project 使用 collectFilesWithExcludes，用户可自定义排除 |

## 验收标准

1. `DEFAULT_SKIP_DIRS` 仅包含 `['.godot', '.import']`
2. `collectFilesByExt` 默认参数同步
3. `delivery.ts` 的 SKIP_DIRS 保持 `['.godot', '.import', 'addons']`
4. 全量测试通过（现有 1800+ 测试无回归）
5. 对 asset-lib-test 项目验证：`list_files`、`validate_scripts`、`get_project_info` 能发现 addons 文件
