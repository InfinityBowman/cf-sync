import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // The engine runs where it ships: workerd, behind a real DO.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './test/fixture/wrangler.jsonc' },
          }),
        ],
        test: { name: 'workerd', include: ['test/**/*.test.ts'], exclude: ['test/node/**'] },
      },
      {
        // Node-only pieces of the ./testing subpath (checkSchemaEvolution
        // reads and writes its snapshot file with node:fs).
        test: { name: 'node', include: ['test/node/**/*.test.ts'] },
      },
    ],
  },
})
