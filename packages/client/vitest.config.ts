import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Timings over a large workspace, opt-in: CF_SYNC_BENCH=1 pnpm vitest run test/bench
    include: process.env.CF_SYNC_BENCH ? ['test/bench/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: process.env.CF_SYNC_BENCH ? [] : ['test/bench/**', 'node_modules/**'],
    testTimeout: process.env.CF_SYNC_BENCH ? 600_000 : 5_000,
  },
})
