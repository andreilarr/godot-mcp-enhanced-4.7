export interface ValidationResult {
  safe: boolean;
  reason?: string;
  priority?: number;
}

/** Dangerous API patterns with priority classification.
 *  Priority: 1=重操作(crash/quit), 5=中等(file/shell), 9=轻操作(warning)
 */
const DANGEROUS_APIS: Array<{ pattern: RegExp; label: string; priority: number }> = [
  // Priority 1: 重操作
  { pattern: /OS\.crash\b/,                           label: 'OS.crash (engine crash)',          priority: 1 },
  { pattern: /Engine\.quit\b/,                        label: 'Engine.quit (engine shutdown)',    priority: 1 },
  { pattern: /OS\.exit\b/,                            label: 'OS.exit (process exit)',           priority: 1 },
  { pattern: /get_tree\(\)\.quit\(\)/,                label: 'get_tree().quit (scene tree quit)',priority: 1 },

  // Priority 5: 中等操作
  { pattern: /OS\.execute\b/,                         label: 'OS.execute (shell command)',       priority: 5 },
  { pattern: /OS\.shell_open\b/,                      label: 'OS.shell_open (shell open)',       priority: 5 },
  { pattern: /FileAccess\.open\b/,                    label: 'FileAccess.open (file access)',    priority: 5 },
  { pattern: /DirAccess\.open\b/,                     label: 'DirAccess.open (dir access)',      priority: 5 },
  { pattern: /DirAccess\.remove\b/,                   label: 'DirAccess.remove (dir removal)',   priority: 5 },
];

/**
 * Validate GDScript code for dangerous API usage.
 * Provides structured validation with priority classification.
 * This is a best-effort defense — dynamic calls (call()/funcref()) may bypass detection.
 */
export function validateGdscriptCommand(code: string): ValidationResult {
  if (!code || code.trim().length === 0) {
    return { safe: true };
  }

  // Find highest-priority (lowest number) match
  let matched: { label: string; priority: number } | null = null;
  for (const api of DANGEROUS_APIS) {
    if (api.pattern.test(code)) {
      if (!matched || api.priority < matched.priority) {
        matched = { label: api.label, priority: api.priority };
      }
    }
  }

  if (matched) {
    return {
      safe: false,
      reason: `Blocked: ${matched.label}`,
      priority: matched.priority,
    };
  }

  return { safe: true };
}
