import { describe, it, expect } from 'vitest'
import { stamp, contentHashId } from '../provenance.ts'

describe('provenance.stamp', () => {
  it('produces identical hashes for semantically identical nested objects with different key order', () => {
    const a = {
      portfolio: {
        id: 'x',
        accounts: [
          { name: 'A', id: 'a', holdings: [{ symbol: 'VTI', shares: 10 }] },
        ],
      },
    }
    const b = {
      portfolio: {
        accounts: [
          { holdings: [{ shares: 10, symbol: 'VTI' }], id: 'a', name: 'A' },
        ],
        id: 'x',
      },
    }
    const s1 = stamp('t', a, a)
    const s2 = stamp('t', b, b)
    expect(s1.inputHash).toBe(s2.inputHash)
    expect(s1.outputHash).toBe(s2.outputHash)
  })

  it('produces different hashes for actually different values', () => {
    const a = { x: 1 }
    const b = { x: 2 }
    expect(stamp('t', a, a).inputHash).not.toBe(stamp('t', b, b).inputHash)
  })

  it('handles primitives and arrays without crashing', () => {
    expect(() => stamp('t', 42, 'hello')).not.toThrow()
    expect(() => stamp('t', [1, 2, 3], null)).not.toThrow()
    const s = stamp('t', 42, 'hello')
    expect(s.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(s.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('arrays preserve order (reordering changes the hash)', () => {
    const a = { items: [1, 2, 3] }
    const b = { items: [3, 2, 1] }
    expect(stamp('t', a, a).inputHash).not.toBe(stamp('t', b, b).inputHash)
  })

  it('stamp version is semver and timestamp is ISO 8601', () => {
    const s = stamp('t', {}, {})
    expect(s.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(s.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

describe('contentHashId', () => {
  it('is deterministic for identical input', () => {
    const a = contentHashId('loaded', 'hello,world\n1,2')
    const b = contentHashId('loaded', 'hello,world\n1,2')
    expect(a).toBe(b)
  })

  it('differs for different content', () => {
    expect(contentHashId('loaded', 'a')).not.toBe(contentHashId('loaded', 'b'))
  })

  it('includes the prefix', () => {
    expect(contentHashId('loaded', 'x')).toMatch(/^loaded-[0-9a-f]{32}$/)
  })
})

describe('provenance.sortKeys — non-plain-object rejection', () => {
  it('throws on Date (not a silent collision)', () => {
    expect(() => stamp('t', { d: new Date() }, {})).toThrow(/non-plain object/)
  })

  it('throws on Map', () => {
    expect(() => stamp('t', { m: new Map() }, {})).toThrow(/non-plain object/)
  })

  it('accepts plain objects and arrays without issue', () => {
    expect(() =>
      stamp('t', { a: [1, 2, { b: 'c' }], d: { e: 'f' } }, { x: 'y' })
    ).not.toThrow()
  })
})
