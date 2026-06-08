/**
 * Path security — sanitizePath for GDScript paths (res://, user://)
 *
 * Validates path strings before they reach GDScript execution:
 * - Normalizes separators (backslash → forward slash)
 * - Collapses double slashes
 * - Blocks path traversal (..)
 * - Blocks illegal characters (<, >, :, ", |, ?, *, control chars)
 * - Enforces prefix whitelist (res://, user:// + custom roots)
 *
 * For filesystem path security, see path-utils.ts (resolveWithinRoot).
 */

const DEFAULT_ALLOWED_ROOTS = ['res://', 'user://'];

// Note: colon (:) excluded — "res://", "user://", "D:/" all use it.
// Path traversal and prefix whitelist handle the remaining security.
const ILLEGAL_CHARS = /[<>|"|?*\x00-\x1f]/;
const TRAVERSAL_PATTERN = /\.\./;

/** Get combined allowed roots: defaults + env var + opts */
function getAllowedRoots(opts?: { allowedRoots?: string[] }): string[] {
  const roots = [...DEFAULT_ALLOWED_ROOTS];
  // 环境变量追加（逗号分隔）
  const envRoots = process.env.GODOT_MCP_ALLOWED_ROOTS;
  if (envRoots) {
    for (const r of envRoots.split(',').map(s => s.trim()).filter(Boolean)) {
      roots.push(r);
    }
  }
  // 调用级追加（不覆盖默认白名单）
  if (opts?.allowedRoots) {
    roots.push(...opts.allowedRoots);
  }
  return roots;
}

/**
 * Sanitize and validate a path string.
 *
 * @param path - The path to validate (e.g. "res://scenes/main.tscn")
 * @param opts - Optional configuration for additional allowed roots
 * @returns The normalized path string
 * @throws Error if path contains traversal, illegal chars, or non-whitelisted prefix
 */
export function sanitizePath(path: string, opts?: { allowedRoots?: string[] }): string {
  if (!path || typeof path !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  // 1. 标准化：反斜杠 → 正斜杠
  let normalized = path.replace(/\\/g, '/');
  // 合并多余斜杠（保留 :// 协议前缀）
  normalized = normalized.replace(/(?<!:)\/{2,}/g, '/');

  // 2. 遍历检测
  if (TRAVERSAL_PATTERN.test(normalized)) {
    throw new Error(`Path traversal detected: ${path}`);
  }

  // 3. 非法字符检测
  if (ILLEGAL_CHARS.test(normalized)) {
    throw new Error(`Illegal characters in path: ${path}`);
  }

  // 4. 前缀白名单
  const allowedRoots = getAllowedRoots(opts);
  const isAllowed = allowedRoots.some(root => {
    const normalizedRoot = root.replace(/\\/g, '/');
    return normalized.startsWith(normalizedRoot);
  });

  if (!isAllowed) {
    throw new Error(`Path prefix not in whitelist: ${path}. Allowed: ${allowedRoots.join(', ')}`);
  }

  return normalized;
}
