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
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.offset === 'number'
        && Number.isFinite(parsed.offset) && parsed.offset >= 0) {
      return { offset: parsed.offset };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Array trimming ──────────────────────────────────────────────────────────

/**
 * Find the largest array in `data`, estimate the max item count via sampling,
 * refine with limited binary search (max 5 iterations), and return a trimmed copy.
 *
 * Non-array fields are preserved. The trimmed array gets `truncatedAt` and
 * `totalNodeCount` metadata appended.
 *
 * Sampling estimation avoids the O(n log n) serialization cost of pure binary
 * search on large arrays (~14 iterations x 4MB = ~56MB overhead).
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
    return data;
  }

  const originalArray = obj[largestKey] as unknown[];

  // Collect non-array fields once
  const nonArrayFields: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key !== largestKey) nonArrayFields[key] = val;
  }

  // Sampling estimation: estimate per-item size from first N items
  const sampleSize = Math.min(100, originalArray.length);
  const sample = originalArray.slice(0, sampleSize);
  const sampleObj = { ...nonArrayFields, [largestKey]: sample };
  const sampleBytes = Buffer.byteLength(JSON.stringify(sampleObj), 'utf-8');
  const nonArrayBytes = Buffer.byteLength(JSON.stringify(nonArrayFields), 'utf-8');
  const sampleArrayBytes = sampleBytes - nonArrayBytes;
  const estimatedItemSize = sampleArrayBytes / sampleSize;
  const budgetBytes = limitBytes - nonArrayBytes;

  // Estimate how many items fit
  let estimatedFit = estimatedItemSize > 0
    ? Math.floor(budgetBytes / estimatedItemSize)
    : originalArray.length;

  // Clamp
  if (estimatedFit >= originalArray.length) return data;
  if (estimatedFit < 0) estimatedFit = 0;

  // Refine with limited binary search (max 5 iterations)
  // Optimization: cache stringify results to avoid redundant JSON.stringify per iteration.
  // Instead of building a new object + stringify each time, we compute the byte length
  // incrementally by measuring only the array portion (non-array part is constant).
  const isEmpty = Object.keys(nonArrayFields).length === 0;
  const prefix = isEmpty
    ? `{"${largestKey}":`
    : JSON.stringify(nonArrayFields).slice(0, -1) + `,"${largestKey}":`;
  const prefixByteLen = Buffer.byteLength(prefix, 'utf-8');
  const suffixByteLen = 1; // closing "}"

  let lo: number;
  let hi: number;
  let best: number;

  // First verify the estimate itself
  const estimateArrayJson = JSON.stringify(originalArray.slice(0, estimatedFit));
  const estimateTotalBytes = prefixByteLen + Buffer.byteLength(estimateArrayJson, 'utf-8') + suffixByteLen;
  if (estimateTotalBytes <= limitBytes) {
    lo = estimatedFit;
    hi = originalArray.length;
    best = estimatedFit;
  } else {
    lo = 0;
    hi = estimatedFit;
    best = 0;
  }

  for (let i = 0; i < 5 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const midArrayJson = JSON.stringify(originalArray.slice(0, mid));
    const midTotalBytes = prefixByteLen + Buffer.byteLength(midArrayJson, 'utf-8') + suffixByteLen;
    if (midTotalBytes <= limitBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best >= originalArray.length) return data;

  // Build result
  const result: Record<string, unknown> = { ...nonArrayFields };
  result[largestKey] = originalArray.slice(0, best);
  result[`${largestKey}_truncatedAt`] = best;
  result[`${largestKey}_totalNodeCount`] = originalArray.length;

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
