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
    /**
     * Suite-level cleanup (Phase 5 hardening). The integration suites create
     * real tickets, so they create real outbox events; without this a run
     * leaves queued jobs and `running` executions behind and the next run
     * inherits the backlog. See vitest.global-setup.ts.
     */
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
