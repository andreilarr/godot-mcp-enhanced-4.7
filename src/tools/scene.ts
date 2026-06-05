// src/tools/scene.ts — barrel re-export (backward compatible)
export * from './scene/helpers.js';
export { mergeTscn, checkSceneHealth } from './scene/scene-merge.js';
export { handleInstanceScene, handleSetInstanceProperty, handleDetachInstance } from './scene/scene-instance.js';
export { getToolDefinitions, handleTool, TOOL_META } from './scene/index.js';
