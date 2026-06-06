# DEFAULT_SKIP_DIRS 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 DEFAULT_SKIP_DIRS 移除 'addons' 和 'tools'，使 MCP 工具默认扫描插件目录。

**Architecture:** 修改 1 个全局常量 + 1 个局部默认参数 + 1 行注释。delivery.ts 维护独立 SKIP_DIRS 不变。

**Tech Stack:** TypeScript, Vitest

**设计文档:** `docs/superpowers/specs/2026-06-06-addons-scan-fix-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/helpers.ts:424` | 修改 | 全局默认跳过目录常量 |
| `src/tools/validation.ts:144` | 修改 | collectFilesByExt 默认参数 |
| `src/tools/delivery.ts:19` | 修改 | 加注释说明 |
| `test/helpers.test.js` | 新增测试 | scanFiles 回归测试 |

---

### Task 1: 修改 DEFAULT_SKIP_DIRS 常量

**Files:**
- Modify: `src/helpers.ts:424`

- [ ] **Step 1: 修改常量**

将 `src/helpers.ts` 第 424 行：

```typescript
export const DEFAULT_SKIP_DIRS = ['.godot', '.import', 'addons', 'tools'];
```

改为：

```typescript
export const DEFAULT_SKIP_DIRS = ['.godot', '.import'];
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/helpers.ts
git commit -m "fix: remove 'addons' and 'tools' from DEFAULT_SKIP_DIRS

addons and tools are user code directories, not build caches.
Skipping them by default caused list_files, get_project_info,
validate_scripts, and validate_project to miss addon resources.

Refs: docs/superpowers/specs/2026-06-06-addons-scan-fix-design.md"
```

---

### Task 2: 同步 collectFilesByExt 默认参数

**Files:**
- Modify: `src/tools/validation.ts:144`

- [ ] **Step 1: 修改默认参数**

将 `src/tools/validation.ts` 第 144 行：

```typescript
function collectFilesByExt(projectPath: string, extensions: string[], excludeDirs: string[] = ['.godot', '.import', 'addons', 'tools']): string[] {
```

改为：

```typescript
function collectFilesByExt(projectPath: string, extensions: string[], excludeDirs: string[] = ['.godot', '.import']): string[] {
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/tools/validation.ts
git commit -m "fix: sync collectFilesByExt default excludeDirs with DEFAULT_SKIP_DIRS

Was using a hardcoded list including 'addons' and 'tools', which
prevented validate_scripts and validate_project from scanning addons
even after the global constant was fixed."
```

---

### Task 3: 为 delivery.ts SKIP_DIRS 加注释

**Files:**
- Modify: `src/tools/delivery.ts:19`

- [ ] **Step 1: 添加注释**

将 `src/tools/delivery.ts` 第 19 行：

```typescript
const SKIP_DIRS = new Set(['.godot', '.import', 'addons']);
```

改为：

```typescript
// 交付检查跳过 addons：第三方插件代码不纳入交付质量门禁
const SKIP_DIRS = new Set(['.godot', '.import', 'addons']);
```

- [ ] **Step 2: 提交**

```bash
git add src/tools/delivery.ts
git commit -m "docs(delivery): add comment explaining why addons is skipped

verify_delivery intentionally skips addons because third-party
plugin code is not under the project's control and should not
block the delivery gate."
```

---

### Task 4: 全量测试验证

**Files:**
- 无代码改动

- [ ] **Step 1: 运行全量测试**

Run: `npx vitest run 2>&1 | tail -20`
Expected: 所有测试通过（无回归）

- [ ] **Step 2: 确认 delivery 测试仍通过**

Run: `npx vitest run test/delivery.test.js 2>&1 | tail -10`
Expected: 所有测试通过（verify_delivery 仍跳过 addons）

- [ ] **Step 3: 确认 helpers 测试仍通过**

Run: `npx vitest run test/helpers.test.js 2>&1 | tail -10`
Expected: 所有测试通过

---

### Task 5: 集成验证（手动）

**Files:**
- 无代码改动

- [ ] **Step 1: 用 asset-lib-test 项目验证 list_files**

对 `D:/GitHub/asset-lib-test` 调用 `list_files`，确认返回的文件包含 `addons/` 下的文件。

- [ ] **Step 2: 验证 validate_scripts 发现 addons 脚本**

对 `D:/GitHub/asset-lib-test` 调用 `validate_scripts`（不传 scripts 参数），确认扫描到的脚本数 > 1（应包含 addons 中的脚本）。

- [ ] **Step 3: 验证 get_project_info file_stats 准确**

对 `D:/GitHub/asset-lib-test` 调用 `get_project_info`，确认 `.gd` 计数 > 1（应包含 addons 中的脚本）。
