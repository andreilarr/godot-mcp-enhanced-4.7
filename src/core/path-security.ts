/**
 * Path security — sanitizePath for GDScript paths (res://, user://)
 *
 * Validates path strings before they reach GDScript execution:
 * - URL-decodes before checking (prevents %2e%2e bypass)
 * - Normalizes separators (backslash → forward slash)
 * - Collapses double slashes
 * - Blocks path traversal (..)
 * - Blocks illegal characters (<, >, :, ", |, ?, *, control chars)
 * - Enforces prefix whitelist (res://, user:// + custom roots)
 *
 * For filesystem path security, see path-utils.ts (resolveWithinRoot).
 */

import { normalize } from 'path';

const DEFAULT_ALLOWED_ROOTS = ['res://', 'user://'];

// Note: colon (:) excluded — "res://", "user://", "D:/" all use it.
// Path traversal and prefix whitelist handle the remaining security.
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>|"?*\x00-\x1f]/;
const TRAVERSAL_PATTERN = /\.\./;

/** Decode URL-encoded sequences to detect encoded traversal (e.g. %2e%2e → ..) */
function deepDecodeUri(s: string): string {
  let prev = '';
  let current = s;
  // Max 3 rounds to prevent infinite loop on malicious input
  for (let i = 0; i < 3 && prev !== current; i++) {
    prev = current;
    try { current = decodeURIComponent(current); } catch { break; }
  }
  return current;
}

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

  // 0. S-2: URL 解码检测 — 先对原始输入做深度解码，检查是否有编码的遍历
  const decoded = deepDecodeUri(path);
  if (TRAVERSAL_PATTERN.test(decoded.replace(/\\/g, '/'))) {
    throw new Error('Path traversal detected');
  }
  if (ILLEGAL_CHARS.test(decoded)) {
    throw new Error('Illegal characters in path');
  }

  // 1. 标准化：反斜杠 → 正斜杠
  let normalized = path.replace(/\\/g, '/');
  // 合并多余斜杠（保留 :// 协议前缀）
  normalized = normalized.replace(/(?<!:)\/{2,}/g, '/');

  // 2. 遍历检测（C-03 安全：泛化错误消息，不泄露路径详情）
  if (TRAVERSAL_PATTERN.test(normalized)) {
    throw new Error('Path traversal detected');
  }

  // 3. 非法字符检测（C-03 安全：不泄露路径内容）
  if (ILLEGAL_CHARS.test(normalized)) {
    throw new Error('Illegal characters in path');
  }

  // 4. 前缀白名单（C-03 安全：不枚举允许的根路径）
  const allowedRoots = getAllowedRoots(opts);
  const isAllowed = allowedRoots.some(root => {
    const normalizedRoot = root.replace(/\\/g, '/');
    // S-2: 使用 normalize 进一步消除路径中的冗余段
    if (normalized.startsWith(normalizedRoot)) return true;
    // 对文件系统路径做 normalize 后的前缀匹配
    try {
      const resolvedPath = normalize(normalized);
      const resolvedRoot = normalize(normalizedRoot);
      return resolvedPath.startsWith(resolvedRoot);
    } catch {
      return false;
    }
  });

  if (!isAllowed) {
    throw new Error('Path prefix not allowed');
  }

  return normalized;
}
