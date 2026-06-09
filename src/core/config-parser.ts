/**
 * Godot config parsing utilities — I-ARCH-03 (extracted from helpers.ts)
 *
 * parseConfigValue, parseGodotConfig, parseMcpScriptOutput.
 */

// ─── Config value parser ─────────────────────────────────────────────────────

/** Split a comma-separated string while respecting quoted segments. */
function splitRespectingQuotes(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  const last = current.trim();
  if (last) parts.push(last);
  return parts;
}

export function parseConfigValue(raw: string, depth = 0): unknown {
  // Depth limit 8 (max 9 nesting levels: 0-8). Godot .cfg/.godot files rarely exceed 3 levels.
  // Prevents pathological input from causing excessive recursion.
  if (depth > 8) return raw;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  // A-06: Use isFinite to exclude Infinity/NaN — Godot configs should never contain infinity
  if (Number.isFinite(num) && raw.trim() !== '') return num;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitRespectingQuotes(inner).map(s => parseConfigValue(s, depth + 1)).filter(s => s !== '');
  }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return {};
    const result: Record<string, unknown> = {};
    const entries = splitRespectingQuotes(inner);
    for (const entry of entries) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx === -1) continue;
      const key = entry.slice(0, eqIdx).trim();
      const val = entry.slice(eqIdx + 1).trim();
      result[key] = parseConfigValue(val, depth + 1);
    }
    return result;
  }
  return raw;
}

// ─── Godot config file parser ─────────────────────────────────────────────────

export interface GodotConfig {
  [section: string]: string | number | boolean | null | unknown[] | GodotConfig;
}

export function parseGodotConfig(content: string): GodotConfig {
  const lines = content.split('\n');
  const sectioned = {} as GodotConfig;
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!;
      if (!sectioned[currentSection]) sectioned[currentSection] = {};
      continue;
    }

    const kvMatch = trimmed.match(/^(\S+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const container = currentSection
        ? (sectioned[currentSection] as Record<string, unknown>)
        : sectioned;
      if (container && typeof container === 'object' && !Array.isArray(container)) {
        container[kvMatch[1]!] = parseConfigValue(kvMatch[2]!.trim());
      }
    }
  }

  return sectioned;
}

// ─── MCP output parser ────────────────────────────────────────────────────────

// TODO: move MARKER_RESULT/MARKER_ERROR to src/core/constants.ts to avoid core→tools dependency
import { MARKER_RESULT, MARKER_ERROR } from '../tools/shared.js';

export function parseMcpScriptOutput(rawOutput: string, exitCode: number | null, resultMarker = MARKER_RESULT, errorMarker = MARKER_ERROR): unknown {
  const lines = rawOutput.split('\n');
  const logLines: string[] = [];
  let parsed: unknown = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(resultMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(resultMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse result JSON', raw: trimmed };
      }
    } else if (trimmed.startsWith(errorMarker)) {
      try {
        parsed = JSON.parse(trimmed.substring(errorMarker.length));
      } catch {
        parsed = { success: false, error: 'Failed to parse error JSON', raw: trimmed };
      }
    } else {
      logLines.push(trimmed);
    }
  }

  if (parsed) return parsed;

  return {
    success: false,
    error: exitCode !== 0 ? `Process exited with code ${exitCode}` : 'No structured output found',
    raw_output: logLines.join('\n'),
  };
}
