import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = 'scripts/security-audit.js'
const knownAdvisory = {
  name: 'braces',
  source: 1240992,
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  severity: 'high',
}

function auditData(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    vulnerabilities: {
      micromatch: {
        severity: 'high',
        isDirect: false,
        via: ['braces'],
      },
      braces: {
        severity: 'high',
        isDirect: false,
        via: [knownAdvisory],
      },
      ...overrides,
    },
  }
}

function runAudit(data: Record<string, unknown>) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: JSON.stringify(data),
  })
}

function runShellAudit(data: Record<string, unknown>, auditStatus: number) {
  const directory = mkdtempSync(join(tmpdir(), 'retire-runway-security-audit-'))
  const npmPath = join(directory, 'npm')
  writeFileSync(
    npmPath,
    `#!/usr/bin/env bash
printf '%s' '${JSON.stringify(data).replaceAll("'", "'\\''")}'
exit ${auditStatus}
`
  )
  chmodSync(npmPath, 0o755)

  const result = spawnSync('bash', ['scripts/security-audit.sh'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
  })
  rmSync(directory, { recursive: true, force: true })
  return result
}

describe('security audit policy', () => {
  it('allows the documented dev-only braces advisory chain', () => {
    expect(runAudit(auditData()).status).toBe(0)
  })

  it('allows the documented dev-only picomatch advisory chain', () => {
    const picomatchAdvisory = {
      name: 'picomatch',
      source: 1247710,
      url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
    }
    const result = runAudit(
      auditData({
        vitest: { severity: 'high', isDirect: true, via: ['picomatch'] },
        tinyglobby: { severity: 'high', isDirect: false, via: ['picomatch'] },
        picomatch: {
          severity: 'high',
          isDirect: false,
          via: [picomatchAdvisory],
        },
      })
    )

    expect(result.status).toBe(0)
  })

  it('rejects a picomatch advisory with a different source id', () => {
    const result = runAudit(
      auditData({
        picomatch: {
          severity: 'high',
          isDirect: false,
          via: [
            {
              name: 'picomatch',
              source: 1,
              url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
            },
          ],
        },
      })
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('picomatch (high)')
  })

  it('rejects the removed Lighthouse CI extract-zip advisory chain', () => {
    const result = runAudit(
      auditData({
        '@lhci/cli': {
          severity: 'high',
          isDirect: true,
          via: ['extract-zip'],
        },
        'extract-zip': {
          severity: 'high',
          isDirect: false,
          via: [
            {
              name: 'extract-zip',
              source: 1139346,
              url: 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
            },
          ],
        },
      })
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@lhci/cli (high)')
  })

  it('rejects a second advisory inside an otherwise allowed package chain', () => {
    const result = runAudit(
      auditData({
        braces: {
          severity: 'high',
          isDirect: true,
          via: [
            knownAdvisory,
            {
              name: 'braces',
              source: 999,
              url: 'https://example.test/advisory',
            },
          ],
        },
      })
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('braces (high)')
  })

  it('ignores lower-severity findings under the high-severity policy', () => {
    const result = runAudit({
      vulnerabilities: {
        'moderate-package': {
          severity: 'moderate',
          isDirect: true,
          via: [
            {
              name: 'moderate-package',
              source: 1,
              url: 'https://example.test/moderate',
            },
          ],
        },
      },
    })

    expect(result.status).toBe(0)
  })

  it('fails for an unrelated high-severity package', () => {
    const result = runAudit(
      auditData({
        'body-parser': {
          severity: 'high',
          isDirect: false,
          via: [
            {
              name: 'body-parser',
              source: 2,
              url: 'https://example.test/high',
            },
          ],
        },
      })
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('body-parser (high)')
  })

  it('fails when npm audit reports an execution error', () => {
    const result = runShellAudit(auditData(), 2)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('npm audit failed with exit status 2')
  })

  it('passes the real audit output through the validator', () => {
    const audit = spawnSync(
      'npm',
      ['audit', '--audit-level', 'high', '--json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    )
    const result = runAudit(JSON.parse(audit.stdout))

    expect(result.status).toBe(0)
  })
})
