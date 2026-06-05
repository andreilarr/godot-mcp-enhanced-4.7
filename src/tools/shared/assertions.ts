// Assertion infrastructure for dev_loop acceptance and delivery.ts assertions.

import { gdEscape } from './value-serializer.js';
import { SCENE_TREE_HEADER } from './gdscript-templates.js';

/** Shared assertion wrapper — called by both dev_loop.acceptance and delivery.ts assertions */
export function wrapAssertionCode(assertionCode: string, description: string, loadScene = true): string {
  const escapedDesc = gdEscape(description);
  const sceneLoadLine = loadScene ? '\t_mcp_load_main_scene()\n' : '';
  return `${SCENE_TREE_HEADER}

func _initialize():
${sceneLoadLine}\tvar _desc = "${escapedDesc}"
\t# --- user assertion code ---
\t${assertionCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join('\n\t')}
\t# --- end user code ---
\t_mcp_done()
`;
}
