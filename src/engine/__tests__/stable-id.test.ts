import { describe, expect, it } from 'vitest'
import { stableId } from '../stable-id'

describe('stableId', () => {
  it('returns a deterministic 128-bit-width hexadecimal fingerprint', () => {
    const first = stableId('same content')
    const second = stableId('same content')

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
  })

  it('changes when the content changes', () => {
    expect(stableId('content A')).not.toBe(stableId('content B'))
  })
})
