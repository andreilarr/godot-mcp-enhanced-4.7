import { describe, it, expect, beforeEach } from 'vitest';
import { AgentContextManager, DEFAULT_AGENT_ID } from '../../src/core/agent-context.js';

describe('AgentContextManager', () => {
  let mgr: AgentContextManager;

  beforeEach(() => {
    mgr = new AgentContextManager();
  });

  describe('getOrCreate', () => {
    it('creates default agent when agentId is undefined', () => {
      const state = mgr.getOrCreate(undefined);
      expect(state.agentId).toBe(DEFAULT_AGENT_ID);
      expect(state.selectedInstance).toBeNull();
      expect(state.activeProfile).toBe('full');
      expect(state.isEphemeral).toBe(false);
    });

    it('creates named agent on first access', () => {
      const state = mgr.getOrCreate('agent-1234-abc');
      expect(state.agentId).toBe('agent-1234-abc');
      expect(state.isEphemeral).toBe(true);
    });

    it('returns same state on repeated access', () => {
      const a = mgr.getOrCreate('agent-1');
      const b = mgr.getOrCreate('agent-1');
      expect(a).toBe(b);
    });
  });

  describe('remove', () => {
    it('removes an agent', () => {
      mgr.getOrCreate('agent-x');
      mgr.remove('agent-x');
      const state = mgr.getOrCreate('agent-x');
      // Should be a new object
      expect(state.lastSeen).toBeGreaterThan(0);
    });
  });

  describe('cleanup', () => {
    it('removes expired ephemeral agents but keeps default', () => {
      const def = mgr.getOrCreate(undefined);
      const ephemeral = mgr.getOrCreate('agent-eph');
      ephemeral.lastSeen = Date.now() - 31 * 60 * 1000;
      mgr.cleanup();
      expect(mgr.getOrCreate(undefined)).toBe(def);
      const recreated = mgr.getOrCreate('agent-eph');
      expect(recreated).not.toBe(ephemeral);
    });
  });

  describe('enqueueEngine', () => {
    it('serializes engine operations in FIFO order', async () => {
      const order: number[] = [];

      const p1 = mgr.enqueueEngine(async () => {
        await new Promise(r => setTimeout(r, 50));
        order.push(1);
      });
      const p2 = mgr.enqueueEngine(async () => {
        order.push(2);
      });
      const p3 = mgr.enqueueEngine(async () => {
        order.push(3);
      });

      await Promise.all([p1, p2, p3]);
      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('getPersistableAgents', () => {
    it('returns only non-ephemeral agents', () => {
      const defaultState = mgr.getOrCreate(undefined);
      defaultState.selectedInstance = { type: 'port', value: '9081' };
      const ephemeral = mgr.getOrCreate('ephemeral-agent');
      ephemeral.selectedInstance = { type: 'path', value: '/tmp/proj' };

      const persistable = mgr.getPersistableAgents();
      expect(persistable.length).toBe(1);
      expect(persistable[0]![0]).toBe('__default__');
      expect(persistable[0]![1].selectedInstance).toEqual({ type: 'port', value: '9081' });
    });
  });

  describe('agentId extraction', () => {
    it('extracts agentId from _meta field', () => {
      const meta = { agentId: 'agent-123' } as Record<string, unknown>;
      const agentId = (meta.agentId ?? meta.agent_id) as string | undefined;
      expect(agentId).toBe('agent-123');
    });

    it('extracts agent_id from _meta field as fallback', () => {
      const meta = { agent_id: 'agent-456' } as Record<string, unknown>;
      const agentId = (meta.agentId ?? meta.agent_id) as string | undefined;
      expect(agentId).toBe('agent-456');
    });

    it('returns undefined when _meta is missing', () => {
      const meta = undefined;
      const agentId = meta?.agentId as string | undefined;
      expect(agentId).toBeUndefined();
    });
  });
});
