import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InstanceRef } from './agent-context.js';

const STATE_FILENAME = 'mcp-state.json';
const DEBOUNCE_MS = 2000;
const STALE_AGENT_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 小时

export interface PersistedAgentState {
  selectedInstance: InstanceRef | null;
  activeProfile: string;
  contextMeta: { scenePath: string; fetchedAt: number } | null;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  agents: Record<string, PersistedAgentState>;
  globalProfile: string;
  lastConnectedPort: number | null;
}

export class FileStateStore {
  private filePath: string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedState: PersistedState | null = null;

  constructor(projectPath: string) {
    const dir = projectPath
      ? path.join(projectPath, '.godot')
      : path.join(os.homedir(), '.godot-mcp');
    this.filePath = path.join(dir, STATE_FILENAME);
  }

  load(): PersistedState | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      return this.validate(parsed);
    } catch {
      return null;
    }
  }

  markDirty(getState: () => PersistedState): void {
    // 立即调用 getState 捕获当前状态快照
    this.cachedState = getState();
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.cachedState) return;

    // 保留原始 savedAt 以便 load 时正确验证过期
    const state = this.cachedState;
    this.cachedState = null;

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // 静默失败 — 状态持久化是尽力而为
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private validate(state: PersistedState): PersistedState {
    if (state.version !== 1) return { version: 1, savedAt: Date.now(), agents: {}, globalProfile: 'full', lastConnectedPort: null };

    const isStale = Date.now() - state.savedAt > STALE_AGENT_THRESHOLD_MS;
    if (isStale) {
      state.agents = {};
    }

    return state;
  }
}
