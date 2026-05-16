import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_NAMES,
  getToolDefinitions,
  sanitizeRecordingFileName,
  generateRecordingFileName,
  genRecordingStartScript,
  genRecordingStopScript,
  genRecordingSaveScript,
  genRecordingLoadScript,
  genRecordingPlayScript,
} from '../build/tools/recording.js';

// ─── TOOL_NAMES ─────────────────────────────────────────────────────────────

describe('TOOL_NAMES', () => {
  it('contains exactly 5 recording tool names', () => {
    assert.strictEqual(TOOL_NAMES.length, 5);
  });
  for (const name of ['recording_start', 'recording_stop', 'recording_save', 'recording_load', 'recording_play']) {
    it(`includes ${name}`, () => {
      assert.ok(TOOL_NAMES.includes(name));
    });
  }
});

// ─── sanitizeRecordingFileName ──────────────────────────────────────────────

describe('sanitizeRecordingFileName', () => {
  it('accepts valid recording file names', () => {
    assert.strictEqual(
      sanitizeRecordingFileName('recording_20260516_120000.json'),
      'recording_20260516_120000.json'
    );
  });

  it('accepts recording names with dashes and underscores', () => {
    assert.strictEqual(
      sanitizeRecordingFileName('recording_test-session_01.json'),
      'recording_test-session_01.json'
    );
  });

  it('rejects path traversal with ..', () => {
    assert.throws(
      () => sanitizeRecordingFileName('recording_..json'),
      /path traversal/
    );
  });

  it('rejects forward slash', () => {
    assert.throws(
      () => sanitizeRecordingFileName('recording_foo/bar.json'),
      /path traversal/
    );
  });

  it('rejects backslash', () => {
    assert.throws(
      () => sanitizeRecordingFileName('recording_foo\\bar.json'),
      /path traversal/
    );
  });

  it('rejects names not matching recording_*.json pattern', () => {
    assert.throws(
      () => sanitizeRecordingFileName('evil.json'),
      /must match/
    );
  });

  it('rejects names with double dot embedded', () => {
    assert.throws(
      () => sanitizeRecordingFileName('../recording_test.json'),
      /path traversal/
    );
  });

  it('rejects names with spaces', () => {
    assert.throws(
      () => sanitizeRecordingFileName('recording_has space.json'),
      /must match/
    );
  });
});

// ─── generateRecordingFileName ──────────────────────────────────────────────

describe('generateRecordingFileName', () => {
  it('generates a name matching recording_*.json', () => {
    const name = generateRecordingFileName();
    assert.ok(/^recording_[\w-]+\.json$/.test(name), `Generated name "${name}" does not match pattern`);
  });

  it('includes timestamp-like portion', () => {
    const name = generateRecordingFileName();
    // Format: recording_YYYYMMDD_HHMMSS.json
    assert.ok(/recording_\d{8}_\d{6}\.json/.test(name), `Name "${name}" missing timestamp portion`);
  });

  it('passes sanitizeRecordingFileName', () => {
    const name = generateRecordingFileName();
    assert.doesNotThrow(() => sanitizeRecordingFileName(name));
  });
});

// ─── genRecordingStartScript ────────────────────────────────────────────────

describe('genRecordingStartScript', () => {
  it('generates GDScript with recording state', () => {
    const script = genRecordingStartScript();
    assert.ok(script.includes('_mcp_recording = true'));
    assert.ok(script.includes('_mcp_recorded_events'));
    assert.ok(script.includes('_mcp_output("recording_started"'));
    assert.ok(script.includes('extends SceneTree'));
  });

  it('includes input event handlers for key and mouse', () => {
    const script = genRecordingStartScript();
    assert.ok(script.includes('InputEventKey'));
    assert.ok(script.includes('InputEventMouseButton'));
    assert.ok(script.includes('InputEventMouseMotion'));
  });
});

// ─── genRecordingStopScript ─────────────────────────────────────────────────

describe('genRecordingStopScript', () => {
  it('generates GDScript that outputs recording data', () => {
    const script = genRecordingStopScript();
    assert.ok(script.includes('_mcp_output("recording_stopped"'));
    assert.ok(script.includes('"version"'));
    assert.ok(script.includes('"events"'));
    assert.ok(script.includes('extends SceneTree'));
  });
});

// ─── genRecordingSaveScript ─────────────────────────────────────────────────

describe('genRecordingSaveScript', () => {
  it('generates GDScript that writes to res://recordings/', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"version":1,"events":[]}');
    assert.ok(script.includes('res://recordings/recording_test.json'));
    assert.ok(script.includes('FileAccess.WRITE'));
    assert.ok(script.includes('_mcp_output("saved"'));
  });

  it('creates recordings directory if missing', () => {
    const script = genRecordingSaveScript('recording_test.json', '{}');
    assert.ok(script.includes('make_dir("recordings")'));
  });

  it('escapes JSON content for GDScript string', () => {
    const script = genRecordingSaveScript('recording_test.json', '{"key": "val\\ue"}');
    assert.ok(script.includes('store_string'));
  });
});

// ─── genRecordingLoadScript ─────────────────────────────────────────────────

describe('genRecordingLoadScript', () => {
  it('generates GDScript that reads from res://recordings/', () => {
    const script = genRecordingLoadScript('recording_test.json');
    assert.ok(script.includes('res://recordings/recording_test.json'));
    assert.ok(script.includes('FileAccess.READ'));
    assert.ok(script.includes('_mcp_output("recording"'));
  });

  it('handles file not found', () => {
    const script = genRecordingLoadScript('recording_missing.json');
    assert.ok(script.includes('File not found'));
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
    assert.ok(script.includes('Input.parse_input_event'));
    assert.ok(script.includes('InputEventKey'));
    assert.ok(script.includes('InputEventMouseButton'));
  });

  it('includes speed factor', () => {
    const script = genRecordingPlayScript(sampleEvents.replace(/"/g, '\\"'), 2.0);
    assert.ok(script.includes('_mcp_play_speed = 2.0'));
  });

  it('handles empty events gracefully', () => {
    const emptyEvents = JSON.stringify({ version: 1, duration_ms: 0, events: [] });
    const script = genRecordingPlayScript(emptyEvents.replace(/"/g, '\\"'), 1.0);
    assert.ok(script.includes('playback_complete'));
  });
});

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('getToolDefinitions', () => {
  it('returns 5 tool definitions', () => {
    const defs = getToolDefinitions();
    assert.strictEqual(defs.length, 5);
  });

  it('each definition has a name from TOOL_NAMES', () => {
    const defs = getToolDefinitions();
    const names = defs.map(d => d.name);
    for (const tn of TOOL_NAMES) {
      assert.ok(names.includes(tn), `missing tool definition for ${tn}`);
    }
  });

  it('each definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    for (const def of defs) {
      assert.ok(def.inputSchema, `${def.name} missing inputSchema`);
      assert.ok(def.inputSchema.required, `${def.name} missing required fields`);
    }
  });

  it('recording_start requires project_path', () => {
    const defs = getToolDefinitions();
    const start = defs.find(d => d.name === 'recording_start');
    assert.ok(start.inputSchema.required.includes('project_path'));
  });

  it('recording_save requires events_json', () => {
    const defs = getToolDefinitions();
    const save = defs.find(d => d.name === 'recording_save');
    assert.ok(save.inputSchema.required.includes('events_json'));
  });

  it('recording_load requires file_name', () => {
    const defs = getToolDefinitions();
    const load = defs.find(d => d.name === 'recording_load');
    assert.ok(load.inputSchema.required.includes('file_name'));
  });

  it('recording_play has optional speed parameter', () => {
    const defs = getToolDefinitions();
    const play = defs.find(d => d.name === 'recording_play');
    assert.ok(play.inputSchema.properties.speed);
    assert.ok(!play.inputSchema.required.includes('speed'));
  });
});
