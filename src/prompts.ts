// src/prompts.ts — MCP Prompt templates for guided workflows
import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js';

export interface PromptDef {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

/**
 * Phase 1 static prompt templates.
 *
 * These templates provide structured guidance text for common workflows.
 * They do not dynamically analyze the project — the parameters are used
 * only for string interpolation into the template text.
 *
 * Future phases will add dynamic context (scene analysis, project scan, etc.)
 * by replacing the static build() functions with tool-calling logic.
 */
const PROMPTS: Record<string, { def: PromptDef; build: (args: Record<string, string>) => PromptMessage[] }> = {
  create_platformer: {
    def: {
      name: 'create_platformer',
      description: '2D platformer game scaffold guidance',
      arguments: [
        { name: 'project_name', description: 'Project name', required: false },
        { name: 'resolution', description: 'Target resolution (e.g. 1920x1080)', required: false },
      ],
    },
    build: (args) => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# 2D Platformer Scaffold Guide — ${args.project_name || 'platformer'}\n\n## Resolution: ${args.resolution || '1280x720'}\n\n## Steps\n1. **Project Setup**: Create project with viewport ${args.resolution || '1280x720'}\n2. **Player Scene**: CharacterBody2D with sprite, collision shape, camera\n3. **Player Script**: move_and_slide with gravity, jump, horizontal movement\n4. **Level TileMap**: TileMapLayer with ground tiles and collision\n5. **Collectibles**: Area2D-based coins with animation\n6. **UI**: VBoxContainer with score label and lives counter\n7. **Game Loop**: game_over and restart logic\n\n## Key Tools\n- create_scene, write_script, tilemap_fill_rect, add_node, save_scene, run_and_verify` },
    }],
  },
  setup_player_controller: {
    def: {
      name: 'setup_player_controller',
      description: 'Player controller setup guidance',
      arguments: [
        { name: 'dimension', description: '2d or 3d', required: false },
        { name: 'movement_type', description: 'topdown, platformer, or fps', required: false },
      ],
    },
    build: (args) => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# Player Controller Guide — ${(args.dimension || '2d').toUpperCase()} ${args.movement_type || 'platformer'}\n\n## Root: ${args.dimension === '3d' ? 'CharacterBody3D' : 'CharacterBody2D'}\n\n## Steps\n1. Define move_left, move_right, jump input actions\n2. Write move_and_slide() controller script\n3. Attach ${args.dimension === '3d' ? 'Camera3D' : 'Camera2D'}\n4. Wire sprite animations for idle/walk/jump` },
    }],
  },
  optimize_scene: {
    def: {
      name: 'optimize_scene',
      description: 'Scene optimization analysis guidance',
      arguments: [
        { name: 'scene_path', description: 'Scene file path', required: false },
      ],
    },
    build: (args) => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# Scene Optimization Guide — ${args.scene_path || 'res://scenes/main.tscn'}\n\n## Analysis Steps\n1. read_scene to understand structure\n2. Count nodes (>500 may need splitting)\n3. Verify sprites use atlas textures\n4. Prefer simple collision shapes\n5. Check for script duplication\n\n## Verification\nRun verify_delivery(scope="scene") to check scene health.` },
    }],
  },
  debug_performance: {
    def: {
      name: 'debug_performance',
      description: 'Performance debugging walkthrough',
      arguments: [],
    },
    build: () => [{
      role: 'user' as const,
      content: { type: 'text' as const, text: `# Performance Debugging Guide\n\n## Step 1: Baseline\n- profiler snapshot for FPS, frame time, draw calls\n\n## Step 2: Identify Bottlenecks\n- Low FPS: check _process functions\n- High memory: look for resource leaks\n- Draw calls >1000: reduce visible nodes\n\n## Step 3: Common Fixes\n- Move heavy logic to timers\n- Disconnect unused signals\n- Use object pooling\n\n## Step 4: Measure Impact\nRun profiler_get_data after each fix.` },
    }],
  },
};

export function listPrompts(): PromptDef[] {
  return Object.values(PROMPTS).map(p => p.def);
}

export async function getPrompt(name: string, args: Record<string, string>): Promise<{ messages: PromptMessage[] }> {
  const prompt = PROMPTS[name];
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  return { messages: prompt.build(args) };
}
