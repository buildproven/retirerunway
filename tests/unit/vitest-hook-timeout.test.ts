// @vitest-environment node
import { describe, expect, it } from 'vitest'
import config from '../../vitest.config'

// NFR-07 (BUI-1440): beforeAll hooks that build bundles (the correctness suite
// runs esbuild when dist/ is absent) exceeded vitest's default 10 s hookTimeout
// on a loaded gate machine. The config sets an explicit, larger limit.
describe('NFR-07 vitest hook timeout', () => {
  it('sets an explicit hookTimeout above the 10 s default', () => {
    expect(config.test?.hookTimeout).toBeGreaterThan(10_000)
  })

  it('keeps the hook limit at or above the test limit', () => {
    expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(
      config.test?.testTimeout ?? 0
    )
  })
})
