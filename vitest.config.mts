import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // Every case spawns dist/roulette.js against its own stub server on an
    // ephemeral port, so nothing is shared and they can overlap freely.
    maxConcurrency: 8,
    // A case that asserted nothing would pass while proving nothing, and
    // these all assert on a subprocess rather than a return value.
    expect: { requireAssertions: true },
  },
})
