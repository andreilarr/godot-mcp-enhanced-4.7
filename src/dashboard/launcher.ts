// src/dashboard/launcher.ts
// Bridge 首次连接成功时，自动在新终端窗口启动 Dashboard TUI

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 模块级标志：整个 MCP 进程生命周期只启动一次 */
let _launched = false;

/**
 * 在新终端窗口中启动 Dashboard TUI。
 * 仅在首次调用时生效，后续调用为空操作。
 * 失败时静默降级，不阻塞调用方。
 */
export function launchDashboardOnce(): void {
  if (_launched) return;
  _launched = true;

  // 环境变量禁用开关
  if (process.env.GODOT_MCP_NO_DASHBOARD === '1' || process.env.GODOT_MCP_NO_DASHBOARD === 'true') {
    return;
  }

  const dashboardPath = join(__dirname, 'index.js');
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Windows: use powershell Start-Process for reliable new-window launch
      const childEnv = { ...process.env, GODOT_MCP_NO_DASHBOARD: '1' };
      try {
        spawn('powershell.exe', [
          '-WindowStyle', 'Hidden',
          '-Command',
          `Start-Process -FilePath 'node' -ArgumentList '${dashboardPath}' -WindowStyle Normal`,
        ], {
          detached: true,
          stdio: 'ignore',
          env: childEnv,
        }).unref();
      } catch {
        // Fallback: cmd /c start
        try {
          spawn('cmd', ['/c', 'start', '"godot-mcp-dashboard"', 'node', `"${dashboardPath}"`], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            env: childEnv,
          }).unref();
        } catch {
          spawn('node', [dashboardPath], {
            detached: true,
            stdio: 'ignore',
            env: childEnv,
          }).unref();
        }
      }
    } else if (platform === 'darwin') {
      // macOS: 使用 osascript 让 Terminal.app 执行
      // 用 quoted form of 防止路径中的特殊字符导致注入
      spawn('osascript', ['-e', `tell application "Terminal"\ndo script "node " & quoted form of "${dashboardPath}"\nactivate\nend tell`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      // Linux: 尝试常见终端模拟器
      const cmd = `node "${dashboardPath}"`;
      const terminals: [string, string[]][] = [
        ['gnome-terminal', ['--', 'bash', '-c', cmd]],
        ['konsole', ['-e', 'bash', '-c', cmd]],
        ['xterm', ['-e', cmd]],
      ];
      for (const [bin, args] of terminals) {
        try {
          const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
          // spawn 是异步的，通过 error 事件检测可执行文件不存在
          child.on('error', () => { /* 终端不可用，尝试下一个 */ });
          child.unref();
          break;
        } catch {
          // 同步错误（极少见），尝试下一个
        }
      }
    }
  } catch {
    // 启动失败不阻塞 Bridge 功能
  }
}
