import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: 'esm',
  platform: 'neutral',
  dts: true,
  // Provided by the workerd runtime; must never be bundled or resolved.
  deps: { neverBundle: [/^cloudflare:/] },
})
