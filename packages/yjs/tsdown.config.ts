import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/server.ts', 'src/client.ts'],
  format: 'esm',
  platform: 'neutral', // /client runs in browsers, /server in workerd
  dts: true,
  // Provided by the workerd runtime; must never be bundled or resolved.
  deps: { neverBundle: [/^cloudflare:/] },
})
