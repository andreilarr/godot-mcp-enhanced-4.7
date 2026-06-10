/**
 * 共享参数 schema 定义 — 所有工具引用而非重写。
 * @phase2 Phase 2 预留 — 统一 Action 路由启用后消费。
 */
export const COMMON_SCHEMAS = {
  project_path: {
    type: 'string' as const,
    description: '项目目录路径（可选，默认 GODOT_PROJECT_PATH 环境变量或当前目录）',
  },
  scene_path: {
    type: 'string' as const,
    description: '场景文件路径（相对项目，如 res://scenes/main.tscn）',
  },
  node_path: {
    type: 'string' as const,
    description: '节点路径（root/Player/Sprite2D）',
  },
  animation_name: {
    type: 'string' as const,
    description: '动画名称',
  },
  load_autoloads: {
    type: 'boolean' as const,
    description: '是否加载 Autoload 上下文（默认 true）',
  },
} as const;

export type CommonSchemaKey = keyof typeof COMMON_SCHEMAS;

/** 构建工具 schema 时注入 common params。已有定义不覆盖。 */
export function withCommonParams(
  params: Record<string, unknown>,
  ...commonKeys: CommonSchemaKey[]
): Record<string, unknown> {
  const result = { ...params };
  for (const key of commonKeys) {
    if (!(key in result) && COMMON_SCHEMAS[key]) {
      result[key] = { ...COMMON_SCHEMAS[key] };
    }
  }
  return result;
}