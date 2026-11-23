import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // Builds the skill bundle once before any worker starts, so no two test
    // files race to rewrite skills/retire-runway/dist (BUI-1452).
    globalSetup: ['./test/global-setup.ts'],
    // The deterministic retirement-plan stress solver takes about 13 seconds
    // under V8 coverage on the supported CI runner.
    testTimeout: 15000,
    // A beforeAll that built a bundle took 0.06 s idle but exceeded the 10 s
    // default on a loaded gate machine (BUI-1440); 60 s leaves 6x that observed
    // ceiling for hooks that do process or file work.
    hookTimeout: 60000,
    exclude: [
      '**/node_modules/**',
      '.next/**',
      'tests/integration/**',
      'tests/e2e/**',
    ],
  },
})
