import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/roulette.ts'],
  publicDir: false,
  clean: true,
  minify: true,
  format: ['cjs'], // 👈 Node
})
