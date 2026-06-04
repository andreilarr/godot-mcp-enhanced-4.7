import { describe, it, expect } from 'vitest';
import { parseSubcommand, isCliInvocation } from '../../src/cli/router.js';

describe('router', () => {
  describe('parseSubcommand', () => {
    it('parses setup subcommand', () => {
      const result = parseSubcommand(['setup', '--project=/foo']);
      expect(result).toEqual({ subcommand: 'setup', rest: ['--project=/foo'] });
    });

    it('returns null for empty args', () => {
      expect(parseSubcommand([])).toBeNull();
    });

    it('returns null for flags', () => {
      expect(parseSubcommand(['--profile=full'])).toBeNull();
    });

    it('returns null for --help', () => {
      expect(parseSubcommand(['--help'])).toBeNull();
    });

    it('parses all valid subcommands', () => {
      for (const cmd of ['setup', 'doctor', 'init', 'dashboard'] as const) {
        expect(parseSubcommand([cmd])).toEqual({ subcommand: cmd, rest: [] });
      }
    });
  });

  describe('isCliInvocation', () => {
    it('returns true for setup', () => {
      expect(isCliInvocation(['setup'])).toBe(true);
    });

    it('returns true for --help', () => {
      expect(isCliInvocation(['--help'])).toBe(true);
    });

    it('returns true for --version', () => {
      expect(isCliInvocation(['--version'])).toBe(true);
    });

    it('returns true for -v', () => {
      expect(isCliInvocation(['-v'])).toBe(true);
    });

    it('returns false for empty args', () => {
      expect(isCliInvocation([])).toBe(false);
    });

    it('returns false for --profile flag', () => {
      expect(isCliInvocation(['--profile=full'])).toBe(false);
    });

    it('returns false for --minimal flag', () => {
      expect(isCliInvocation(['--minimal'])).toBe(false);
    });

    it('returns false for unknown flag', () => {
      expect(isCliInvocation(['--unknown'])).toBe(false);
    });
  });
});
