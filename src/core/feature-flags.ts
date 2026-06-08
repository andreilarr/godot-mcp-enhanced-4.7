// src/core/feature-flags.ts

/** Feature flag definitions: key → { env var, default value } */
const FEATURES = {
  TOOL_GROUPS:     { env: 'GODOT_MCP_TOOL_GROUPS',     default: true },
  PATH_SECURITY:   { env: 'GODOT_MCP_PATH_SECURITY',   default: true },
  MULTI_INSTANCE:  { env: 'GODOT_MCP_MULTI_INSTANCE',   default: false },
  ADVANCED_PROXY:  { env: 'GODOT_MCP_ADVANCED_PROXY',   default: false },
  RESPONSE_LIMIT:  { env: 'GODOT_MCP_RESPONSE_LIMIT',   default: true },
  HEALTH_MONITOR:  { env: 'GODOT_MCP_HEALTH_MONITOR',   default: true },
  OFFLINE_MODE:    { env: 'GODOT_MCP_OFFLINE_MODE',     default: true },
  ELICITATION:     { env: 'GODOT_MCP_ELICITATION',      default: true },
} as const;

export type FeatureKey = keyof typeof FEATURES;

/** Check if a feature is enabled. Reads from env var, falls back to default. */
export function isFeatureEnabled(key: FeatureKey): boolean {
  const feature = FEATURES[key];
  const envVal = process.env[feature.env];
  if (envVal === undefined) return feature.default;
  return envVal.toLowerCase() === 'true';
}

let flagsCache: Record<FeatureKey, boolean> | null = null;

/** Get all feature flags with their current values. Result is cached (flags don't change at runtime). */
export function getAllFeatureFlags(): Record<FeatureKey, boolean> {
  if (flagsCache) return flagsCache;
  const result = {} as Record<FeatureKey, boolean>;
  for (const key of Object.keys(FEATURES) as FeatureKey[]) {
    result[key] = isFeatureEnabled(key);
  }
  flagsCache = result;
  return flagsCache;
}
