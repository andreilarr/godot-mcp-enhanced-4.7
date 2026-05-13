import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { validatePath } from '../helpers.js';
import { executeGdscript } from '../gdscript-executor.js';
import { gdEscape } from './godot-ops.js';
import { SCENE_TREE_HEADER, NON_PERSIST, opsErrorResult, parseGdscriptResult } from './shared.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_NAMES = ['profiler'] as const;

// ─── Tool Definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'profiler',
      description:
        '性能分析工具。snapshot: 快照（FPS/内存/绘制调用/物理统计）。start/stop: 开始/停止分析会话。get_data: 收集帧级数据，含百分位统计、尖峰检测、帧预算分析、内存统计。get_active_processes: 遍历场景树查找有 _process/_physics_process 的节点。get_signal_connections: 列出子树所有信号连接。' +
        NON_PERSIST,
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Godot 项目目录路径' },
          action: {
            type: 'string',
            enum: ['snapshot', 'start', 'stop', 'get_data', 'get_active_processes', 'get_signal_connections'],
            description: '操作类型',
          },
          target_fps: { type: 'number', description: '目标帧率，用于帧预算分析（get_data，默认 60）' },
          frame_count: { type: 'number', description: '采样帧数（get_data，默认 60）' },
          node_path: { type: 'string', description: '子树根节点路径（get_active_processes/get_signal_connections，默认 root）' },
          load_autoloads: { type: 'boolean', description: '是否加载 Autoload 上下文（默认 true）' },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── GDScript Generators ───────────────────────────────────────────────────

function genSnapshot(): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []

func _initialize():
\t_mcp_load_main_scene()
\tvar _data: Dictionary = {}
\t_data["fps"] = Performance.get_monitor(Performance.TIME_FPS)
\t_data["process_time_ms"] = Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
\t_data["physics_process_time_ms"] = Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0
\t_data["memory_static_mb"] = Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0
\t_data["object_count"] = int(Performance.get_monitor(Performance.OBJECT_COUNT))
\t_data["resource_count"] = int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT))
\t_data["node_count"] = int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT))
\t_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\t_data["draw_calls"] = int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME))
\t_data["objects_drawn"] = int(Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME))
\t_data["physics_3d_active_objects"] = int(Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS))
\t_data["physics_3d_collision_pairs"] = int(Performance.get_monitor(Performance.PHYSICS_3D_COLLISION_PAIRS))
\t_mcp_output("snapshot", _data)
\t_mcp_done()
`;
}

function genStart(): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []

func _initialize():
\t_mcp_load_main_scene()
\t_mcp_output("result", {"status": "profiling_started", "message": "Use get_data to collect frame data after waiting some frames"})
\t_mcp_done()
`;
}

function genStop(): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []

func _initialize():
\t_mcp_load_main_scene()
\t_mcp_output("result", {"status": "profiling_stopped"})
\t_mcp_done()
`;
}

function genGetData(targetFps: number, frameCount: number): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []
var _mcp_frame_times: Array = []
var _mcp_target_fps: float = ${targetFps}
var _mcp_frame_count: int = ${frameCount}
var _mcp_collected: int = 0

func _initialize():
\t_mcp_load_main_scene()

func _process(_delta: float):
\tvar _pt: float = Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0
\t_mcp_frame_times.append(_pt)
\t_mcp_collected += 1
\tif _mcp_collected >= _mcp_frame_count:
\t\t_analyze_and_report()

func _analyze_and_report():
\tvar _times: Array = _mcp_frame_times
\tvar _n: int = _times.size()
\tif _n == 0:
\t\t_mcp_output("error", "No frame data collected")
\t\t_mcp_done()
\t\treturn
\tvar _sorted: Array = _times.duplicate()
\t_sorted.sort()
\tvar _total: float = 0.0
\tvar _min_val: float = _sorted[0]
\tvar _max_val: float = _sorted[_n - 1]
\tfor _t in _times:
\t\t_total += _t
\tvar _avg: float = _total / float(_n)
\tvar _p50: float = _sorted[int(_n * 0.5)]
\tvar _p95_idx: int = int(_n * 0.95)
\tif _p95_idx >= _n:
\t\t_p95_idx = _n - 1
\tvar _p95: float = _sorted[_p95_idx]
\tvar _median: float = _sorted[int(_n * 0.5)]
\tvar _spike_threshold: float = _median * 2.0
\tvar _spikes: Array = []
\tfor _i in range(_n):
\t\tif _times[_i] > _spike_threshold:
\t\t\t_spikes.append({"frame": _i, "time_ms": _times[_i]})
\tvar _frame_budget_ms: float = 1000.0 / _mcp_target_fps
\tvar _over_budget: int = 0
\tfor _t in _times:
\t\tif _t > _frame_budget_ms:
\t\t\t_over_budget += 1
\tvar _frame_data: Dictionary = {}
\t_frame_data["frame_count"] = _n
\t_frame_data["target_fps"] = _mcp_target_fps
\t_frame_data["frame_budget_ms"] = _frame_budget_ms
\t_frame_data["avg_ms"] = _avg
\t_frame_data["min_ms"] = _min_val
\t_frame_data["max_ms"] = _max_val
\t_frame_data["p50_ms"] = _p50
\t_frame_data["p95_ms"] = _p95
\t_frame_data["spike_count"] = _spikes.size()
\t_frame_data["spikes"] = _spikes
\t_frame_data["over_budget_count"] = _over_budget
\t_frame_data["over_budget_pct"] = (float(_over_budget) / float(_n)) * 100.0
\t_mcp_output("frame_analysis", _frame_data)
\tvar _mem_data: Dictionary = {}
\t_mem_data["memory_static_mb"] = Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0
\t_mem_data["object_count"] = int(Performance.get_monitor(Performance.OBJECT_COUNT))
\t_mem_data["resource_count"] = int(Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT))
\t_mem_data["node_count"] = int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT))
\t_mem_data["orphan_node_count"] = int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
\t_mcp_output("memory_stats", _mem_data)
\t_mcp_done()
`;
}

function genGetActiveProcesses(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []

func _initialize():
\t_mcp_load_main_scene()
\tvar _root: Node = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not found")
\t\t_mcp_done()
\t\treturn
\tvar _search_root: Node = _root
\tif "${gdEscape(nodePath)}" != "":
\t\t_search_root = _mcp_get_node("${gdEscape(nodePath)}")
\t\tif _search_root == null:
\t\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t\t_mcp_done()
\t\t\treturn
\tvar _results: Array = []
\tvar _stack: Array = [_search_root]
\twhile _stack.size() > 0:
\t\tvar _n: Node = _stack.pop_back()
\t\tvar _has_process: bool = _n.has_method("_process")
\t\tvar _has_physics: bool = _n.has_method("_physics_process")
\t\tif _has_process or _has_physics:
\t\t\tvar _entry: Dictionary = {}
\t\t\t_entry["path"] = str(_n.get_path()).trim_prefix("/root/")
\t\t\t_entry["type"] = _n.get_class()
\t\t\t_entry["has_process"] = _has_process
\t\t\t_entry["has_physics_process"] = _has_physics
\t\t\t_results.append(_entry)
\t\tfor _c in _n.get_children():
\t\t\t_stack.append(_c)
\t_mcp_output("active_processes", _results)
\t_mcp_output("total_count", _results.size())
\t_mcp_done()
`;
}

function genGetSignalConnections(nodePath: string): string {
  return `${SCENE_TREE_HEADER}
var _mcp_outputs: Array = []

func _initialize():
\t_mcp_load_main_scene()
\tvar _root: Node = _mcp_get_root()
\tif _root == null:
\t\t_mcp_output("error", "Scene root not found")
\t\t_mcp_done()
\t\treturn
\tvar _search_root: Node = _root
\tif "${gdEscape(nodePath)}" != "":
\t\t_search_root = _mcp_get_node("${gdEscape(nodePath)}")
\t\tif _search_root == null:
\t\t\t_mcp_output("error", "Node not found: ${gdEscape(nodePath)}")
\t\t\t_mcp_done()
\t\t\treturn
\tvar _results: Array = []
\tvar _stack: Array = [_search_root]
\twhile _stack.size() > 0:
\t\tvar _n: Node = _stack.pop_back()
\t\tvar _sig_list: Array = _n.get_signal_list()
\t\tfor _sig_info in _sig_list:
\t\t\tvar _sig_name: String = _sig_info["name"]
\t\t\tvar _conns: Array = _n.get_signal_connection_list(_sig_name)
\t\t\tfor _conn in _conns:
\t\t\t\tvar _entry: Dictionary = {}
\t\t\t\t_entry["source_path"] = str(_n.get_path()).trim_prefix("/root/")
\t\t\t\t_entry["signal_name"] = _sig_name
\t\t\t\tvar _target_obj: Object = _conn["callable"].get_object()
\t\t\t\tif _target_obj is Node:
\t\t\t\t\t_entry["target_path"] = str((_target_obj as Node).get_path()).trim_prefix("/root/")
\t\t\t\telse:
\t\t\t\t\t_entry["target_path"] = str(_target_obj)
\t\t\t\t_entry["target_method"] = _conn["callable"].get_method()
\t\t\t\t_entry["flags"] = _conn["flags"]
\t\t\t\t_results.append(_entry)
\t\tfor _c in _n.get_children():
\t\t\t_stack.append(_c)
\t_mcp_output("signal_connections", _results)
\t_mcp_output("total_count", _results.size())
\t_mcp_done()
`;
}

function ensurePositiveInt(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got: ${JSON.stringify(v)}`);
  }
  return Math.round(n);
}

// ─── Tool Handler ──────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (!(TOOL_NAMES as readonly string[]).includes(name)) return null;

  try {
    const projectPath = validatePath(args.project_path as string);
    const action = args.action as string;
    const loadAutoloads = (args.load_autoloads as boolean) ?? true;
    const godotPath = await ctx.findGodot();

    let code: string;
    let timeout: number = 30;

    switch (action) {
      case 'snapshot':
        code = genSnapshot();
        break;
      case 'start':
        code = genStart();
        break;
      case 'stop':
        code = genStop();
        break;
      case 'get_data': {
        const targetFps = args.target_fps !== undefined
          ? ensurePositiveInt(args.target_fps, 'target_fps', 1, 1000)
          : 60;
        const frameCount = args.frame_count !== undefined
          ? ensurePositiveInt(args.frame_count, 'frame_count', 1, 600)
          : 60;
        code = genGetData(targetFps, frameCount);
        timeout = 45;
        break;
      }
      case 'get_active_processes': {
        const nodePath = (args.node_path as string) ?? '';
        code = genGetActiveProcesses(nodePath);
        break;
      }
      case 'get_signal_connections': {
        const nodePath = (args.node_path as string) ?? '';
        code = genGetSignalConnections(nodePath);
        break;
      }
      default:
        return opsErrorResult('INVALID_ACTION', `Unknown action: ${action}`);
    }

    const result = await executeGdscript({
      godotPath,
      projectPath,
      code,
      timeout,
      loadAutoloads,
    });

    return parseGdscriptResult(result);
  } catch (err) {
    return opsErrorResult('INVALID_PARAMS', err instanceof Error ? err.message : String(err));
  }
}
