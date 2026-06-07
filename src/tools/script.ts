import { join, basename, extname } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, renameSync, unlinkSync, copyFileSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, ensureDir } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { batchValidateScripts } from './validation.js';
import { lintGDScript, formatLintResults } from './gdscript-lint.js';
import { getTemplateSuggestion } from './code-templates.js';
import { gdEscape, opsErrorResult } from './shared.js';
import { validateTimeout } from './shared.js';
import { getLogger } from '../core/logger.js';

function detectDuplicateLines(lines: string[]): string[] {
  const warnings: string[] = [];
  let runStart = -1;
  for (let i = 1; i <= lines.length; i++) {
    const cur = i < lines.length ? lines[i]!.trim() : '';
    const prev = lines[i - 1]!.trim();
    if (cur.length > 10 && cur === prev && (cur.includes('(') || cur.includes('='))) {
      if (runStart < 0) runStart = i - 1;
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        warnings.push(`Duplicate block (lines ${runStart + 1}-${i}): "${prev.substring(0, 80)}"`);
      }
      runStart = -1;
    }
  }
  return warnings;
}

function formatDuplicateWarnings(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return `\n\n⚠ Warning: ${warnings.length} duplicate line(s) detected (possible copy-paste error):\n${warnings.map(w => `  ${w}`).join('\n')}`;
}

function joinWithLineEnding(content: string, hasCRLF: boolean): string {
  if (!hasCRLF) return content;
  return content.split('\n').join('\r\n');
}

async function validateAndRevert(
  fullPath: string,
  rawFile: string,
  godotPath: string,
  projectPath: string,
  contextInfo?: string
): Promise<string | null> {
  try {
    const valResult = await batchValidateScripts(godotPath, projectPath, [fullPath], 15000);
    if (valResult.length > 0 && valResult[0]!.errors.length > 0) {
      try {
        writeFileSync(fullPath, rawFile, 'utf-8');
      } catch (rollbackErr) {
        return `⚠️ CRITICAL: Parse error detected AND rollback failed!\n` +
          `Parse errors:\n  ${valResult[0]!.errors.join('\n  ')}\n` +
          `Rollback error: ${rollbackErr}\n` +
          `File may be in a corrupted state: ${fullPath}`;
      }
      // 尝试解析结构化错误信息
      const parsed = parseGodotErrors(valResult[0]!.errors);
      let errorLines: string;
      if (parsed.length > 0) {
        errorLines = parsed.map(e => {
          let line = `  Line ${e.line}: ${e.message}`;
          if (e.identifier) line += ` (${e.identifier})`;
          return line;
        }).join('\n');
      } else {
        // 回退到原始格式
        errorLines = valResult[0]!.errors.map(e => `  ${e}`).join('\n');
      }

      return `⚠️ Edit REVERTED due to GDScript parse error:\n` +
        errorLines +
        `\n\nOriginal file restored. Please fix the edit content and retry.` +
        (contextInfo ? `\n\n--- Attempted change ---\n${contextInfo}` : '');
    }
  } catch (e) {
    return `⚠️ Validation skipped (Godot unavailable): ${(e as Error).message}\nEdit was applied but not validated.`;
  }
  return null;
}

const ACTIONS = [
  'read_script',
  'write_script',
  'edit_script',
  'generate_test',
  'create_test_scene',
  'execute_gdscript',
  'project_replace',
] as const;

// ─── GDScript error parsing (best-effort) ────────────────────────────────────

interface ParseErrorDetail {
  line: number;
  message: string;
  type: 'parse_error' | 'script_error';
  /** 标识符名称（best-effort 提取，可能为空） */
  identifier?: string;
}

/**
 * 解析 Godot 验证错误输出。标识符提取是 best-effort，
 * 提取失败不阻塞主要错误消息展示。
 */
function parseGodotErrors(rawErrors: string[]): ParseErrorDetail[] {
  const details: ParseErrorDetail[] = [];
  for (const err of rawErrors) {
    const match = err.match(/:(\d+)\s*-\s*(Parse Error|Script Error):\s*(.*)/);
    if (match) {
      const detail: ParseErrorDetail = {
        line: parseInt(match[1]!),
        message: match[3]!,
        type: match[2]! === 'Parse Error' ? 'parse_error' : 'script_error',
      };
      // best-effort 标识符提取
      const identMatch =
        match[3]!.match(/identifier "([^"]+)"/i) ||
        match[3]!.match(/"(\w+)" not declared/i) ||
        match[3]!.match(/Unexpected identifier:\s*"(\w+)"/i);
      if (identMatch) {
        detail.identifier = identMatch[1]!;
      }
      details.push(detail);
    }
  }
  return details;
}

// ─── Indent detection (heuristic — GDScript typically uses tabs or 2/4 spaces) ──

interface IndentStyle {
  type: 'tab' | 'space';
  size: number;
}

/**
 * 检测文件缩进风格。只统计有实际缩进（>0）的行，排除空行和 0 级缩进行。
 * 注意：这是启发式算法，非严格 GCD。对 3/6 空格交替等极端情况可能推断错误，
 * 但 GDScript 几乎只用 tab 或 2/4 空格，99% 场景正确。
 */
function detectIndentStyle(lines: string[]): IndentStyle {
  let tabCount = 0;
  let spaceCount = 0;
  const spaceSizes: number[] = [];

  const sampleLines = lines.slice(0, 100);
  for (const line of sampleLines) {
    if (line.trim().length === 0) continue;
    const leadingMatch = line.match(/^(\s+)/);
    if (!leadingMatch) continue;

    // 只统计有实际缩进的行（缩进长度 > 0 已经由 leadingMatch 保证）
    const leading = leadingMatch[1]!;
    if (leading.includes('\t')) {
      tabCount++;
    } else {
      spaceCount++;
      spaceSizes.push(leading.length);
    }
  }

  if (tabCount >= spaceCount) {
    return { type: 'tab', size: 1 };
  }

  // 计算最常见的空格缩进大小，推断单个缩进级别
  const sizeCounts = new Map<number, number>();
  for (const s of spaceSizes) {
    sizeCounts.set(s, (sizeCounts.get(s) || 0) + 1);
  }
  const sorted = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const commonSize = sorted[0]?.[0] ?? 4;
  // 启发式：bucket 到 2/4/8
  const indentSize = commonSize <= 2 ? 2 : (commonSize <= 4 ? 4 : 8);

  return { type: 'space', size: indentSize };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'script',
      description: '脚本操作。读写: read_script, write_script。编辑: edit_script（行号/search_and_replace）。执行: execute_gdscript（⚠️ 沙箱仅防误操作，不可用于不可信输入。高安全场景请用 ALLOW_EXECUTE_GDSCRIPT=false 或容器隔离）。测试: generate_test, create_test_scene。批量替换: project_replace。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: '操作类型',
          },
          script_path: { type: 'string', description: 'read_script 用绝对路径；write_script/edit_script/generate_test 用绝对或相对项目路径' },
          content: { type: 'string', description: 'write_script: GDScript 内容' },
          overwrite: { type: 'boolean', description: 'write_script: 覆盖已有文件（默认 false）', default: false },
          start_line: { type: 'number', description: 'edit_script: 替换起始行（1-based）' },
          end_line: { type: 'number', description: 'edit_script: 替换结束行（1-based，含）' },
          new_content: { type: 'string', description: 'edit_script: 替换内容' },
          indent_mode: {
            type: 'string',
            enum: ['raw', 'smart'],
            description: 'edit_script: 缩进模式（默认 raw）',
            default: 'raw',
          },
          verify_content: { type: 'string', description: 'edit_script: 期望内容守卫（不匹配则中止）' },
          auto_validate: {
            type: 'boolean',
            description: 'edit_script: 自动验证语法并在失败时回滚（默认 true）',
            default: true,
          },
          search_and_replace: {
            type: 'object',
            description: 'edit_script: 内容搜索替换模式（提供时忽略 start_line/end_line）',
            properties: {
              search: { type: 'string', description: '搜索文本（CRLF 归一化匹配）' },
              replace: { type: 'string', description: '替换文本' },
              occurrence: { type: 'number', description: '替换第几次出现（1-based，0=全部）' },
            },
            required: ['search', 'replace'],
          },
          code: { type: 'string', description: 'execute_gdscript: 要执行的 GDScript 代码' },
          timeout: { type: 'number', description: 'execute_gdscript: 超时秒数（默认 30）', default: 30 },
          load_autoloads: { type: 'boolean', description: 'execute_gdscript: 加载完整 Autoload 上下文（默认 false）', default: false },
          search: { type: 'string', description: 'project_replace: 搜索文本' },
          replace: { type: 'string', description: 'project_replace: 替换文本' },
          extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 文件扩展名（默认 [".gd"]）',
            default: ['.gd'],
          },
          exclude_dirs: {
            type: 'array',
            items: { type: 'string' },
            description: 'project_replace: 排除目录（默认 [".godot", ".import"]）',
            default: ['.godot', '.import'],
          },
          dry_run: { type: 'boolean', description: 'project_replace: 仅预览不写入（默认 false）', default: false },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'script') return null;

  const action = args.action as string;

  switch (action) {
    case 'read_script': {
      const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(args.script_path as string));
      if (!existsSync(sp)) return textResult(`Script not found: ${sp}`);

      const content = readFileSync(sp, 'utf-8');
      const lines = content.split('\n');
      const ext = extname(sp).toLowerCase();

      // C# 文件：直接读取，返回 csharp 语言标记
      if (ext === '.cs') {
        let csClassName = '';
        let csNamespace = '';
        let csBaseClass = '';
        for (const line of lines) {
          const nsMatch = line.match(/^\s*namespace\s+(\S+)/);
          if (nsMatch) csNamespace = nsMatch[1]!;
          const clsMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+([A-Za-z_]\w*)/);
          if (clsMatch && !csClassName) csClassName = clsMatch[1]!;
          const baseMatch = line.match(/^\s*(?:public\s+)?(?:partial\s+)?class\s+[A-Za-z_]\w*\s*:\s*([A-Za-z_]\w*)/);
          if (baseMatch) csBaseClass = baseMatch[1]!;
        }
        return textResult(JSON.stringify({
          path: sp,
          language: 'csharp',
          namespace: csNamespace,
          class_name: csClassName,
          extends: csBaseClass,
          lines: lines.length,
          content,
        }, null, 2));
      }

      // GDScript 文件：解析 extends / class_name
      let extendsClass = '';
      let className = '';

      for (const line of lines) {
        const extMatch = line.match(/^extends\s+(\S+)/);
        if (extMatch) extendsClass = extMatch[1]!;
        const clsMatch = line.match(/^class_name\s+(\S+)/);
        if (clsMatch) className = clsMatch[1]!;
      }

      return textResult(JSON.stringify({
        path: sp,
        extends: extendsClass,
        class_name: className,
        lines: lines.length,
        content,
      }, null, 2));
    }

    case 'write_script': {
      const scriptPath = args.script_path as string;
      const sp = resolveWithinRoot(requireProjectPath(args), normalizeUserProjectPath(scriptPath));
      const content = args.content as string;
      const overwrite = args.overwrite === true; // default false

      if (existsSync(sp) && !overwrite) {
        return opsErrorResult('FILE_EXISTS', `File already exists: ${sp}. Set overwrite=true to replace it.`);
      }

      ensureDir(sp);
      writeFileSync(sp, content, 'utf-8');

      let lintSection = '';
      let templateHint = '';
      if (sp.endsWith('.gd')) {
        const lintOutput = lintGDScript(content);
        lintSection = formatLintResults(lintOutput);

        const allIssues = [...lintOutput.errors, ...lintOutput.warnings];
        if (allIssues.length > 0) {
          const suggestions = new Set<string>();
          for (const issue of allIssues) {
            const suggestion = getTemplateSuggestion(issue.rule);
            if (suggestion) {
              const preview = suggestion.split('\n').slice(0, 3).join('\n');
              suggestions.add(`  (${issue.rule}) → 建议:\n    ${preview}\n    ... (完整模板见 templates(action=list))`);
            }
          }
          if (suggestions.size > 0) {
            templateHint = '\n\nTemplate suggestions:\n' + [...suggestions].join('\n');
          }
        }
      }
      return textResult(`Script written to ${sp} (${content.split('\n').length} lines)${lintSection}${templateHint}`);
    }

    case 'edit_script': {
      const scriptPath = args.script_path as string;
      const projectPath = requireProjectPath(args);
      const fullPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(scriptPath));

      if (!existsSync(fullPath)) {
        return opsErrorResult('NOT_FOUND', `File not found: ${fullPath}`, {
          suggestion: 'Check the script_path for typos. Use validate_scripts to scan all scripts in the project.',
        });
      }

      const rawFile = readFileSync(fullPath, 'utf-8');
      const hasCRLF = rawFile.includes('\r\n');
      const lines = rawFile.split(/\r?\n/);
      const autoValidate = args.auto_validate !== false;

      let godotPath: string | null = null;
      if (autoValidate && fullPath.endsWith('.gd')) {
        try {
          godotPath = await ctx.findGodot();
        } catch {
          godotPath = null;
        }
      }

      // search_and_replace mode
      if (args.search_and_replace && typeof args.search_and_replace === 'object') {
        const sr = args.search_and_replace as { search: string; replace: string; occurrence?: number };
        if (!sr.search) {
          return opsErrorResult('INVALID_PARAMS', 'search_and_replace.search must be a non-empty string.');
        }
        const normalizedContent = rawFile.replace(/\r\n/g, '\n');
        const normalizedSearch = sr.search.replace(/\r\n/g, '\n');
        const normalizedReplace = sr.replace.replace(/\r\n/g, '\n');

        const occurrence = sr.occurrence ?? 1;
        let searchIndex = -1;
        let foundCount = 0;

        if (occurrence === 0) {
          if (!normalizedContent.includes(normalizedSearch)) {
            return opsErrorResult('NOT_FOUND', `search_and_replace: search text not found in ${fullPath}`);
          }
          const newFileContent = normalizedContent.replaceAll(normalizedSearch, normalizedReplace);
          const finalContent = joinWithLineEnding(newFileContent, hasCRLF);
          writeFileSync(fullPath, finalContent, 'utf-8');

          if (godotPath) {
            const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
            if (revertMsg) return textResult(revertMsg);
          }

          const count = normalizedContent.split(normalizedSearch).length - 1;

          const dupWarns = detectDuplicateLines(finalContent.split(/\r?\n/));
          const dw = formatDuplicateWarnings(dupWarns);

          let editLintSection = '';
          if (fullPath.endsWith('.gd')) {
            const editedContent = readFileSync(fullPath, 'utf-8');
            editLintSection = formatLintResults(lintGDScript(editedContent));
          }

          return textResult(`Edited ${fullPath}: replaced all ${count} occurrences of search text.${dw}${editLintSection}`);
        }

        let pos = 0;
        while (pos < normalizedContent.length) {
          const idx = normalizedContent.indexOf(normalizedSearch, pos);
          if (idx === -1) break;
          foundCount++;
          if (foundCount === occurrence) {
            searchIndex = idx;
            break;
          }
          pos = idx + 1;
        }

        if (searchIndex === -1) {
          return opsErrorResult('NOT_FOUND', `search_and_replace: occurrence ${occurrence} not found (found ${foundCount} total matches in ${fullPath})`);
        }

        const before = normalizedContent.substring(0, searchIndex);
        const after = normalizedContent.substring(searchIndex + normalizedSearch.length);
        const newFileContent = before + normalizedReplace + after;
        const finalContent = joinWithLineEnding(newFileContent, hasCRLF);
        writeFileSync(fullPath, finalContent, 'utf-8');

        if (godotPath) {
          const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath);
          if (revertMsg) return textResult(revertMsg);
        }

        const dupWarns = detectDuplicateLines(finalContent.split(/\r?\n/));
        const dw = formatDuplicateWarnings(dupWarns);

        let editLintSection = '';
        if (fullPath.endsWith('.gd')) {
          const editedContent = readFileSync(fullPath, 'utf-8');
          editLintSection = formatLintResults(lintGDScript(editedContent));
        }

        return textResult(`Edited ${fullPath}: replaced occurrence ${occurrence} of search text (${foundCount} total matches found).${dw}${editLintSection}`);
      }

      // Line-number mode
      // I-02: safe numeric conversion instead of raw `as number`
      const startLine = Number(args.start_line);
      const endLine = Number(args.end_line);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return opsErrorResult('INVALID_PARAMS', `start_line and end_line must be finite numbers, got start_line=${args.start_line}, end_line=${args.end_line}`);
      }
      const newContent = args.new_content as string;
      const indentMode = (args.indent_mode as string) || 'raw';
      const verifyContent = args.verify_content as string | undefined;

      if (startLine < 1 || endLine < startLine) {
        return opsErrorResult('INVALID_PARAMS', `Invalid line range: start_line=${startLine}, end_line=${endLine}`);
      }

      if (endLine > lines.length) {
        return opsErrorResult('INVALID_PARAMS', `end_line ${endLine} exceeds file length ${lines.length}`);
      }

      const beforeLines = lines.slice(startLine - 1, endLine);

      if (verifyContent !== undefined) {
        const existingContent = beforeLines.join('\n');
        const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\t/g, '    ').trim();
        if (normalize(existingContent) !== normalize(verifyContent)) {
          return opsErrorResult(
            'CONTENT_MISMATCH',
            `Content verification failed at lines ${startLine}-${endLine}. The file has changed since the line numbers were read.\n` +
            `--- Expected ---\n${verifyContent}\n` +
            `--- Actual ---\n${existingContent}`
          );
        }
      }

      const newLines = newContent.split(/\r?\n/);
      let adjustedLines: string[];

      if (indentMode === 'smart') {
        // 检测文件实际缩进风格（排除 0 级缩进行，只统计有实际缩进的行）
        const indentStyle = detectIndentStyle(lines);

        if (indentStyle.type === 'tab') {
          // 保持现有 tab 逻辑
          const originalLine = lines[startLine - 1] || '';
          const originalBaseIndent = (originalLine.match(/^(\t*)/) || ['',''])[1]!.length;

          const newNonEmptyLines = newLines.filter(l => l.trim() !== '');
          let newMinIndent = Infinity;
          for (const nl of newNonEmptyLines) {
            const tabs = (nl.match(/^(\t*)/) || ['',''])[1]!.length;
            if (tabs < newMinIndent) newMinIndent = tabs;
          }
          if (newMinIndent === Infinity) newMinIndent = 0;

          const indentDelta = originalBaseIndent - newMinIndent;

          adjustedLines = newLines.map((line: string) => {
            if (line.trim() === '') return line;

            const currentTabs = (line.match(/^(\t*)/) || ['',''])[1]!.length;

            if (indentDelta > 0) {
              return '\t'.repeat(indentDelta) + line;
            } else if (indentDelta < 0) {
              const tabsToRemove = Math.min(-indentDelta, currentTabs);
              return line.substring(tabsToRemove);
            }
            return line;
          });
        } else {
          // 空格缩进逻辑
          const originalLine = lines[startLine - 1] || '';
          const originalBaseIndent = (originalLine.match(/^( *)/) || ['',''])[1]!.length;

          const newNonEmptyLines = newLines.filter(l => l.trim() !== '');
          let newMinIndent = Infinity;
          for (const nl of newNonEmptyLines) {
            const spaces = (nl.match(/^( *)/) || ['',''])[1]!.length;
            if (spaces < newMinIndent) newMinIndent = spaces;
          }
          if (newMinIndent === Infinity) newMinIndent = 0;

          const indentDelta = originalBaseIndent - newMinIndent;

          adjustedLines = newLines.map((line: string) => {
            if (line.trim() === '') return line;
            const currentSpaces = (line.match(/^( *)/) || ['',''])[1]!.length;
            if (indentDelta > 0) {
              return ' '.repeat(indentDelta) + line;
            } else if (indentDelta < 0) {
              const toRemove = Math.min(-indentDelta, currentSpaces);
              return line.substring(toRemove);
            }
            return line;
          });
        }
      } else {
        adjustedLines = newLines;
      }

      lines.splice(startLine - 1, endLine - startLine + 1, ...adjustedLines);

      const result = joinWithLineEnding(lines.join('\n'), hasCRLF);
      writeFileSync(fullPath, result, 'utf-8');

      if (godotPath) {
        const ctxInfo = `Lines ${startLine}-${endLine}:\n${beforeLines.join('\n')}\n→\n${adjustedLines.join('\n')}`;
        const revertMsg = await validateAndRevert(fullPath, rawFile, godotPath, projectPath, ctxInfo);
        if (revertMsg) return textResult(revertMsg);
      }

      const afterLines = adjustedLines;
      const diffHeader = `Edited ${fullPath}: replaced lines ${startLine}-${endLine} (${beforeLines.length} lines → ${afterLines.length} lines)`;
      const diffBody = `--- Before ---\n${beforeLines.join('\n')}\n--- After ---\n${afterLines.join('\n')}`;

      const contextBefore = lines.slice(Math.max(0, startLine - 3), startLine - 1);
      const contextAfterStart = startLine - 1 + adjustedLines.length;
      const contextAfter = lines.slice(contextAfterStart, contextAfterStart + 2);
      const ctxBefore = contextBefore.length > 0 ? `\n--- Context (before) ---\n${contextBefore.join('\n')}` : '';
      const ctxAfter = contextAfter.length > 0 ? `\n--- Context (after) ---\n${contextAfter.join('\n')}` : '';

      const warnings = formatDuplicateWarnings(detectDuplicateLines(lines));
      const skipNote = (autoValidate && !fullPath.endsWith('.gd'))
        ? "\nNote: Auto-validate only supports .gd files. Other file types are not validated."
        : "";

      let editLintSection = '';
      if (fullPath.endsWith('.gd')) {
        const editedContent = readFileSync(fullPath, 'utf-8');
        editLintSection = formatLintResults(lintGDScript(editedContent));
      }

      return textResult(`${diffHeader}\n${diffBody}${ctxBefore}${ctxAfter}${warnings}${skipNote}${editLintSection}`);
    }

    case 'generate_test': {
      const projectPath = requireProjectPath(args);
      const scriptPath = args.script_path as string;
      if (!scriptPath) {
        return opsErrorResult('INVALID_PARAMS', 'script_path is required (e.g. "scripts/player.gd")');
      }

      const fullScriptPath = resolveWithinRoot(projectPath, normalizeUserProjectPath(scriptPath));
      if (!existsSync(fullScriptPath)) {
        return opsErrorResult('NOT_FOUND', `Script not found: ${fullScriptPath}`, {
          suggestion: 'Check the script_path for typos. Use validate_scripts to scan all scripts in the project.',
        });
      }

      const source = readFileSync(fullScriptPath, 'utf-8');
      const srcLines = source.split('\n');

      let extendsClass = '';
      let className = '';
      for (const line of srcLines) {
        const extMatch = line.match(/^extends\s+(\S+)/);
        if (extMatch) extendsClass = extMatch[1]!;
        const clsMatch = line.match(/^class_name\s+(\S+)/);
        if (clsMatch) className = clsMatch[1]!;
      }

      const publicMethods: string[] = [];
      const voidMethods = new Set<string>();
      for (const line of srcLines) {
        const funcMatch = line.match(/^func\s+(\w+)\s*\((?:[^)]*)\)\s*(?:->\s*(\w+))?\s*:/);
        if (funcMatch && !funcMatch[1]!.startsWith('_')) {
          publicMethods.push(funcMatch[1]!);
          if (funcMatch[2] === 'void') {
            voidMethods.add(funcMatch[1]!);
          }
        }
      }

      if (publicMethods.length === 0) {
        return textResult(
          `No public methods found in ${scriptPath}.\n` +
          `Only private methods (starting with _) were detected or the file has no functions.\n` +
          `The script extends "${extendsClass || 'unknown'}".`
        );
      }

      let testTarget: string;
      if (className) {
        testTarget = className;
      } else if (scriptPath.includes('/')) {
        testTarget = scriptPath.split('/').pop()?.replace('.gd', '') || 'Target';
      } else {
        testTarget = scriptPath.replace('.gd', '');
      }
      const scriptResPath = scriptPath.startsWith('res://') ? scriptPath : `res://${scriptPath}`;

      let testCode = 'extends GutTest\n\n';
      testCode += `var ${testTarget}  # Instance under test\n\n`;
      testCode += 'func before_each():\n';
      testCode += `\t${testTarget} = load("${gdEscape(scriptResPath)}").new()\n\n`;
      testCode += 'func after_each():\n';
      testCode += `\tif is_instance_valid(${testTarget}):\n`;
      testCode += `\t\t${testTarget}.free()\n\n`;

      for (const method of publicMethods) {
        testCode += `func test_${method}():\n`;
        if (voidMethods.has(method)) {
          testCode += `\t# void method — no return value to assert\n`;
          testCode += `\t${testTarget}.${method}()\n`;
          testCode += `\tpass # TODO: verify side effects\n\n`;
        } else {
          testCode += `\tvar result = ${testTarget}.${method}()\n`;
          testCode += `\tassert_not_null(result, "${method} should return a value")\n\n`;
        }
      }

      const outputTestPath = join(projectPath, 'test', 'scripts', `test_${basename(scriptPath)}`);

      return textResult(
        `Generated GUT test for ${scriptPath}\n\n` +
        `Target class: ${testTarget}\n` +
        `Extends: ${extendsClass || 'N/A'}\n` +
        `Class name: ${className || 'N/A'}\n` +
        `Public methods found: ${publicMethods.length}\n` +
        `  ${publicMethods.join(', ')}\n\n` +
        `Suggested save path: ${outputTestPath}\n\n` +
        `--- Generated test code ---\n${testCode}` +
        `--- End of generated code ---\n\n` +
        `To save, use: write_script(project_path="${projectPath}", script_path="test/scripts/test_${basename(scriptPath)}", content=<above code>)`
      );
    }

    case 'create_test_scene': {
      const p = requireProjectPath(args);

      const gutDir = join(p, 'addons', 'gut');
      if (!existsSync(gutDir)) {
        return textResult(
          `GUT (Godot Unit Test) addon not found at ${gutDir}.\n\n` +
          `To install GUT:\n` +
          `1. Download from: https://github.com/bitwes/Gut/releases\n` +
          `2. Extract to ${join(p, 'addons', 'gut')}\n` +
          `3. Or use the Godot Asset Library: https://godotengine.org/asset-library/asset/282\n\n` +
          `After installing GUT, run create_test_scene again.`
        );
      }

      mkdirSync(join(p, 'test', 'scripts'), { recursive: true });

      const testSceneContent = [
        '[gd_scene load_steps=2 format=3]',
        '',
        '[ext_resource type="Script" path="res://addons/gut/gut.gd" id="1_gut"]',
        '',
        '[node name="TestScene" type="Node"]',
        'script = ExtResource("1_gut")',
        '',
      ].join('\n');
      writeFileSync(join(p, 'test_scene.tscn'), testSceneContent, 'utf-8');

      return textResult(
        `GUT test scene created at ${join(p, 'test_scene.tscn')}\n\n` +
        `To run tests:\n` +
        `1. Open test_scene.tscn in Godot editor\n` +
        `2. Click "Run All" in the GUT panel\n` +
        `3. Or use run_tests(project_path="${p}") for headless testing\n\n` +
        `Test scripts should be placed in: test/scripts/`
      );
    }

    case 'execute_gdscript': {
      const projectPath = requireProjectPath(args);
      const code = args.code as string;
      // I-01: validate code is a non-empty string before passing to wrapSnippet
      if (!code || typeof code !== 'string') {
        return opsErrorResult('INVALID_PARAMS', 'code must be a non-empty string.');
      }
      const timeout = validateTimeout(args.timeout);
      const loadAutoloads = (args.load_autoloads as boolean) || false;
      const godot = await ctx.findGodot();

      const result = await executeGdscript({
        godotPath: godot,
        projectPath,
        code,
        timeout,
        loadAutoloads,
      });

      return textResult(JSON.stringify(result, null, 2));
    }

    case 'project_replace': {
      const p = requireProjectPath(args);
      const search = args.search as string;
      const replace = (args.replace as string) ?? '';
      const ALLOWED_EXTENSIONS = new Set(['.gd', '.tscn', '.tres', '.gdshader', '.cfg', '.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.toml', '.csv']);
      const HARDCODED_EXCLUDE = new Set(['.git', 'node_modules']);
      const rawExtensions: string[] = (args.extensions as string[]) || ['.gd'];
      const extensions = rawExtensions.filter(ext => ALLOWED_EXTENSIONS.has(ext));
      if (extensions.length === 0) {
        return opsErrorResult('INVALID_PARAMS', `No allowed extensions. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`);
      }
      const userExcludeDirs: string[] = (args.exclude_dirs as string[]) || ['.godot', '.import'];
      const excludeDirs = [...new Set([...userExcludeDirs, ...HARDCODED_EXCLUDE])];
      const dryRun = args.dry_run === true;

      if (!search) {
        return opsErrorResult('INVALID_PARAMS', 'search must be a non-empty string.');
      }

      const normalizedSearch = search.replace(/\r\n/g, '\n');
      const normalizedReplace = replace.replace(/\r\n/g, '\n');

      // I-01, I-03: Clean up residual .bak / .mcp-tmp files from interrupted atomic writes
      // Scan all top-level subdirectories (not just . and src) since project_replace can affect any location
      const cleanedResiduals: string[] = [];
      for (const suffix of ['.bak', '.mcp-tmp']) {
        try {
          const rootEntries = readdirSync(p, { withFileTypes: true });
          for (const rootEntry of rootEntries) {
            const absDir = join(p, rootEntry.name);
            // Only scan directories that aren't excluded and the root itself
            const isExcluded = excludeDirs.includes(rootEntry.name) || rootEntry.name.startsWith('.');
            const targets = isExcluded ? [] : (rootEntry.isDirectory() ? [absDir] : rootEntry.isFile() && rootEntry.name.endsWith(suffix) ? [absDir] : []);
            // Also check root-level files matching suffix
            if (rootEntry.isFile() && rootEntry.name.endsWith(suffix)) {
              try { unlinkSync(absDir); cleanedResiduals.push(rootEntry.name); } catch { /* best effort */ }
              continue;
            }
            for (const targetDir of targets) {
              if (!existsSync(targetDir)) continue;
              const entries = readdirSync(targetDir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith(suffix)) {
                  const residualPath = join(targetDir, entry.name);
                  try { unlinkSync(residualPath); cleanedResiduals.push(join(rootEntry.name, entry.name)); } catch { /* best effort */ }
                }
              }
            }
          }
        } catch { /* non-critical cleanup */ }
      }

      // Collect files
      const MAX_FILES = 500;
      const matchedFiles: string[] = [];
      const skippedDirs: string[] = [];
      function scanDir(dir: string, depth: number): void {
        if (matchedFiles.length >= MAX_FILES) return;
        if (depth > 15) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (matchedFiles.length >= MAX_FILES) return;
            if (entry.name.startsWith('.')) continue;
            if (excludeDirs.includes(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (existsSync(join(full, '.gdignore'))) continue;
              scanDir(full, depth + 1);
            } else if (extensions.some(ext => entry.name.endsWith(ext))) {
              matchedFiles.push(full);
            }
          }
        } catch (err) {
          getLogger().debug('script', `scan dir for files: ${err instanceof Error ? err.message : err}`);
          skippedDirs.push(dir.slice(p.length + 1) || dir);
        }
      }
      scanDir(p, 0);
      if (matchedFiles.length >= MAX_FILES) {
        return opsErrorResult('INVALID_PARAMS', `Too many matching files (>${MAX_FILES}). Narrow the search with more specific extensions or add directories to exclude_dirs.`);
      }

      const relOf = (absPath: string) => absPath.slice(p.length + 1);

      const changedFiles: string[] = [];
      const unchangedFiles: string[] = [];
      const skippedLarge: string[] = [];
      let totalReplacements = 0;
      const MAX_FILE_SIZE = 1_000_000; // 1MB

      // Phase 1: 收集所有变更到内存
      const pendingWrites: Array<{ filePath: string; finalContent: string }> = [];

      for (const filePath of matchedFiles) {
        try {
          const fileSize = statSync(filePath).size;
          if (fileSize > MAX_FILE_SIZE) {
            skippedLarge.push(relOf(filePath));
            continue;
          }
        } catch (e) { getLogger().debug('script', `stat failed for ${filePath}: ${e instanceof Error ? e.message : e}`); continue; }
        const content = readFileSync(filePath, 'utf-8');
        const hasCRLF = content.includes('\r\n');
        const normalized = content.replace(/\r\n/g, '\n');

        if (!normalized.includes(normalizedSearch)) {
          unchangedFiles.push(relOf(filePath));
          continue;
        }

        const count = normalized.split(normalizedSearch).length - 1;
        totalReplacements += count;

        if (!dryRun) {
          const newContent = normalized.replaceAll(normalizedSearch, normalizedReplace);
          const finalContent = hasCRLF ? newContent.split('\n').join('\r\n') : newContent;
          pendingWrites.push({ filePath, finalContent });
        }

        changedFiles.push(relOf(filePath));
      }

      // Phase 2: Best-effort atomic write — backup originals, write .tmp, rename with rollback
      if (!dryRun && pendingWrites.length > 0) {
        const tmpFiles: string[] = [];
        const bakFiles: string[] = [];
        const renamedCount = { value: 0 };
        try {
          // Step 1: Write all .tmp files (safe — originals untouched)
          for (const pw of pendingWrites) {
            const tmpPath = pw.filePath + '.tmp';
            writeFileSync(tmpPath, pw.finalContent, 'utf-8');
            tmpFiles.push(tmpPath);
          }
          // Step 2: Backup originals to .bak (needed for rollback)
          for (const pw of pendingWrites) {
            const bakPath = pw.filePath + '.bak';
            copyFileSync(pw.filePath, bakPath);
            bakFiles.push(bakPath);
          }
          // Step 3: Rename .tmp → target
          for (let i = 0; i < pendingWrites.length; i++) {
            renameSync(tmpFiles[i]!, pendingWrites[i]!.filePath);
            renamedCount.value++;
          }
        } catch (writeErr) {
          // Rollback: restore .bak for already-renamed files
          for (let i = 0; i < renamedCount.value; i++) {
            try { renameSync(bakFiles[i]!, pendingWrites[i]!.filePath); } catch { /* best effort */ }
          }
          // Cleanup .tmp and remaining .bak files
          for (const tmp of tmpFiles) {
            try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
          }
          for (const bak of bakFiles) {
            try { if (existsSync(bak)) unlinkSync(bak); } catch { /* best effort */ }
          }
          return opsErrorResult('ATOMIC_WRITE_FAILED', `Batch write failed: ${(writeErr as Error).message}. Rollback attempted for ${renamedCount.value} files.`);
        }
        // Success: cleanup .bak files
        for (const bak of bakFiles) {
          try { if (existsSync(bak)) unlinkSync(bak); } catch { /* best effort */ }
        }
        // Cleanup .tmp (already renamed, but defensive)
        for (const tmp of tmpFiles) {
          try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
        }
      }

      const prefix = dryRun ? '[DRY RUN] ' : '';
      const summary = [
        `${prefix}Batch replace complete.`,
        `Search: "${search.substring(0, 80)}${search.length > 80 ? '...' : ''}"`,
        `Replace: "${replace.substring(0, 80)}${replace.length > 80 ? '...' : ''}"`,
        `Extensions: ${extensions.join(', ')}`,
        `Scanned: ${matchedFiles.length} files`,
        `Changed: ${changedFiles.length} files (${totalReplacements} replacements)`,
        unchangedFiles.length > 0 ? `Unchanged: ${unchangedFiles.length} files` : '',
        skippedLarge.length > 0 ? `Skipped (>${MAX_FILE_SIZE / 1_000_000}MB): ${skippedLarge.length} files` : '',
        skippedDirs.length > 0 ? `Skipped dirs (unreadable): ${skippedDirs.slice(0, 10).join(', ')}${skippedDirs.length > 10 ? ` ... and ${skippedDirs.length - 10} more` : ''}` : '',
        cleanedResiduals.length > 0 ? `Cleaned residuals: ${cleanedResiduals.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      const details = changedFiles.length > 0
        ? '\n\nChanged files:\n' + changedFiles.slice(0, 50).map(f => `  ${f}`).join('\n')
          + (changedFiles.length > 50 ? `\n  ... and ${changedFiles.length - 50} more` : '')
        : '\n\nNo files contained the search text.';

      return textResult(summary + details);
    }

    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  script: { readonly: false, long_running: false },
};
