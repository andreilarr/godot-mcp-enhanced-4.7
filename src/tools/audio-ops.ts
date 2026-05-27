import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult, gdEscape, normalizeNodePath, clampParam } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const ERROR_CODES = {
  AUDIO_NOT_FOUND: 'AUDIO_NOT_FOUND',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_PATH: 'INVALID_PATH',
} as const;

export const TOOL_NAMES = [
  'audio_play',
  'audio_stop',
  'audio_set_param',
  'audio_query',
] as const;

// ─── GDScript Generators: Audio ────────────────────────────────────────────

export function genAudioPlayScript(
  nodePath: string, streamPath?: string, volumeDb?: number,
  pitchScale?: number, bus?: string, fromPosition?: number
): string {
  let streamLine = '';
  if (streamPath) {
    streamLine = `\n\tvar stream_res = load("${gdEscape(streamPath)}")\n\tif stream_res:\n\t\tnode.stream = stream_res`;
  }
  const fmtNum = (n: number) => Number.isInteger(n) ? n.toFixed(1) : String(n);
  const volLine = volumeDb !== undefined ? `\n\tnode.volume_db = ${volumeDb}` : '';
  const pitchLine = pitchScale !== undefined ? `\n\tnode.pitch_scale = ${fmtNum(pitchScale)}` : '';
  const busLine = bus ? `\n\tnode.bus = "${gdEscape(bus)}"` : '';
  const playArg = fromPosition !== undefined ? `(${fmtNum(fromPosition)})` : '()';

  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type: " + node.get_class())
\t\t_mcp_done()
\t\treturn${streamLine}${volLine}${pitchLine}${busLine}
\tnode.play${playArg}
\t_mcp_output("playing", {"node": "${gdEscape(nodePath)}", "stream": str(node.stream) if node.stream else "None"})
\t_mcp_done()
`;
}

export function genAudioStopScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tnode.stop()
\t_mcp_output("stopped", {"node": "${gdEscape(nodePath)}"})
\t_mcp_done()
`;
}

export function genAudioSetParamScript(
  nodePath: string, param: 'volume_db' | 'pitch_scale' | 'bus', value: number | string
): string {
  const valStr = typeof value === 'string' ? `"${gdEscape(value)}"` : String(value);
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tnode.${param} = ${valStr}
\t_mcp_output("param_set", {"node": "${gdEscape(nodePath)}", "param": "${param}", "value": ${valStr}})
\t_mcp_done()
`;
}

export function genAudioQueryScript(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
func _initialize():
\t_mcp_load_main_scene()
\tvar node = _mcp_get_node("${gdEscape(nodePath)}")
\tif node == null:
\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t_mcp_done()
\t\treturn
\tif not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
\t\t_mcp_output("error", "Node is not an AudioStreamPlayer type")
\t\t_mcp_done()
\t\treturn
\tvar info = {}
\tinfo["playing"] = node.playing
\tinfo["volume_db"] = node.volume_db
\tinfo["pitch_scale"] = node.pitch_scale
\tinfo["bus"] = node.bus
\tinfo["stream"] = str(node.stream.resource_path) if node.stream else "None"
\tinfo["playback_position"] = node.get_playback_position() if node.playing else 0.0
\tinfo["stream_length"] = node.stream.get_length() if node.stream else 0.0
\tinfo["node_type"] = node.get_class()
\t_mcp_output("audio_info", info)
\t_mcp_done()
`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'audio_play',
      description: `Play audio. Supports AudioStreamPlayer/AudioStreamPlayer2D/AudioStreamPlayer3D nodes. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          stream_path: { type: 'string', description: '音频资源路径（res://...），不传则播放已配置的' },
          volume_db: { type: 'number', description: '音量（dB，-80 到 24）' },
          pitch_scale: { type: 'number', description: '音调缩放（0.01 到 100）' },
          bus: { type: 'string', description: '音频总线名称' },
          from_position: { type: 'number', description: '从指定位置开始播放（秒）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'audio_stop',
      description: `Stop audio playback. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
    {
      name: 'audio_set_param',
      description: `Set audio parameters (volume/pitch/bus). ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          param: { type: 'string', enum: ['volume_db', 'pitch_scale', 'bus'], description: '参数名' },
          value: { description: '参数值（number for volume_db/pitch_scale, string for bus）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path', 'param', 'value'],
      },
    },
    {
      name: 'audio_query',
      description: `Query audio playback status. ${NON_PERSIST}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          node_path: { type: 'string', description: '音频节点路径' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'node_path'],
      },
    },
  ];
}

// ─── Tool Handler ───────────────────────────────────────────────────────────

export async function handleTool(
  name: string, args: Record<string, unknown>, ctx: ToolContext
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const godot = await ctx.findGodot();
    const loadAutoloads = args.load_autoloads !== false;
    let script: string;
    const paramWarnings: string[] = [];

    switch (name) {
      case 'audio_play': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const streamPath = args.stream_path as string | undefined;
        const volumeDb = args.volume_db as number | undefined;
        const pitchScale = args.pitch_scale as number | undefined;
        const bus = args.bus as string | undefined;
        const fromPosition = args.from_position as number | undefined;
        if (fromPosition !== undefined && (typeof fromPosition !== 'number' || !Number.isFinite(fromPosition) || fromPosition < 0)) {
          return opsErrorResult('INVALID_TYPE', 'from_position must be a non-negative finite number');
        }
        const clampVol = clampParam(volumeDb, -80, 24, 'volume_db', paramWarnings);
        const clampPitch = clampParam(pitchScale, 0.01, 100, 'pitch_scale', paramWarnings);
        script = genAudioPlayScript(nodePath, streamPath, clampVol, clampPitch, bus, fromPosition);
        break;
      }
      case 'audio_stop': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genAudioStopScript(nodePath);
        break;
      }
      case 'audio_set_param': {
        const nodePath = normalizeNodePath(args.node_path as string);
        const param = args.param as string;
        const value = args.value;
        if (!['volume_db', 'pitch_scale', 'bus'].includes(param)) {
          return opsErrorResult('INVALID_TYPE', 'param must be volume_db, pitch_scale, or bus');
        }
        if (param === 'bus' && typeof value !== 'string') {
          return opsErrorResult('INVALID_TYPE', 'bus param requires a string value');
        }
        if (param !== 'bus' && typeof value !== 'number') {
          return opsErrorResult('INVALID_TYPE', `${param} param requires a number value`);
        }
        script = genAudioSetParamScript(nodePath, param as 'volume_db' | 'pitch_scale' | 'bus', value as number | string);
        break;
      }
      case 'audio_query': {
        const nodePath = normalizeNodePath(args.node_path as string);
        script = genAudioQueryScript(nodePath);
        break;
      }
      default:
        return null;
    }

    const result = await executeGdscript({
      godotPath: godot,
      projectPath,
      code: script,
      timeout: 30,
      loadAutoloads,
    });

    const errorMapper = (msg: string) =>
      (msg.includes('not found') || msg.includes('not an Audio')) ? ERROR_CODES.AUDIO_NOT_FOUND : ERROR_CODES.SCRIPT_EXEC_FAILED;

    return parseGdscriptResult(result, paramWarnings, errorMapper);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('NodePath')) return opsErrorResult('INVALID_PATH', msg);
    return opsErrorResult('SCRIPT_EXEC_FAILED', msg);
  }
}

// ─── Tool Meta ──────────────────────────────────────────────────────────────

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  audio_play: { readonly: false, long_running: false },
  audio_stop: { readonly: false, long_running: false },
  audio_set_param: { readonly: false, long_running: false },
  audio_query: { readonly: true, long_running: false },
};
