import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'integrations/*/test/**/*.test.ts',
      'training/*/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    reporters: ['default'],
  },
});
