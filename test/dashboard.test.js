// test/dashboard.test.js — Basic coverage for dashboard modules
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Dashboard index.ts calls process.exit on error; mock it during import
const originalExit = process.exit;
let exitCalled = false;

beforeAll(() => {
  process.exit = (code) => { exitCalled = true; throw new Error(`process.exit(${code})`); };
});

afterAll(() => {
  process.exit = originalExit;
});

describe('dashboard ui renderDashboard', () => {
  it('exports renderDashboard function', async () => {
    const mod = await import('../src/dashboard/ui.js');
    expect(typeof mod.renderDashboard).toBe('function');
  });
});

describe('dashboard themes', () => {
  it('exports theme functions and constants', async () => {
    const mod = await import('../src/dashboard/themes.js');
    expect(typeof mod.fg).toBe('function');
    expect(typeof mod.bg).toBe('function');
    expect(typeof mod.colorize).toBe('function');
    expect(mod.LEVEL_COLORS).toBeDefined();
    expect(mod.STATUS).toBeDefined();
  });
});
