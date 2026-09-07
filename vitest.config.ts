import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@iris/shared/hmac': r('./shared/hmac-utils/ts/index.ts'),
      '@iris/shared/types': r('./shared/types/index.ts'),
      '@iris/shared': r('./shared/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration + security suites talk to a real Postgres and must not race
    // each other over the same rows.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
