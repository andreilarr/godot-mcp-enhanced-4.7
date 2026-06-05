// UI theme operations: ui_set_theme, theme_create, theme_set_property.

import { gdEscape, sanitizeResPath, SCENE_TREE_HEADER } from '../shared.js';

// ─── ui_set_theme ──────────────────────────────────────────────────────────

export function genUiSetThemeScript(
  scenePath: string,
  nodePath: string,
  action: 'set_params' | 'create' | 'save' | 'load',
  themePath?: string,
  params?: Record<string, unknown>,
): string {
  let actionBlock: string;

  switch (action) {
    case 'create':
      actionBlock = `
\tvar theme = Theme.new()
\tnode.theme = theme`;
      break;
    case 'set_params': {
      const paramLines: string[] = [];
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === null || value === undefined) {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", null)`);
          } else if (typeof value === 'number') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", ${value})`);
          } else if (typeof value === 'boolean') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", ${String(value)})`);
          } else if (typeof value === 'string') {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", "${gdEscape(value)}")`);
          } else if (Array.isArray(value) && value.length === 4) {
            paramLines.push(`\ttheme.set("${gdEscape(key)}", Color(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]}))`);
          }
        }
      }
      actionBlock = `
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme assigned")
\t\t_mcp_done()
\t\treturn${paramLines.length > 0 ? '\n' + paramLines.join('\n') : ''}`;
      break;
    }
    case 'save':
      if (!themePath) throw new Error('theme_path is required for save action');
      actionBlock = `
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme to save")
\t\t_mcp_done()
\t\treturn
\tvar dir = "${gdEscape(themePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar err = ResourceSaver.save(theme, "${gdEscape(themePath)}")
\tif err != OK:
\t\t_mcp_output("error", "Failed to save theme: " + str(err))
\t\t_mcp_done()
\t\treturn`;
      break;
    case 'load':
      if (!themePath) throw new Error('theme_path is required for load action');
      actionBlock = `
\tvar res = load("${gdEscape(themePath)}")
\tif res == null:
\t\t_mcp_output("error", "Failed to load theme from: ${gdEscape(themePath)}")
\t\t_mcp_done()
\t\treturn
\tnode.theme = res`;
      break;
  }

  const outputKey = action === 'save' ? 'saved' : action === 'load' ? 'loaded' : 'theme_set';
  const outputValue = action === 'save'
    ? '{"resource_path": "' + gdEscape(themePath || '') + '"}'
    : action === 'load'
      ? '{"resource_path": "' + gdEscape(themePath || '') + '"}'
      : '{"node": "' + gdEscape(nodePath) + '", "action": "' + action + '"}';

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn
\tvar node = _mcp_get_scene_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not node is Control:
\t\t_mcp_output("error", "Node is not a Control: " + node.get_class())
\t\t_mcp_done()
\t\treturn${actionBlock}
\t_mcp_output("${outputKey}", ${outputValue})
\t_mcp_done()
`;
}

// ─── theme_create ──────────────────────────────────────────────────────────

export function genThemeCreateScript(
  scenePath: string,
  action: 'create' | 'extract',
  sourceNodePath?: string,
  savePath?: string,
): string {
  let actionBlock: string;

  if (action === 'create') {
    actionBlock = `
\tvar theme = Theme.new()`;
  } else {
    // extract
    if (!sourceNodePath) throw new Error('source_node_path is required for extract action');
    actionBlock = `
\tvar source = _mcp_get_scene_node("${gdEscape(sourceNodePath)}")
\tif source == null:
\t\t_mcp_output("error", "Source node not found: ${gdEscape(sourceNodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not source is Control:
\t\t_mcp_output("error", "Source node is not a Control: " + source.get_class())
\t\t_mcp_done()
\t\treturn
\tvar theme = source.theme
\tif theme == null:
\t\t_mcp_output("error", "Source node has no theme")
\t\t_mcp_done()
\t\treturn`;
  }

  let saveBlock = '';
  if (savePath) {
    saveBlock = `
\tvar dir = "${gdEscape(savePath)}".get_base_dir()
\tif not DirAccess.dir_exists_absolute(dir):
\t\tDirAccess.make_dir_recursive_absolute(dir)
\tvar err = ResourceSaver.save(theme, "${gdEscape(savePath)}")
\tif err != OK:
\t\t_mcp_output("error", "Failed to save theme: " + str(err))
\t\t_mcp_done()
\t\treturn
\t_mcp_output("saved", {"resource_path": "${gdEscape(savePath)}"})
\t_mcp_done()
\treturn`;
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
\tif not _mcp_load_scene("${gdEscape(scenePath)}"):
\t\t_mcp_done()
\t\treturn${actionBlock}${saveBlock}
\t_mcp_output("theme_created", {"action": "${action}"})
\t_mcp_done()
`;
}

// ─── theme_set_property ────────────────────────────────────────────────────

export function genThemeSetPropertyScript(
  projectPath: string,
  themeNodePath: string,
  itemType: 'default_font' | 'color' | 'constant' | 'stylebox',
  name: string,
  value: unknown,
  themeType?: string,
  scenePath?: string,
): string {
  const sceneLine = scenePath
    ? `\tif not _mcp_load_scene("${gdEscape(scenePath)}"):\n\t\t_mcp_done()\n\t\treturn\n`
    : '';

  let setLine = '';
  const tt = themeType ? `"${gdEscape(themeType)}"` : '""';
  const safeName = gdEscape(name);

  switch (itemType) {
    case 'default_font': {
      const fontPath = String(value);
      sanitizeResPath(fontPath, 'font_path');
      setLine = `\ttheme.set_default_font(load("${gdEscape(fontPath)}"))`;
      break;
    }
    case 'color': {
      const c = value as number[];
      if (!Array.isArray(c) || c.length < 3) throw new Error('Color value must be array [r, g, b] or [r, g, b, a]');
      const a = c.length >= 4 ? c[3] : 1.0;
      setLine = `\ttheme.set_color("${safeName}", ${tt}, Color(${c[0]}, ${c[1]}, ${c[2]}, ${a}))`;
      break;
    }
    case 'constant': {
      setLine = `\ttheme.set_constant("${safeName}", ${tt}, ${Number(value)})`;
      break;
    }
    case 'stylebox': {
      const sbPath = String(value);
      sanitizeResPath(sbPath, 'stylebox_path');
      setLine = `\ttheme.set_stylebox("${safeName}", ${tt}, load("${gdEscape(sbPath)}"))`;
      break;
    }
  }

  return `${SCENE_TREE_HEADER}
func _initialize():
${sceneLine}\tvar node = _mcp_get_scene_node("${gdEscape(themeNodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(themeNodePath)}")
\t\t_mcp_done()
\t\treturn
\tvar theme = node.theme
\tif theme == null:
\t\t_mcp_output("error", "Node has no theme assigned")
\t\t_mcp_done()
\t\treturn
\tif not theme is Theme:
\t\t_mcp_output("error", "Node.theme is not a Theme")
\t\t_mcp_done()
\t\treturn
${setLine}
\t_mcp_output("property_set", {"node": "${gdEscape(themeNodePath)}", "item_type": "${itemType}", "name": "${safeName}"})
\t_mcp_done()
`;
}
