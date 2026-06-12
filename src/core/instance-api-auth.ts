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

// S-3: Nonce 防重放 — 记录最近使用的 nonce（TTL 内去重）
const _usedNonces = new Map<string, number>();
const NONCE_CLEANUP_INTERVAL = 120_000; // 每 2 分钟清理过期 nonce
let _lastNonceCleanup = Date.now();

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
 * 生成认证令牌 — HMAC(instance.id:timestamp:nonce, secret)
 * 格式: `{timestamp}.{nonce}.{hmacHex}`
 */
export function generateApiToken(instanceId: string): string {
  const secret = getOrCreateApiSecret();
  const timestamp = Date.now().toString();
  const nonce = randomBytes(8).toString('hex');
  const hmac = createHmac(HMAC_ALGORITHM, secret)
    .update(`${instanceId}:${timestamp}:${nonce}`)
    .digest('hex');
  return `${timestamp}.${nonce}.${hmac}`;
}

/**
 * 验证认证令牌。返回 true 表示有效。
 * 支持旧格式（无 nonce）和新格式（含 nonce + 防重放）。
 */
export function verifyApiToken(instanceId: string, token: string): boolean {
  // S-3: 解析新格式 timestamp.nonce.hmac 或旧格式 timestamp.hmac
  const parts = token.split('.');
  // C-02: 拒绝旧格式 token（无 nonce），强制使用新格式 timestamp.nonce.hmac
  if (parts.length !== 3) return false;

  const timestampStr = parts[0]!;
  const nonce = parts[1]!;
  const providedHmac = parts[2]!;

  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return false;

  // 检查时效性
  if (Date.now() - timestamp > TOKEN_TTL_MS) return false;

  // S-3: Nonce 防重放检查
  const nonceKey = `${instanceId}:${nonce}`;
  if (_usedNonces.has(nonceKey)) return false; // 已使用的 nonce → 重放攻击
  _usedNonces.set(nonceKey, Date.now());
  // 定期清理过期 nonce + I-01 上限保护
  const now = Date.now();
  if (now - _lastNonceCleanup > NONCE_CLEANUP_INTERVAL || _usedNonces.size > 10_000) {
    for (const [key, ts] of _usedNonces) {
      if (now - ts > TOKEN_TTL_MS * 2) _usedNonces.delete(key);
    }
    _lastNonceCleanup = now;
  }

  try {
    const secret = getOrCreateApiSecret();
    const expectedHmac = createHmac(HMAC_ALGORITHM, secret)
      .update(`${instanceId}:${timestampStr}:${nonce}`)
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

/** 清除缓存的 secret 和 nonce 记录（测试用） */
export function clearCachedSecret(): void {
  _cachedSecret = null;
  _usedNonces.clear();
}
