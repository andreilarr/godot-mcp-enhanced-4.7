/**
 * Vitest 全局 setup — 在所有测试之前执行。
 * 设置 GODOT_MCP_UNRESTRICTED=true 以绕过路径白名单检查，
 * 因为测试使用临时目录（tmpdir）和假路径。
 */
process.env.GODOT_MCP_UNRESTRICTED = 'true';
