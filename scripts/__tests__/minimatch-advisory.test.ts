// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// NFR-07 (BUI-1958): minimatch GHSA-g3hv-75wg-m249 is fixed in 11.0.1. The repo's
// own `overrides` entry forced every minimatch to the 10.x line, so Dependabot
// could not raise it (security_update_not_possible). These tests keep the lockfile
// and the override at or above the fixed version.
const FIXED = '11.0.1'
const FLOOR_FROM = '7.0.0'

type Lock = { packages: Record<string, { version?: string }> }
const read = (file: string): string =>
  readFileSync(resolve(__dirname, '../../', file), 'utf8')
const lock = JSON.parse(read('package-lock.json')) as Lock
const pkg = JSON.parse(read('package.json')) as {
  overrides?: Record<string, unknown>
}

const parse = (v: string): number[] => {
  const parts = v.trim().split('-')[0].split('.').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN))
    throw new Error(`not a plain x.y.z version: ${v}`)
  return parts
}
const compare = (a: string, b: string): number => {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

// Minimal range check for the forms an override can take here: `^x.y.z`,
// `~x.y.z`, `>=x.y.z`, `x.y.z` (exact), `*`/`latest`/empty (anything).
const admits = (range: string, version: string): boolean => {
  const r = range.trim()
  if (r === '' || r === '*' || r === 'x' || r === 'latest') return true
  const m = /^(\^|~|>=|=)?\s*v?(\d+\.\d+\.\d+)$/.exec(r)
  if (!m) throw new Error(`unsupported range in overrides.minimatch: ${range}`)
  const [, op = '=', base] = m
  const [bMaj, bMin] = parse(base)
  const [vMaj, vMin] = parse(version)
  if (compare(version, base) < 0) return false
  if (op === '>=') return true
  if (op === '=') return compare(version, base) === 0
  if (op === '~') return vMaj === bMaj && vMin === bMin
  return bMaj > 0 ? vMaj === bMaj : vMin === bMin
}

describe('NFR-07 minimatch advisory GHSA-g3hv-75wg-m249', () => {
  it('REQ-DEPS-1: every resolved minimatch at 7.x or above is >= 11.0.1', () => {
    const versions = Object.entries(lock.packages)
      .filter(([path]) => path.endsWith('node_modules/minimatch'))
      .map(([, p]) => p.version ?? '')
    expect(versions.length).toBeGreaterThan(0)
    for (const v of versions) {
      if (compare(v, FLOOR_FROM) < 0) continue
      expect(compare(v, FIXED)).toBeGreaterThanOrEqual(0)
    }
  })

  it('REQ-DEPS-2: overrides.minimatch admits no version in [7.0.0, 11.0.1)', () => {
    const range = pkg.overrides?.minimatch
    // An absent override is allowed: nothing then holds Dependabot back.
    if (range === undefined) return
    expect(typeof range).toBe('string')
    for (const v of ['7.4.6', '9.0.5', '10.2.5', '10.99.99', '11.0.0'])
      expect(admits(range as string, v), `${range} admits ${v}`).toBe(false)
    expect(admits(range as string, FIXED)).toBe(true)
  })

  it('range helper rejects what it cannot evaluate instead of passing', () => {
    expect(() => admits('^10 || ^11', '10.2.5')).toThrow(/unsupported range/)
  })
})
