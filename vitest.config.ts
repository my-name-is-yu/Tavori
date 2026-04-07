import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const include = [
  'src/**/__tests__/**/*.test.ts',
  'plugins/**/__tests__/**/*.test.ts',
  'examples/**/__tests__/**/*.test.ts',
  'tests/e2e/**/*.test.ts',
  'tests/regression/**/*.test.ts',
  'tests/test_*.ts',
];

if (existsSync('web/src/app')) {
  include.push('tests/web/**/*.test.ts');
}

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/tui/**'],
      reporter: ['text', 'text-summary', 'json', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
