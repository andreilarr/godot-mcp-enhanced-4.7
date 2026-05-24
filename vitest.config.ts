import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.{js,ts}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['build/**/*.js'],
      exclude: ['build/**/*.js.map', 'build/**/*.d.ts', 'build/**/*.gd'],
    },
    testTimeout: 30_000,
  },
});
