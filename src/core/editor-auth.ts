// src/core/editor-auth.ts
import { readFileSync, chmodSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { userInfo } from 'os';
import { getLogger } from './logger.js';

const SECRET_FILE_NAME = 'mcp_editor.key';
let _permWarned = false;

/** On Windows, use icacls to restrict file to current user only. Returns true if ACL was applied successfully. */
function restrictFileWindows(filePath: string): boolean {
  try {
    // C-ARC-01: Use os.userInfo().username (no environment variable spoofing)
    // and strictly validate format — no backslashes (rejects DOMAIN\user injection).
    const username = userInfo().username;
    if (!username || !/^[A-Za-z0-9_-]+$/.test(username)) {
      if (!_permWarned) {
        _permWarned = true;
        getLogger().error('security', `Cannot set ACL: username "${username}" contains unexpected characters.`);
      }
      return false;
    }
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:R`], { stdio: 'ignore' });
    // Verify the ACL was applied by reading it back
    const output = execFileSync('icacls', [filePath], { encoding: 'utf-8' });
    // Case-insensitive match — Windows usernames are case-insensitive
    if (!output.toLowerCase().includes(username.toLowerCase())) {
      if (!_permWarned) {
        _permWarned = true;
        getLogger().error('security', `ACL verification failed for ${filePath}: ${output.trim()}`);
      }
      return false;
    }
    return true;
  } catch {
    if (!_permWarned) {
      _permWarned = true;
      getLogger().error('security', `Failed to set Windows ACL on ${filePath}`);
    }
    return false;
  }
}

/** Check and tighten file permissions. Returns true if permissions are acceptable. */
function checkFilePermissions(filePath: string): boolean {
  if (process.platform === 'win32') {
    // Windows: restrictFileWindows applies ACL restrictions; always returns true.
    return restrictFileWindows(filePath);
  }
  try { chmodSync(filePath, 0o600); } catch (err) { getLogger().debug('auth', `chmod secret: ${err}`); }
  const stat = statSync(filePath);
  if ((stat.mode & 0o007) !== 0) {
    if (!_permWarned) {
      _permWarned = true;
      getLogger().error('security', `Editor secret ${filePath} is world-readable. Attempted chmod 0600.`);
    }
    return false;
  }
  return true;
}

/** Read the editor secret from {project}/.godot/mcp_editor.key. Returns null if not found. */
export function readEditorSecret(projectPath: string): string | null {
  const secretPath = join(projectPath, '.godot', SECRET_FILE_NAME);
  try {
    // Read directly without existsSync to avoid TOCTOU race between check and read.
    const content = readFileSync(secretPath, 'utf-8').trim();
    if (!checkFilePermissions(secretPath)) {
      getLogger().error('security', `Refusing to use editor secret with insecure permissions: ${secretPath}`);
      return null;
    }
    return content;
  } catch (err: unknown) {
    // ENOENT is expected (plugin not started yet) — silent.
    // Other errors (EACCES, EISDIR, etc.) should be surfaced for diagnosis.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getLogger().error('auth', `Failed to read editor secret: ${(err as NodeJS.ErrnoException).code} — ${(err as Error).message}`);
    }
    return null;
  }
}

/** Poll for the editor secret file to appear (plugin may still be starting). */
export async function waitForEditorSecret(
  projectPath: string,
  timeoutMs = 5000,
): Promise<string | null> {
  const interval = 200;
  const deadline = Date.now() + timeoutMs;
  const secretFilePath = join(projectPath, '.godot', SECRET_FILE_NAME);
  while (Date.now() < deadline) {
    // I-09: Fast path — check existsSync first to avoid expensive execFileSync (icacls) on every poll
    if (!existsSync(secretFilePath)) {
      await new Promise(r => setTimeout(r, interval));
      continue;
    }
    const secret = readEditorSecret(projectPath);
    if (secret) return secret;
    await new Promise(r => setTimeout(r, interval));
  }
  return readEditorSecret(projectPath);
}
