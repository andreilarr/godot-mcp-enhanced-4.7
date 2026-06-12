import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from './logger.js';

const execFileAsync = promisify(execFile);

const WINDOWS_SEARCH_DIRS = [
  'C:\\Program Files\\Godot',
  'C:\\Program Files (x86)\\Godot',
  // User-specific locations (resolved at runtime to avoid hardcoded usernames)
];

/** Extra search directories from GODOT_MCP_SEARCH_PATHS env var (semicolon-separated). */
function getExtraSearchDirs(): string[] {
  const env = process.env.GODOT_MCP_SEARCH_PATHS;
  if (!env) return [];
  return env.split(';').filter(d => d.length > 0);
}

/** Resolve user-specific search directories (Downloads, Desktop, etc.). */
function getUserSearchDirs(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return [];
  return [
    join(home, 'Downloads'),
    join(home, 'Desktop'),
  ];
}

const POSIX_CANDIDATES = [
  '/usr/bin/godot4',
  '/usr/local/bin/godot4',
  '/Applications/Godot.app/Contents/MacOS/Godot',
];

// ─── Multi-path cache (replaces global singleton) ────────────────────────────
// Key: projectPath or GLOBAL_KEY for the default fallback
const GLOBAL_KEY = '__global__';
const _pathCache = new Map<string, string>();

/** Validate a candidate binary by running --version and checking for Godot signature. */
async function validateGodotBinary(candidatePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(candidatePath, ['--version'], { encoding: 'utf-8', timeout: 5000 });
    return stdout.trim().toLowerCase().includes('godot') || /^\d+\.\d+/.test(stdout.trim());
  } catch (err) {
    getLogger().debug('godot-finder', `validateGodotBinary failed for ${candidatePath}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

function findInDirectory(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir)) {
      if (/^Godot_v4.*\.exe$/i.test(entry)) {
        return join(dir, entry);
      }
    }
  } catch (err) { getLogger().debug('godot-finder', `scanning directory: ${err instanceof Error ? err.message : err}`); }
  return null;
}

// ─── Project-level override resolution ────────────────────────────────────────

/**
 * Try to resolve a project-specific Godot binary path.
 * Priority: .godot/mcp-godot.json > project.godot [godot_mcp] > .godot-version (godots)
 */
async function tryProjectOverride(projectPath: string, tried: string[]): Promise<string | null> {
  // A. Try .godot/mcp-godot.json
  const mcpConfigPath = join(projectPath, '.godot', 'mcp-godot.json');
  if (existsSync(mcpConfigPath)) {
    try {
      const raw = readFileSync(mcpConfigPath, 'utf-8');
      const config = JSON.parse(raw) as { godot_path?: string };
      if (config.godot_path) {
        const candidate = config.godot_path;
        if (existsSync(candidate) && await validateGodotBinary(candidate)) return candidate;
        tried.push(`mcp-godot.json: ${candidate} (not found or failed validation)`);
      }
    } catch {
      tried.push(`mcp-godot.json: parse error`);
    }
  }

  // B. Try [godot_mcp] section in project.godot
  const projectGodotPath = join(projectPath, 'project.godot');
  if (existsSync(projectGodotPath)) {
    try {
      const content = readFileSync(projectGodotPath, 'utf-8');
      // Match [godot_mcp] section and extract godot_path value
      const sectionMatch = content.match(/^\[godot_mcp\]\s*\n([\s\S]*?)(?=\n\[|$)/m);
      if (sectionMatch?.[1]) {
        const pathMatch = sectionMatch[1].match(/^godot_path\s*=\s*"?(.+?)"?\s*$/m);
        if (pathMatch?.[1]) {
          const candidate = pathMatch[1].trim();
          if (existsSync(candidate) && await validateGodotBinary(candidate)) return candidate;
          tried.push(`project.godot [godot_mcp]: ${candidate} (not found or failed validation)`);
        }
      }
    } catch { /* skip */ }
  }

  // C. Try .godot-version file (godots / asdf-style version managers)
  const versionFile = join(projectPath, '.godot-version');
  if (existsSync(versionFile)) {
    try {
      const versionSpec = readFileSync(versionFile, 'utf-8').trim();
      if (versionSpec) {
        const resolved = resolveGodotsVersion(versionSpec);
        if (resolved) {
          if (await validateGodotBinary(resolved)) return resolved;
          tried.push(`godots version "${versionSpec}": ${resolved} (failed validation)`);
        } else {
          tried.push(`godots version "${versionSpec}": no matching binary found`);
        }
      }
    } catch { /* skip */ }
  }

  return null;
}

/**
 * Resolve a godots version specifier to a Godot binary path.
 * Searches ~/.godots/versions/ (and platform-specific locations) for matching versions.
 */
function resolveGodotsVersion(versionSpec: string): string | null {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;

  // godots stores versions in ~/.godots/versions/<version>/
  const godotsDirs = [
    join(home, '.godots', 'versions'),
    // macOS: check Application Support
    join(home, 'Library', 'Application Support', 'Godots', 'versions'),
  ];

  for (const godotsDir of godotsDirs) {
    if (!existsSync(godotsDir)) continue;
    try {
      for (const entry of readdirSync(godotsDir)) {
        if (entry.includes(versionSpec)) {
          const versionDir = join(godotsDir, entry);
          // Look for the Godot binary inside the version directory
          const found = findGodotBinaryInDir(versionDir);
          if (found) return found;
        }
      }
    } catch { /* skip */ }
  }

  return null;
}

/** Find a Godot binary inside a directory (recursively, depth 1). */
function findGodotBinaryInDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      // Direct executable
      if (process.platform === 'win32' && /^Godot.*\.exe$/i.test(entry)) return fullPath;
      if (process.platform !== 'win32' && /^Godot$/i.test(entry)) return fullPath;
      // macOS .app bundle
      if (entry.endsWith('.app')) {
        const macosBin = join(fullPath, 'Contents', 'MacOS', 'Godot');
        if (existsSync(macosBin)) return macosBin;
      }
      // Check one level deeper
      if (existsSync(fullPath) && !entry.startsWith('.')) {
        try {
          for (const sub of readdirSync(fullPath)) {
            if (process.platform === 'win32' && /^Godot.*\.exe$/i.test(sub)) return join(fullPath, sub);
            if (process.platform !== 'win32' && /^Godot$/i.test(sub)) return join(fullPath, sub);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Clear the cached Godot binary path. If projectPath is given, only clear that project's cache. */
export function clearGodotPathCache(projectPath?: string): void {
  if (projectPath) {
    _pathCache.delete(projectPath);
  } else {
    _pathCache.clear();
  }
}

/** Get the currently cached Godot binary path, or null if not yet resolved. */
export function getCachedGodotPath(projectPath?: string): string | null {
  return _pathCache.get(projectPath ?? GLOBAL_KEY) ?? null;
}

/**
 * Find a Godot binary.
 * When projectPath is given, checks project-level overrides first (.godot/mcp-godot.json,
 * project.godot [godot_mcp], .godot-version). Falls back to global GODOT_PATH, PATH, and
 * platform-specific search.
 */
export async function findGodot(projectPath?: string): Promise<string> {
  const cacheKey = projectPath ?? GLOBAL_KEY;

  // 1. Check cache
  const cached = _pathCache.get(cacheKey);
  if (cached && (cached === 'godot' || existsSync(cached))) return cached;
  _pathCache.delete(cacheKey);

  const tried: string[] = [];

  // 2. Project-level overrides (only when projectPath is given)
  if (projectPath) {
    const projectOverride = await tryProjectOverride(projectPath, tried);
    if (projectOverride) { _pathCache.set(cacheKey, projectOverride); return projectOverride; }
  }

  // 3. Environment variable — validate the binary
  if (process.env.GODOT_PATH) {
    if (existsSync(process.env.GODOT_PATH)) {
      if (await validateGodotBinary(process.env.GODOT_PATH)) {
        _pathCache.set(cacheKey, process.env.GODOT_PATH);
        return process.env.GODOT_PATH;
      }
      tried.push(`GODOT_PATH=${process.env.GODOT_PATH} (failed validation)`);
    } else {
      tried.push(`GODOT_PATH=${process.env.GODOT_PATH} (not found)`);
    }
  }

  // 4. Try `godot` on PATH via a quick async spawn
  try {
    const { stdout } = await execFileAsync('godot', ['--version'], { encoding: 'utf-8', timeout: 5000 });
    const out = stdout.trim();
    if (out.includes('Godot') || /^\d+\.\d+/.test(out)) {
      _pathCache.set(cacheKey, 'godot');
      return 'godot';
    }
  } catch (err) { getLogger().debug('godot-finder', `PATH godot failed: ${err instanceof Error ? err.message : err}`); tried.push('godot (PATH)'); }

  // 5. Windows-specific: Registry + Scoop
  if (process.platform === 'win32') {
    const registryResult = await findViaRegistry();
    if (registryResult) { _pathCache.set(cacheKey, registryResult); return registryResult; }
    tried.push('Windows Registry');

    const scoopResult = await findViaScoop();
    if (scoopResult) { _pathCache.set(cacheKey, scoopResult); return scoopResult; }
    tried.push('Scoop');
  }

  // 6. Platform-specific search
  if (process.platform === 'win32') {
    const allDirs = [...WINDOWS_SEARCH_DIRS, ...getUserSearchDirs(), ...getExtraSearchDirs()];
    for (const dir of allDirs) {
      tried.push(`${dir}/Godot_v4*.exe`);
      const found = findInDirectory(dir);
      if (found && await validateGodotBinary(found)) { _pathCache.set(cacheKey, found); return found; }
      if (found) tried.push(`${found} (failed --version validation)`);
    }
  } else {
    for (const candidate of POSIX_CANDIDATES) {
      tried.push(candidate);
      if (existsSync(candidate) && await validateGodotBinary(candidate)) { _pathCache.set(cacheKey, candidate); return candidate; }
    }
  }

  throw new Error(
    `Godot binary not found. Tried:\n${tried.map(t => `  - ${t}`).join('\n')}\nSet GODOT_PATH or add godot to PATH.`
    + (projectPath ? `\nFor project-level config, create .godot/mcp-godot.json or add [godot_mcp] section to project.godot.` : ''),
  );
}

/** Windows: 查找注册表中的 Godot 安装路径 */
async function findViaRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    // 查询 HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall 下的 Godot 条目
    const { stdout } = await execFileAsync('reg', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      '/s', '/f', 'Godot',
    ], { encoding: 'utf-8', timeout: 5000 });
    // 从输出中提取 DisplayIcon 或 InstallLocation 路径
    const match = stdout.match(/DisplayIcon\s+REG_SZ\s+(.+)/m);
    if (match?.[1]) {
      const candidate = match[1].trim();
      if (existsSync(candidate) && await validateGodotBinary(candidate)) return candidate;
    }
  } catch { /* registry not available or no entries */ }
  return null;
}

/** Windows: 查找 Scoop 安装的 Godot */
async function findViaScoop(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return null;
    const scoopShim = join(home, 'scoop', 'shims', 'godot.exe');
    if (existsSync(scoopShim) && await validateGodotBinary(scoopShim)) return scoopShim;
  } catch { /* ignore */ }
  return null;
}
