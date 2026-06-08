import { describe, it, expect } from 'vitest';
import { listPrompts, getPrompt } from '../src/prompts.js';

describe('prompts', () => {
  it('listPrompts returns 4 templates', () => {
    const prompts = listPrompts();
    expect(prompts).toHaveLength(4);
    expect(prompts.map(p => p.name)).toContain('create_platformer');
    expect(prompts.map(p => p.name)).toContain('setup_player_controller');
    expect(prompts.map(p => p.name)).toContain('optimize_scene');
    expect(prompts.map(p => p.name)).toContain('debug_performance');
  });

  it('getPrompt returns content with injected args', async () => {
    const result = await getPrompt('create_platformer', { project_name: 'my-game', resolution: '1920x1080' });
    expect(result.messages.length).toBeGreaterThan(0);
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('my-game');
    expect(text).toContain('1920x1080');
  });

  it('getPrompt uses defaults when args empty', async () => {
    const result = await getPrompt('create_platformer', {});
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('platformer');
  });

  it('getPrompt throws for unknown name', async () => {
    await expect(getPrompt('nonexistent', {})).rejects.toThrow();
  });

  it('debug_performance works without args', async () => {
    const result = await getPrompt('debug_performance', {});
    const text = (result.messages[0].content as any).text;
    expect(text).toContain('Performance');
  });
});
