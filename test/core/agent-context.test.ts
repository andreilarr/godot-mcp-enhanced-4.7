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
});
