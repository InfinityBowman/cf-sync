import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/react.ts'],
  format: 'esm',
  platform: 'neutral', // browser-first; peers (react, @tanstack/db) stay external
  dts: true,
})
