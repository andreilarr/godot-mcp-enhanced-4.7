/**
 * Import warmup module for Godot MCP Enhanced.
 *
 * Godot headless mode does NOT run the resource import pipeline,
 * so `.godot/imported/` may be missing or stale, causing `load()` to fail.
 *
 * This module detects stale/missing imported resources and runs
 * `godot --headless --import` to warm up the cache before execution.
 */

import { spawn } from 'child_process';
import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { forceKillTree } from '../core/process-state.js';
import { getLogger } from '../core/logger.js';
import { buildSafeEnv } from '../helpers.js';

// ─── Cache state ──────────────────────────────────────────────────────────────

/** Timestamp of the latest mtime seen across scanned asset directories. */
let _lastCheckedAssetMtime: number | null = null;

/** Project path that the cached mtime corresponds to. */
let _lastCheckedProject: string | null = null;

/** Directories to scan for new/modified assets (top-level only). */
const ASSET_SCAN_DIRS = ['assets', 'scenes', 'scripts'];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reset import cache — for test isolation.
 */
export function resetImportCache(): void {
  _lastCheckedAssetMtime = null;
  _lastCheckedProject = null;
}

/**
 * Check whether a project needs an import warmup run.
 *
 * Returns true when:
 * 1. `GODOT_MCP_AUTO_IMPORT=false` is NOT set, AND
 * 2. `.godot/imported/` does not exist, OR new asset files have been detected
 *    (based on mtime comparison with cached state).
 */
export function needsImport(projectPath: string): boolean {
  // P3: Allow users to opt out of auto-import
  if (process.env.GODOT_MCP_AUTO_IMPORT === 'false') {
    return false;
  }

  const importedDir = join(projectPath, '.godot', 'imported');

  // If .godot/imported/ doesn't exist at all, definitely need import
  if (!existsSync(importedDir)) {
    return true;
  }

  // Scan asset directories for latest mtime
  const latestMtime = scanLatestMtime(projectPath);

  // No asset dirs found or couldn't scan — assume no import needed
  if (latestMtime === 0) {
    // Update cache to avoid repeated scanning
    _lastCheckedAssetMtime = 0;
    _lastCheckedProject = projectPath;
    return false;
  }

  // First check for this project — cache current state, but still check freshness
  if (_lastCheckedProject !== projectPath || _lastCheckedAssetMtime === null) {
    // Check if imported dir is stale (older than latest asset)
    const importedStat = statSafe(importedDir);
    if (importedStat && importedStat.mtimeMs < latestMtime) {
      return true;
    }
    // Cache the current state
    _lastCheckedAssetMtime = latestMtime;
    _lastCheckedProject = projectPath;
    return false;
  }

  // Same project — check if any new files appeared since last check
  if (latestMtime > _lastCheckedAssetMtime) {
    return true;
  }

  // No new files detected — update cache and return false
  _lastCheckedAssetMtime = latestMtime;
  _lastCheckedProject = projectPath;
  return false;
}

/**
 * Run `godot --headless --import` to warm up the resource import cache.
 *
 * @throws Error if the import process fails or times out.
 */
export async function runImport(
  projectPath: string,
  godotPath: string,
  timeoutMs: number = 60_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      godotPath,
      ['--headless', '--import', '--path', projectPath],
      { stdio: ['ignore', 'pipe', 'pipe'], env: buildSafeEnv() },
    );

    // C-PERF-01: Use Buffer[] to avoid O(n²) string concatenation
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout?.on('data', (data: Buffer) => {
      stdoutChunks.push(data);
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data);
    });

    const timer = setTimeout(() => {
      forceKillTree(proc);
      const stdoutTail = Buffer.concat(stdoutChunks).toString('utf-8').slice(-500);
      const stderrTail = Buffer.concat(stderrChunks).toString('utf-8').slice(-500);
      reject(new Error(
        `Import warmup timed out after ${timeoutMs}ms for ${projectPath}. ` +
        `stdout: ${stdoutTail || '(empty)'}; stderr: ${stderrTail || '(empty)'}`,
      ));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Import warmup failed to spawn: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code === 0) {
        // Update cache to reflect the fresh import
        const latestMtime = scanLatestMtime(projectPath);
        _lastCheckedAssetMtime = latestMtime || Date.now();
        _lastCheckedProject = projectPath;
        getLogger().info('import-check', `Import warmup completed for ${projectPath}`);
        resolve();
      } else {
        reject(new Error(
          `Import warmup exited with code ${code} for ${projectPath}. ` +
          `stdout: ${stdout.slice(-500) || '(empty)'}; stderr: ${stderr.slice(-500) || '(empty)'}`,
        ));
      }
    });
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Scan top-level asset directories for the latest file mtime.
 * Returns 0 if no files found or directories don't exist.
 */
function scanLatestMtime(projectPath: string): number {
  let latest = 0;

  for (const dir of ASSET_SCAN_DIRS) {
    const dirPath = join(projectPath, dir);
    if (!existsSync(dirPath)) continue;

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          const stat = statSync(join(dirPath, entry.name));
          if (stat.mtimeMs > latest) {
            latest = stat.mtimeMs;
          }
        } catch {
          // Skip files we can't stat (permissions, broken symlinks, etc.)
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return latest;
}

/**
 * Safe statSync that returns null on error instead of throwing.
 */
function statSafe(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
