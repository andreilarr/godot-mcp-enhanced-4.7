import { ensureNumber, valueToGd } from './shared.js';

// Re-export ensureNumber for backward compatibility with animation-ops and animation-track
export { ensureNumber };

// Re-export the unified valueToGd from shared.ts (replaces the old local implementation)
export { valueToGd };

// ─── Constants ─────────────────────────────────────────────────────────────

export const ANIM_ERROR_CODES = {
  INVALID_ACTION: 'INVALID_ACTION',
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  ANIM_NOT_FOUND: 'ANIM_NOT_FOUND',
  TRACK_NOT_FOUND: 'TRACK_NOT_FOUND',
  KEYFRAME_NOT_FOUND: 'KEYFRAME_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  SCRIPT_EXEC_FAILED: 'SCRIPT_EXEC_FAILED',
} as const;

export const TRACK_TYPES = [
  'value', 'position_3d', 'rotation_3d', 'scale_3d',
  'blend_shape', 'method', 'bezier', 'audio', 'animation',
] as const;

export const LOOP_MODES = ['none', 'linear', 'pingpong'] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

export function argsToGd(args?: unknown[]): string {
  if (!args || args.length === 0) return '[]';
  return `[${args.map(a => valueToGd(a)).join(', ')}]`;
}

export function animErrorMapper(errorMsg: string): string {
  if (errorMsg.includes('not found')) {
    if (errorMsg.includes('AnimationPlayer')) return ANIM_ERROR_CODES.NODE_NOT_FOUND;
    if (errorMsg.includes('Animation not found')) return ANIM_ERROR_CODES.ANIM_NOT_FOUND;
    if (errorMsg.includes('Track index')) return ANIM_ERROR_CODES.TRACK_NOT_FOUND;
    if (errorMsg.includes('Keyframe')) return ANIM_ERROR_CODES.KEYFRAME_NOT_FOUND;
  }
  return ANIM_ERROR_CODES.SCRIPT_EXEC_FAILED;
}
