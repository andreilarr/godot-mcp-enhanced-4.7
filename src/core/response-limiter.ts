// src/core/response-limiter.ts — Dual-threshold response truncation + cursor pagination

import type { ToolResult } from '../types.js';
import { isFeatureEnabled } from './feature-flags.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const WARN_THRESHOLD = 2 * 1024 * 1024;  // 2 MB
const HARD_THRESHOLD = 4 * 1024 * 1024;  // 4 MB
const TRIM_TARGET    = 2 * 1024 * 1024;  // trim down to 2 MB

// ─── Cursor pagination ───────────────────────────────────────────────────────

export interface CursorData {
  offset: number;
}

/** Base64-encode cursor with version prefix. */
export function encodeCursor(data: CursorData): string {
  const json = JSON.stringify(data);
  return 'v1:' + Buffer.from(json, 'utf-8').toString('base64');
}

/** Decode and validate cursor. Returns null for invalid or wrong-version input. */
export function decodeCursor(cursor: string): CursorData | null {
  if (!cursor.startsWith('v1:')) return null;
  try {
    const b64 = cursor.slice(3);
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.offset === 'number') {
      return { offset: parsed.offset };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Array trimming ──────────────────────────────────────────────────────────

/**
 * Find the largest array in `data`, binary-search for the max item count
 * that fits within `limitBytes`, and return a trimmed copy.
 *
 * Non-array fields are preserved. The trimmed array gets `truncatedAt` and
 * `totalNodeCount` metadata appended.
 */
export function trimToArrayLimit(data: unknown, limitBytes: number): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  const obj = data as Record<string, unknown>;

  // Find the largest array field
  let largestKey: string | null = null;
  let largestLen = 0;

  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val) && val.length > largestLen) {
      largestKey = key;
      largestLen = val.length;
    }
  }

  if (largestKey === null || largestLen === 0) {
    return data; // nothing to trim
  }

  const originalArray = obj[largestKey] as unknown[];

  // Binary search for the largest slice that fits
  let lo = 0;
  let hi = originalArray.length;
  let best = originalArray.length;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trimmed = { ...obj, [largestKey]: originalArray.slice(0, mid) };
    const size = Buffer.byteLength(JSON.stringify(trimmed), 'utf-8');
    if (size <= limitBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // If trimming didn't help (best is full array), return as-is
  if (best >= originalArray.length) {
    return data;
  }

  // Build trimmed result preserving non-array fields
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === largestKey) {
      result[key] = originalArray.slice(0, best);
    } else {
      result[key] = val;
    }
  }

  // Add truncation metadata
  result[largestKey] = (result[largestKey] as unknown[]).concat([]);
  // Store metadata as extra keys on the trimmed array's parent
  (result as Record<string, unknown>)[`${largestKey}_truncatedAt`] = best;
  (result as Record<string, unknown>)[`${largestKey}_totalNodeCount`] = originalArray.length;

  return result;
}

// ─── Response truncation ─────────────────────────────────────────────────────

/**
 * Dual-threshold size control for MCP tool results.
 *
 * - Under 2 MB: pass through unchanged (same reference).
 * - 2–4 MB: add a warning content block.
 * - Over 4 MB: trim the largest array, add truncation metadata + notice.
 *
 * Controlled by `GODOT_MCP_RESPONSE_LIMIT` feature flag.
 */
export function truncateResponse(response: ToolResult): ToolResult {
  // Feature flag gate
  if (!isFeatureEnabled('RESPONSE_LIMIT')) {
    return response;
  }

  const sizeBytes = Buffer.byteLength(JSON.stringify(response), 'utf-8');

  // Under warn threshold — no-op
  if (sizeBytes < WARN_THRESHOLD) {
    return response;
  }

  // 2–4 MB: add warning
  if (sizeBytes < HARD_THRESHOLD) {
    return {
      ...response,
      content: [
        ...response.content,
        {
          type: 'text' as const,
          text: `[Warning: Response exceeds 2MB (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB). Set GODOT_MCP_RESPONSE_LIMIT=false to disable truncation.]`,
        },
      ],
    };
  }

  // Over 4 MB: truncate
  const content = response.content;
  // Find the first text block that contains JSON-serializable data
  let parsed: unknown = null;
  let parsedIdx = -1;

  for (let i = 0; i < content.length; i++) {
    const block = content[i]!;
    if (block.type === 'text' && 'text' in block) {
      try {
        parsed = JSON.parse((block as { type: 'text'; text: string }).text);
        parsedIdx = i;
        break;
      } catch {
        // not JSON, skip
      }
    }
  }

  if (parsed !== null && parsedIdx >= 0) {
    const trimmed = trimToArrayLimit(parsed, TRIM_TARGET);
    const trimmedJson = JSON.stringify(trimmed);

    const newContent = [...content];
    newContent[parsedIdx] = {
      type: 'text' as const,
      text: trimmedJson,
    };

    // Add truncation notice
    newContent.push({
      type: 'text' as const,
      text: `[Response truncated: original ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB exceeded 4MB limit. Use cursor pagination for remaining data.]`,
    });

    return { ...response, content: newContent };
  }

  // Fallback: couldn't find parseable JSON, just add warning
  return {
    ...response,
    content: [
      ...response.content,
      {
        type: 'text' as const,
        text: `[Warning: Response exceeds 4MB (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB) but no truncatable array found.]`,
      },
    ],
  };
}
