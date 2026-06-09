import { expect } from 'vitest';
import {
  getToolDefinitions,
  TOOL_META,
  genAudioPlayScript,
  genAudioStopScript,
  genAudioSetParamScript,
  genAudioQueryScript,
} from '../src/tools/audio-ops.js';

// ─── getToolDefinitions ─────────────────────────────────────────────────────

describe('audio-ops getToolDefinitions', () => {
  it('returns 1 merged tool definition', () => {
    const defs = getToolDefinitions();
    expect(defs.length).toBe(1);
  });
  it('tool is named "audio"', () => {
    const defs = getToolDefinitions();
    expect(defs[0].name).toBe('audio');
  });
  it('action enum contains all 4 actions', () => {
    const defs = getToolDefinitions();
    const actionEnum = defs[0].inputSchema.properties.action.enum;
    expect(actionEnum).toContain('audio_play');
    expect(actionEnum).toContain('audio_stop');
    expect(actionEnum).toContain('audio_set_param');
    expect(actionEnum).toContain('audio_query');
  });
  it('definition has inputSchema with required fields', () => {
    const defs = getToolDefinitions();
    expect(defs[0].inputSchema).toBeTruthy();
    expect(defs[0].inputSchema.required).toContain('action');
  });
});

// ─── TOOL_META ──────────────────────────────────────────────────────────────

describe('audio-ops TOOL_META', () => {
  it('has exactly 1 entry', () => {
    expect(Object.keys(TOOL_META).length).toBe(1);
  });
  it('has entry for "audio"', () => {
    expect(TOOL_META.audio).toBeDefined();
  });
  it('audio is non-readonly and non-long-running', () => {
    expect(TOOL_META.audio.readonly).toBe(false);
    expect(TOOL_META.audio.long_running).toBe(false);
  });
});

// ─── genAudioPlayScript ─────────────────────────────────────────────────────

describe('genAudioPlayScript', () => {
  it('generates play script with stream_path', () => {
    const script = genAudioPlayScript('/root/BGMPlayer', 'res://audio/bgm.ogg', -10, 1.0, 'Master');
    expect(script.includes('get_node("/root/BGMPlayer")')).toBeTruthy();
    expect(script.includes('res://audio/bgm.ogg')).toBeTruthy();
    expect(script.includes('volume_db = -10')).toBeTruthy();
    expect(script.includes('pitch_scale = 1.0')).toBeTruthy();
    expect(script.includes('AudioStreamPlayer')).toBeTruthy();
    expect(script.includes('.play()')).toBeTruthy();
  });
  it('generates play script without stream_path', () => {
    const script = genAudioPlayScript('/root/SFX');
    expect(script.includes('.play()')).toBeTruthy();
    expect(script.includes('node.stream =')).toBeFalsy();
  });
  it('generates play script with from_position', () => {
    const script = genAudioPlayScript('/root/BGM', undefined, undefined, undefined, undefined, 5.0);
    expect(script.includes('.play(5.0)')).toBeTruthy();
  });
});

// ─── genAudioStopScript ─────────────────────────────────────────────────────

describe('genAudioStopScript', () => {
  it('generates stop script', () => {
    const script = genAudioStopScript('/root/BGMPlayer');
    expect(script.includes('get_node("/root/BGMPlayer")')).toBeTruthy();
    expect(script.includes('.stop()')).toBeTruthy();
  });
});

// ─── genAudioSetParamScript ─────────────────────────────────────────────────

describe('genAudioSetParamScript', () => {
  it('generates volume_db param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'volume_db', -5);
    expect(script.includes('volume_db = -5')).toBeTruthy();
  });
  it('generates pitch_scale param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'pitch_scale', 1.5);
    expect(script.includes('pitch_scale = 1.5')).toBeTruthy();
  });
  it('generates bus param script', () => {
    const script = genAudioSetParamScript('/root/BGM', 'bus', 'SFX');
    expect(script.includes('bus = "SFX"')).toBeTruthy();
  });
});

// ─── genAudioQueryScript ────────────────────────────────────────────────────

describe('genAudioQueryScript', () => {
  it('generates query script', () => {
    const script = genAudioQueryScript('/root/BGM');
    expect(script.includes('get_node("/root/BGM")')).toBeTruthy();
    expect(script.includes('playing')).toBeTruthy();
    expect(script.includes('volume_db')).toBeTruthy();
    expect(script.includes('pitch_scale')).toBeTruthy();
    expect(script.includes('bus')).toBeTruthy();
    expect(script.includes('get_playback_position')).toBeTruthy();
  });
});
