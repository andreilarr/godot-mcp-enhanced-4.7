export const DEFAULT_AGENT_ID = '__default__';
const EPHEMERAL_AGENT_TTL = 30 * 60 * 1000; // 30 分钟

export interface InstanceRef {
  type: 'port' | 'path';
  value: string;
}

export interface ProjectContext {
  sceneTree: unknown | null;
  scriptPaths: string[];
  lastValidation: number;
}

export interface AgentState {
  agentId: string;
  selectedInstance: InstanceRef | null;
  activeProfile: string;
  contextCache: Map<string, ProjectContext>;
  lastSeen: number;
  isEphemeral: boolean;
}

function createAgentState(agentId: string, isEphemeral: boolean): AgentState {
  return {
    agentId,
    selectedInstance: null,
    activeProfile: 'full',
    contextCache: new Map(),
    lastSeen: Date.now(),
    isEphemeral,
  };
}

export class AgentContextManager {
  private agents = new Map<string, AgentState>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private engineQueue: Array<{
    op: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  private engineRunning = false;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  getOrCreate(agentId: string | undefined): AgentState {
    const id = agentId ?? DEFAULT_AGENT_ID;
    let state = this.agents.get(id);
    if (!state) {
      state = createAgentState(id, id !== DEFAULT_AGENT_ID);
      this.agents.set(id, state);
    }
    state.lastSeen = Date.now();
    return state;
  }

  remove(agentId: string): void {
    this.agents.delete(agentId);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, state] of this.agents) {
      if (state.isEphemeral && (now - state.lastSeen) > EPHEMERAL_AGENT_TTL) {
        this.agents.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // Task 2 占位
  async enqueueEngine<T>(op: () => Promise<T>): Promise<T> {
    return op();
  }

  async enqueueIO<T>(op: () => Promise<T>): Promise<T> {
    return op();
  }
}
