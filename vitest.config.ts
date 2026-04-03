import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: [
      'src/**/__tests__/**/*.test.ts',
      'plugins/**/__tests__/**/*.test.ts',
      'examples/**/__tests__/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      'tests/regression/**/*.test.ts',
      'tests/web/**/*.test.ts',
      'tests/test_*.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/tui/**'],
      reporter: ['text', 'text-summary', 'json', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
