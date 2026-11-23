import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = 'scripts/license-audit.js'

function runAudit(data: Record<string, unknown>) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: JSON.stringify(data),
  })
}

describe('license audit policy', () => {
  it('allows the approved sharp-libvips platform package', () => {
    const result = runAudit({
      '@img/sharp-libvips-darwin-arm64@1.3.2': {
        licenses: 'LGPL-3.0-or-later',
      },
      'safe-package@1.0.0': { licenses: 'MIT' },
    })

    expect(result.status).toBe(0)
  })

  it('allows observed package-specific license exceptions only by identity', () => {
    const result = runAudit({
      '@csstools/color-helpers@6.1.0': { licenses: 'MIT-0' },
      'json-schema@0.4.0': { licenses: '(AFL-2.1 OR BSD-3-Clause)' },
    })

    expect(result.status).toBe(0)
  })

  it('rejects LGPL packages outside the approved sharp-libvips family', () => {
    const result = runAudit({
      'unreviewed-package@1.0.0': { licenses: 'LGPL-3.0-or-later' },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unreviewed-package@1.0.0')
  })

  it('rejects package-specific licenses when the package identity is unreviewed', () => {
    const result = runAudit({
      'unreviewed-package@1.0.0': { licenses: 'MIT-0' },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MIT-0')
  })

  it.each([
    ['blank metadata', ''],
    ['whitespace metadata', '   '],
    ['empty metadata array', []],
  ])('rejects %s', (_description, licenses) => {
    const result = runAudit({ 'unreviewed-package@1.0.0': { licenses } })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unreviewed-package@1.0.0')
  })

  it('rejects an empty scanner result', () => {
    const result = runAudit({})

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no package license metadata')
  })

  it('rejects licenses outside the project allowlist', () => {
    const result = runAudit({
      'unreviewed-package@1.0.0': { licenses: 'GPL-3.0-only' },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GPL-3.0-only')
  })
})
