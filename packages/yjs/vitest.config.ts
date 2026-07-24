import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // The server extension runs where it ships: workerd, behind a real DO.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './test/fixture/wrangler.jsonc' },
          }),
        ],
        test: { name: 'server', include: ['test/server/**/*.test.ts'] },
      },
      {
        // The client add-on is plain library code over the SyncClient seam;
        // its tests drive a scripted fake seam in node.
        test: { name: 'client', include: ['test/client/**/*.test.ts'] },
      },
    ],
  },
})
