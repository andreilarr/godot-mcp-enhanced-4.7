/**
 * Path security utilities — I-ARCH-03 (extracted from helpers.ts)
 *
 * Path traversal protection, symlink resolution, allowed roots validation.
 */

import { isAbsolute, resolve, relative, sep, basename, dirname, normalize } from 'path';
import { existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_DECODE_ITERATIONS = 20;

/** Windows device names that must never be used as file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) */
const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// ─── Iterative URL decode ─────────────────────────────────────────────────────

/** A-15: Iterative URL decode — defeats multi-layer encoding. */
export function iterativeDecode(raw: string, maxIterations = MAX_DECODE_ITERATIONS): string {
  let decoded = raw;
  let prev = '';
  let iterations = 0;
  while (decoded !== prev && iterations < maxIterations) {
    prev = decoded;
    decoded = decodeURIComponent(decoded);
    iterations++;
  }
  return decoded;
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/** Resolve a path to absolute. Does NOT validate security — use resolveWithinRoot for that. */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/** Validate and resolve a project root path. */
export const validatePath = resolvePath;

/** Validate that a path is a valid Godot project root (contains project.godot). */
export function validateProjectRoot(p: string): string {
  const resolved = resolvePath(p);
  if (!existsSync(join(resolved, 'project.godot'))) {
    throw new Error(`Not a valid Godot project (no project.godot found): ${resolved}`);
  }
  return resolved;
}

// ─── Project path resolution (shared with ToolDispatcher) ────────────────────

/** 5min TTL cache — project path rarely changes mid-session */
let _resolvedProjectPath: string | undefined;
let _resolvedProjectPathTime = 0;
const PROJECT_PATH_CACHE_TTL_MS = 300_000;

/**
 * Resolve project path with priority chain:
 * 1. explicitPath (tool call argument) → use directly, no validation
 * 2. GODOT_PROJECT_PATH env → validate project.godot exists
 * 3. cwd upward search → find project.godot (max 30 levels)
 * 4. None → return undefined (caller decides error handling)
 *
 * Results are cached for 30s (PROJECT_PATH_CACHE_TTL_MS).
 */
export function resolveProjectPath(explicitPath?: string): string | undefined {
  if (explicitPath) return explicitPath;

  const now = Date.now();
  if (_resolvedProjectPathTime > 0 && now - _resolvedProjectPathTime < PROJECT_PATH_CACHE_TTL_MS) {
    return _resolvedProjectPath;
  }

  const rawEnvPath = process.env.GODOT_PROJECT_PATH;
  if (rawEnvPath) {
    const envPath = resolvePath(rawEnvPath); // normalize relative → absolute
    if (existsSync(join(envPath, 'project.godot'))) {
      _resolvedProjectPath = envPath;
      _resolvedProjectPathTime = now;
      return envPath;
    }
    getLogger().warn('godot-mcp', `GODOT_PROJECT_PATH="${rawEnvPath}" does not contain project.godot, ignoring`);
  }

  let dir = process.cwd();
  const searchedPaths: string[] = [];
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, 'project.godot'))) {
      _resolvedProjectPath = dir;
      _resolvedProjectPathTime = now;
      return dir;
    }
    searchedPaths.push(dir);
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  getLogger().warn('godot-mcp', `resolveProjectPath: no project.godot found. Searched: ${searchedPaths.join(' → ')}`);
  _resolvedProjectPath = undefined;
  _resolvedProjectPathTime = now;
  return undefined;
}

/** Reset cache state (test-only). */
export function _resetProjectPathCache(): void {
  _resolvedProjectPath = undefined;
  _resolvedProjectPathTime = 0;
}

// ─── Symlink-safe path resolution ─────────────────────────────────────────────

/** Safely resolve real path — walks up to find existing ancestor for symlink resolution. */
export function safeRealPath(p: string, base?: string): string {
  try { return realpathSync(p); } catch {
    let current = resolvePath(p);
    const trailing: string[] = [];
    while (!existsSync(current)) {
      trailing.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    let resolvedAncestor: string;
    try { resolvedAncestor = realpathSync(current); } catch (err) {
      throw new Error(`Cannot resolve real path for "${current}" (component of "${p}"): ${err instanceof Error ? err.message : err}`, { cause: err });
    }
    const resolved = trailing.length > 0 ? join(resolvedAncestor, ...trailing) : resolvedAncestor;
    if (base) {
      const rel = relative(base, resolved);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Path traversal detected in fallback resolution: ${p}`);
      }
    }
    return resolved;
  }
}

// ─── Path traversal protection ────────────────────────────────────────────────

/**
 * Resolve userPath within root, blocking traversal attacks.
 *
 * Security layers: UNC path reject → Windows device name reject →
 * iterative URL decode → `..` segment reject → realpath + relative check.
 *
 * NOTE: TOCTOU window exists between symlink check and actual use —
 * accepted risk for local-only scenarios.
 */
export function resolveWithinRoot(root: string, userPath: string): string {
  const base = safeRealPath(resolvePath(root));

  if (/^\\\\[^\\]/.test(userPath)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  const leafName = userPath.replace(/\\/g, '/').split('/').pop() || '';
  const baseName = leafName.replace(/\.[^.]*$/, '');
  if (WINDOWS_DEVICE_RE.test(baseName)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  let decoded: string;
  try {
    decoded = iterativeDecode(userPath);
  } catch {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  const normalizedPath = decoded.replace(/\\/g, '/');
  // F-4: 段级精确匹配,避免误拒含 ".." 的合法文件名(my..file.txt、..hidden、foo/..bar)
  // 子串匹配会 over-block;第180行 realpath+relative 兜底仍保留作纵深防御
  const segments = normalizedPath.split('/');
  if (segments.some(s => s === '..')) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  const resolved = resolve(base, normalizedPath);
  const realResolved = safeRealPath(resolved, base);
  const rel = relative(base, realResolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return realResolved;
}

// ─── Project path utilities ───────────────────────────────────────────────────

export function normalizeUserProjectPath(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('res://')) return trimmed.slice('res://'.length);
  return trimmed;
}

export function getAllowedProjectPaths(): string[] {
  const env = process.env.ALLOWED_PROJECT_PATHS;
  if (!env) return [];
  return env.split(';').filter(Boolean).map(p => resolvePath(p));
}

const _pathAllowLogged = new Set<string>();

function ensureSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/**
 * Check whether a requested path is within allowed project roots.
 *
 * Priority (highest wins):
 * 1. GODOT_MCP_UNRESTRICTED=true → allow everything (dev mode)
 * 2. ALLOWED_PROJECT_PATHS=/path1;/path2 → allow only listed roots + children
 * 3. No config → restrict to process.cwd() (deny-by-default)
 *
 * C-07: Changed from allow-by-default to deny-by-default.
 * Users must explicitly opt in via ALLOWED_PROJECT_PATHS or GODOT_MCP_UNRESTRICTED.
 */
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') {
    if (!_pathAllowLogged.has('unrestricted')) {
      getLogger().info('security', 'GODOT_MCP_UNRESTRICTED=true — all path restrictions bypassed');
      _pathAllowLogged.add('unrestricted');
    }
    // A-10: Debug-level audit log for every path access in unrestricted mode
    getLogger().debug('security', `UNRESTRICTED path access: ${requestedPath}`);
    return true;
  }
  // C-SEC-1: 必须在比较前归一化以消除 ".." 段。resolvePath 对绝对路径原样返回(不 normalize),
  // 导致 "root\..\..\Windows\..." 经 startsWith(ensureSep(root)) 前缀匹配被错误放行。
  // normalize 消除 ".." 与混合分隔符后,该路径落回 root 之外 → 拒绝。
  // 注:normalize 不解析符号链接;符号链接攻击由下游 resolveWithinRoot 的 realpath 检查纵深防御。
  const requested = normalize(resolvePath(requestedPath));
  const allowed = getAllowedProjectPaths();
  if (allowed.length === 0) {
    // C-07: deny-by-default — restrict to cwd when no explicit allowlist configured.
    // Users must set ALLOWED_PROJECT_PATHS=/path1;/path2 or GODOT_MCP_UNRESTRICTED=true
    // to access paths outside cwd.
    if (!_pathAllowLogged.has('cwd-fallback')) {
      getLogger().warn('security',
        'ALLOWED_PROJECT_PATHS not configured — restricting to process.cwd(). ' +
        'Set ALLOWED_PROJECT_PATHS=/path1;/path2 for explicit control, ' +
        'or GODOT_MCP_UNRESTRICTED=true to disable restrictions.');
      _pathAllowLogged.add('cwd-fallback');
    }
    const cwd = normalize(resolvePath('.'));
    return requested === cwd || requested.startsWith(ensureSep(cwd));
  }
  return allowed.some(p => {
    const normP = normalize(p);
    return requested === normP || requested.startsWith(ensureSep(normP));
  });
}

/** Reset log state (test-only). */
export function _resetPathAllowWarned(): void { _pathAllowLogged.clear(); }
