import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/sql.ts', 'src/testing.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  minify: true,
})
