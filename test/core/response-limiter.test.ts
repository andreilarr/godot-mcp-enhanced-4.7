import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '../../src/types.js';
import {
  truncateResponse,
  trimToArrayLimit,
  encodeCursor,
  decodeCursor,
} from '../../src/core/response-limiter.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a text-only ToolResult whose JSON size is approximately `sizeBytes`. */
function makeLargeResult(sizeBytes: number): ToolResult {
  const overhead = JSON.stringify({ content: [{ type: 'text', text: '' }] }).length;
  const textSize = Math.max(0, sizeBytes - overhead);
  const payload = 'x'.repeat(textSize);
  return { content: [{ type: 'text', text: payload }] };
}

/** Create a ToolResult with JSON-parseable array data of roughly `itemCount * itemSize` bytes. */
function makeArrayResult(itemCount: number, itemSize: number): ToolResult {
  // Each item is roughly: {"data":"<padding>"}  ~ 12 bytes overhead + padding
  const padding = 'x'.repeat(Math.max(1, itemSize - 14));
  const itemStr = `{"data":"${padding}"}`;
  // Build the JSON string directly to avoid per-item object overhead
  const items = Array.from({ length: itemCount }, () => itemStr).join(',');
  const json = `{"nodes":[${items}],"status":"ok"}`;
  return {
    content: [
      { type: 'text' as const, text: json },
    ],
  };
}

/** Get the byte size of a ToolResult's JSON serialization. */
function resultSize(r: ToolResult): number {
  return Buffer.byteLength(JSON.stringify(r), 'utf-8');
}

// ─── encodeCursor / decodeCursor ─────────────────────────────────────────────

describe('encodeCursor', () => {
  it('produces base64 with v1 prefix', () => {
    const encoded = encodeCursor({ offset: 42 });
    expect(encoded).toMatch(/^v1:/);
    const b64part = encoded.slice(3);
    // Valid base64
    expect(() => Buffer.from(b64part, 'base64')).not.toThrow();
  });

  it('encodes offset correctly', () => {
    const encoded = encodeCursor({ offset: 100 });
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ offset: 100 });
  });
});

describe('decodeCursor', () => {
  it('round-trips offset', () => {
    for (const offset of [0, 1, 999, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCursor(encodeCursor({ offset }))).toEqual({ offset });
    }
  });

  it('returns null for empty string', () => {
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null for wrong version prefix', () => {
    const encoded = 'v2:' + Buffer.from('{"offset":0}', 'utf-8').toString('base64');
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('returns null for invalid base64', () => {
    expect(decodeCursor('v1:!!!not-base64!!!')).toBeNull();
  });

  it('returns null for valid base64 but non-object payload', () => {
    const encoded = 'v1:' + Buffer.from('"hello"', 'utf-8').toString('base64');
    expect(decodeCursor(encoded)).toBeNull();
  });

  it('returns null for object without offset field', () => {
    const encoded = 'v1:' + Buffer.from('{"page":5}', 'utf-8').toString('base64');
    expect(decodeCursor(encoded)).toBeNull();
  });
});

// ─── trimToArrayLimit ─────────────────────────────────────────────────────────

describe('trimToArrayLimit', () => {
  it('trims the largest array to fit within limit', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i, data: 'x'.repeat(500) }));
    const data = { nodes: items, status: 'ok' };
    const limit = 5000; // 5 KB — much smaller than the full data

    const trimmed = trimToArrayLimit(data, limit) as Record<string, unknown>;

    // The trimmed array should be shorter
    const trimmedNodes = trimmed.nodes as unknown[];
    expect(trimmedNodes.length).toBeLessThan(100);

    // The result should fit within the limit
    expect(Buffer.byteLength(JSON.stringify(trimmed), 'utf-8')).toBeLessThanOrEqual(limit);
  });

  it('preserves non-array fields', () => {
    const data = { nodes: [1, 2, 3], status: 'ok', count: 3 };
    const trimmed = trimToArrayLimit(data, 100) as Record<string, unknown>;

    expect(trimmed.status).toBe('ok');
    expect(trimmed.count).toBe(3);
  });

  it('adds truncatedAt and totalNodeCount metadata', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, data: 'y'.repeat(200) }));
    const data = { nodes: items };
    const limit = 2000;

    const trimmed = trimToArrayLimit(data, limit) as Record<string, unknown>;

    expect(trimmed).toHaveProperty('nodes_truncatedAt');
    expect(trimmed).toHaveProperty('nodes_totalNodeCount');
    expect(trimmed.nodes_totalNodeCount).toBe(50);
    expect(typeof trimmed.nodes_truncatedAt).toBe('number');
  });

  it('returns data unchanged when there is no array', () => {
    const data = { status: 'ok', count: 5 };
    const result = trimToArrayLimit(data, 100);
    expect(result).toBe(data); // same reference
  });

  it('returns data unchanged when array is empty', () => {
    const data = { nodes: [], status: 'ok' };
    const result = trimToArrayLimit(data, 100);
    expect(result).toBe(data);
  });

  it('returns data unchanged when it fits within limit', () => {
    const data = { nodes: [1, 2, 3] };
    const limit = 10000; // way bigger than needed
    const result = trimToArrayLimit(data, limit);
    expect(result).toBe(data);
  });

  it('returns non-object inputs unchanged', () => {
    expect(trimToArrayLimit(null, 100)).toBeNull();
    expect(trimToArrayLimit('string', 100)).toBe('string');
    expect(trimToArrayLimit(42, 100)).toBe(42);
  });

  it('handles arrays as top-level input by returning them unchanged', () => {
    const arr = [1, 2, 3];
    expect(trimToArrayLimit(arr, 100)).toBe(arr);
  });
});

// ─── truncateResponse ─────────────────────────────────────────────────────────

describe('truncateResponse', () => {
  const originalEnv = process.env.GODOT_MCP_RESPONSE_LIMIT;

  beforeEach(() => {
    // Ensure feature flag is enabled by default
    delete process.env.GODOT_MCP_RESPONSE_LIMIT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GODOT_MCP_RESPONSE_LIMIT;
    } else {
      process.env.GODOT_MCP_RESPONSE_LIMIT = originalEnv;
    }
  });

  it('passes through responses under 2MB (same reference)', () => {
    const small = { content: [{ type: 'text' as const, text: 'hello' }] };
    const result = truncateResponse(small);
    expect(result).toBe(small); // same reference, no copy
  });

  it('adds a warning for responses between 2MB and 4MB', () => {
    // Create a response just over 2MB
    const response = makeLargeResult(2.1 * 1024 * 1024);
    expect(resultSize(response)).toBeGreaterThan(2 * 1024 * 1024);

    const result = truncateResponse(response);
    expect(result).not.toBe(response); // different reference

    // Should have the original content plus a warning
    expect(result.content.length).toBe(response.content.length + 1);
    const warningBlock = result.content[result.content.length - 1];
    expect(warningBlock.type).toBe('text');
    expect((warningBlock as { text: string }).text).toMatch(/Warning.*exceeds 2MB/);
  });

  it('truncates responses over 4MB and produces valid JSON', () => {
    // Create a response over 4MB with JSON array data
    // Each item ~1500 bytes, need > 4MB → 3000 items
    const response = makeArrayResult(3000, 1500);
    const originalSize = resultSize(response);
    expect(originalSize).toBeGreaterThan(4 * 1024 * 1024);

    const result = truncateResponse(response);
    expect(result).not.toBe(response);

    // Find the JSON text block and verify it's parseable
    const textBlock = result.content.find(
      (b): b is { type: 'text'; text: string } => {
        if (b.type !== 'text') return false;
        try { JSON.parse((b as { text: string }).text); return true; } catch { return false; }
      }
    );
    expect(textBlock).toBeDefined();

    const parsed = JSON.parse(textBlock!.text);
    // The trimmed result should be smaller
    const newSize = Buffer.byteLength(JSON.stringify(parsed), 'utf-8');
    expect(newSize).toBeLessThan(originalSize);

    // Should have truncation notice
    const noticeBlock = result.content[result.content.length - 1];
    expect((noticeBlock as { text: string }).text).toMatch(/truncated/i);
  });

  it('skips all processing when feature flag is disabled', () => {
    process.env.GODOT_MCP_RESPONSE_LIMIT = 'false';

    // Create a response over 4MB
    const response = makeArrayResult(3000, 1500);
    const originalSize = resultSize(response);
    expect(originalSize).toBeGreaterThan(4 * 1024 * 1024);

    const result = truncateResponse(response);
    // Should be the exact same reference — no processing
    expect(result).toBe(response);
  });

  it('handles over-4MB response without parseable JSON gracefully', () => {
    // Plain text, not JSON
    const bigText = 'y'.repeat(4.5 * 1024 * 1024);
    const response: ToolResult = {
      content: [{ type: 'text', text: bigText }],
    };

    const result = truncateResponse(response);
    expect(result).not.toBe(response);
    // Should have a warning about no truncatable array
    const warningBlock = result.content[result.content.length - 1];
    expect((warningBlock as { text: string }).text).toMatch(/no truncatable array/i);
  });
});
