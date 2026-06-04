/**
 * ClientAdapter — 统一的 AI 客户端配置接口。
 *
 * 两种范式：
 * - 文件写入型（Claude Code、Cursor）：直接写配置文件
 * - CLI 调用型（OpenCode、Codex）：调用 CLI 子命令
 */
export interface ClientAdapter {
  name: string;
  /** 客户端是否已安装 */
  detect(): Promise<boolean>;
  /** godot MCP 是否已在该项目中配置 */
  isConfigured(projectDir: string): Promise<boolean>;
  /** 将 godot MCP 配置写入该客户端 */
  configure(projectDir: string, godotPath: string, mcpCommand: string, mcpArgs: string[]): Promise<void>;
}
