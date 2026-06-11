/**
 * GDScript executor module for Godot MCP Enhanced.
 *
 * Enables execution of arbitrary GDScript code in a headless Godot process.
 * Inspired by Hastur Operation Plugin's remote execution design:
 * - Code snippet auto-wrapping (no `extends` → auto-wrap)
 * - Structured key-value output via `_mcp_output(key, value)`
 * - Marked output protocol for reliable parsing
 *
 * SECURITY WARNING: GDScript has full system access (FileAccess, DirAccess,
 * OS.execute). There is NO sandbox or code audit layer. This is acceptable for
 * local MCP usage (editor on the same machine), but MUST NOT be exposed to
 * untrusted remote connections without an external sandbox.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { writeFile, mkdir, rm, readdir, lstat, mkdtemp } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { tmpdir, userInfo } from 'os';
import { randomUUID } from 'crypto';
import { analyzeOutput, type ParsedError } from './error-analyzer.js';
import { forceKillTree, getProjectDir, getRunningProcess, acquireShortRunningSlot, releaseShortRunningSlot } from './core/process-state.js';
import { buildSafeEnv } from './helpers.js';
import { MARKER_RESULT as MARKER_RESULT_SHARED, MARKER_ERROR as MARKER_ERROR_SHARED, GD_MCP_GET_ROOT, GD_MCP_GET_NODE, GD_MCP_LOAD_MAIN_SCENE, GD_MCP_OUTPUT } from './tools/shared.js';
import { normalizeIndentToTabs as _sharedNormalizeIndent } from './tools/shared/value-serializer.js';
import { getLogger } from './core/logger.js';
import { needsImport, runImport } from './tools/import-check.js';


// ─── Sandbox scanner (C-SEC-02) ──────────────────────────────────────────────

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /OS\.(execute|shell_open|kill|set_restart_on_exit|crash)\b/, label: 'OS system command' },
  { pattern: /DirAccess\.(remove_absolute|remove)\b/, label: 'Directory removal' },
  // C-03: Allow FileAccess.READ, only flag write modes (WRITE / READ_WRITE / READ_WRITE_APPEND)
  // Use [^;]* to match to statement boundary — avoids truncation on ')' in file paths
  { pattern: /FileAccess\.open\s*\([^;]*FileAccess\.(?:WRITE|READ_WRITE|READ_WRITE_APPEND)\b/, label: 'File write access' },
  { pattern: /Engine\.(set_singleton)\b/, label: 'Engine singleton modification' },
  // C-03: Engine.get_singleton bypasses class-level restrictions (e.g. FileAccess, DirAccess)
  { pattern: /Engine\.get_singleton\b/, label: 'Engine singleton access (sandbox bypass)' },
  { pattern: /JavaScriptBridge\.eval\b/, label: 'JavaScript eval (web escape)' },
  { pattern: /\bstr2var\b/, label: 'str2var (arbitrary deserialization)' },
  { pattern: /\bbytes2var\b/, label: 'bytes2var (arbitrary deserialization)' },
  { pattern: /load\s*\(\s*"(?!res:\/\/)/, label: 'load() with non-resource path' },
  { pattern: /Thread\.(new|start)\b/, label: 'Thread creation' },
  { pattern: /Semaphore\.new\b/, label: 'Semaphore creation' },
  { pattern: /Mutex\.new\b/, label: 'Mutex creation' },
  // C-SEC-01: Reflection/indirect call bypass vectors
  { pattern: /\bClassDB\b/, label: 'ClassDB reflection (sandbox bypass)' },
  // C-SEC-01: Only flag .call()/.callv() with string-literal first arg (reflection pattern).
  // Legitimate Callable.call(variable) is NOT flagged — internal tools use this (e.g. physics-ops collision_overlay).
  { pattern: /\.call\s*\(\s*["']/, label: 'Indirect call via .call("string") (sandbox bypass)' },
  { pattern: /\.callv\s*\(\s*["']/, label: 'Indirect call via .callv("string") (sandbox bypass)' },
  // A-09: Expression.execute can evaluate arbitrary expressions
  { pattern: /Expression\b.*\.execute\b/, label: 'Expression.execute (arbitrary code execution)' },
];

/**
 * Phase 2: Dangerous API tokens that should not appear in string concatenation.
 * Detects bypass attempts like "OS" + ".execute" or preload with computed paths.
 */
const DANGEROUS_API_TOKENS: readonly string[] = [
  'OS.execute', 'OS.shell_open', 'OS.kill',
  'DirAccess.remove', 'DirAccess.remove_absolute',
  'JavaScriptBridge.eval',
  'str2var', 'bytes2var',
  // C-SEC-01: Reflection bypass tokens for string concatenation detection
  'ClassDB', '.call(', '.callv(',
  // C-03: Singleton access via string concatenation
  'Engine.get_singleton',
];

/** Check if code uses string concatenation to build dangerous API names.
 *  Catches patterns like: "OS" + ".execute", 'Dir' + 'Access.remove', etc.
 *  Uses sliding window over string literals to reconstruct concatenated tokens. */
function detectStringConcatBypass(code: string): string[] {
  const warnings: string[] = [];
  // Extract all string literal contents (single and double quoted)
  const stringContents: string[] = [];
  const stringLiteralRe = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match: RegExpExecArray | null;
  while ((match = stringLiteralRe.exec(code)) !== null) {
    const content = match[1] ?? match[2];
    if (content) stringContents.push(content);
  }

  // Concatenate adjacent string parts and check against dangerous tokens.
  // For "ClassName.method" tokens, also check ".method" suffix (e.g. ".execute")
  // to catch: "OS" + ".execute" → ".execute" matches suffix.
  for (let i = 0; i < stringContents.length; i++) {
    for (let j = i; j < Math.min(i + 4, stringContents.length); j++) {
      const combined = stringContents.slice(i, j + 1).join('');
      for (const token of DANGEROUS_API_TOKENS) {
        const dotIdx = token.indexOf('.');
        const suffix = dotIdx >= 0 ? token.slice(dotIdx) : null;
        if (combined === token || (suffix !== null && combined === suffix)) {
          warnings.push(`[SANDBOX-P2] String concatenation bypass attempt: "${token}" built from parts`);
          break;
        }
      }
    }
  }

  // Detect preload with non-literal or computed path
  if (/\bpreload\s*\(\s*(?!["']res:\/\/)/.test(code)) {
    warnings.push('[SANDBOX-P2] preload() with computed/dynamic path');
  }

  return warnings;
}

/** Best-effort scan for dangerous GDScript patterns. Returns warnings array.
 *  Enabled by default; set GODOT_MCP_SANDBOX=disabled to skip scanning.
 *  When warnings are found, execution is BLOCKED unless GODOT_MCP_DISABLE_SAFETY=true
 *  (or the legacy GODOT_MCP_ALLOW_UNSAFE=true).
 *
 *  Phase 1: Direct regex matching of dangerous API calls.
 *  Phase 2: String concatenation bypass detection + preload computed path detection.
 *
 *  ⚠️  SECURITY LIMITATION: This scanner does NOT parse GDScript syntax.
 *  Phase 2 catches common bypass patterns but determined attackers may still
 *  find ways around it. It is designed to prevent ACCIDENTAL and common-intent
 *  misuse, not to defend against adversarial input. For true sandboxing, use
 *  container/VM isolation.
 *
 *  ⚠️  GODOT_MCP_SANDBOX=disabled / GODOT_MCP_DISABLE_SAFETY=true completely
 *  bypasses ALL safety checks. These flags exist for development/debugging only.
 *  Do NOT use in production or multi-user environments. Any code executed while
 *  these flags are active has unrestricted access to the host filesystem,
 *  network, and process execution via OS.execute / FileAccess / DirAccess. */
export function scanGdscriptSandbox(code: string): string[] {
  if (process.env.GODOT_MCP_SANDBOX === 'disabled') {
    getLogger().warn('security', '⚠️ GODOT_MCP_SANDBOX=disabled — ALL sandbox checks bypassed. Any GDScript code will execute with unrestricted host access.');
    return [];
  }
  const warnings: string[] = [];

  // Phase 1: Direct pattern matching
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      warnings.push(`[SANDBOX] Potential dangerous operation detected: ${label}`);
    }
  }

  // C-03: In strict mode, also block FileAccess.READ (all file access)
  if (process.env.GODOT_MCP_SANDBOX === 'strict') {
    if (/FileAccess\.open\b/.test(code)) {
      warnings.push('[SANDBOX] Potential dangerous operation detected: File access (strict mode)');
    }
  }

  // Phase 2: String concatenation bypass detection
  const concatWarnings = detectStringConcatBypass(code);
  warnings.push(...concatWarnings);

  return warnings;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutputEntry {
  key: string;
  value: string;
}

export interface ExecuteGdscriptResult {
  success: boolean;
  compile_success: boolean;
  compile_error: string;
  /** Structured error list with type, file, line, message, and suggestion */
  errors: ParsedError[];
  run_success: boolean;
  run_error: string;
  outputs: OutputEntry[];
  raw_output: string;
  duration_ms: number;
}

export interface ExecuteGdscriptOptions {
  godotPath: string;
  projectPath: string;
  code: string;
  timeout: number; // seconds
  /** When true, runs with full autoload context (slower but can access autoloads like DataRegistry) */
  loadAutoloads?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TMP_PREFIX = 'godot-mcp-exec-';

/** I-16: Opaque symbol to prevent external code from bypassing sandbox */
const _trustedSymbol = Symbol('trusted');

/** Execute GDScript with sandbox scanning disabled. Only for internal trusted code paths. */
export function executeGdscriptTrusted(options: Omit<ExecuteGdscriptOptions, '_skipSandbox'>): Promise<ExecuteGdscriptResult> {
  (options as unknown as Record<symbol, boolean>)[_trustedSymbol] = true;
  return executeGdscript(options as ExecuteGdscriptOptions);
}
/** Re-export markers from shared.ts for consumers that import from this module */
export { MARKER_RESULT_SHARED as MARKER_RESULT, MARKER_ERROR_SHARED as MARKER_ERROR };

/** Generate a random per-execution marker prefix to prevent output forgery.
 *
 *  SECURITY CONTRACT (I-05): This function MUST use a cryptographically secure random source.
 *  The current implementation uses Node.js `randomUUID()` (backed by crypto.randomUUID),
 *  which provides 122 bits of entropy — sufficient to prevent marker prediction.
 *
 *  DO NOT replace with Math.random(), timestamp-based, or any deterministic generator.
 *  If this contract is violated, GDScript code could forge MCP output markers and
 *  inject false results into tool responses. */
function generateMarker(): string {
  return `__MCP_${randomUUID().replace(/-/g, '').substring(0, 16)}__`;
}

// ─── Temp file helpers ──────────────────────────────────────────────────────

const BASE_TMP_DIR = join(tmpdir(), 'godot-mcp-exec');
let baseDirPromise: Promise<void> | null = null;

async function ensureBaseDir(): Promise<void> {
  baseDirPromise ??= mkdir(BASE_TMP_DIR, { recursive: true, mode: 0o700 })
    .then(() => {})
    .catch((err) => {
      baseDirPromise = null;  // C-01: clear cache on failure so next call retries
      throw err;
    });
  return baseDirPromise;
}

/** Create an isolated session directory for one execution */
async function createSessionDir(): Promise<string> {
  await ensureBaseDir();
  // A-02: 嵌入时间戳到目录名，cleanupOldSessions 解析文件名判断过期（不依赖 mtime）
  return mkdtemp(join(BASE_TMP_DIR, `${TMP_PREFIX}${Date.now()}-`));
}

/** Background cleanup: remove session dirs older than 1 hour */
async function cleanupOldSessions(): Promise<void> {
  if (!baseDirPromise) return;
  const maxAge = 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const entry of await readdir(BASE_TMP_DIR)) {
      if (!entry.startsWith(TMP_PREFIX)) continue;
      const dirPath = join(BASE_TMP_DIR, entry);
      const stat = await lstat(dirPath);
      if (stat.isSymbolicLink()) continue;
      // A-02: 优先解析文件名中的时间戳；回退到 mtime（兼容旧格式目录）
      let dirAge: number;
      const tsMatch = entry.match(/-(\d+)-$/);
      if (tsMatch) {
        dirAge = now - parseInt(tsMatch[1]!);
      } else {
        dirAge = now - stat.mtimeMs;
      }
      if (stat.isDirectory() && dirAge > maxAge) {
        // A-07: Retry rm on EPERM/EBUSY (Windows file locking) with backoff
        await retryRm(dirPath);
      }
    }
  } catch (err) { getLogger().debug('gdscript', `cleanup stale dirs: ${err}`); }
}

/** A-07: Retry rm with backoff for EPERM/EBUSY errors on Windows. */
async function retryRm(dirPath: string, maxRetries = 3): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const isRetryable = err instanceof Error && 'code' in err &&
        ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EBUSY');
      if (!isRetryable || attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

async function writeTempScript(code: string, sessionDir: string): Promise<string> {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}.gd`);
  // I-24: POSIX — mode 0o600 restricts to owner read/write only
  await writeFile(filePath, code, { encoding: 'utf-8', mode: 0o600 });
  // I-S5: Restrict file permissions on Windows (icacls overrides POSIX mode)
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = await import('node:child_process');
      // C-ARC-01: Validate username strictly (no backslash injection), use :R not :F
      const winUser = userInfo().username;
      if (winUser && /^[A-Za-z0-9_-]+$/.test(winUser)) {
        execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${winUser}:R`], { windowsHide: true });
      }
    } catch { /* non-critical: best-effort permission restriction */ }
  }
  return filePath;
}

async function writeSessionFile(content: string, ext: string, sessionDir: string): Promise<string> {
  const id = randomUUID().replace(/-/g, '').substring(0, 8);
  const filePath = join(sessionDir, `${id}${ext}`);
  await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600 });
  return filePath;
}

// ─── Code wrapping ──────────────────────────────────────────────────────────

/**
 * Detect if the code is a "full class" (contains `extends`)
 * or a "snippet" that needs auto-wrapping.
 */
export function isFullClass(code: string): boolean {
  // Match `extends` at the start of a line (ignoring whitespace and comments)
  return /^\s*extends\s+/m.test(code);
}

/**
 * Classify GDScript code lines into declarations (class-level) and statements.
 * Declarations include func, var, const, signal, enum, class_name, and annotations.
 * Statements go into _initialize() body.
 */
function classifyLines(code: string): { declarationLines: string[]; statementLines: string[] } {
  // Normalize CRLF → LF so \r doesn't leak into line content and break GDScript parsing
  const lines = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const declarationLines: string[] = [];
  const statementLines: string[] = [];

  let inFuncBody = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // Empty lines go to statement group
    if (trimmed === '') {
      if (inFuncBody) {
        declarationLines.push(line);
      }
      continue;
    }

    // Comment-only lines at top level go to declarations
    if (trimmed.startsWith('#') && !inFuncBody) {
      declarationLines.push(line);
      continue;
    }

    // Top-level declarations: func, var, const, signal, enum, class_name, annotations
    // Only classify as declaration if the line starts at column 0 (no indentation).
    // Indented var/const inside if/while/for blocks are local, not class-level.
    if (/^[^\t ]/.test(line) && /^(func |static func |var |const |signal |enum |class_name |@export|@onready|@icon|@warning)/.test(trimmed)) {
      declarationLines.push(line);
      if (/^(static )?func /.test(trimmed)) {
        inFuncBody = true;
      }
      // Multi-line lambda: var x = func(): / var x = func(args):
      // Body lines must stay with the declaration, not go to _initialize().
      if (/=\s*func\s*\(.*\)\s*:\s*$/.test(trimmed)) {
        inFuncBody = true;
      }
      continue;
    }

    // Lines indented under a func declaration are part of that func body.
    // A top-level (column-0) non-comment line ends the func body.
    // Comment lines at column 0 are intentionally allowed inside func bodies —
    // they don't constitute a new top-level construct.
    if (inFuncBody) {
      if (/^[^\t ]/.test(line) && !trimmed.startsWith('#')) {
        inFuncBody = false;
        // Fall through to statement classification below
      } else {
        declarationLines.push(line);
        continue;
      }
    }

    // Everything else is a statement
    statementLines.push(line);
  }

  // Normalize leading spaces → tabs so wrapper's \t prefix doesn't create mixed indentation
  _normalizeIndentToTabs(declarationLines);
  _normalizeIndentToTabs(statementLines);

  return { declarationLines, statementLines };
}

/** Normalize leading spaces to tabs in-place via the shared implementation. */
function _normalizeIndentToTabs(lines: string[]): void {
  const normalized = _sharedNormalizeIndent(lines.join('\n'));
  const result = normalized.split('\n');
  for (let i = 0; i < lines.length; i++) {
    lines[i] = result[i] ?? lines[i]!;
  }
}

/**
 * Wrap a snippet into a valid `extends SceneTree` script with helper functions.
 * Splits user code into declarations (class-level) and statements (inside _initialize).
 * This allows func/var/const definitions to work correctly at class scope.
 */
export function wrapSnippet(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);

  // BUG-2 fix: SceneTree has a built-in `root` property (Window).
  // User `var root = ...` at class level collides with it.
  // Rename user's `var root` → `var _mcp_user_root` and update references.
  const ST_RESERVED = ['root'];
  for (const reserved of ST_RESERVED) {
    // Step 1: Rename declaration `var root =` → `var _mcp_user_root =`
    // Also covers `var root: Type = ...` and `var root` (no initializer)
    const declPattern = new RegExp(`^(var\\s+)${reserved}\\b`, 'g');
    for (let i = 0; i < declarationLines.length; i++) {
      declarationLines[i] = declarationLines[i]!.replace(declPattern, `$1_mcp_user_${reserved}`);
    }
    // Step 2: Update references in both declarationLines and statementLines.
    // _mcp_user_root contains 'root' but is preceded by '_' so refPattern won't match it.
    const refPattern = new RegExp(`(?<![_.\\w])\\b${reserved}\\b(?!\\w)`, 'g');
    for (let i = 0; i < declarationLines.length; i++) {
      declarationLines[i] = declarationLines[i]!.replace(refPattern, `_mcp_user_${reserved}`);
    }
    for (let i = 0; i < statementLines.length; i++) {
      statementLines[i] = statementLines[i]!.replace(refPattern, `_mcp_user_${reserved}`);
    }
  }

  // Build via array join — prevents JS template interpolation of user code
  const scriptLines: string[] = [
    'extends SceneTree',
    '## MCP snippet mode — autoloads are NOT available unless load_autoloads=true',
    '## Use Variant type for variables to avoid "Cannot infer type" errors',
    '',
    'var _mcp_outputs: Array = []',
    '# Note: _mcp_root named to avoid collision with SceneTree.root (Godot 4.6+)',
    'var _mcp_root: Node = null',
    '',
    ...GD_MCP_GET_ROOT,
    '',
    ...GD_MCP_GET_NODE,
    '',
    ...GD_MCP_LOAD_MAIN_SCENE,
    '',
    ...GD_MCP_OUTPUT,
    '',
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tif Engine.get_main_loop() == self:',
    '\t\tquit(0)',
  ];
  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    scriptLines.push('');
    scriptLines.push(...declarationLines);
    scriptLines.push('');
  }

  scriptLines.push(
    'func _initialize():',
    '\t_mcp_load_main_scene()',
  );

  if (statementLines.length > 0) {
    for (const l of statementLines) {
      scriptLines.push('\t' + l);
    }
  }

  scriptLines.push(
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tif Engine.get_main_loop() == self:',
    '\t\tquit(0)',
  );

  return scriptLines.join('\n') + '\n';
}

/**
 * Wrap a snippet as `extends Node` for autoload mode.
 * The loader scene instantiates this via .new(), so it must be a Node subclass.
 */
export function wrapSnippetAsNode(code: string, resultMarker = MARKER_RESULT_SHARED): string {
  const { declarationLines, statementLines } = classifyLines(code);

  // Rename user's _initialize to _mcp_user_init to avoid collision with our _initialize
  for (let i = 0; i < declarationLines.length; i++) {
    declarationLines[i] = declarationLines[i]!.replace(/func _initialize\(/g, "func _mcp_user_init(");
  }
  const hasUserInit = /func _mcp_user_init\(/.test(declarationLines.join('\n'));

  // Node context variant: uses get_tree().root instead of self.root
  const GD_MCP_GET_ROOT_AS_NODE: readonly string[] = [
    'func _mcp_get_root() -> Node:',
    '\tif _mcp_root != null:',
    '\t\treturn _mcp_root',
    '\tvar _tree = get_tree()',
    '\tif _tree != null and _tree.root != null:',
    '\t\t_mcp_root = _tree.root',
    '\t\treturn _mcp_root',
    '\treturn null',
  ];

  // Build via array join — prevents JS template interpolation of user code
  const nodeLines: string[] = [
    'extends Node',
    '## MCP autoload snippet mode — runs as Node child in loader scene',
    '',
    'var _mcp_outputs: Array = []',
    'var _mcp_root: Node = null',
    '',
    ...GD_MCP_GET_ROOT_AS_NODE,
    '',
    ...GD_MCP_OUTPUT,
    '',
    'func _mcp_done() -> void:',
    '\tprint("' + resultMarker + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
    '\tvar _tree = get_tree()',
    '\tif _tree != null:',
    '\t\t_tree.quit(0)',
  ];

  // User code — safe: array join does not interpolate dollar-brace or backticks
  if (declarationLines.length > 0) {
    nodeLines.push('');
    nodeLines.push(...declarationLines);
    nodeLines.push('');
  }

  nodeLines.push('func _initialize() -> void:');
  if (statementLines.length > 0) {
    for (const l of statementLines) {
      nodeLines.push('\t' + l);
    }
  }
  if (hasUserInit) {
    nodeLines.push('\t_mcp_user_init()');
  }
  nodeLines.push('\t_mcp_done()');

  return nodeLines.join('\n') + '\n';
}

/**
 * For full class mode, inject helper functions and result reporting.
 */
export function injectHelpers(code: string): string {
  // Add helper variables at the top (after extends line)
  const lines = code.split('\n');
  const extendsIdx = lines.findIndex(l => /^\s*extends\s+/.test(l));

  // Skip injection if the code already declares these helpers (exclude comment lines)
  const hasOutputsVar = lines.some(l => /^\s*var\s+_mcp_outputs\s*:/.test(l) && !l.trim().startsWith('#'));
  const hasOutputFunc = lines.some(l => /^\s*func\s+_mcp_output\s*\(/.test(l) && !l.trim().startsWith('#'));
  const hasDoneFunc = lines.some(l => /^\s*func\s+_mcp_done\s*\(/.test(l) && !l.trim().startsWith('#'));

  const helperLines: string[] = [''];
  if (!hasOutputsVar) {
    helperLines.push('var _mcp_outputs: Array = []', '');
  }
  if (!hasOutputFunc) {
    helperLines.push('func _mcp_output(key: String, value: Variant) -> void:', '\t_mcp_outputs.append({"key": key, "value": str(value)})', '');
  }
  if (!hasDoneFunc) {
    helperLines.push(
      'func _mcp_done() -> void:',
      '\tprint("' + MARKER_RESULT_SHARED + '" + JSON.stringify({"success": true, "outputs": _mcp_outputs}))',
      '\tif Engine.get_main_loop() == self:',
      '\t\tquit(0)',
      '',
    );
  }

  const result = [...lines.slice(0, extendsIdx + 1), ...helperLines, ...lines.slice(extendsIdx + 1)];
  return result.join('\n');
}

// ─── Output parsing ─────────────────────────────────────────────────────────

export function parseMcpMarkers(raw: string, resultMarker = MARKER_RESULT_SHARED, errorMarker = MARKER_ERROR_SHARED): {
  parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null;
  logLines: string[];
} {
  const lines = raw.split('\n');
  const logLines: string[] = [];
  let parsed: { success: boolean; outputs?: OutputEntry[]; error?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(resultMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(resultMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON: ' + trimmed };
      }
    } else if (trimmed.startsWith(errorMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(errorMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON: ' + trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  return { parsed, logLines };
}

// ─── Main execution function ────────────────────────────────────────────────

export async function executeGdscript(
  options: ExecuteGdscriptOptions
): Promise<ExecuteGdscriptResult> {
  const { godotPath, projectPath, timeout = 30 } = options;
  let code = options.code;
  let loadAutoloads = options.loadAutoloads ?? false;
  const startTime = Date.now();

  // Warn if same project is being used by a running game process
  const activeProjectDir = getProjectDir();
  if (activeProjectDir && getRunningProcess() && resolve(projectPath) === resolve(activeProjectDir)) {
    getLogger().warn('gdscript', `Warning: project ${projectPath} is also being used by a running game process. Headless execution should be safe but watch for .godot/ cache conflicts.`);
  }

  // Hard kill switch: set ALLOW_EXECUTE_GDSCRIPT=false to disable GDScript execution
  if (process.env.ALLOW_EXECUTE_GDSCRIPT === 'false') {
    return { success: false, compile_success: false, compile_error: 'GDScript execution is disabled (ALLOW_EXECUTE_GDSCRIPT=false)', errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0 };
  }

  // C-SEC-02: Sandbox scan — BLOCKS execution on dangerous patterns by default
  const skipSandbox = (options as unknown as Record<symbol, boolean>)[_trustedSymbol] === true;
  const sandboxWarnings = skipSandbox ? [] : scanGdscriptSandbox(code);
  // C-02: Support both new GODOT_MCP_DISABLE_SAFETY and legacy GODOT_MCP_ALLOW_UNSAFE
  const safetyDisabled = process.env.GODOT_MCP_DISABLE_SAFETY === 'true' || process.env.GODOT_MCP_ALLOW_UNSAFE === 'true';
  if (sandboxWarnings.length > 0 && !safetyDisabled) {
    return {
      success: false, compile_success: false,
      compile_error: `Sandbox violation: code contains dangerous patterns. Set GODOT_MCP_DISABLE_SAFETY=true to override.\n${sandboxWarnings.join('\n')}`,
      errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0,
    };
  }
  if (sandboxWarnings.length > 0 && safetyDisabled) {
    // I-04: 结构化审计事件 — 记录安全绕过的完整上下文（代码摘要、时间戳、触发模式）
    // I-10: Sanitize string literals in code summary to prevent credential leakage
    const rawSummary = code.slice(0, 120).replace(/\n/g, '\\n');
    const codeSummary = rawSummary.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g, '"***"');
    getLogger().warn('security', JSON.stringify({
      audit: 'SANDBOX_BYPASS',
      warnings: sandboxWarnings,
      codePreview: codeSummary,
      flag: process.env.GODOT_MCP_DISABLE_SAFETY === 'true' ? 'GODOT_MCP_DISABLE_SAFETY' : 'GODOT_MCP_ALLOW_UNSAFE',
    }));
    getLogger().warn('security', `Safety bypass active — executing despite sandbox warnings: ${sandboxWarnings}`);
    // I-18: Mark execution output so downstream consumers know sandbox was bypassed
    code = '# [UNSANDBOXED] Executing with safety bypass\n' + code;
  }

  // Validate godotPath exists and looks like a Godot binary
  if (!existsSync(godotPath)) {
    return { success: false, compile_success: false, compile_error: `Godot binary not found: ${godotPath}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0 };
  }
  const binName = basename(godotPath).toLowerCase();
  if (!binName.includes('godot')) {
    return { success: false, compile_success: false, compile_error: `Binary does not appear to be Godot: ${basename(godotPath)}`, errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0 };
  }

  // P3: Auto-import warmup — ensures .godot/imported/ is fresh before headless execution
  if (needsImport(projectPath)) {
    try {
      getLogger().info('executor', `Running import warmup for ${projectPath}`);
      await runImport(projectPath, godotPath);
    } catch (importErr) {
      getLogger().warn('executor', `Import warmup failed: ${importErr instanceof Error ? importErr.message : importErr}`);
      // Non-fatal — continue execution
    }
  }

  // Acquire short-running slot AFTER all validation — ensures no early-return leaks the slot
  if (!acquireShortRunningSlot()) {
    return { success: false, compile_success: false, compile_error: 'Too many concurrent headless operations (max 3). Please wait and retry.', errors: [], run_success: false, run_error: '', outputs: [], raw_output: '', duration_ms: 0 };
  }

  // C-01: Generate random per-execution markers to prevent user code forgery
  const rndResult = generateMarker();
  const rndError = generateMarker();

  // Prepare script content
  // Routing logic:
  // --script mode requires extends SceneTree/MainLoop
  // --scene (autoload) mode uses loader that calls .new(), requires extends Node
  // SceneTree-based scripts (using root/quit/get_node override) CANNOT run as Node,
  // so autoload mode is downgraded to --script for them.
  let scriptContent: string;
  if (isFullClass(code)) {
    const extendsSceneTree = /^\s*extends\s+(SceneTree|MainLoop)/m.test(code);
    if (extendsSceneTree) {
      // SceneTree scripts always use --script mode (root/quit API incompatible with Node)
      loadAutoloads = false;
      scriptContent = injectHelpers(code);
    } else if (loadAutoloads) {
      // Full class extending Node etc. with autoloads → inject helpers, loader calls .new()
      scriptContent = injectHelpers(code);
    } else {
      // Full class extending Node/etc. without autoloads → strip extends, wrap as SceneTree
      const strippedCode = code.replace(/^\s*extends\s+\S+.*\n?/m, '');
      scriptContent = wrapSnippet(strippedCode, rndResult);
    }
  } else if (loadAutoloads) {
    scriptContent = wrapSnippetAsNode(code, rndResult);
  } else {
    scriptContent = wrapSnippet(code, rndResult);
  }

  // C-09: For injectHelpers path, replace fixed markers with random ones
  // (wrapSnippet paths already use random markers via template parameter)
  scriptContent = scriptContent.replaceAll(MARKER_RESULT_SHARED, rndResult);
  scriptContent = scriptContent.replaceAll(MARKER_ERROR_SHARED, rndError);

  // Create isolated session directory
  await cleanupOldSessions();
  const sessionDir = await createSessionDir();

  // Write temp file
  const tempFiles: string[] = [];
  let tempFile: string;
  try {
    tempFile = await writeTempScript(scriptContent, sessionDir);
    tempFiles.push(tempFile);
  } catch (err) {
    releaseShortRunningSlot();
    return {
      success: false,
      compile_success: false,
      compile_error: `Failed to write temp script: ${err}`,
      errors: [],
      run_success: false,
      run_error: '',
      outputs: [],
      raw_output: '',
      duration_ms: Date.now() - startTime,
    };
  }

  // Build Godot arguments
  const godotArgs: string[] = ['--headless', '--path', projectPath];
  if (loadAutoloads) {
    // Autoload mode: create a loader scene that initializes all autoloads first
    try {
      // Write loader script first to get its absolute path
      const loaderScriptPath = await writeSessionFile(createAutoloadLoaderScript(tempFile, rndError), '.gd', sessionDir);
      tempFiles.push(loaderScriptPath);
      // Create scene referencing loader script by absolute path (not res://)
      const loaderScene = createAutoloadLoaderScene(loaderScriptPath);
      const loaderScenePath = await writeSessionFile(loaderScene, '.tscn', sessionDir);
      tempFiles.push(loaderScenePath);
      godotArgs.push('--scene', loaderScenePath);
    } catch (err) {
      rm(sessionDir, { recursive: true, force: true }).catch(() => {});
      releaseShortRunningSlot();
      return {
        success: false,
        compile_success: false,
        compile_error: `Failed to create autoload loader files: ${err}`,
        errors: [],
        run_success: false,
        run_error: '',
        outputs: [],
        raw_output: '',
        duration_ms: Date.now() - startTime,
      };
    }
  } else {
    godotArgs.push('--script', tempFile);
  }

  // Spawn Godot process
  return new Promise<ExecuteGdscriptResult>((resolve, reject) => {
    // C-PERF-01: Use Buffer[] to avoid O(n²) string concatenation.
    // Each += on a string copies the entire contents; with 10MB of output
    // this becomes catastrophically slow. Buffers collect chunks and
    // are joined once at close time.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB output limit
    let outputExceeded = false;

    const proc = spawn(godotPath, godotArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildSafeEnv(),
    });

    proc.stdout?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stdoutChunks.push(d);
      stdoutBytes += d.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        stdoutChunks.push(Buffer.from('\n[OUTPUT TRUNCATED: exceeded 10MB limit]'));
        forceKillTree(proc);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      if (outputExceeded) return;
      stderrChunks.push(d);
      stderrBytes += d.byteLength;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        stderrChunks.push(Buffer.from('\n[OUTPUT TRUNCATED: exceeded 10MB limit]'));
        forceKillTree(proc);
      }
    });

    const timer = setTimeout(() => {
      if (!proc.killed) {
        forceKillTree(proc);
      }
    }, timeout * 1000);

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      releaseShortRunningSlot();
      // Cleanup session directory (fire-and-forget async)
      rm(sessionDir, { recursive: true, force: true }).catch(() => {});

      const rawOutput = stdout + stderr;
      const duration = Date.now() - startTime;
      const { parsed, logLines } = parseMcpMarkers(rawOutput, rndResult, rndError);
      const analysis = analyzeOutput(logLines);

      if (parsed) {
        const isSuccess = parsed.success === true;
        // Detect compile errors from Godot output
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;

        resolve({
          success: isSuccess && !hasCompileError,
          compile_success: !hasCompileError,
          compile_error: compileError,
          errors: analysis.errors,
          run_success: isSuccess,
          run_error: parsed.error || '',
          outputs: (parsed.outputs || []) as OutputEntry[],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
        });
      } else {
        // No marker found — likely a compile error or crash
        const compileError = extractCompileError(rawOutput);
        const hasCompileError = compileError.length > 0;
        // Safety net: if no real errors (only RID leak cleanup warnings),
        // the script likely ran but cleanup crashed before marker print
        if (!hasCompileError && exitCode !== 0) {
          const hasRealError = /\b(Parse Error|Script Error|SCRIPT ERROR)\b/.test(rawOutput);
          if (!hasRealError) {
            resolve({
              success: false,
              compile_success: true,
              compile_error: '',
              errors: analysis.errors,
              run_success: false,
              run_error: `Process exited with code ${exitCode} (likely RID leak during cleanup, no script error found)`,
              outputs: [],
              raw_output: logLines.join('\n'),
              duration_ms: duration,
            });
            return;
          }
        }
        resolve({
          success: false,
          compile_success: !hasCompileError,
          compile_error: compileError,
          errors: analysis.errors,
          run_success: false,
          run_error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
          outputs: [],
          raw_output: logLines.join('\n'),
          duration_ms: duration,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      releaseShortRunningSlot();
      rm(sessionDir, { recursive: true, force: true }).catch(() => {});

      // Spawn failure is fatal — reject so callers can catch and report
      reject(new Error(`Failed to spawn Godot process: ${err.message}`));
    });
  });
}

/**
 * Extract compile error from Godot output.
 * Godot prints errors like: "scripts/gdscript/gdscript.cpp:123 - Parse Error: ..."
 */
function extractCompileError(raw: string): string {
  const lines = raw.split('\n');
  const errors: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('Parse Error:') || trimmed.includes('Script Error:')) {
      errors.push(trimmed);
    }
  }
  return errors.join('\n');
}

// ─── Autoload loader helpers ──────────────────────────────────────────────────

/**
 * Create a minimal .tscn scene that loads with autoload context.
 * The scene runs the user's script from _ready().
 */
export function createAutoloadLoaderScene(loaderScriptPath: string): string {
  const loaderPathRes = loaderScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    '[gd_scene load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="' + loaderPathRes + '" id="1"]',
    '',
    '[node name="MCPLoader" type="Node"]',
    'script = ExtResource("1")',
    '',
  ].join('\n');
}

/**
 * Create the loader GDScript that loads with autoload context.
 * In _ready(), all autoloads are available. It then loads and runs the user script.
 */
export function createAutoloadLoaderScript(userScriptPath: string, errorMarker: string): string {
  const pathRes = userScriptPath.replace(/\\/g, '/').replace(/"/g, '\\"');
  return [
    'extends Node',
    '',
    'func _ready() -> void:',
    '\tvar user_script: GDScript = load("' + pathRes + '") as GDScript',
    '\tif user_script == null:',
    '\t\tprint("' + errorMarker + '" + JSON.stringify({"success": false, "error": "Failed to load user script"}))',
    '\t\tget_tree().quit(0)',
    '\t\treturn',
    '\tvar instance: Variant = user_script.new()',
    '\tif instance.has_method("_initialize"):',
    '\t\tinstance._initialize()',
    '\tget_tree().quit(0)',
  ].join('\n') + '\n';
}
