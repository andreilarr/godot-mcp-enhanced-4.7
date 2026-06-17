import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateApiToken,
  verifyApiToken,
  buildAuthHeaders,
  clearCachedSecret,
  getOrCreateApiSecret,
} from '../../src/core/instance-api-auth.js';

// 将 homedir mock 到临时目录，避免污染真实环境
const MOCK_HOME = join(tmpdir(), `mcp-auth-test-${Date.now()}`);
const MOCK_REGISTRY = join(MOCK_HOME, '.godot-mcp');

// Mock homedir
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => MOCK_HOME };
});

describe('instance-api-auth', () => {
  beforeEach(() => {
    clearCachedSecret();
    mkdirSync(MOCK_REGISTRY, { recursive: true });
  });

  afterEach(() => {
    clearCachedSecret();
    try { rmSync(MOCK_HOME, { recursive: true, force: true }); } catch { /* ok */ }
  });

  describe('getOrCreateApiSecret', () => {
    it('generates a new secret when none exists', () => {
      const secret = getOrCreateApiSecret();
      expect(secret).toBeDefined();
      expect(secret.length).toBeGreaterThanOrEqual(64); // 32 bytes hex

      // 验证文件已写入
      const secretPath = join(MOCK_REGISTRY, '.api-secret');
      expect(existsSync(secretPath)).toBe(true);
      expect(readFileSync(secretPath, 'utf-8').trim()).toBe(secret);
    });

    it('reads existing secret from file', () => {
      const preset = 'a'.repeat(64);
      writeFileSync(join(MOCK_REGISTRY, '.api-secret'), preset, 'utf-8');

      const secret = getOrCreateApiSecret();
      expect(secret).toBe(preset);
    });

    it('regenerates if existing secret is too short', () => {
      writeFileSync(join(MOCK_REGISTRY, '.api-secret'), 'tooshort', 'utf-8');

      const secret = getOrCreateApiSecret();
      expect(secret.length).toBeGreaterThanOrEqual(64);
      expect(secret).not.toBe('tooshort');
    });
  });

  describe('generateApiToken + verifyApiToken', () => {
    it('generates verifiable tokens', () => {
      const token = generateApiToken('inst-1');
      expect(token).toContain('.');
      expect(verifyApiToken('inst-1', token)).toBe(true);
    });

    it('rejects wrong instance id', () => {
      const token = generateApiToken('inst-1');
      expect(verifyApiToken('inst-2', token)).toBe(false);
    });

    it('rejects malformed tokens', () => {
      expect(verifyApiToken('inst-1', '')).toBe(false);
      expect(verifyApiToken('inst-1', 'no-dot')).toBe(false);
      expect(verifyApiToken('inst-1', 'abc.123')).toBe(false);
      // C-02: 旧格式（无 nonce）应被拒绝
      expect(verifyApiToken('inst-1', '1234567890.abcdef1234567890')).toBe(false);
    });

    it('rejects expired tokens', () => {
      vi.useFakeTimers();
      try {
        const token = generateApiToken('inst-1');
        // 推进 61 秒，超过 TOKEN_TTL_MS
        vi.advanceTimersByTime(61_000);
        expect(verifyApiToken('inst-1', token)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects replayed tokens (nonce anti-replay)', () => {
      const token = generateApiToken('inst-1');
      expect(verifyApiToken('inst-1', token)).toBe(true);
      // 同一 token 第二次使用应被拒绝
      expect(verifyApiToken('inst-1', token)).toBe(false);
    });

    it('forged token does not pollute nonce pool (A-2: nonce recorded only after HMAC passes)', () => {
      const token = generateApiToken('inst-1'); // 有效: nonce=N, hmac=H
      const parts = token.split('.');
      // 篡改 HMAC 段(保持长度)→ 伪造 token: 同 nonce=N, 错误签名
      const forged = `${parts[0]!}.${parts[1]!}.${'0'.repeat(parts[2]!.length)}`;
      expect(verifyApiToken('inst-1', forged)).toBe(false); // HMAC 错 → 拒绝
      // 原有效 token 仍可用:伪造 token 未污染 nonce N(修复前此处因 nonce 被占会失败)
      expect(verifyApiToken('inst-1', token)).toBe(true);
    });
  });

  describe('buildAuthHeaders', () => {
    it('includes Authorization Bearer header', () => {
      const headers = buildAuthHeaders('inst-1');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toMatch(/^Bearer \d+\.[a-f0-9]+\.[a-f0-9]+$/);
    });
  });
});
