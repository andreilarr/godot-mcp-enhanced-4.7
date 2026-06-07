// Assertion infrastructure for dev_loop acceptance and delivery.ts assertions.

import { gdEscape } from './value-serializer.js';
import { SCENE_TREE_HEADER } from './gdscript-templates.js';
import { scanGdscriptSandbox } from '../../gdscript-executor.js';

/** Normalize leading spaces to tabs to prevent "Mixed tabs and spaces" errors.
 *  Detects the smallest nonzero leading-space count as the indent unit,
 *  then replaces each group of that many spaces with one tab. */
function normalizeIndentToTabs(code: string): string {
  const lines = code.split('\n');
  let indentUnit = 0;
  for (const line of lines) {
    const m = line.match(/^( +)\S/);
    if (m) {
      const len = m[1]!.length;
      if (indentUnit === 0 || len < indentUnit) {
        indentUnit = len;
      }
    }
  }
  if (indentUnit === 0) return code;

  return lines.map(line => {
    let leadingSpaces = 0;
    while (leadingSpaces < line.length && line[leadingSpaces] === ' ') {
      leadingSpaces++;
    }
    if (leadingSpaces === 0) return line;
    const tabs = Math.floor(leadingSpaces / indentUnit);
    const remainder = leadingSpaces % indentUnit;
    return '\t'.repeat(tabs) + ' '.repeat(remainder) + line.slice(leadingSpaces);
  }).join('\n');
}

/** Shared assertion wrapper — called by both dev_loop.acceptance and delivery.ts assertions.
 *  Scans user assertion code through the GDScript sandbox before wrapping (C-SEC-07). */
export function wrapAssertionCode(assertionCode: string, description: string, loadScene = true): string {
  const sandboxWarnings = scanGdscriptSandbox(assertionCode);
  if (sandboxWarnings.length > 0) {
    throw new Error(`Assertion code blocked by sandbox: ${sandboxWarnings.join('; ')}`);
  }
  const escapedDesc = gdEscape(description);
  const sceneLoadLine = loadScene ? '\t_mcp_load_main_scene()\n' : '';
  // Normalize spaces to tabs BEFORE joining with tab prefix to avoid mixed indentation
  const normalizedCode = normalizeIndentToTabs(assertionCode.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const indentedCode = normalizedCode.split('\n').join('\n\t');
  return `${SCENE_TREE_HEADER}

func _initialize():
${sceneLoadLine}\tvar _desc = "${escapedDesc}"
\t# --- user assertion code ---
\t${indentedCode}
\t# --- end user code ---
\t_mcp_done()
`;
}
