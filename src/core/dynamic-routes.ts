// src/core/dynamic-routes.ts
/**
 * Dynamic route derivation + error classification (Phase 3)
 *
 * These utilities enable lazy tool discovery — new Godot-side tools can be
 * called through godot_advanced_tool without MCP-side code changes.
 */

// ─── Route derivation ─────────────────────────────────────────────────────────

/** Known irregular tool→route mappings that don't follow convention. */
const ROUTE_OVERRIDES: Record<string, string> = {
  // Add known overrides here as needed
};

/**
 * Convert a tool name to a Godot-side API route.
 *
 * Convention: godot_category_action → category/action
 * Examples:
 *   godot_custom_light_bake → custom/light-bake
 *   godot_terrain_sculpt → terrain/sculpt
 *   godot_animation_play → animation/play
 *
 * Only accepts tool names with the 'godot_' prefix.
 * Returns null for names that don't match.
 */
export function toolNameToRoute(toolName: string): string | null {
  if (ROUTE_OVERRIDES[toolName]) return ROUTE_OVERRIDES[toolName];

  if (!toolName.startsWith('godot_')) return null;

  const withoutPrefix = toolName.slice(6); // strip 'godot_'
  const parts = withoutPrefix.split('_');
  if (parts.length < 2) return null; // need at least category + action

  const category = parts[0];
  const action = parts.slice(1).join('-');
  return `${category}/${action}`;
}

// ─── Error classification ─────────────────────────────────────────────────────

export type ErrorClass = 'permanent' | 'transient';

/**
 * Classify an HTTP status code for retry decisions.
 *
 * - 4xx (client errors): permanent — don't retry
 * - 5xx (server errors): transient — retry with backoff
 * - Other: permanent — conservative default
 */
export function classifyError(status: number): ErrorClass {
  if (status >= 500) return 'transient';
  return 'permanent'; // 4xx and everything else
}
