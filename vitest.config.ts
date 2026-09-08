import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // CLI tests import the source entry before the CI build step; resolve the
    // workspace package to source in Vitest, while production still uses dist.
    alias: {
      '@stagepick/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
