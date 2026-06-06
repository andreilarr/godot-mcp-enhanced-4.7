import { isAbsolute, resolve, dirname, relative, sep, basename } from 'path';
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from './core/logger.js';

const execFileAsync = promisify(execFile);

// ─── Path security constants ──────────────────────────────────────────────────

const MAX_DECODE_ITERATIONS = 20;
const GODOT_VERSION_CHECK_TIMEOUT_MS = 5000;

// ─── Shared: iterative URL decode ─────────────────────────────────────────────

/** A-15: 提取共享的迭代 URL 解码函数，供 resolveWithinRoot 和 resources.ts 共用。
 *  迭代解码直到稳定或达到上限，防止多层编码绕过。 */
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

/** Windows device names that must never be used as file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) */
const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// ─── Path helpers ────────────────────────────────────────────────────────────

/** Resolve a path to absolute. Does NOT validate security — use resolveWithinRoot for that. */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/** Validate and resolve a project root path. Delegates to resolvePath; use resolveWithinRoot for sub-path traversal protection. */
export const validatePath = resolvePath;

/** Validate that a path is a valid Godot project root (contains project.godot). Throws if not found. */
export function validateProjectRoot(p: string): string {
  const resolved = resolvePath(p);
  if (!existsSync(join(resolved, 'project.godot'))) {
    throw new Error(`Not a valid Godot project (no project.godot found): ${resolved}`);
  }
  return resolved;
}

/** Safely resolve real path — walks up to find existing ancestor for symlink resolution.
 *  When the full path doesn't exist, resolves the nearest existing ancestor via realpathSync,
 *  then appends the remaining non-existent segments. This prevents symlink bypass in intermediate
 *  directories (e.g. /allowed/symlink_to_external/newfile). */
export function safeRealPath(p: string, base?: string): string {
  try { return realpathSync(p); } catch {
    let current = resolvePath(p);
    const trailing: string[] = [];
    while (!existsSync(current)) {
      trailing.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) break; // filesystem root
      current = parent;
    }
    let resolvedAncestor: string;
    try { resolvedAncestor = realpathSync(current); } catch (err) {
      throw new Error(`Cannot resolve real path for "${current}" (component of "${p}"): ${err instanceof Error ? err.message : err}`, { cause: err });
    }
    const resolved = trailing.length > 0 ? join(resolvedAncestor, ...trailing) : resolvedAncestor;
    // If a base is provided, verify the resolved path doesn't escape it
    if (base) {
      const rel = relative(base, resolved);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`Path traversal detected in fallback resolution: ${p}`);
      }
    }
    return resolved;
  }
}

export function resolveWithinRoot(root: string, userPath: string): string {
  // Resolve real root path (handles symlinks and junction points)
  // NOTE: TOCTOU window exists between symlink check and actual use — accepted risk for local-only scenarios.
  const base = safeRealPath(resolvePath(root));

  // Reject UNC paths (\\server\share) — only relevant on Windows
  if (/^\\\\[^\\]/.test(userPath)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  // Reject Windows device names in the final path component (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const leafName = userPath.replace(/\\/g, '/').split('/').pop() || '';
  const baseName = leafName.replace(/\.[^.]*$/, '');
  if (WINDOWS_DEVICE_RE.test(baseName)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  // Decode iteratively to defeat multi-layer encoding (generous cap for safety)
  let decoded: string;
  try {
    decoded = iterativeDecode(userPath);
  } catch {
    throw new Error(`Path traversal detected: ${userPath}`);
  }

  // Reject paths containing ".." before resolution
  const normalizedPath = decoded.replace(/\\/g, '/');
  if (normalizedPath.includes('..')) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  const resolved = resolve(base, normalizedPath);
  // Resolve real path for the target (handles symlinks and junction points)
  // Pass base so the fallback resolution can also check for traversal
  const realResolved = safeRealPath(resolved, base);
  const rel = relative(base, realResolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${userPath}`);
  }
  return realResolved;
}

export function ensureDir(p: string): void {
  if (!existsSync(dirname(p))) {
    mkdirSync(dirname(p), { recursive: true });
  }
}

/** Require a non-empty string from tool args. Throws descriptive error on missing/invalid. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${key} must be a non-empty string, got: ${v === undefined ? 'undefined' : v === null ? 'null' : JSON.stringify(v)}`);
  }
  return v;
}

/** Require a finite number from tool args. Returns fallback if key is absent/undefined. */
export function requireNumber(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${key} is required and must be a number`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${key} must be a finite number, got: ${JSON.stringify(v)}`);
  }
  return n;
}

/** Convenience: require and validate project_path in one call. */
export function requireProjectPath(args: Record<string, unknown>): string {
  const resolved = validatePath(requireString(args, 'project_path'));
  if (!isPathInAllowedRoots(resolved)) {
    throw new Error(`project_path not in ALLOWED_PROJECT_PATHS: ${resolved}. Check your ALLOWED_PROJECT_PATHS setting.`);
  }
  return resolved;
}

export function normalizeUserProjectPath(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('res://')) return trimmed.slice('res://'.length);
  return trimmed;
}

/** Parse ALLOWED_PROJECT_PATHS env var (semicolon-separated whitelist). Returns empty array if not set. */
export function getAllowedProjectPaths(): string[] {
  const env = process.env.ALLOWED_PROJECT_PATHS;
  if (!env) return [];
  return env.split(';').filter(Boolean).map(p => resolvePath(p));
}

export function allowOutsideProjectPaths(): boolean {
  // @deprecated since v0.16.0, remove in v0.18.0 — use ALLOWED_PROJECT_PATHS whitelist instead
  // Migration: set ALLOWED_PROJECT_PATHS=/path1;/path2 (semicolon-separated) or GODOT_MCP_UNRESTRICTED=true
  if (process.env.ALLOW_OUTSIDE_PROJECT_PATHS === 'true') {
    getLogger().error('security', 'ALLOW_OUTSIDE_PROJECT_PATHS is deprecated (removes in v0.18.0) — migrate to ALLOWED_PROJECT_PATHS whitelist (see getAllowedProjectPaths)');
    return true;
  }
  return false;
}

/** Per-message deduplication for path-allow log messages.
 *  Each security path (UNRESTRICTED, unconfigured) logs once independently. */
const _pathAllowLogged = new Set<string>();

/** Ensure path ends with separator for prefix matching (avoids double-sep on Windows). */
function ensureSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

/** Check if a requested path is within the ALLOWED_PROJECT_PATHS whitelist.
 *
 *  Priority:
 *  1. GODOT_MCP_UNRESTRICTED=true → allow all (backward compat, logs once).
 *  2. ALLOWED_PROJECT_PATHS set → restrict to whitelist (opt-in security).
 *  3. Unconfigured → allow all with info log (allow-by-default).
 *
 *  Why allow-by-default? When launched via `npx` from Claude Code's mcpServers,
 *  process.cwd() is the npx cache dir — not the user's Godot project.
 *  The deny-by-default (cwd fallback) blocked legitimate users who hadn't
 *  configured env vars, with no actionable path to recovery.
 *  Real security is enforced by Claude Code's permission system, not by the
 *  MCP server's path check. Users who want restriction can set ALLOWED_PROJECT_PATHS. */
export function isPathInAllowedRoots(requestedPath: string): boolean {
  if (process.env.GODOT_MCP_UNRESTRICTED === 'true') {
    if (!_pathAllowLogged.has('unrestricted')) {
      getLogger().info('security', 'GODOT_MCP_UNRESTRICTED=true — all path restrictions bypassed');
      _pathAllowLogged.add('unrestricted');
    }
    return true;
  }
  if (allowOutsideProjectPaths()) return true;
  const allowed = getAllowedProjectPaths();
  if (allowed.length === 0) {
    if (!_pathAllowLogged.has('unconfigured')) {
      getLogger().info('security', 'ALLOWED_PROJECT_PATHS not configured — allowing all project paths. Set ALLOWED_PROJECT_PATHS=/path1;/path2 to restrict.');
      _pathAllowLogged.add('unconfigured');
    }
    return true;
  }
  const resolved = resolvePath(requestedPath);
  return allowed.some(p => resolved === p || resolved.startsWith(ensureSep(p)));
}

/** Reset log state (test-only). */
export function _resetPathAllowWarned(): void { _pathAllowLogged.clear(); }

/** Build a safe environment for child processes, only passing necessary variables. */
/**
 * Build a sanitized environment for Godot child processes.
 *
 * ⚠️ SECURITY NOTE (I-04): The following user-directory variables are passed
 * because Godot needs them for config/cache paths, font discovery, etc.
 * GDScript code running in the child process can read these via OS.get_environment().
 * In sandbox mode, this means GDScript can learn user paths (HOME, APPDATA, etc.).
 * If stricter isolation is needed, use container/VM-level sandboxing.
 */
export function buildSafeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    USERPROFILE: process.env.USERPROFILE ?? '',
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
    APPDATA: process.env.APPDATA ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    GODOT: process.env.GODOT ?? '',
    // Windows-specific variables required for proper process spawning
    SystemRoot: process.env.SystemRoot ?? '',
    COMSPEC: process.env.COMSPEC ?? '',
    OS: process.env.OS ?? '',
    PATHEXT: process.env.PATHEXT ?? '',
    // Linux/GUI variables required for Godot to access display and GPU drivers (A-04)
    DISPLAY: process.env.DISPLAY ?? '',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '',
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '',
  };
}

// ─── Shared: checkVersionMismatch ────────────────────────────────────────────

export async function checkVersionMismatch(projectPath: string, godotBin: string): Promise<string | null> {
  try {
    const configPath = join(projectPath, 'project.godot');
    if (!existsSync(configPath)) return null;
    const config = readFileSync(configPath, 'utf-8');
    const featuresMatch = config.match(/config\/features=PackedStringArray\("([^"]+)"\)/);
    if (!featuresMatch) return null;
    const projectVersion = featuresMatch[1];

    const { stdout, stderr } = await execFileAsync(godotBin, ['--version'], { timeout: GODOT_VERSION_CHECK_TIMEOUT_MS });
    const binVersion = (stdout || stderr || '').trim();
    const binMatch = binVersion.match(/^(\d+\.\d+)/);
    if (!binMatch) return null;
    const binMajorMinor = binMatch[1];

    if (projectVersion !== binMajorMinor) {
      return `[WARNING] Version mismatch: project.godot expects Godot ${projectVersion}, but binary is ${binVersion} (${binMajorMinor}). Errors may be inaccurate.`;
    }
    return null;
  } catch (err) {
    getLogger().warn('helpers', `checkVersionMismatch failed: ${(err as Error).message}`);
    return null;
  }
}

// ─── Shared: parseConfigValue ────────────────────────────────────────────────

/** Split a comma-separated string while respecting quoted segments. */
function splitRespectingQuotes(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) parts.push(last);
  return parts;
}

export function parseConfigValue(raw: string, depth = 0): unknown {
  if (depth > 8) return raw;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  // A-06: 使用 isFinite 排除 Infinity/NaN，Godot 配置中不应出现无穷大
  const num = Number(raw);
  if (Number.isFinite(num) && raw.trim() !== '') return num;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitRespectingQuotes(inner).map(s => parseConfigValue(s, depth + 1)).filter(s => s !== '');
  }
  // I-06: Parse Godot dictionary type {key = value, ...}
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return {};
    const result: Record<string, unknown> = {};
    const entries = splitRespectingQuotes(inner);
    for (const entry of entries) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) continue;
      const key = entry.slice(0, eqIdx).trim();
      const val = entry.slice(eqIdx + 1).trim();
      result[key] = parseConfigValue(val, depth + 1);
    }
    return result;
  }
  return raw;
}

// ─── Shared: parseGodotConfig ────────────────────────────────────────────────

export interface GodotConfig {
  [section: string]: string | number | boolean | null | unknown[] | GodotConfig;
}

export function parseGodotConfig(content: string): GodotConfig {
  const lines = content.split('\n');
  const sectioned = {} as GodotConfig;
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!;
      if (!sectioned[currentSection]) sectioned[currentSection] = {};
      continue;
    }

    const kvMatch = trimmed.match(/^(\S+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const container = currentSection
        ? (sectioned[currentSection] as Record<string, unknown>)
        : sectioned;
      // I-03: Ensure container is actually an object before writing properties
      if (container && typeof container === 'object' && !Array.isArray(container)) {
        container[kvMatch[1]!] = parseConfigValue(kvMatch[2]!.trim());
      }
    }
  }

  return sectioned;
}

// ─── MCP output parser ───────────────────────────────────────────────────────

import { MARKER_RESULT, MARKER_ERROR } from './tools/shared.js';

export function parseMcpScriptOutput(rawOutput: string, exitCode: number | null, resultMarker = MARKER_RESULT, errorMarker = MARKER_ERROR): unknown {
  const lines = rawOutput.split('\n');
  const logLines: string[] = [];
  let parsed: unknown = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(resultMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(resultMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON', raw: trimmed };
      }
    } else if (trimmed.startsWith(errorMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(errorMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON', raw: trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  if (parsed) return parsed;

  return {
    success: false,
    error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
    raw_output: logLines.join('\n'),
  };
}

// ─── File scanner ────────────────────────────────────────────────────────────

export const DEFAULT_SKIP_DIRS = ['.godot', '.import'];

/** Recursively scan a directory for files matching given extensions.
 *  @param rootDir Root directory to scan
 *  @param extensions File extensions to include (e.g. ['.gd', '.tscn'])
 *  @param options.skipDirs Directory names to skip (default: DEFAULT_SKIP_DIRS)
 *  @param options.maxDepth Maximum recursion depth (default: 15)
 *  @param options.skipDotFiles Skip files/dirs starting with '.' (default: true) */
export function scanFiles(
  rootDir: string,
  extensions: string[],
  options: { skipDirs?: string[]; maxDepth?: number; skipDotFiles?: boolean } = {},
): string[] {
  const { skipDirs = DEFAULT_SKIP_DIRS, maxDepth = 15, skipDotFiles = true } = options;
  const results: string[] = [];
  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skipDotFiles && entry.name.startsWith('.')) continue;
        if (skipDirs.includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (extensions.length === 0 || extensions.some(ext => entry.name.endsWith(ext))) {
          results.push(full);
        }
      }
    } catch (err) { getLogger().debug('helpers', `scanFiles: ${err}`); }
  }
  scan(rootDir, 0);
  return results;
}
