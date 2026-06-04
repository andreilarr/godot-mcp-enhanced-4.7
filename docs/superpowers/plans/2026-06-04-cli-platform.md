# CLI Platform 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 godot-mcp-enhanced 从手动配置的 MCP 服务器变成 `npx godot-mcp-enhanced setup` 一行启动的 CLI 开发环境。

**Architecture:** 统一 CLI 入口——无参数走 MCP stdio，子命令走 CLI。4 个客户端适配器（策略模式）。init 复用现有 create_project。~550 行新代码。

**Tech Stack:** TypeScript, Vitest, Node.js child_process

---

## File Structure

```
新增:
src/cli/
├── router.ts           (~80 行) 子命令路由
├── setup.ts            (~120 行) setup 命令
├── doctor.ts           (~100 行) doctor 命令
├── init.ts             (~60 行) init 命令
└── clients/
    ├── types.ts        (~20 行) ClientAdapter 接口
    ├── claude-code.ts  (~50 行) Claude Code 适配器
    ├── cursor.ts       (~40 行) Cursor 适配器
    ├── opencode.ts     (~40 行) OpenCode 适配器
    └── codex.ts        (~40 行) Codex 适配器

修改:
src/index.ts            (+20 行) 子命令分流
src/core/godot-finder.ts (+50 行) 注册表 + Scoop 发现

新增测试:
test/cli/
├── router.test.ts
├── setup.test.ts
├── doctor.test.ts
├── init.test.ts
└── clients/
    ├── claude-code.test.ts
    ├── cursor.test.ts
    ├── opencode.test.ts
    └── codex.test.ts
```

---

### Task 1: ClientAdapter 接口 + 路由骨架

**Files:**
- Create: `src/cli/clients/types.ts`
- Create: `src/cli/router.ts`
- Modify: `src/index.ts`
- Create: `test/cli/router.test.ts`

- [ ] **Step 1: 写 types.ts — ClientAdapter 接口**

```typescript
// src/cli/clients/types.ts
export interface ClientAdapter {
  name: string;
  detect(): Promise<boolean>;
  isConfigured(projectDir: string): Promise<boolean>;
  configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void>;
}
```

- [ ] **Step 2: 写 router.ts 骨架**

```typescript
// src/cli/router.ts
import type { ClientAdapter } from './clients/types.js';

const SUBCOMMANDS = ['setup', 'doctor', 'init', 'dashboard'] as const;
export type Subcommand = typeof SUBCOMMANDS[number];

export function parseSubcommand(args: string[]): { subcommand: Subcommand; rest: string[] } | null {
  if (args.length === 0) return null;
  const first = args[0];
  if ((SUBCOMMANDS as readonly string[]).includes(first)) {
    return { subcommand: first as Subcommand, rest: args.slice(1) };
  }
  return null;
}

export async function routeCommand(args: string[]): Promise<void> {
  const parsed = parseSubcommand(args);
  if (!parsed) {
    console.error(`Unknown command: ${args[0]}`);
    console.error('Run "godot-mcp-enhanced --help" for usage.');
    process.exit(1);
  }

  switch (parsed.subcommand) {
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      await runSetup(parsed.rest);
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      await runDoctor(parsed.rest);
      break;
    }
    case 'init': {
      const { runInit } = await import('./init.js');
      await runInit(parsed.rest);
      break;
    }
    case 'dashboard': {
      const { launchDashboardOnce } = await import('../dashboard/launcher.js');
      launchDashboardOnce();
      // 启动后保持进程存活（Dashboard 会接管终端）
      const { resolveLogDir } = await import('../core/logger.js');
      const { LogReader } = await import('../dashboard/log-reader.js');
      const { Aggregator } = await import('../dashboard/aggregator.js');
      const { renderDashboard } = await import('../dashboard/ui.js');
      // 复用 dashboard/index.ts 的启动逻辑（后续 Task 细化）
      console.log('Dashboard starting...');
      process.exit(0);
    }
  }
}

export function isCliInvocation(args: string[]): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  if (first.startsWith('-')) {
    // --help / --version 走 CLI
    if (first === '--help' || first === '-h' || first === '--version' || first === '-v') return true;
    // --profile=xxx 等 MCP flags 不走 CLI
    return false;
  }
  // 子命令走 CLI
  return (SUBCOMMANDS as readonly string[]).includes(first);
}

export function showHelp(): void {
  console.log(`
godot-mcp-enhanced — Godot AI 开发环境

用法:
  godot-mcp-enhanced                  启动 MCP 服务器（stdio 模式）
  godot-mcp-enhanced setup            一键配置 AI 客户端
  godot-mcp-enHANCED doctor           环境诊断
  godot-mcp-enhanced init <name>      创建 Godot 项目
  godot-mcp-enhanced dashboard        启动监控面板

MCP 参数:
  --profile=<name>  工具 profile (full/minimal/lite)
  --minimal         最小工具集
  --lite            轻量工具集
  --help, -h        显示帮助
  --version, -v     显示版本
`);
}

export function showVersion(): void {
  // 读取 package.json version
  const pkg = require('../../package.json');
  console.log(`godot-mcp-enhanced v${pkg.version}`);
}
```

- [ ] **Step 3: 修改 src/index.ts — 子命令分流**

将现有 MCP 启动逻辑提取为 `startMcpServer()` 函数，并在入口添加 CLI 分流：

```typescript
// src/index.ts — 完整替换
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { GodotServer } from './GodotServer.js';
import { getLogger } from './core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function startMcpServer(args: string[]): Promise<void> {
  const profileArg = args.find(a => a.startsWith('--profile='));
  const profileFromArg = profileArg ? profileArg.split('=')[1] : null;
  const profileFromEnv = process.env.GODOT_MCP_PROFILE;

  const activeProfile = profileFromArg || profileFromEnv;

  const toolMode = activeProfile ? activeProfile
    : args.includes('--minimal') ? 'minimal'
    : args.includes('--lite') ? 'lite'
    : process.env.GODOT_MCP_MODE === 'minimal' ? 'minimal'
    : process.env.GODOT_MCP_MODE === 'lite' ? 'lite'
    : 'full';

  const connectionMode = process.env.GODOT_MCP_MODE === 'editor' ? 'editor' : 'headless';
  const readOnly = process.env.GODOT_MCP_READ_ONLY === 'true' || process.env.READ_ONLY_MODE === 'true';
  const noFallback = process.env.GODOT_MCP_NO_FALLBACK === 'true';

  const server = new GodotServer(join(__dirname, 'scripts', 'godot_operations.gd'), {
    mode: toolMode,
    connectionMode,
    readOnly,
    noFallback,
  });

  let shuttingDown = false;
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const logger = getLogger();
    logger.info('godot-mcp', `Received ${signal}, shutting down...`);
    try {
      logger.close();
      await server.close();
    } catch (err) {
      logger.error('godot-mcp', `Error during shutdown: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  server.run().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    getLogger().error('godot-mcp', 'Failed to run server', { error: msg });
    process.exit(1);
  });
}

// ── 入口分流 ──────────────────────────────────────────────
const args = process.argv.slice(2);

(async () => {
  const { isCliInvocation, showHelp, showVersion, routeCommand } = await import('./cli/router.js');

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }
  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }
  if (isCliInvocation(args)) {
    await routeCommand(args);
    process.exit(0);
  }

  // 默认: MCP stdio 模式
  await startMcpServer(args);
})();
```

- [ ] **Step 4: 写 router 测试**

```typescript
// test/cli/router.test.ts
import { describe, it, expect } from 'vitest';
import { parseSubcommand, isCliInvocation } from '../../src/cli/router.js';

describe('router', () => {
  describe('parseSubcommand', () => {
    it('parses setup subcommand', () => {
      const result = parseSubcommand(['setup', '--project=/foo']);
      expect(result).toEqual({ subcommand: 'setup', rest: ['--project=/foo'] });
    });

    it('returns null for empty args', () => {
      expect(parseSubcommand([])).toBeNull();
    });

    it('returns null for flags', () => {
      expect(parseSubcommand(['--profile=full'])).toBeNull();
    });

    it('returns null for --help', () => {
      expect(parseSubcommand(['--help'])).toBeNull();
    });

    it('parses all valid subcommands', () => {
      for (const cmd of ['setup', 'doctor', 'init', 'dashboard'] as const) {
        expect(parseSubcommand([cmd])).toEqual({ subcommand: cmd, rest: [] });
      }
    });
  });

  describe('isCliInvocation', () => {
    it('returns true for setup', () => {
      expect(isCliInvocation(['setup'])).toBe(true);
    });

    it('returns true for --help', () => {
      expect(isCliInvocation(['--help'])).toBe(true);
    });

    it('returns true for --version', () => {
      expect(isCliInvocation(['--version'])).toBe(true);
    });

    it('returns true for -v', () => {
      expect(isCliInvocation(['-v'])).toBe(true);
    });

    it('returns false for empty args', () => {
      expect(isCliInvocation([])).toBe(false);
    });

    it('returns false for --profile flag', () => {
      expect(isCliInvocation(['--profile=full'])).toBe(false);
    });

    it('returns false for --minimal flag', () => {
      expect(isCliInvocation(['--minimal'])).toBe(false);
    });

    it('returns false for unknown flag', () => {
      expect(isCliInvocation(['--unknown'])).toBe(false);
    });
  });
});
```

- [ ] **Step 5: 编译 + 测试**

```bash
npx tsc --noEmit && npx vitest run test/cli/router.test.ts
```

- [ ] **Step 6: 提交**

```bash
git add src/cli/clients/types.ts src/cli/router.ts src/index.ts test/cli/router.test.ts
git commit -m "feat(cli): unified entry point with subcommand routing"
```

---

### Task 2: Claude Code 客户端适配器

**Files:**
- Create: `src/cli/clients/claude-code.ts`
- Create: `test/cli/clients/claude-code.test.ts`

- [ ] **Step 1: 写 claude-code.ts**

Claude Code 使用 `.claude/settings.json`（项目级）或 `~/.claude/settings.json`（全局）。

```typescript
// src/cli/clients/claude-code.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ClientAdapter } from './types.js';

export class ClaudeCodeAdapter implements ClientAdapter {
  name = 'Claude Code';

  async detect(): Promise<boolean> {
    // Claude Code 的全局目录存在即视为已安装
    return existsSync(join(homedir(), '.claude'));
  }

  async isConfigured(projectDir: string): Promise<boolean> {
    const settingsPath = join(projectDir, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return false;
    try {
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return !!(content.mcpServers?.godot);
    } catch { return false; }
  }

  async configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const claudeDir = join(projectDir, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');

    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { /* ignore */ }
    }

    if (!settings.mcpServers) settings.mcpServers = {};
    (settings.mcpServers as Record<string, unknown>).godot = {
      command: mcpCommand,
      ...(mcpArgs.length > 0 ? { args: mcpArgs } : {}),
      env: { GODOT_PATH: godotPath },
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }
}
```

- [ ] **Step 2: 写测试**

```typescript
// test/cli/clients/claude-code.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeCodeAdapter } from '../../../src/cli/clients/claude-code.js';

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('has correct name', () => {
    expect(adapter.name).toBe('Claude Code');
  });

  it('isConfigured returns false when no settings file', async () => {
    expect(await adapter.isConfigured(testDir)).toBe(false);
  });

  it('isConfigured returns false when no godot entry', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ mcpServers: {} }));
    expect(await adapter.isConfigured(testDir)).toBe(false);
  });

  it('isConfigured returns true when godot entry exists', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      mcpServers: { godot: { command: 'npx', args: ['godot-mcp-enhanced'] } },
    }));
    expect(await adapter.isConfigured(testDir)).toBe(true);
  });

  it('configure creates settings file with godot entry', async () => {
    await adapter.configure(testDir, '/path/to/godot', 'npx', ['godot-mcp-enhanced']);
    const settingsPath = join(testDir, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.mcpServers.godot.command).toBe('npx');
    expect(settings.mcpServers.godot.env.GODOT_PATH).toBe('/path/to/godot');
  });

  it('configure merges with existing settings', async () => {
    const claudeDir = join(testDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const { writeFileSync } = await import('fs');
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      otherSetting: true,
      mcpServers: { other: { command: 'other' } },
    }));
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.otherSetting).toBe(true);
    expect(settings.mcpServers.other.command).toBe('other');
    expect(settings.mcpServers.godot.command).toBe('npx');
  });
});
```

- [ ] **Step 3: 编译 + 测试**

```bash
npx tsc --noEmit && npx vitest run test/cli/clients/claude-code.test.ts
```

- [ ] **Step 4: 提交**

```bash
git add src/cli/clients/claude-code.ts test/cli/clients/claude-code.test.ts
git commit -m "feat(cli): Claude Code client adapter"
```

---

### Task 3: Cursor 客户端适配器

**Files:**
- Create: `src/cli/clients/cursor.ts`
- Create: `test/cli/clients/cursor.test.ts`

- [ ] **Step 1: 写 cursor.ts**

Cursor 使用项目级 `.cursor/mcp.json`。

```typescript
// src/cli/clients/cursor.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ClientAdapter } from './types.js';

export class CursorAdapter implements ClientAdapter {
  name = 'Cursor';

  async detect(): Promise<boolean> {
    // Cursor 全局配置目录
    return existsSync(join(homedir(), '.cursor'));
  }

  async isConfigured(projectDir: string): Promise<boolean> {
    const mcpPath = join(projectDir, '.cursor', 'mcp.json');
    if (!existsSync(mcpPath)) return false;
    try {
      const content = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      return !!(content.mcpServers?.godot);
    } catch { return false; }
  }

  async configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const cursorDir = join(projectDir, '.cursor');
    const mcpPath = join(cursorDir, 'mcp.json');

    if (!existsSync(cursorDir)) mkdirSync(cursorDir, { recursive: true });

    let config: Record<string, unknown> = {};
    if (existsSync(mcpPath)) {
      try { config = JSON.parse(readFileSync(mcpPath, 'utf-8')); } catch { /* ignore */ }
    }

    if (!config.mcpServers) config.mcpServers = {};
    (config.mcpServers as Record<string, unknown>).godot = {
      command: mcpCommand,
      ...(mcpArgs.length > 0 ? { args: mcpArgs } : {}),
      env: { GODOT_PATH: godotPath },
    };

    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
}
```

- [ ] **Step 2: 写测试**（模式与 claude-code.test.ts 相同，测试 detect/isConfigured/configure/merge）

```typescript
// test/cli/clients/cursor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CursorAdapter } from '../../../src/cli/clients/cursor.js';

describe('CursorAdapter', () => {
  const adapter = new CursorAdapter();
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('has correct name', () => {
    expect(adapter.name).toBe('Cursor');
  });

  it('isConfigured returns false when no mcp.json', async () => {
    expect(await adapter.isConfigured(testDir)).toBe(false);
  });

  it('configure creates .cursor/mcp.json with godot entry', async () => {
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    const mcpPath = join(testDir, '.cursor', 'mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(config.mcpServers.godot.command).toBe('npx');
    expect(config.mcpServers.godot.env.GODOT_PATH).toBe('/godot');
  });

  it('configure merges with existing config', async () => {
    const cursorDir = join(testDir, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({
      mcpServers: { existing: { command: 'existing' } },
    }));
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    const config = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(config.mcpServers.existing.command).toBe('existing');
    expect(config.mcpServers.godot.command).toBe('npx');
  });

  it('isConfigured returns true after configure', async () => {
    await adapter.configure(testDir, '/godot', 'npx', ['godot-mcp-enhanced']);
    expect(await adapter.isConfigured(testDir)).toBe(true);
  });
});
```

- [ ] **Step 3: 编译 + 测试 + 提交**

```bash
npx tsc --noEmit && npx vitest run test/cli/clients/cursor.test.ts
git add src/cli/clients/cursor.ts test/cli/clients/cursor.test.ts
git commit -m "feat(cli): Cursor client adapter"
```

---

### Task 4: OpenCode + Codex CLI 型适配器

**Files:**
- Create: `src/cli/clients/opencode.ts`
- Create: `src/cli/clients/codex.ts`
- Create: `test/cli/clients/opencode.test.ts`
- Create: `test/cli/clients/codex.test.ts`

- [ ] **Step 1: 写 opencode.ts**

OpenCode 使用 CLI 命令 `opencode mcp add`。

```typescript
// src/cli/clients/opencode.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ClientAdapter } from './types.js';

const execFileAsync = promisify(execFile);

export class OpenCodeAdapter implements ClientAdapter {
  name = 'OpenCode';

  async detect(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('opencode', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch { return false; }
  }

  async isConfigured(_projectDir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('opencode', ['mcp', 'list'], { timeout: 5000 });
      return stdout.includes('godot');
    } catch { return false; }
  }

  async configure(_projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const fullCommand = mcpArgs.length > 0 ? `${mcpCommand} ${mcpArgs.join(' ')}` : mcpCommand;
    const { stdout } = await execFileAsync('opencode', [
      'mcp', 'add', 'godot', fullCommand,
      '--env', `GODOT_PATH=${godotPath}`,
    ], { timeout: 10000 });
  }
}
```

- [ ] **Step 2: 写 codex.ts**

Codex 使用 `codex mcp add` CLI 命令。

```typescript
// src/cli/clients/codex.ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ClientAdapter } from './types.js';

const execFileAsync = promisify(execFile);

export class CodexAdapter implements ClientAdapter {
  name = 'Codex';

  async detect(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch { return false; }
  }

  async isConfigured(_projectDir: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 5000 });
      return stdout.includes('godot');
    } catch { return false; }
  }

  async configure(_projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void> {
    const fullCommand = mcpArgs.length > 0 ? `${mcpCommand} ${mcpArgs.join(' ')}` : mcpCommand;
    await execFileAsync('codex', [
      'mcp', 'add', 'godot', fullCommand,
      '--env', `GODOT_PATH=${godotPath}`,
    ], { timeout: 10000 });
  }
}
```

- [ ] **Step 3: 写测试**（mock execFileAsync）

```typescript
// test/cli/clients/opencode.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OpenCodeAdapter } from '../../../src/cli/clients/opencode.js';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], opts: any, cb: any) => {
    if (_cmd === 'opencode' && _args[0] === '--version') cb(null, { stdout: '1.0.0' });
    else if (_cmd === 'opencode' && _args[0] === 'mcp' && _args[1] === 'list') cb(null, { stdout: 'godot\nother' });
    else if (_cmd === 'opencode' && _args[0] === 'mcp' && _args[1] === 'add') cb(null, { stdout: 'Added' });
    else cb(new Error('not found'));
  }),
}));

describe('OpenCodeAdapter', () => {
  const adapter = new OpenCodeAdapter();

  it('has correct name', () => {
    expect(adapter.name).toBe('OpenCode');
  });

  it('detects installed opencode', async () => {
    expect(await adapter.detect()).toBe(true);
  });

  it('isConfigured returns true when godot listed', async () => {
    expect(await adapter.isConfigured('/tmp')).toBe(true);
  });

  it('configure calls mcp add', async () => {
    await expect(adapter.configure('/tmp', '/godot', 'npx', ['godot-mcp-enhanced'])).resolves.toBeUndefined();
  });
});
```

```typescript
// test/cli/clients/codex.test.ts — 同样模式
import { describe, it, expect, vi } from 'vitest';
import { CodexAdapter } from '../../../src/cli/clients/codex.js';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], opts: any, cb: any) => {
    if (_cmd === 'codex' && _args[0] === '--version') cb(null, { stdout: '1.0.0' });
    else if (_cmd === 'codex' && _args[0] === 'mcp' && _args[1] === 'list') cb(null, { stdout: 'godot' });
    else if (_cmd === 'codex' && _args[0] === 'mcp' && _args[1] === 'add') cb(null, { stdout: 'Added' });
    else cb(new Error('not found'));
  }),
}));

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();

  it('has correct name', () => {
    expect(adapter.name).toBe('Codex');
  });

  it('detects installed codex', async () => {
    expect(await adapter.detect()).toBe(true);
  });

  it('isConfigured returns true when godot listed', async () => {
    expect(await adapter.isConfigured('/tmp')).toBe(true);
  });

  it('configure calls mcp add', async () => {
    await expect(adapter.configure('/tmp', '/godot', 'npx', ['godot-mcp-enhanced'])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: 编译 + 测试 + 提交**

```bash
npx tsc --noEmit && npx vitest run test/cli/clients/
git add src/cli/clients/opencode.ts src/cli/clients/codex.ts test/cli/clients/opencode.test.ts test/cli/clients/codex.test.ts
git commit -m "feat(cli): OpenCode + Codex client adapters"
```

---

### Task 5: setup 命令

**Files:**
- Create: `src/cli/setup.ts`
- Create: `test/cli/setup.test.ts`

- [ ] **Step 1: 写 setup.ts**

```typescript
// src/cli/setup.ts
import { join } from 'path';
import { findGodot } from '../core/godot-finder.js';
import { ClaudeCodeAdapter } from './clients/claude-code.js';
import { CursorAdapter } from './clients/cursor.js';
import { OpenCodeAdapter } from './clients/opencode.js';
import { CodexAdapter } from './clients/codex.js';
import type { ClientAdapter } from './clients/types.js';

const ALL_ADAPTERS: ClientAdapter[] = [
  new ClaudeCodeAdapter(),
  new CursorAdapter(),
  new OpenCodeAdapter(),
  new CodexAdapter(),
];

/** 检测 MCP command/args — 本地开发用 node 绝对路径，否则用 npx */
function detectMcpCommand(): { command: string; args: string[] } {
  // 如果在本地开发目录运行（存在 src/ 目录），用 node + 绝对路径
  const devEntry = join(import.meta.dirname ?? '.', 'index.js');
  // 检查是否是 npm 全局安装的路径
  const isNpmGlobal = (import.meta.url ?? '').includes('node_modules');
  if (isNpmGlobal) {
    return { command: 'npx', args: ['godot-mcp-enhanced'] };
  }
  return { command: 'node', args: [devEntry] };
}

export async function runSetup(_args: string[]): Promise<void> {
  console.log('🔍 Detecting environment...\n');

  // 1. 发现 Godot
  let godotPath: string;
  try {
    godotPath = await findGodot();
    console.log(`✓ Godot found: ${godotPath}`);
  } catch (err) {
    console.error(`✗ Godot not found: ${(err as Error).message}`);
    console.error('  Set GODOT_PATH environment variable or install Godot.');
    process.exit(1);
  }

  // 2. 检测 MCP 命令
  const { command, args: mcpArgs } = detectMcpCommand();

  // 3. 检测 + 配置各客户端
  const projectDir = process.cwd();
  console.log(`\n📁 Project: ${projectDir}\n`);

  let configured = 0;
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    if (!installed) {
      console.log(`  ⊘ ${adapter.name}: not installed, skipping`);
      continue;
    }

    const already = await adapter.isConfigured(projectDir);
    if (already) {
      console.log(`  ✓ ${adapter.name}: already configured`);
      continue;
    }

    try {
      await adapter.configure(projectDir, godotPath, command, mcpArgs);
      console.log(`  ✓ ${adapter.name}: configured`);
      configured++;
    } catch (err) {
      console.error(`  ✗ ${adapter.name}: ${(err as Error).message}`);
    }
  }

  console.log(`\n${configured > 0 ? `✓ ${configured} client(s) configured.` : 'No new clients to configure.'}`);
}
```

- [ ] **Step 2: 写测试**

```typescript
// test/cli/setup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock godot-finder
vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
}));

// Mock all client adapters
vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(() => ({
    name: 'Claude Code',
    detect: vi.fn().mockResolvedValue(true),
    isConfigured: vi.fn().mockResolvedValue(false),
    configure: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(() => ({
    name: 'Cursor',
    detect: vi.fn().mockResolvedValue(false), // 未安装
    isConfigured: vi.fn().mockResolvedValue(false),
    configure: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(() => ({
    name: 'OpenCode',
    detect: vi.fn().mockResolvedValue(true),
    isConfigured: vi.fn().mockResolvedValue(true), // 已配置
    configure: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(() => ({
    name: 'Codex',
    detect: vi.fn().mockResolvedValue(false), // 未安装
    isConfigured: vi.fn().mockResolvedValue(false),
    configure: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('setup', () => {
  it('runSetup completes without error', async () => {
    const { runSetup } = await import('../../src/cli/setup.js');
    // 不测试退出码（会调用 process.exit），只验证不抛异常
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSetup([]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
    consoleError.mockRestore();
  });
});
```

- [ ] **Step 3: 编译 + 测试 + 提交**

```bash
npx tsc --noEmit && npx vitest run test/cli/setup.test.ts
git add src/cli/setup.ts test/cli/setup.test.ts
git commit -m "feat(cli): setup command with 4 client adapters"
```

---

### Task 6: doctor 命令

**Files:**
- Create: `src/cli/doctor.ts`
- Create: `test/cli/doctor.test.ts`

- [ ] **Step 1: 写 doctor.ts**

```typescript
// src/cli/doctor.ts
import { findGodot } from '../core/godot-finder.js';
import { ClaudeCodeAdapter } from './clients/claude-code.js';
import { CursorAdapter } from './clients/cursor.js';
import { OpenCodeAdapter } from './clients/opencode.js';
import { CodexAdapter } from './clients/codex.js';
import type { ClientAdapter } from './clients/types.js';

const ALL_ADAPTERS: ClientAdapter[] = [
  new ClaudeCodeAdapter(),
  new CursorAdapter(),
  new OpenCodeAdapter(),
  new CodexAdapter(),
];

function status(ok: boolean, msg: string): string {
  return ok ? `  ✓ ${msg}` : `  ✗ ${msg}`;
}

export async function runDoctor(_args: string[]): Promise<void> {
  let hasError = false;

  // 1. Node.js 版本
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  console.log(status(nodeMajor >= 18, `Node.js ${nodeVersion} ${nodeMajor >= 18 ? '' : '(requires >= 18)'}`));
  if (nodeMajor < 18) hasError = true;

  // 2. Godot 发现
  let godotFound = false;
  try {
    const godotPath = await findGodot();
    console.log(status(true, `Godot found: ${godotPath}`));
    godotFound = true;
  } catch {
    console.log(status(false, 'Godot not found (set GODOT_PATH)'));
    hasError = true;
  }

  // 3. AI 客户端
  console.log('\nAI Clients:');
  const projectDir = process.cwd();
  for (const adapter of ALL_ADAPTERS) {
    const installed = await adapter.detect();
    if (!installed) {
      console.log(status(false, `${adapter.name}: not installed`));
      continue;
    }
    const configured = await adapter.isConfigured(projectDir);
    console.log(status(configured, `${adapter.name}: ${configured ? 'configured' : 'not configured'}`));
  }

  // 4. 项目结构
  console.log('\nProject:');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const hasProject = existsSync(join(projectDir, 'project.godot'));
  console.log(status(hasProject, `project.godot ${hasProject ? 'found' : 'not found'}`));

  const hasClaudeMd = existsSync(join(projectDir, 'CLAUDE.md'));
  console.log(status(hasClaudeMd, `CLAUDE.md ${hasClaudeMd ? 'found' : 'not found'}`));

  if (hasError) process.exit(1);
}
```

- [ ] **Step 2: 写测试**

```typescript
// test/cli/doctor.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/godot-finder.js', () => ({
  findGodot: vi.fn().mockResolvedValue('/usr/bin/godot'),
}));

vi.mock('../../src/cli/clients/claude-code.js', () => ({
  ClaudeCodeAdapter: vi.fn().mockImplementation(() => ({
    name: 'Claude Code', detect: vi.fn().mockResolvedValue(true), isConfigured: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock('../../src/cli/clients/cursor.js', () => ({
  CursorAdapter: vi.fn().mockImplementation(() => ({
    name: 'Cursor', detect: vi.fn().mockResolvedValue(false), isConfigured: vi.fn().mockResolvedValue(false),
  })),
}));

vi.mock('../../src/cli/clients/opencode.js', () => ({
  OpenCodeAdapter: vi.fn().mockImplementation(() => ({
    name: 'OpenCode', detect: vi.fn().mockResolvedValue(false), isConfigured: vi.fn().mockResolvedValue(false),
  })),
}));

vi.mock('../../src/cli/clients/codex.js', () => ({
  CodexAdapter: vi.fn().mockImplementation(() => ({
    name: 'Codex', detect: vi.fn().mockResolvedValue(false), isConfigured: vi.fn().mockResolvedValue(false),
  })),
}));

describe('doctor', () => {
  it('runDoctor completes and reports Node version', async () => {
    const { runDoctor } = await import('../../src/cli/doctor.js');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runDoctor([]);
    const output = consoleSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(output).toContain('Node.js');
    expect(output).toContain('Godot');
    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 3: 编译 + 测试 + 提交**

```bash
npx tsc --noEmit && npx vitest run test/cli/doctor.test.ts
git add src/cli/doctor.ts test/cli/doctor.test.ts
git commit -m "feat(cli): doctor command with environment diagnostics"
```

---

### Task 7: init 命令（复用现有 create_project）

**Files:**
- Create: `src/cli/init.ts`
- Create: `test/cli/init.test.ts`

- [ ] **Step 1: 写 init.ts**

```typescript
// src/cli/init.ts
import { join, basename } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';

function parseInitArgs(args: string[]): { name: string; template: string } {
  const name = args[0] || 'my-game';
  let template = 'empty';
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--template=')) template = args[i].split('=')[1];
  }
  return { name, template };
}

export async function runInit(args: string[]): Promise<void> {
  const { name, template } = parseInitArgs(args);
  const projectDir = join(process.cwd(), name);

  if (existsSync(projectDir)) {
    console.error(`Directory already exists: ${projectDir}`);
    process.exit(1);
  }

  console.log(`Creating project "${name}" (template: ${template})...`);

  // 创建项目目录
  mkdirSync(projectDir, { recursive: true });

  // 写入最小 project.godot
  writeFileSync(join(projectDir, 'project.godot'), [
    '; Engine configuration file.',
    '; It\'s best edited using the editor UI and not directly.',
    '',
    '[application]',
    '',
    `config/name="${name}"`,
    '',
    '[display]',
    '',
    'window/size/viewport_width=1280',
    'window/size/viewport_height=720',
    '',
  ].join('\n'), 'utf-8');

  // 写入 scenes 目录
  mkdirSync(join(projectDir, 'scenes'), { recursive: true });

  // 提示运行 setup_project_rules
  console.log(`\n✓ Project created at ${projectDir}`);
  console.log('\nNext steps:');
  console.log(`  1. cd ${name}`);
  console.log('  2. Open in AI editor (Claude Code / Cursor)');
  console.log('  3. Run setup_project_rules to generate CLAUDE.md and hooks');
}
```

- [ ] **Step 2: 写测试**

```typescript
// test/cli/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runInit } from '../../src/cli/init.js';

describe('init', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-init-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates project directory with project.godot', async () => {
    const origCwd = process.cwd();
    process.chdir(testDir);
    const consoleSpy = expect.spyOn(console, 'log') ?? (() => {});
    await runInit(['test-game']);
    process.chdir(origCwd);

    const projectDir = join(testDir, 'test-game');
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(join(projectDir, 'project.godot'))).toBe(true);

    const content = readFileSync(join(projectDir, 'project.godot'), 'utf-8');
    expect(content).toContain('test-game');
    expect(existsSync(join(projectDir, 'scenes'))).toBe(true);
  });

  it('fails if directory already exists', async () => {
    mkdirSync(join(testDir, 'existing'), { recursive: true });
    const origCwd = process.cwd();
    process.chdir(testDir);
    await expect(runInit(['existing'])).rejects.toThrow();
    process.chdir(origCwd);
  });

  it('uses default name when no args', async () => {
    const origCwd = process.cwd();
    process.chdir(testDir);
    await runInit([]);
    process.chdir(origCwd);
    expect(existsSync(join(testDir, 'my-game', 'project.godot'))).toBe(true);
  });
});
```

- [ ] **Step 3: 编译 + 测试 + 提交**

```bash
npx tsc --noEmit && npx vitest run test/cli/init.test.ts
git add src/cli/init.ts test/cli/init.test.ts
git commit -m "feat(cli): init command for project scaffolding"
```

---

### Task 8: Godot 发现增强（注册表 + Scoop）

**Files:**
- Modify: `src/core/godot-finder.ts`
- 已有: `test/gdscript-executor-cache.test.js`（验证不回归）

- [ ] **Step 1: 添加 findViaRegistry() 和 findViaScoop()**

在 `src/core/godot-finder.ts` 的 `findGodot()` 函数中，步骤 2（PATH 搜索）和步骤 3（平台搜索）之间插入新步骤：

```typescript
// 在 findGodot() 中，步骤 2 之后添加：

// 2.5 Windows-specific: Registry + Scoop
if (process.platform === 'win32') {
  const registryResult = await findViaRegistry();
  if (registryResult) { godotPath = registryResult; return registryResult; }
  tried.push('Windows Registry');

  const scoopResult = await findViaScoop();
  if (scoopResult) { godotPath = scoopResult; return scoopResult; }
  tried.push('Scoop');
}
```

新增两个函数：

```typescript
/** Windows: 查找注册表中的 Godot 安装路径 */
async function findViaRegistry(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  try {
    const { execFileAsync } = await import('child_process');
    const prom = await import('util');
    const execAsync = prom.promisify(execFileAsync);
    // 查询 HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall 下的 Godot 条目
    const { stdout } = await execAsync('reg', [
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
    const scoopApps = join(home, 'scoop', 'shims', 'godot.exe');
    if (existsSync(scoopApps) && await validateGodotBinary(scoopApps)) return scoopApps;
  } catch { /* ignore */ }
  return null;
}
```

- [ ] **Step 2: 编译 + 全量测试**

```bash
npx tsc --noEmit && npx vitest run
```

- [ ] **Step 3: 提交**

```bash
git add src/core/godot-finder.ts
git commit -m "feat(godot-finder): Windows registry + Scoop discovery"
```

---

### Task 9: 全量集成测试 + package.json 更新

**Files:**
- Modify: `package.json`（bin 指向确认）
- 修改: 确认 1839+ 全部测试通过

- [ ] **Step 1: 确认 bin 入口正确**

package.json 已有 `"godot-mcp-enhanced": "./build/index.js"`。无需改动（`src/index.ts` 仍是主入口，子命令路由在 index.ts 内部）。

- [ ] **Step 2: 全量测试**

```bash
npm run build && npx vitest run
```

- [ ] **Step 3: 集成冒烟测试**

```bash
node build/index.js --help       # 显示帮助
node build/index.js --version    # 显示版本
node build/index.js setup        # 运行 setup
node build/index.js doctor       # 运行 doctor
node build/index.js              # MCP stdio 模式（验证不回归）
```

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat(cli): unified CLI platform — setup, doctor, init, 4 client adapters"
```
