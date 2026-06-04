# CCGS 游戏设计能力集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CCGS 三套最有价值的设计模式（GDD 文档标准、Chain-of-Verification 自我质疑、文件即记忆状态快照）集成进 godot-mcp-enhanced，使其具备游戏设计验证能力。

**Architecture:** 新增一个 `game-design.ts` 工具模块，包含 GDD 模板验证器（8 章节标准）和 Chain-of-Verification 引擎。扩展 `verify_delivery` 增加 `gdd_standards` 第五维度。扩展 `dev_loop` 增加 `save_state` 参数实现文件即记忆。所有新功能复用现有基础设施（`executeGdscript`、`wrapAssertionCode`、lint 规则框架）。

**Tech Stack:** TypeScript, Vitest, godot-mcp-enhanced 工具模块体系

---

## File Structure

```
src/tools/
  game-design.ts          ← 新建：GDD 验证 + Chain-of-Verification
  delivery.ts             ← 修改：新增 gdd_standards 维度
  workflow.ts             ← 修改：新增 save_state 参数
  gdscript-lint.ts        ← 不动（只引用其 LintRule 接口风格）

test/
  game-design.test.js     ← 新建：GDD 验证测试
  game-design-cov.test.js ← 新建：Chain-of-Verification 测试
  delivery-gdd.test.js    ← 新建：集成测试
  workflow-state.test.js  ← 新建：状态快照测试
```

---

### Task 1: GDD 文档验证器核心

**Files:**
- Create: `src/tools/game-design.ts`（前半部分）

- [ ] **Step 1: 写 GDD 验证的失败测试**

```javascript
// test/game-design.test.js
import { describe, it, expect } from 'vitest';
import { validateGDD, GDD_REQUIRED_SECTIONS } from '../src/tools/game-design.js';

describe('validateGDD', () => {
  it('should fail when required sections are missing', () => {
    const markdown = `# Combat System\n\n## Overview\nA combat system.\n\n## Player Fantasy\nFeel powerful.`;
    const result = validateGDD(markdown);
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    // 缺少: Detailed Rules, Formulas, Edge Cases, Dependencies, Tuning Knobs, Acceptance Criteria
    expect(result.issues.filter(i => i.severity === 'error').length).toBe(6);
  });

  it('should pass when all 8 sections are present', () => {
    const markdown = `# Combat System
## Overview
A combat system.
## Player Fantasy
Feel powerful.
## Detailed Rules
Rules here.
## Formulas
damage = atk * 2
## Edge Cases
Edge case: zero health.
## Dependencies
Depends on health system.
## Tuning Knobs
- damage_multiplier: 2.0
## Acceptance Criteria
- Player can attack`;
    const result = validateGDD(markdown);
    expect(result.passed).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  it('should warn when section body is too short (< 20 chars)', () => {
    const markdown = `# X\n## Overview\nA combat system.\n## Player Fantasy\nFeel powerful.\n## Detailed Rules\nTODO\n## Formulas\ndmg=x\n## Edge Cases\nNone.\n## Dependencies\nNone.\n## Tuning Knobs\nk:1\n## Acceptance Criteria\n- Test`;
    const result = validateGDD(markdown);
    expect(result.passed).toBe(true); // warnings don't fail
    expect(result.issues.some(i => i.severity === 'warning')).toBe(true);
  });

  it('should detect hardcoded numbers in formulas section', () => {
    const markdown = `# X
## Overview\nA system.
## Player Fantasy\nFeel powerful.
## Detailed Rules\nRules.
## Formulas
damage = 10 + atk * 2.5
## Edge Cases\nNone.
## Dependencies\nNone.
## Tuning Knobs\nNone.
## Acceptance Criteria\n- Test`;
    const result = validateGDD(markdown);
    const formulaWarnings = result.issues.filter(i => i.message.includes('hardcoded'));
    expect(formulaWarnings.length).toBeGreaterThan(0);
  });

  it('should detect acceptance criteria without testable format', () => {
    const markdown = `# X
## Overview\nA system.
## Player Fantasy\nFeel powerful.
## Detailed Rules\nRules.
## Formulas\ndamage = atk * mult
## Edge Cases\nNone.
## Dependencies\nNone.
## Tuning Knobs\nmult: 2.0
## Acceptance Criteria
The combat should feel good.`;
    const result = validateGDD(markdown);
    const acWarnings = result.issues.filter(i => i.location === 'Acceptance Criteria');
    expect(acWarnings.some(w => w.message.includes('testable'))).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/game-design.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 GDD 验证器**

```typescript
// src/tools/game-design.ts（Part 1: GDD Validation）
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { readFileSync } from 'fs';
import { join } from 'path';

// ─── GDD Constants ──────────────────────────────────────────────────────────

export const GDD_REQUIRED_SECTIONS = [
  'Overview',
  'Player Fantasy',
  'Detailed Rules',
  'Formulas',
  'Edge Cases',
  'Dependencies',
  'Tuning Knobs',
  'Acceptance Criteria',
] as const;

const MIN_SECTION_LENGTH = 20;

interface GDDIssue {
  severity: 'error' | 'warning';
  location: string;
  message: string;
  suggestion?: string;
}

export interface GDDValidationResult {
  passed: boolean;
  sections_found: string[];
  sections_missing: string[];
  issues: GDDIssue[];
}

// ─── GDD Validation Logic ───────────────────────────────────────────────────

export function validateGDD(markdown: string): GDDValidationResult {
  const issues: GDDIssue[] = [];
  const found: string[] = [];
  const missing: string[] = [];

  for (const section of GDD_REQUIRED_SECTIONS) {
    const headerPattern = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'm');
    if (!headerPattern.test(markdown)) {
      missing.push(section);
      issues.push({
        severity: 'error',
        location: section,
        message: `Missing required section: "${section}"`,
        suggestion: GDD_SECTION_HINTS[section],
      });
    } else {
      found.push(section);
      const body = extractSectionBody(markdown, section);
      if (body.length < MIN_SECTION_LENGTH) {
        issues.push({
          severity: 'warning',
          location: section,
          message: `Section "${section}" is too short (${body.length} chars, minimum ${MIN_SECTION_LENGTH})`,
          suggestion: `Expand "${section}" with concrete details`,
        });
      }
      // Section-specific validations
      validateSection(section, body, issues);
    }
  }

  return {
    passed: !issues.some(i => i.severity === 'error'),
    sections_found: found,
    sections_missing: missing,
    issues,
  };
}

function extractSectionBody(markdown: string, section: string): string {
  const escaped = escapeRegex(section);
  const regex = new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s|$)`, 'm');
  const match = regex.exec(markdown);
  return match ? match[1].trim() : '';
}

function validateSection(section: string, body: string, issues: GDDIssue[]): void {
  switch (section) {
    case 'Formulas':
      // 检测硬编码数值（公式中不应出现魔法数字）
      const hardcodedNumbers = body.match(/(?<![a-zA-Z_])\d+\.?\d*(?![a-zA-Z_])/g);
      if (hardcodedNumbers && hardcodedNumbers.length > 0) {
        issues.push({
          severity: 'warning',
          location: 'Formulas',
          message: `Potential hardcoded values in formulas: ${hardcodedNumbers.join(', ')}. Extract to Tuning Knobs.`,
          suggestion: 'Replace hardcoded values with named variables referenced in Tuning Knobs',
        });
      }
      break;

    case 'Acceptance Criteria':
      // 检查是否有可测试的条目（以 - 或 * 开头的列表）
      const testableItems = body.match(/^[\s]*[-*]\s+/gm);
      if (!testableItems || testableItems.length === 0) {
        issues.push({
          severity: 'warning',
          location: 'Acceptance Criteria',
          message: 'No testable criteria found. Use bullet list format (- Item)',
          suggestion: 'Write each criterion as a bullet point with measurable outcome',
        });
      }
      break;

    case 'Dependencies':
      if (body.length > 0 && !body.match(/[-*]/) && !body.includes('None')) {
        issues.push({
          severity: 'warning',
          location: 'Dependencies',
          message: 'Dependencies should be listed as bullet items',
          suggestion: 'List each dependency system as a separate bullet point',
        });
      }
      break;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GDD_SECTION_HINTS: Record<string, string> = {
  'Overview': 'One-paragraph summary of the system/mechanic',
  'Player Fantasy': 'What feeling/experience should the player have?',
  'Detailed Rules': 'Unambiguous mechanical rules — no vague language',
  'Formulas': 'All math with named variables (e.g., damage = atk * multiplier)',
  'Edge Cases': 'Unusual situations: min/max values, simultaneous events, empty states',
  'Dependencies': 'Other systems this one interacts with',
  'Tuning Knobs': 'Configurable values with defaults and ranges',
  'Acceptance Criteria': 'Testable success conditions as bullet list',
};
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/game-design.test.js`
Expected: 5/5 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/game-design.ts test/game-design.test.js
git commit -m "feat(game-design): add GDD 8-section validator with content quality checks"
```

---

### Task 2: Chain-of-Verification 自我质疑引擎

**Files:**
- Modify: `src/tools/game-design.ts`（后半部分）
- Create: `test/game-design-cov.test.js`

- [ ] **Step 1: 写 Chain-of-Verification 的失败测试**

```javascript
// test/game-design-cov.test.js
import { describe, it, expect } from 'vitest';
import { chainOfVerification } from '../src/tools/game-design.js';

describe('chainOfVerification', () => {
  it('should generate exactly 5 challenge questions', () => {
    const verdict = 'PASS: All GDD sections present and well-formed';
    const context = 'Validated combat_system.md with 8 sections, 2 minor warnings';
    const result = chainOfVerification(verdict, context);
    expect(result.questions.length).toBe(5);
    expect(result.questions.every(q => typeof q === 'string' && q.length > 10)).toBe(true);
  });

  it('should include self-doubt phrase patterns', () => {
    const verdict = 'PASS: No issues found';
    const context = 'Checked player_movement.md';
    const result = chainOfVerification(verdict, context);
    const allText = result.questions.join(' ');
    // 至少有一个问题表达了对结论的质疑
    const doubtPatterns = ['what if', 'could', 'might', 'miss', 'overlook', 'assume', 'wrong'];
    const hasDoubt = doubtPatterns.some(p => allText.toLowerCase().includes(p));
    expect(hasDoubt).toBe(true);
  });

  it('should return verdict and confidence adjustment', () => {
    const verdict = 'CONCERNS: 2 warnings found';
    const context = 'combat.md has hardcoded values and short acceptance criteria';
    const result = chainOfVerification(verdict, context);
    expect(result.original_verdict).toBe(verdict);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('should lower confidence when challenges are strong', () => {
    const weakVerdict = 'PASS: Everything looks fine';
    const badContext = 'Only checked Overview section, skipped formulas validation';
    const result = chainOfVerification(weakVerdict, badContext);
    // 弱验证上下文应该导致置信度下降
    expect(result.confidence).toBeLessThan(0.8);
    expect(result.recommendation).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/game-design-cov.test.js`
Expected: FAIL — chainOfVerification not exported

- [ ] **Step 3: 实现 Chain-of-Verification**

在 `src/tools/game-design.ts` 末尾追加：

```typescript
// ─── Chain-of-Verification ──────────────────────────────────────────────────

export interface CoVResult {
  original_verdict: string;
  questions: string[];
  confidence: number; // 0-1
  recommendation: string;
}

const COV_QUESTION_TEMPLATES = [
  'What if {context} has an edge case that was not considered in the verdict?',
  'Could the {verdict_verb} be wrong because {reason}?',
  'What assumption in "{verdict}" might not hold for this specific project?',
  'Might there be a quality issue that was overlooked during {context}?',
  'If a senior reviewer challenged "{verdict}", what would they point out?',
];

export function chainOfVerification(verdict: string, context: string): CoVResult {
  const verdictLower = verdict.toLowerCase();
  const questions: string[] = [];

  // 生成 5 个质疑问题
  const templates = [...COV_QUESTION_TEMPLATES];
  for (let i = 0; i < 5; i++) {
    const idx = i % templates.length;
    const template = templates[idx];
    questions.push(
      template
        .replace('{context}', context)
        .replace('{verdict_verb}', extractVerb(verdict))
        .replace('{verdict}', verdict.substring(0, 60))
        .replace('{reason}', generateReason(verdictLower, context))
    );
  }

  // 基于上下文质量调整置信度
  let confidence = 0.9;
  const weakSignals = [
    context.toLowerCase().includes('skipped'),
    context.toLowerCase().includes('only checked'),
    context.toLowerCase().includes('partial'),
    verdictLower.includes('concerns'),
    verdictLower.includes('fail'),
    context.length < 30,
  ];
  const weakCount = weakSignals.filter(Boolean).length;
  confidence -= weakCount * 0.15;
  confidence = Math.max(0.1, Math.min(1.0, confidence));

  const recommendation = confidence < 0.7
    ? 'Low confidence — recommend manual review before proceeding'
    : confidence < 0.9
      ? 'Moderate confidence — verify key concerns manually'
      : 'High confidence — verdict is well-supported by evidence';

  return {
    original_verdict: verdict,
    questions,
    confidence: Math.round(confidence * 100) / 100,
    recommendation,
  };
}

function extractVerb(verdict: string): string {
  const verbs = ['pass', 'fail', 'concerns', 'accept', 'reject'];
  const lower = verdict.toLowerCase();
  return verbs.find(v => lower.includes(v)) ?? 'conclusion';
}

function generateReason(verdictLower: string, context: string): string {
  if (verdictLower.includes('pass') && context.length < 50) return 'the validation scope was very narrow';
  if (verdictLower.includes('concerns')) return 'the concerns might indicate deeper systemic issues';
  if (verdictLower.includes('fail')) return 'the failure might cascade to dependent systems';
  return 'the validation context might be incomplete';
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/game-design-cov.test.js`
Expected: 4/4 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/game-design.ts test/game-design-cov.test.js
git commit -m "feat(game-design): add Chain-of-Verification self-challenge engine"
```

---

### Task 3: 注册 MCP 工具（validate_gdd + chain_verify）

**Files:**
- Modify: `src/tools/game-design.ts`（追加工具注册）
- Modify: `src/GodotServer.ts`（导入新模块）

- [ ] **Step 1: 写工具注册的失败测试**

```javascript
// test/game-design.test.js（追加到现有文件）
import { describe, it, expect } from 'vitest';
import { getToolDefinitions, handleTool, TOOL_META } from '../src/tools/game-design.js';

describe('game-design MCP tools', () => {
  it('should register validate_gdd tool', () => {
    const defs = getToolDefinitions();
    const validateGdd = defs.find(d => d.name === 'validate_gdd');
    expect(validateGdd).toBeDefined();
    expect(validateGdd!.inputSchema.required).toContain('project_path');
    expect(validateGdd!.inputSchema.required).toContain('gdd_path');
  });

  it('should register chain_verify tool', () => {
    const defs = getToolDefinitions();
    const chainVerify = defs.find(d => d.name === 'chain_verify');
    expect(chainVerify).toBeDefined();
    expect(chainVerify!.inputSchema.required).toContain('verdict');
    expect(chainVerify!.inputSchema.required).toContain('context');
  });

  it('should have correct TOOL_META', () => {
    expect(TOOL_META.validate_gdd.readonly).toBe(true);
    expect(TOOL_META.chain_verify.readonly).toBe(true);
  });

  it('handleTool should return null for unknown tool', async () => {
    const result = await handleTool('unknown_tool', {}, {} as any);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/game-design.test.js`
Expected: FAIL — getToolDefinitions not exported

- [ ] **Step 3: 添加工具定义和 handler**

在 `src/tools/game-design.ts` 追加工具注册代码：

```typescript
// ─── Tool Definitions ────────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'validate_gdd',
      description:
        'Validate a Game Design Document against the 8-section GDD standard ' +
        '(Overview, Player Fantasy, Detailed Rules, Formulas, Edge Cases, Dependencies, Tuning Knobs, Acceptance Criteria). ' +
        'Checks section existence, content quality, hardcoded values, and testable criteria.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          gdd_path: { type: 'string', description: 'GDD file path relative to project (e.g. design/gdd/combat.md)' },
        },
        required: ['project_path', 'gdd_path'],
      },
    },
    {
      name: 'chain_verify',
      description:
        'Chain-of-Verification: generate 5 self-challenge questions against a verdict. ' +
        'Use after reviews/evaluations to catch blind spots and overconfidence.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          verdict: { type: 'string', description: 'The verdict/conclusion to challenge (e.g. "PASS: All checks passed")' },
          context: { type: 'string', description: 'What was checked and how (e.g. "Validated 8 GDD sections in combat.md")' },
        },
        required: ['verdict', 'context'],
      },
    },
  ];
}

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name === 'validate_gdd') {
    const projectPath = validatePath(args.project_path as string);
    const gddPath = args.gdd_path as string;
    const fullPath = join(projectPath, gddPath);
    const content = readFileSync(fullPath, 'utf-8');
    const result = validateGDD(content);
    return textResult(JSON.stringify(result, null, 2));
  }

  if (name === 'chain_verify') {
    const verdict = args.verdict as string;
    const context = args.context as string;
    const result = chainOfVerification(verdict, context);
    return textResult(JSON.stringify(result, null, 2));
  }

  return null;
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  validate_gdd: { readonly: true, long_running: false },
  chain_verify: { readonly: true, long_running: false },
};
```

- [ ] **Step 4: 注册到 GodotServer**

在 `src/GodotServer.ts` 的 `toolModules` 数组中添加 `gameDesign` 模块导入：

找到其他工具导入的位置，添加：
```typescript
import * as gameDesign from './tools/game-design.js';
```

在 `toolModules` 数组中添加 `gameDesign`。

- [ ] **Step 5: 运行全部 game-design 测试**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/game-design.test.js test/game-design-cov.test.js`
Expected: ALL PASS

- [ ] **Step 6: 提交**

```bash
git add src/tools/game-design.ts src/GodotServer.ts test/game-design.test.js
git commit -m "feat(game-design): register validate_gdd and chain_verify as MCP tools"
```

---

### Task 4: 扩展 verify_delivery 增加 gdd_standards 维度

**Files:**
- Modify: `src/tools/delivery.ts`
- Create: `test/delivery-gdd.test.js`

- [ ] **Step 1: 写集成测试**

```javascript
// test/delivery-gdd.test.js
import { describe, it, expect, vi } from 'vitest';

// Mock：只测试 schema 层面，不跑真正的 Godot
describe('verify_delivery gdd_standards dimension', () => {
  it('should accept gdd_standards in checks schema', async () => {
    // 验证工具定义中包含 gdd_standards
    const { getToolDefinitions } = await import('../src/tools/delivery.js');
    const defs = getToolDefinitions();
    const verifyDef = defs.find(d => d.name === 'verify_delivery');
    const checksProps = (verifyDef!.inputSchema as any).properties.checks.properties;
    expect(checksProps.gdd_standards).toBeDefined();
    expect(checksProps.gdd_standards.type).toBe('boolean');
  });

  it('should accept gdd_dirs in checks schema', async () => {
    const { getToolDefinitions } = await import('../src/tools/delivery.js');
    const defs = getToolDefinitions();
    const verifyDef = defs.find(d => d.name === 'verify_delivery');
    const checksProps = (verifyDef!.inputSchema as any).properties.checks.properties;
    expect(checksProps.gdd_dirs).toBeDefined();
    expect(checksProps.gdd_dirs.type).toBe('array');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/delivery-gdd.test.js`
Expected: FAIL — gdd_standards not in schema

- [ ] **Step 3: 扩展 delivery.ts 工具定义**

在 `delivery.ts` 的 `getToolDefinitions()` 的 `checks.properties` 中添加：

```typescript
gdd_standards: {
  type: 'boolean',
  description: 'Check GDD documents against 8-section standard (requires design/ directory)',
},
gdd_dirs: {
  type: 'array',
  description: 'Directories to scan for GDD .md files (default: ["design/gdd"])',
  items: { type: 'string' },
},
```

- [ ] **Step 4: 在 handleTool 中添加 GDD 维度处理**

在 `delivery.ts` 的 Dimension 4 (assertions) 之后、Summary 之前，插入 Dimension 5：

```typescript
// ── Dimension 5: GDD Standards ──
if (checks.gdd_standards !== false) {
  const gddDirs = (checks.gdd_dirs as string[]) || ['design/gdd'];
  // 动态导入避免循环依赖
  const { validateGDD } = await import('./game-design.js');
  const gddIssues: Issue[] = [];
  let gddFilesScanned = 0;

  for (const gddDir of gddDirs) {
    const fullDir = join(projectPath, gddDir);
    if (!existsSync(fullDir)) {
      gddIssues.push({
        severity: 'warning',
        location: gddDir,
        message: `GDD directory not found: ${gddDir}`,
        suggestion: 'Create design/gdd/ directory for game design documents',
      });
      continue;
    }
    // 扫描 .md 文件
    function collectGddFiles(dir: string, prefix: string): string[] {
      const result: string[] = [];
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
            result.push(...collectGddFiles(join(dir, e.name), `${prefix}${e.name}/`));
          } else if (e.name.endsWith('.md')) {
            result.push(`${prefix}${e.name}`);
          }
        }
      } catch { /* ignore */ }
      return result;
    }

    const gddFiles = collectGddFiles(fullDir, '');
    gddFilesScanned += gddFiles.length;

    for (const gf of gddFiles) {
      const content = safeReadFile(join(fullDir, gf));
      if (!content) continue;
      const validation = validateGDD(content);
      for (const issue of validation.issues) {
        gddIssues.push({
          severity: issue.severity,
          location: `${gddDir}/${gf}:${issue.location}`,
          message: issue.message,
          suggestion: issue.suggestion,
        });
      }
    }
  }

  const gddPassed = !hasErrors(gddIssues);
  report.gdd_standards = {
    passed: gddPassed,
    files_scanned: gddFilesScanned,
    issues: gddIssues,
  };
  dimensionResults.push({ dim: 'gdd_standards', passed: gddPassed });
}
```

同时在 handler 顶部提取新参数：
```typescript
const gddStandards = checks.gdd_standards !== false;
```

注意：仅当 `scope === 'full'` 且项目有 `design/` 目录时才默认启用。修改默认值逻辑：

```typescript
// 只在 scope=full 时默认启用 GDD 检查
const effectiveGddStandards = checks.gdd_standards === true || (checks.gdd_standards !== false && scope === 'full' && existsSync(join(projectPath, 'design')));
```

用 `effectiveGddStandards` 替换条件判断中的 `checks.gdd_standards !== false`。

- [ ] **Step 5: 运行测试验证通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/delivery-gdd.test.js`
Expected: 2/2 PASS

- [ ] **Step 6: 运行已有 delivery 测试确认无回归**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/delivery.test.js`
Expected: ALL PASS（无回归）

- [ ] **Step 7: 提交**

```bash
git add src/tools/delivery.ts test/delivery-gdd.test.js
git commit -m "feat(delivery): add gdd_standards as 5th verification dimension"
```

---

### Task 5: 扩展 dev_loop 增加 save_state 文件即记忆

**Files:**
- Modify: `src/tools/workflow.ts`
- Create: `test/workflow-state.test.js`

- [ ] **Step 1: 写失败测试**

```javascript
// test/workflow-state.test.js
import { describe, it, expect } from 'vitest';
import { formatSessionState, buildStateBlock } from '../src/tools/workflow.js';

describe('Session State', () => {
  it('formatSessionState should produce valid markdown', () => {
    const state = {
      current_task: 'Implementing combat hitbox detection',
      epic: 'Combat System',
      feature: 'Melee Combat',
      files_modified: ['scripts/combat/hitbox.gd', 'scenes/combat/melee.tscn'],
      decisions: ['Use Area3D for hitbox instead of RayCast3D'],
      open_questions: ['Should hitbox persist across animation frames?'],
    };
    const md = formatSessionState(state);
    expect(md).toContain('## Current Task');
    expect(md).toContain('Implementing combat hitbox detection');
    expect(md).toContain('scripts/combat/hitbox.gd');
    expect(md).toContain('## Open Questions');
  });

  it('buildStateBlock should produce STATUS block', () => {
    const block = buildStateBlock('Combat System', 'Melee Combat', 'Hitbox detection');
    expect(block).toContain('<!-- STATUS -->');
    expect(block).toContain('Epic: Combat System');
    expect(block).toContain('Feature: Melee Combat');
    expect(block).toContain('Task: Hitbox detection');
    expect(block).toContain('<!-- /STATUS -->');
  });

  it('buildStateBlock should omit empty fields', () => {
    const block = buildStateBlock('Combat System', '', '');
    expect(block).toContain('Epic: Combat System');
    expect(block).not.toContain('Feature:');
    expect(block).not.toContain('Task:');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/workflow-state.test.js`
Expected: FAIL — formatSessionState not exported

- [ ] **Step 3: 在 workflow.ts 中添加状态格式化函数和 save_state 参数**

首先添加工具定义中的 `save_state` 参数，在 `dev_loop` 的 `inputSchema.properties` 中加入：

```typescript
save_state: {
  type: 'object',
  description: 'Save session state to file for context recovery (file-as-memory pattern from CCGS)',
  properties: {
    path: { type: 'string', description: 'State file path relative to project (default: production/session-state/active.md)' },
    task: { type: 'string', description: 'Current task description' },
    epic: { type: 'string', description: 'Epic name (optional)' },
    feature: { type: 'string', description: 'Feature name (optional)' },
    files_modified: {
      type: 'array',
      description: 'List of files modified in this session',
      items: { type: 'string' },
    },
    decisions: {
      type: 'array',
      description: 'Key decisions made',
      items: { type: 'string' },
    },
    open_questions: {
      type: 'array',
      description: 'Unresolved questions',
      items: { type: 'string' },
    },
  },
},
```

然后在 `workflow.ts` 中添加导出函数：

```typescript
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// ─── Session State Formatting ────────────────────────────────────────────────

interface SessionState {
  current_task: string;
  epic?: string;
  feature?: string;
  files_modified?: string[];
  decisions?: string[];
  open_questions?: string[];
}

export function formatSessionState(state: SessionState): string {
  const lines: string[] = [
    `# Session State`,
    ``,
    `> Auto-generated by dev_loop save_state`,
    ``,
    `## Current Task`,
    ``,
    state.current_task,
    ``,
  ];

  if (state.epic || state.feature) {
    lines.push(`## Context`);
    lines.push(``);
    if (state.epic) lines.push(`- **Epic**: ${state.epic}`);
    if (state.feature) lines.push(`- **Feature**: ${state.feature}`);
    lines.push(``);
  }

  if (state.files_modified && state.files_modified.length > 0) {
    lines.push(`## Files Modified`);
    lines.push(``);
    for (const f of state.files_modified) lines.push(`- \`${f}\``);
    lines.push(``);
  }

  if (state.decisions && state.decisions.length > 0) {
    lines.push(`## Key Decisions`);
    lines.push(``);
    for (const d of state.decisions) lines.push(`- ${d}`);
    lines.push(``);
  }

  if (state.open_questions && state.open_questions.length > 0) {
    lines.push(`## Open Questions`);
    lines.push(``);
    for (const q of state.open_questions) lines.push(`- [ ] ${q}`);
    lines.push(``);
  }

  return lines.join('\n');
}

export function buildStateBlock(epic: string, feature: string, task: string): string {
  const lines = ['<!-- STATUS -->'];
  if (epic) lines.push(`Epic: ${epic}`);
  if (feature) lines.push(`Feature: ${feature}`);
  if (task) lines.push(`Task: ${task}`);
  lines.push('<!-- /STATUS -->');
  return lines.join('\n');
}
```

然后在 `handleTool` 的 dev_loop handler 末尾（acceptance 之后），添加 save_state 处理：

```typescript
// ── Step 5: Save State (optional) ──
if (args.save_state && typeof args.save_state === 'object') {
  const ss = args.save_state as Record<string, unknown>;
  const statePath = (ss.path as string) || 'production/session-state/active.md';
  const fullStatePath = join(projectPath, statePath);
  const dir = dirname(fullStatePath);
  mkdirSync(dir, { recursive: true });
  const content = formatSessionState({
    current_task: (ss.task as string) || 'Unknown task',
    epic: ss.epic as string | undefined,
    feature: ss.feature as string | undefined,
    files_modified: ss.files_modified as string[] | undefined,
    decisions: ss.decisions as string[] | undefined,
    open_questions: ss.open_questions as string[] | undefined,
  });
  writeFileSync(fullStatePath, content, 'utf-8');
  result.save_state = { saved: true, path: statePath };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/workflow-state.test.js`
Expected: 3/3 PASS

- [ ] **Step 5: 运行已有 workflow 测试确认无回归**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/workflow.test.js`
Expected: ALL PASS

- [ ] **Step 6: 提交**

```bash
git add src/tools/workflow.ts test/workflow-state.test.js
git commit -m "feat(workflow): add save_state for file-as-memory session persistence"
```

---

### Task 6: 全量集成测试 + 文档更新

**Files:**
- Create: `test/integration/game-design-integration.test.js`
- Modify: `README.md`

- [ ] **Step 1: 写集成测试验证工具注册完整链路**

```javascript
// test/integration/game-design-integration.test.js
import { describe, it, expect } from 'vitest';
import { getToolDefinitions as getGDDDefs, TOOL_META as gddMeta } from '../../src/tools/game-design.js';
import { getToolDefinitions as getDeliveryDefs } from '../../src/tools/delivery.js';
import { getToolDefinitions as getWorkflowDefs } from '../../src/tools/workflow.js';

describe('Game Design Integration', () => {
  it('all 3 new tools are registered', () => {
    const gddDefs = getGDDDefs();
    const deliveryDefs = getDeliveryDefs();
    const workflowDefs = getWorkflowDefs();

    expect(gddDefs.find(d => d.name === 'validate_gdd')).toBeDefined();
    expect(gddDefs.find(d => d.name === 'chain_verify')).toBeDefined();
    expect(deliveryDefs.find(d => d.name === 'verify_delivery')).toBeDefined();
    expect(workflowDefs.find(d => d.name === 'dev_loop')).toBeDefined();
  });

  it('gdd_standards dimension is in verify_delivery schema', () => {
    const deliveryDefs = getDeliveryDefs();
    const vd = deliveryDefs.find(d => d.name === 'verify_delivery');
    const checksProps = (vd!.inputSchema as any).properties.checks.properties;
    expect(checksProps.gdd_standards).toBeDefined();
    expect(checksProps.gdd_dirs).toBeDefined();
  });

  it('save_state is in dev_loop schema', () => {
    const workflowDefs = getWorkflowDefs();
    const dl = workflowDefs.find(d => d.name === 'dev_loop');
    const props = (dl!.inputSchema as any).properties;
    expect(props.save_state).toBeDefined();
    expect(props.save_state.description).toContain('file-as-memory');
  });

  it('TOOL_META has correct entries for new tools', () => {
    expect(gddMeta.validate_gdd.readonly).toBe(true);
    expect(gddMeta.chain_verify.readonly).toBe(true);
  });
});
```

- [ ] **Step 2: 运行集成测试**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run test/integration/game-design-integration.test.js`
Expected: 4/4 PASS

- [ ] **Step 3: 运行全量测试套件确认无回归**

Run: `cd D:/GitHub/godot-mcp-enhanced && npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: 更新 README 工具数量**

在 README 的工具统计部分，工具总数 +2（validate_gdd, chain_verify），更新相关描述。

- [ ] **Step 5: 提交**

```bash
git add test/integration/game-design-integration.test.js README.md
git commit -m "test(game-design): integration tests and README update for game design tools"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - GDD 8 章节标准 → Task 1（validateGDD） + Task 4（集成到 verify_delivery）
   - Chain-of-Verification → Task 2（chainOfVerification） + Task 3（chain_verify 工具）
   - 文件即记忆 → Task 5（save_state 参数 + formatSessionState）

2. **Placeholder scan:** 无 TBD/TODO/fill-in-later。每个步骤有完整代码。

3. **Type consistency:**
   - `validateGDD` 返回 `GDDValidationResult`，Task 4 通过 `import('./game-design.js')` 动态导入使用
   - `chainOfVerification` 返回 `CoVResult`，工具 handler 直接 JSON.stringify
   - `formatSessionState` 接受 `SessionState`，`buildStateBlock` 接受 3 个 string
   - `TOOL_META` 导出名与 `getToolDefinitions` 中工具名一致
