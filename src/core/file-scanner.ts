/**
 * File scanning utilities — I-ARCH-03 (extracted from helpers.ts)
 *
 * Recursive directory scanner for Godot project files.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';

export const DEFAULT_SKIP_DIRS = ['.godot', '.import'];

/** Recursively scan a directory for files matching given extensions. */
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
    } catch (err) { getLogger().debug('file-scanner', `scanFiles: ${err}`); }
  }
  scan(rootDir, 0);
  return results;
}
