// src/tools/delivery.ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, gdEscape, wrapAssertionCode } from './shared.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Issue {
  severity: 'error' | 'warning';
  location: string;
  message: string;
  suggestion?: string;
}

// ─── Tool Definition ────────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'verify_delivery',
      description:
        'End-to-end delivery verification tool. Four-dimension checks: scene tree integrity, script robustness, performance/resource health, and custom behavior assertions. ' +
        'Returns a structured report with clear pass/fail per dimension. scope controls scanning range, checks controls which dimensions to run.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          scope: {
            type: 'string',
            enum: ['scene', 'script', 'full'],
            description: 'Verification scope: scene, script, or full project',
          },
          scene_path: { type: 'string', description: 'Scene path for scope=scene (relative to project)' },
          script_path: { type: 'string', description: 'Script path for scope=script (relative to project)' },
          checks: {
            type: 'object',
            description: 'Check dimensions (all default to true)',
            properties: {
              scene_tree: { type: 'boolean', description: 'Check scene tree integrity' },
              script_health: { type: 'boolean', description: 'Check script robustness' },
              performance: { type: 'boolean', description: 'Check performance/resource health' },
              assertions: {
                type: 'array',
                description: 'Custom behavior assertions (max 10)',
                items: {
                  type: 'object',
                  properties: {
                    description: { type: 'string' },
                    gdscript: { type: 'string' },
                    expect: { type: 'string' },
                  },
                  required: ['description', 'gdscript'],
                },
              },
            },
          },
        },
        required: ['project_path', 'scope'],
      },
    },
  ];
}

// ─── Scene Integrity Helpers ────────────────────────────────────────────────

export function checkSceneIntegrity(projectPath: string, scenePath: string): { passed: boolean; issues: Issue[] } {
  const issues: Issue[] = [];
  const fullPath = join(projectPath, scenePath);

  if (!existsSync(fullPath)) {
    return { passed: false, issues: [{ severity: 'error', location: scenePath, message: `Scene file not found: ${scenePath}` }] };
  }

  const content = readFileSync(fullPath, 'utf-8');

  // Check ext_resource references
  const extRegex = /^\[ext_resource[^]*path="res:\/\/([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = extRegex.exec(content)) !== null) {
    const refPath = match[1];
    const diskPath = join(projectPath, refPath);
    if (!existsSync(diskPath)) {
      issues.push({
        severity: 'error',
        location: `${scenePath}:res://${refPath}`,
        message: `Referenced resource not found: res://${refPath}`,
      });
    }
  }

  // Check [connection] static signals
  const connRegex = /^\[connection\s+.*?\]/gm;
  while ((match = connRegex.exec(content)) !== null) {
    const line = match[0];
    const target = line.match(/target="([^"]+)"/)?.[1];
    const method = line.match(/method="([^"]+)"/)?.[1];
    const signal = line.match(/signal="([^"]+)"/)?.[1];
    if (target !== undefined && method !== undefined) {
      if (!target.trim() || !method.trim()) {
        issues.push({
          severity: 'warning',
          location: `${scenePath}:connection`,
          message: `Malformed connection: signal=${signal ?? '?'}, target=${target}, method=${method}`,
        });
      }
    }
  }

  return { passed: issues.filter(i => i.severity === 'error').length === 0, issues };
}

export function findAssociatedScenes(projectPath: string, scriptPath: string): string[] {
  const scenes: string[] = [];
  const scriptResPath = `res://${scriptPath}`;

  function scanDir(dir: string, relPrefix: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== '.godot' && entry.name !== '.import') {
            scanDir(join(dir, entry.name), `${relPrefix}${entry.name}/`);
          }
        } else if (entry.name.endsWith('.tscn')) {
          const content = readFileSync(join(dir, entry.name), 'utf-8');
          if (content.includes(`"${scriptResPath}"`)) {
            scenes.push(`${relPrefix}${entry.name}`);
          }
        }
      }
    } catch { /* ignore unreadable dirs */ }
  }

  scanDir(projectPath, '');
  return scenes;
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'verify_delivery') return null;

  const projectPath = validatePath(args.project_path as string);
  const scope = args.scope as string;
  const checks = (args.checks as Record<string, unknown>) ?? {};

  const sceneTree = checks.scene_tree !== false;
  const scriptHealth = checks.script_health !== false;
  const perfCheck = checks.performance !== false;
  const assertions = (checks.assertions as Array<Record<string, string>>) ?? [];

  const report: Record<string, unknown> = {};
  const dimensionResults: Array<{ dim: string; passed: boolean }> = [];

  // ── Dimension 1: Scene tree integrity ──
  if (sceneTree) {
    let scenePaths: string[] = [];

    if (scope === 'scene') {
      const sp = args.scene_path as string;
      if (!sp) {
        report.scene_tree = { passed: false, issues: [{ severity: 'error', location: '', message: 'scene_path required for scope=scene' }] };
      } else {
        scenePaths = [sp];
      }
    } else if (scope === 'script') {
      const sp = args.script_path as string;
      if (!sp) {
        report.scene_tree = { passed: false, issues: [{ severity: 'error', location: '', message: 'script_path required for scope=script' }] };
      } else {
        scenePaths = findAssociatedScenes(projectPath, sp);
      }
    } else {
      // scope=full: collect all .tscn
      function collectScenes(dir: string, prefix: string): string[] {
        const result: string[] = [];
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && e.name !== '.godot' && e.name !== '.import') {
              result.push(...collectScenes(join(dir, e.name), `${prefix}${e.name}/`));
            } else if (e.name.endsWith('.tscn')) {
              result.push(`${prefix}${e.name}`);
            }
          }
        } catch { /* ignore */ }
        return result;
      }
      scenePaths = collectScenes(projectPath, '');
    }

    if (!report.scene_tree) {
      const allIssues: Issue[] = [];
      for (const sp of scenePaths) {
        const result = checkSceneIntegrity(projectPath, sp);
        allIssues.push(...result.issues);
      }
      const passed = allIssues.filter(i => i.severity === 'error').length === 0;
      report.scene_tree = { passed, issues: allIssues };
      dimensionResults.push({ dim: 'scene_tree', passed });
    } else {
      dimensionResults.push({ dim: 'scene_tree', passed: (report.scene_tree as { passed: boolean }).passed });
    }
  }

  // ── Dimension 2: Script health ──
  if (scriptHealth) {
    const issues: Issue[] = [];
    let scriptPaths: string[] = [];

    if (scope === 'script') {
      const sp = args.script_path as string;
      if (sp) scriptPaths = [sp];
    } else if (scope === 'scene') {
      const scenePath = args.scene_path as string;
      if (scenePath) {
        const fullPath = join(projectPath, scenePath);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf-8');
          const scriptRegex = /path="(res:\/\/[^"]+\.gd)"/g;
          let m: RegExpExecArray | null;
          while ((m = scriptRegex.exec(content)) !== null) {
            scriptPaths.push(m[1].replace('res://', ''));
          }
        }
      }
    } else {
      function collectScripts(dir: string, prefix: string): string[] {
        const result: string[] = [];
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && e.name !== '.godot' && e.name !== '.import' && e.name !== 'addons') {
              result.push(...collectScripts(join(dir, e.name), `${prefix}${e.name}/`));
            } else if (e.name.endsWith('.gd')) {
              result.push(`${prefix}${e.name}`);
            }
          }
        } catch { /* ignore */ }
        return result;
      }
      scriptPaths = collectScripts(projectPath, '');
    }

    // Check file existence
    for (const sp of scriptPaths) {
      if (!existsSync(join(projectPath, sp))) {
        issues.push({ severity: 'error', location: sp, message: `Script file not found: ${sp}` });
      }
    }

    // Check preload/load references
    for (const sp of scriptPaths) {
      const fullPath = join(projectPath, sp);
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, 'utf-8');
      const preloadRegex = /(?:preload|load)\("res:\/\/([^"]+)"\)/g;
      let m: RegExpExecArray | null;
      while ((m = preloadRegex.exec(content)) !== null) {
        if (!existsSync(join(projectPath, m[1]))) {
          issues.push({
            severity: 'warning',
            location: sp,
            message: `Resource not found: res://${m[1]} (referenced by preload/load)`,
          });
        }
      }
    }

    const passed = issues.filter(i => i.severity === 'error').length === 0;
    report.script_health = { passed, issues };
    dimensionResults.push({ dim: 'script_health', passed });
  }

  // ── Dimension 3: Performance/resource health ──
  if (perfCheck) {
    const godot = await ctx.findGodot();
    const perfScript = `${SCENE_TREE_HEADER}

func _initialize():
\t_mcp_load_main_scene()
\tvar _data: Dictionary = {}
\t_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\t_data["static_memory_mb"] = Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0
\t_data["resource_count"] = int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT))
\t_mcp_output("perf", _data)
\t_mcp_done()
`;
    const perfResult = await executeGdscript({
      godotPath: godot, projectPath, code: perfScript, timeout: 20, loadAutoloads: false,
    });

    const perfIssues: Issue[] = [];
    let perfData: Record<string, unknown> = {};

    if (perfResult.compile_success && perfResult.run_success) {
      for (const entry of perfResult.outputs) {
        if (entry.key === 'perf') {
          try { perfData = JSON.parse(entry.value); } catch { perfData = { raw: entry.value }; }
        }
      }
      const orphans = (perfData.orphan_node_count as number) ?? 0;
      if (orphans > 100) {
        perfIssues.push({
          severity: 'warning',
          location: '(project-wide)',
          message: `High orphan node count: ${orphans}`,
          suggestion: 'Check for nodes created without add_child or missing queue_free() calls',
        });
      }
    } else {
      perfIssues.push({ severity: 'warning', location: '(project-wide)', message: 'Performance snapshot unavailable' });
    }

    const perfPassed = perfIssues.filter(i => i.severity === 'error').length === 0;
    report.performance = { passed: perfPassed, issues: perfIssues, metrics: perfData };
    dimensionResults.push({ dim: 'performance', passed: perfPassed });
  }

  // ── Dimension 4: Custom behavior assertions ──
  if (assertions.length > 0) {
    if (assertions.length > 10) {
      report.assertions = { passed: false, results: [], error: 'Too many assertions (max 10)' };
      dimensionResults.push({ dim: 'assertions', passed: false });
    } else {
      const godot = await ctx.findGodot();
      const assertionResults: Array<Record<string, unknown>> = [];

      for (const a of assertions) {
        const desc = a.description ?? 'unnamed assertion';
        const expected = a.expect;
        try {
          const wrappedCode = wrapAssertionCode(a.gdscript, desc);
          const assertResult = await executeGdscript({
            godotPath: godot, projectPath, code: wrappedCode, timeout: 15, loadAutoloads: false,
          });

          if (!assertResult.compile_success) {
            assertionResults.push({ description: desc, passed: false, error: assertResult.compile_error });
          } else if (!assertResult.run_success) {
            assertionResults.push({ description: desc, passed: false, error: assertResult.run_error });
          } else {
            let actual = '';
            for (const entry of assertResult.outputs) {
              if (entry.key === 'assert_result') actual = entry.value;
            }
            const passed = expected ? actual === expected : true;
            assertionResults.push({ description: desc, passed, actual, expected });
          }
        } catch (err) {
          assertionResults.push({ description: desc, passed: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const allPassed = assertionResults.every(r => r.passed);
      report.assertions = { passed: allPassed, results: assertionResults };
      dimensionResults.push({ dim: 'assertions', passed: allPassed });
    }
  }

  // ── Summary ──
  const passedCount = dimensionResults.filter(d => d.passed).length;
  const totalCount = dimensionResults.length;
  report.passed = dimensionResults.every(d => d.passed);
  report.summary = `${passedCount}/${totalCount} dimensions passed`;

  return textResult(JSON.stringify(report, null, 2));
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  verify_delivery: { readonly: true, long_running: true },
};
