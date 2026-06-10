// src/core/instance-api-auth.ts
/**
 * C-03: 多实例 HTTP API 认证
 *
 * 在机器级注册目录 (~/.godot-mcp/) 下维护一个共享 API secret。
 * sendToInstance 请求携带 HMAC 签名，服务端可使用同一 secret 验证。
 *
 * 安全模型：
 * - secret 文件权限收紧 (0600 / icacls)
 * - HMAC 签名包含 instance.id + timestamp，防重放
 * - 仅限 localhost 通信 (127.0.0.1)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { getLogger } from './logger.js';

const API_SECRET_FILENAME = '.api-secret';
const HMAC_ALGORITHM = 'sha256';
const TOKEN_TTL_MS = 60_000; // 签名有效期 60 秒

let _cachedSecret: string | null = null;

/** 获取机器级注册目录 */
function getRegistryDir(): string {
  return join(homedir(), '.godot-mcp');
}

/** 读取或创建共享 API secret */
export function getOrCreateApiSecret(): string {
  if (_cachedSecret) return _cachedSecret;

  const secretPath = join(getRegistryDir(), API_SECRET_FILENAME);

  try {
    if (existsSync(secretPath)) {
      const secret = readFileSync(secretPath, 'utf-8').trim();
      if (secret.length >= 32) {
        _cachedSecret = secret;
        return secret;
      }
    }
  } catch {
    // 读取失败 — 重新生成
  }

  // 生成新 secret (32 bytes = 256 bits)
  const secret = randomBytes(32).toString('hex');
  try {
    const dir = getRegistryDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(secretPath, secret, { encoding: 'utf-8', mode: 0o600 });

    // Windows: 收紧 ACL — I-01 fix: 使用 os.userInfo().username + execFileSync 防止 ACL 注入
    if (process.platform === 'win32') {
      try {
        const username = userInfo().username;
        if (username && /^[A-Za-z0-9_-]+$/.test(username)) {
          execFileSync('icacls', [secretPath, '/inheritance:r', '/grant:r', `${username}:R`], { stdio: 'ignore' });
        } else {
          getLogger().warn('instance-api-auth', `Username "${username}" contains unexpected characters, skipping ACL restriction`);
        }
      } catch {
        getLogger().warn('instance-api-auth', `ACL restriction failed for ${secretPath}, file may inherit default permissions`);
      }
    }

    getLogger().info('instance-api-auth', `Generated new API secret at ${secretPath}`);
  } catch (err) {
    getLogger().warn('instance-api-auth', `Failed to persist API secret: ${err instanceof Error ? err.message : err}`);
  }

  _cachedSecret = secret;
  return secret;
}

/**
 * 生成认证令牌 — HMAC(instance.id:timestamp, secret)
 * 格式: `{timestamp}.{hmacHex}`
 */
export function generateApiToken(instanceId: string): string {
  const secret = getOrCreateApiSecret();
  const timestamp = Date.now().toString();
  const hmac = createHmac(HMAC_ALGORITHM, secret)
    .update(`${instanceId}:${timestamp}`)
    .digest('hex');
  return `${timestamp}.${hmac}`;
}

/**
 * 验证认证令牌。返回 true 表示有效。
 * 服务端（Godot 插件或另一个 MCP 实例）可使用此函数验证请求。
 */
export function verifyApiToken(instanceId: string, token: string): boolean {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestampStr = token.substring(0, dotIndex);
  const providedHmac = token.substring(dotIndex + 1);

  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return false;

  // 检查时效性
  if (Date.now() - timestamp > TOKEN_TTL_MS) return false;

  try {
    const secret = getOrCreateApiSecret();
    const expectedHmac = createHmac(HMAC_ALGORITHM, secret)
      .update(`${instanceId}:${timestampStr}`)
      .digest('hex');
    // 常量时间比较，防时序攻击
    if (expectedHmac.length !== providedHmac.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expectedHmac.length; i++) {
      mismatch |= expectedHmac.charCodeAt(i) ^ providedHmac.charCodeAt(i);
    }
    return mismatch === 0;
  } catch {
    return false;
  }
}

/** 构建带认证头的 headers 对象 */
export function buildAuthHeaders(instanceId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${generateApiToken(instanceId)}`,
  };
}

/** 清除缓存的 secret（测试用） */
export function clearCachedSecret(): void {
  _cachedSecret = null;
}
