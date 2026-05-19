import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import {
  getClassInfo,
  searchClasses,
  findMethod as findMethodInfo,
  getInheritanceChain,
} from '../godot-docs.js';
import { DEPRECATED_PROPERTIES } from './deprecated-properties.js';

const TOOL_NAMES = [
  'get_class_info',
  'search_classes',
  'find_method',
  'get_inheritance',
] as const;

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'get_class_info',
      description: 'Get complete information about a Godot class including methods, properties, signals, and constants.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          class_name: { type: 'string', description: 'Godot class name (e.g. Node2D, Control, CharacterBody2D)' },
          include_inherited: { type: 'boolean', description: 'Include inherited members (default: true)', default: true },
        },
        required: ['class_name'],
      },
    },
    {
      name: 'search_classes',
      description: 'Search Godot classes by name or description. Useful for discovering available classes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query (e.g. "sprite", "physics", "audio")' },
          limit: { type: 'number', description: 'Max results (default: 20)', default: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'find_method',
      description: 'Find a specific method on a Godot class, searching up the inheritance chain. Returns signature, parameters, and description.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          class_name: { type: 'string', description: 'Godot class name' },
          method_name: { type: 'string', description: 'Method name to find' },
        },
        required: ['class_name', 'method_name'],
      },
    },
    {
      name: 'get_inheritance',
      description: 'Get the full inheritance chain of a Godot class.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          class_name: { type: 'string', description: 'Godot class name' },
        },
        required: ['class_name'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  switch (name) {
    case 'get_class_info': {
      const className = args.class_name as string;
      const includeInherited = args.include_inherited !== false;
      const info = getClassInfo(className, includeInherited);
      if (!info) {
        return textResult(`Class not found: ${className}`);
      }
      const classDeprecated = DEPRECATED_PROPERTIES[className];
      const deprecated_warnings = classDeprecated
        ? Object.entries(classDeprecated).map(([name, info]) => ({
            property: name,
            removed: info.removed,
            replacement: info.replacement ?? null,
          }))
        : [];

      const result = {
        name: info.name,
        inherits: info.inherits,
        brief_description: info.brief_description,
        description: info.description,
        methods_count: info.methods.length,
        methods: info.methods.map(m => ({
          name: m.name,
          signature: `${m.return_type} ${m.name}(${m.arguments.map(a => a.type + ' ' + a.name).join(', ')})`,
          description: m.description,
        })),
        properties_count: info.properties.length,
        properties: info.properties.map(p => {
          const deprecated = DEPRECATED_PROPERTIES[className]?.[p.name];
          return {
            name: p.name,
            type: p.type,
            description: p.description,
            deprecated_notes: deprecated
              ? (deprecated.removed
                ? `已移除 (Godot 4.6)${deprecated.replacement ? '，替代: ' + deprecated.replacement : ''}`
                : `已重命名 (Godot 4.6): 使用 ${deprecated.replacement}`)
              : null,
          };
        }),
        deprecated_warnings,
        signals_count: info.signals.length,
        signals: info.signals.map(s => ({
          name: s.name,
          description: s.description,
        })),
        constants_count: info.constants.length,
        constants: info.constants.slice(0, 50),
        enums_count: info.enums.length,
      };
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'search_classes': {
      const query = args.query as string;
      const limit = (args.limit as number) || 20;
      const results = searchClasses(query, limit);
      if (results.length === 0) {
        return textResult(`No classes found matching "${query}"`);
      }
      return textResult(JSON.stringify({ count: results.length, classes: results }, null, 2));
    }

    case 'find_method': {
      const className = args.class_name as string;
      const methodName = args.method_name as string;
      const method = findMethodInfo(className, methodName);
      if (!method) {
        return textResult(`Method "${methodName}" not found on ${className} or its parent classes.`);
      }
      const result = {
        class: className,
        name: method.name,
        return_type: method.return_type,
        arguments: method.arguments.map(a => ({
          name: a.name,
          type: a.type,
          default: a.default_value,
        })),
        signature: `${method.return_type} ${method.name}(${method.arguments.map(a => a.type + ' ' + a.name + (a.default_value ? ' = ' + a.default_value : '')).join(', ')})`,
        description: method.description,
      };
      return textResult(JSON.stringify(result, null, 2));
    }

    case 'get_inheritance': {
      const className = args.class_name as string;
      const chain = getInheritanceChain(className);
      if (chain.length === 0) {
        return textResult(`Class not found: ${className}`);
      }
      return textResult(JSON.stringify({ class: className, inheritance_chain: chain }, null, 2));
    }

    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  get_class_info: { readonly: true, long_running: false },
  search_classes: { readonly: true, long_running: false },
  find_method: { readonly: true, long_running: false },
  get_inheritance: { readonly: true, long_running: false },
};
