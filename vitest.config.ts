/// <reference types="vitest/globals" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['test/setup.js'],
    include: ['test/**/*.test.{js,ts}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/scripts/*.gd'],
      // C-01: Thresholds set with margin to prevent flaky CI from new code additions.
      // Review: when coverage consistently exceeds thresholds by >3%, raise them.
      thresholds: {
        statements: 55,
        branches: 47,
        functions: 66,
        lines: 57,
      },
    },
    testTimeout: 10_000,
  },
});
