/**
 * Path security utilities — I-ARCH-03 (extracted from helpers.ts)
 *
 * Path traversal protection, symlink resolution, allowed roots validation.
 */

import { isAbsolute, resolve, relative, sep, basename, dirname } from 'path';
import { existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_DECODE_ITERATIONS = 20;

/** Windows device names that must never be used as file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) */
export const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

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
  if (normalizedPath.includes('..')) {
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

export function allowOutsideProjectPaths(): boolean {
  if (process.env.ALLOW_OUTSIDE_PROJECT_PATHS === 'true') {
    getLogger().error('security', 'ALLOW_OUTSIDE_PROJECT_PATHS is deprecated (removes in v0.18.0) — migrate to ALLOWED_PROJECT_PATHS whitelist');
    return true;
  }
  return false;
}

const _pathAllowLogged = new Set<string>();

function ensureSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep;
}

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
