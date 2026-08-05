import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@createiq/reviewer-roulette',
  entry: ['src/roulette.ts'],
  format: ['cjs'],
  outDir: 'dist',
  clean: true,
  minify: true,
  // tsdown would name a CJS build `roulette.cjs`. This package has no `type`
  // field, so `.js` already means CommonJS, and `bin`/`main` point at
  // `dist/roulette.js` — keep that name rather than repoint the published CLI.
  outExtensions: () => ({ js: '.js' }),
})
