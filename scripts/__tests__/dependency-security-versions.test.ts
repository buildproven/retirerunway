// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// NFR-07 (BUI-1492): the lockfile resolves vite and vitest past the advisories
// that turned `npm audit --audit-level high` red on 2026-10-20 (vite 8.0.0–8.1.5,
// GHSA-698v-4r3x-3vcv and others; vitest/@vitest/mocker < 4.1.11, GHSA-82fw-gwwq-j7x9).
type Lock = { packages: Record<string, { version?: string }> }
const lock = JSON.parse(
  readFileSync(resolve(__dirname, '../../package-lock.json'), 'utf8')
) as Lock

const parse = (v: string): number[] => v.split('-')[0].split('.').map(Number)
const compare = (a: string, b: string): number => {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
const versionsOf = (name: string): string[] =>
  Object.entries(lock.packages)
    .filter(([path]) => path.endsWith(`node_modules/${name}`))
    .map(([, pkg]) => pkg.version ?? '')

describe('NFR-07 dependency security versions', () => {
  it.each(['vitest', '@vitest/coverage-v8', '@vitest/mocker'])(
    'every resolved %s is at least 4.1.11',
    name => {
      const versions = versionsOf(name)
      expect(versions.length).toBeGreaterThan(0)
      for (const v of versions)
        expect(compare(v, '4.1.11')).toBeGreaterThanOrEqual(0)
    }
  )

  it('every resolved vite is above 8.1.5', () => {
    const versions = versionsOf('vite')
    expect(versions.length).toBeGreaterThan(0)
    for (const v of versions) expect(compare(v, '8.1.5')).toBeGreaterThan(0)
  })

  // next 16.0.0–16.4.0: GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr (critical RCE),
  // GHSA-p3m5-59mp-jv5r; `next build` refuses to run on an affected version.
  it('every resolved next is above 16.4.0', () => {
    const versions = versionsOf('next')
    expect(versions.length).toBeGreaterThan(0)
    for (const v of versions) expect(compare(v, '16.4.0')).toBeGreaterThan(0)
  })

  it('every resolved zod is at least 4.6.6', () => {
    const versions = versionsOf('zod').filter(v => v.startsWith('4.'))
    expect(versions.length).toBeGreaterThan(0)
    for (const v of versions)
      expect(compare(v, '4.6.6')).toBeGreaterThanOrEqual(0)
  })
})
