import { defineConfig } from 'vitest/config';

/**
 * Performance budgets, kept apart from the unit suite.
 *
 * Two reasons for a separate config rather than another `*.test.ts`: these
 * files measure, so they must run alone rather than alongside 500 other tests
 * competing for the same core; and a budget failure has a different meaning
 * from a correctness failure, so it deserves its own job in the CI gate.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.bench.ts'],
    // Measuring is meaningless with several files timing each other out of the
    // same CPU.
    fileParallelism: false,
    pool: 'forks',
    isolate: false,
    maxForks: 1,
    minForks: 1,
  },
});
