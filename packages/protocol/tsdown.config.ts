import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts'],
  format: 'esm',
  platform: 'neutral', // runs in browsers and workerd alike
  dts: true,
})
