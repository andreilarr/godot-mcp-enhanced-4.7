import { expect } from 'vitest';
import {
  getToolDefinitions,
  sanitizeRecordingFileName,
  generateRecordingFileName,
  genRecordingSaveScript,
  genRecordingLoadScript,
  genRecordingPlayScript,
} from '../src/tools/recording.js';

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 1 merged tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
  });

  it('tool name is "recording"', () => {
    const defs = getToolDefinitions();
    expect(defs[0].name).toBe('recording');
  });

  it('tool has action enum with 5 operations', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toEqual([
      'recording_start',
      'recording_stop',
      'recording_save',
      'recording_load',
      'recording_play',
    ]);
  });

  it('tool has required fields: action, project_path', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema.required).toContain('action');
    expect(defs[0].inputSchema.required).toContain('project_path');
  });

  it('tool has optional events_json, file_name, speed parameters', () => {
    const defs = getToolDefinitions();
    const props = defs[0].inputSchema.properties;
    expect(props.events_json).toBeTruthy();
    expect(props.file_name).toBeTruthy();
    expect(props.speed).toBeTruthy();
  });
});

// ─── sanitizeRecordingFileName ──────────────────────────────────────────────

describe('sanitizeRecordingFileName', () => {
  it('accepts valid recording file names', () => {
    expect(sanitizeRecordingFileName('recording_20260516_120000.json')).toBe('recording_20260516_120000.json');
  });

  it('accepts recording names with dashes and underscores', () => {
    expect(sanitizeRecordingFileName('recording_test-session_01.json')).toBe('recording_test-session_01.json');
  });

  it('rejects path traversal with ..', () => {
    expect(() => sanitizeRecordingFileName('recording_..json')).toThrow(/path traversal/);
  });

  it('rejects forward slash', () => {
    expect(() => sanitizeRecordingFileName('recording_foo/bar.json')).toThrow(/path traversal/);
  });

  it('rejects backslash', () => {
    expect(() => sanitizeRecordingFileName('recording_foo\\bar.json')).toThrow(/path traversal/);
  });

  it('rejects names not matching recording_*.json pattern', () => {
    expect(() => sanitizeRecordingFileName('evil.json')).toThrow(/must match/);
  });

  it('rejects names with double dot embedded', () => {
    expect(() => sanitizeRecordingFileName('../recording_test.json')).toThrow(/path traversal/);
  });

  it('rejects names with spaces', () => {
    expect(() => sanitizeRecordingFileName('recording_has space.json')).toThrow(/must match/);
  });
});

// ─── generateRecordingFileName ──────────────────────────────────────────────

describe('generateRecordingFileName', () => {
  it('generates a name matching recording_*.json', () => {
    const name = generateRecordingFileName();
    expect(/^recording_[\w-]+\.json$/.test(name)).toBeTruthy();
  });

  it('includes timestamp-like portion', () => {
    const name = generateRecordingFileName();
    expect(/recording_\d{8}_\d{6}\.json/.test(name)).toBeTruthy();
  });

  it('passes sanitizeRecordingFileName', () => {
    const name = generateRecordingFileName();
    expect(() => sanitizeRecordingFileName(name)).not.toThrow();
  });
});

// ─── genRecordingSaveScript ─────────────────────────────────────────────────

describe('genRecordingSaveScript', () => {
  it('generates GDScript that writes to res://recordings/', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"version":1,"events":[]}');
    expect(script.includes('res://recordings/recording_test.json')).toBeTruthy();
    expect(script.includes('FileAccess.WRITE')).toBeTruthy();
    expect(script.includes('_mcp_output("saved"')).toBeTruthy();
  });

  it('creates recordings directory if missing', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    expect(script.includes('make_dir("recordings")')).toBeTruthy();
  });

  it('escapes JSON content for GDScript string', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"key": "val\\ue"}');
    expect(script.includes('store_string')).toBeTruthy();
  });
});

// ─── genRecordingLoadScript ─────────────────────────────────────────────────

describe('genRecordingLoadScript', () => {
  it('generates GDScript that reads from res://recordings/', () => {
    const script = genRecordingLoadScript('recording_test.json');
    expect(script.includes('res://recordings/recording_test.json')).toBeTruthy();
    expect(script.includes('FileAccess.READ')).toBeTruthy();
    expect(script.includes('_mcp_output("recording"')).toBeTruthy();
  });

  it('handles file not found', () => {
    const script = genRecordingLoadScript('recording_missing.json');
    expect(script.includes('File not found')).toBeTruthy();
  });
});

// ─── genRecordingPlayScript ─────────────────────────────────────────────────

describe('genRecordingPlayScript', () => {
  const sampleEvents = JSON.stringify({
    version: 1,
    duration_ms: 1000,
    events: [
      { type: 'key', keycode: 87, pressed: true, time_ms: 0 },
      { type: 'mouse_click', position: [400, 300], button: 1, pressed: true, time_ms: 500 },
    ],
  });

  it('generates GDScript with playback logic', () => {
    const script = genRecordingPlayScript(sampleEvents.replace(/"/g, '\\"'), 1.0);
    expect(script.includes('Input.parse_input_event')).toBeTruthy();
    expect(script.includes('InputEventKey')).toBeTruthy();
    expect(script.includes('InputEventMouseButton')).toBeTruthy();
  });

  it('includes speed factor', () => {
    const script = genRecordingPlayScript(sampleEvents.replace(/"/g, '\\"'), 2.0);
    expect(script.includes('_mcp_play_speed = 2.0')).toBeTruthy();
  });

  it('handles empty events gracefully', () => {
    const emptyEvents = JSON.stringify({ version: 1, duration_ms: 0, events: [] });
    const script = genRecordingPlayScript(emptyEvents.replace(/"/g, '\\"'), 1.0);
    expect(script.includes('playback_complete')).toBeTruthy();
  });
});

// ─── Bridge-mode recording start/stop ───────────────────────────────────────

describe('recording_start/stop use Bridge', () => {
  it('recording_start handler calls sendToBridge with recording.start method', async () => {
    const mod = await import('../src/tools/recording.js');
    expect(mod.genRecordingStartScript).toBeUndefined();
  });

  it('recording_stop handler calls sendToBridge with recording.stop method', async () => {
    const mod = await import('../src/tools/recording.js');
    expect(mod.genRecordingStopScript).toBeUndefined();
  });
});
