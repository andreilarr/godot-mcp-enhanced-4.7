/**
 * helpers.ts — Aggregated re-export barrel (I-ARCH-03)
 *
 * Original implementations moved to:
 *   - src/core/path-utils.ts    (path security, traversal protection)
 *   - src/core/config-parser.ts  (config parsing, MCP output parsing)
 *   - src/core/file-scanner.ts   (recursive file scanning)
 *
 * This file re-exports everything for backward compatibility.
 * 37 import sites continue to work without changes.
 */

// ─── Re-export from split modules ─────────────────────────────────────────────
export {
  iterativeDecode,
  resolvePath,
  validatePath,
  validateProjectRoot,
  safeRealPath,
  resolveWithinRoot,
  normalizeUserProjectPath,
  getAllowedProjectPaths,
  allowOutsideProjectPaths,
  isPathInAllowedRoots,
  _resetPathAllowWarned,
} from './core/path-utils.js';
// Note: WINDOWS_DEVICE_RE intentionally NOT re-exported — internal to path-utils

export {
  parseConfigValue,
  parseGodotConfig,
  parseMcpScriptOutput,
} from './core/config-parser.js';

export type { GodotConfig } from './core/config-parser.js';

export {
  scanFiles,
  DEFAULT_SKIP_DIRS,
} from './core/file-scanner.js';

// ─── Local utilities (kept here — small, used broadly) ────────────────────────

import { dirname } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from './core/logger.js';
import { validatePath, isPathInAllowedRoots } from './core/path-utils.js';

const execFileAsync = promisify(execFile);

export function ensureDir(p: string): void {
  if (!existsSync(dirname(p))) {
    mkdirSync(dirname(p), { recursive: true });
  }
}

/** Require a non-empty string from tool args. */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${key} must be a non-empty string, got: ${v === undefined ? 'undefined' : v === null ? 'null' : JSON.stringify(v)}`);
  }
  return v;
}

/** Require a finite number from tool args. */
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

/**
 * Build a sanitized environment for Godot child processes.
 *
 * SECURITY NOTE (I-04): The following user-directory variables are passed
 * because Godot needs them to locate editor data, cache, and config:
 * HOME, USERPROFILE, LOCALAPPDATA, APPDATA, XDG_*, DISPLAY.
 * All other env vars are stripped to prevent credential leakage to child processes.
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
    SystemRoot: process.env.SystemRoot ?? '',
    COMSPEC: process.env.COMSPEC ?? '',
    OS: process.env.OS ?? '',
    PATHEXT: process.env.PATHEXT ?? '',
    DISPLAY: process.env.DISPLAY ?? '',
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '',
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? '',
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '',
  };
}

const GODOT_VERSION_CHECK_TIMEOUT_MS = 5000;

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
