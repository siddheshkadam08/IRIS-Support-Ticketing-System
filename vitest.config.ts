import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@iris/shared/hmac': r('./shared/hmac-utils/ts/index.ts'),
      '@iris/shared/types': r('./shared/types/index.ts'),
      /**
       * Phase 18. Listed BEFORE the bare '@iris/shared' entry: string aliases
       * match by prefix in order, so the generic one would rewrite
       * '@iris/shared/kb' to 'shared/index.ts/kb' and fail to resolve.
       *
       * The subpath exists so the admin panel can import the KB lifecycle rules
       * as VALUES without pulling in the types barrel, which re-exports ids.ts
       * and therefore `node:crypto`. Vite resolves it through the package
       * exports map; vitest needs it spelled out here because these aliases
       * take precedence over that map.
       */
      '@iris/shared/kb': r('./shared/types/kb.ts'),
      '@iris/shared/screenshot': r('./shared/types/screenshot.ts'),
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
