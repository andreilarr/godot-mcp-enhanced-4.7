/**
 * Tool module auto-registration — C-ARCH-01
 *
 * Centralizes all tool module imports and registration in one place.
 * GodotServer.ts only needs to call registerAllModules().
 * Adding a new tool module requires editing ONLY this file.
 */

import { registerModule, TOOL_GROUPS } from './tool-registry.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ─── Tool module imports ─────────────────────────────────────────────────────
import * as runtime from '../tools/runtime.js';
import * as screenshot from '../tools/screenshot.js';
import * as project from '../tools/project.js';
import * as scene from '../tools/scene.js';
import * as script from '../tools/script.js';
import * as validation from '../tools/validation.js';
import * as docs from '../tools/docs.js';
import * as node3dOps from '../tools/node-3d-ops.js';
import * as physicsOps from '../tools/physics-ops.js';
import * as audioOps from '../tools/audio-ops.js';
import * as tilemapOps from '../tools/tilemap-ops.js';
import * as materialOps from '../tools/material-ops.js';
import * as gameBridge from '../tools/game-bridge.js';
import * as workflow from '../tools/workflow.js';
import * as animationOps from '../tools/animation-ops.js';
import * as profilerOps from '../tools/profiler-ops.js';
import * as spatialOps from '../tools/spatial-ops.js';
import * as testFramework from '../tools/test-framework.js';
import * as animtreeOps from '../tools/animtree.js';
import * as navigationOps from '../tools/navigation.js';
import * as particlesOps from '../tools/particles.js';
import * as signalOps from '../tools/signal-ops.js';
import * as batchTools from '../tools/batch-tools.js';
import * as uiOps from '../tools/ui-tools.js';
import * as recordingOps from '../tools/recording.js';
import * as editorSync from '../tools/editor-sync.js';
import * as animationTrack from '../tools/animation-track.js';
import * as delivery from '../tools/delivery.js';
import * as codeTemplates from '../tools/code-templates.js';
import * as ikTools from '../tools/ik-tools.js';
import * as gameDesign from '../tools/game-design.js';
import * as sceneCommit from '../tools/scene-commit-tool.js';
import * as manageTools from '../tools/manage-tools.js';
import * as instanceTools from '../tools/instance-tools.js';

// ─── Registration ─────────────────────────────────────────────────────────────

/** All tool modules in registration order. */
const ALL_MODULES = [
  runtime, screenshot, project, scene, script, validation, docs,
  node3dOps, physicsOps, audioOps, tilemapOps, materialOps,
  gameBridge, workflow, animationOps, animationTrack, profilerOps,
  spatialOps, testFramework, animtreeOps, navigationOps, particlesOps,
  signalOps, batchTools, uiOps, recordingOps, editorSync,
  delivery, codeTemplates, ikTools, gameDesign, sceneCommit, manageTools, instanceTools,
];

// ─── Tag injection ─────────────────────────────────────────────────────────────

/** Build tool→group mapping for tag injection. */
function buildToolGroupMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [group, def] of Object.entries(TOOL_GROUPS)) {
    for (const tool of def.tools) {
      map.set(tool, group);
    }
  }
  return map;
}

const toolGroupMap = buildToolGroupMap();

/** Inject annotations.tags into tool definitions based on TOOL_GROUPS mapping. */
function injectTags(defs: Tool[]): Tool[] {
  return defs.map(def => ({
    ...def,
    annotations: {
      ...def.annotations,
      tags: [`group:${toolGroupMap.get(def.name) ?? 'unknown'}`],
    },
  }));
}

/** Register all tool modules into the global registry. */
export function registerAllModules(): void {
  for (const mod of ALL_MODULES) {
    const originalGetDefs = mod.getToolDefinitions;
    const wrappedMod = {
      ...mod,
      TOOL_META: mod.TOOL_META,
      getToolDefinitions: () => injectTags(originalGetDefs.call(mod)),
    };
    registerModule(wrappedMod);
  }
}
