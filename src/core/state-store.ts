import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InstanceRef } from './agent-context.js';
import { getLogger } from './logger.js';

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
  private generation = 0;

  constructor(projectPath: string) {
    const dir = projectPath
      ? path.join(projectPath, '.godot')
      : path.join(os.homedir(), '.godot-mcp');
    this.filePath = path.join(dir, STATE_FILENAME);
  }

  async load(): Promise<PersistedState | null> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      return this.validate(parsed);
    } catch {
      return null;
    }
  }

  markDirty(getState: () => PersistedState): void {
    // 立即调用 getState 捕获当前状态快照
    this.cachedState = getState();
    this.generation++;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.cachedState) return;

    // C-01 fix: 记录写入前的 generation，写入完成后仅在没有新脏数据时清空
    const genBeforeWrite = this.generation;
    const state: PersistedState = { ...this.cachedState, savedAt: Date.now() };

    try {
      const dir = path.dirname(this.filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
      // 仅在没有新 markDirty 调用时清空缓存，避免覆盖更新快照
      if (this.generation === genBeforeWrite) {
        this.cachedState = null;
      }
    } catch (err) {
      // A-18: Log flush failure instead of silently swallowing
      getLogger().error('state-store', `flush failed: ${err instanceof Error ? err.message : err}`);
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
