// @vitest-environment node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'

// NFR-07 (BUI-1230): the install failure message must state the budget the job
// enforces, and a failed install must not be reported as a budget overrun.
type Step = { name?: string; run?: string }
type Workflow = { jobs: Record<string, { steps?: Step[] }> }

const workflow = load(
  readFileSync(
    resolve(__dirname, '../../../.github/workflows/quality.yml'),
    'utf8'
  )
) as Workflow
const install = Object.values(workflow.jobs)
  .flatMap(job => job.steps ?? [])
  .find(
    step =>
      step.name === 'Install dependencies' &&
      (step.run ?? '').includes('performance budget')
  )?.run

// Render the step as GitHub would on one runner kind.
const render = (selfHosted: boolean): string =>
  (install ?? '')
    .replace(
      /\$\{\{ runner\.environment == 'self-hosted' && ('[^']*'|\S+) \|\| ('[^']*'|\S+) \}\}/g,
      (_m, onSelf: string, onHosted: string) =>
        (selfHosted ? onSelf : onHosted).replace(/^'|'$/g, '')
    )
    .replace('${{ needs.detect-maturity.outputs.install-cmd }}', 'fake-install')

const dir = mkdtempSync(join(tmpdir(), 'install-budget-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A fake `timeout` exits with $FAKE_STATUS, as the real one would after the install.
const timeoutBin = join(dir, 'timeout')
writeFileSync(timeoutBin, '#!/bin/sh\nexit "$FAKE_STATUS"\n')
chmodSync(timeoutBin, 0o755)

const run = (selfHosted: boolean, status: number) =>
  spawnSync('bash', ['-e', '-c', render(selfHosted)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_STATUS: String(status),
    },
  })

describe('NFR-07 install budget failure message', () => {
  it('has a budgeted Install dependencies step', () => {
    expect(install).toBeDefined()
  })

  it('announces the enforced budget for each runner kind', () => {
    expect(run(true, 0).stdout).toContain('must complete within 6 minutes')
    expect(run(false, 0).stdout).toContain('must complete within 2 minutes')
  })

  it('names the 6-minute budget when a self-hosted install times out', () => {
    const r = run(true, 124)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('exceeded the 6-minute performance budget')
    expect(r.stdout).not.toContain('2-minute')
  })

  it('names the 2-minute budget when a hosted install times out', () => {
    const r = run(false, 124)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('exceeded the 2-minute performance budget')
  })

  it('treats the macOS shim SIGALRM exit (142) as a timeout', () => {
    expect(run(true, 142).stdout).toContain(
      'exceeded the 6-minute performance budget'
    )
  })

  it('reports a failed install as a failure, not a budget overrun', () => {
    const r = run(true, 3)
    expect(r.status).toBe(3)
    expect(r.stdout).toContain('Dependency installation failed (exit 3)')
    expect(r.stdout).not.toContain('performance budget!')
  })

  it('passes when the install succeeds', () => {
    const r = run(true, 0)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('::error::')
  })
})
