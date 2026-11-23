// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'

// NFR-07 (BUI-1233): the quality workflow's shell steps must be ShellCheck-clean
// under actionlint. The Semgrep array put commas in an unquoted element (SC2054)
// and the macOS timeout shim used single-quoted `$` expressions (SC2016).
type Step = { name?: string; run?: string }
type Workflow = { jobs: Record<string, { steps?: Step[] }> }

const workflow = load(
  readFileSync(
    resolve(__dirname, '../../../.github/workflows/quality.yml'),
    'utf8'
  )
) as Workflow
const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
const scriptOf = (name: string): string =>
  steps.find(step => step.name === name)?.run ?? ''

const dir = mkdtempSync(join(tmpdir(), 'timeout-shim-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('NFR-07 quality workflow shell steps', () => {
  it('quotes the comma-bearing --tmpfs element in the Semgrep array (SC2054)', () => {
    const script = scriptOf('Security pattern detection')
    expect(script).toContain('SEMGREP=(docker run')
    expect(script).not.toMatch(/^\s+--tmpfs \/tmp:rw,\S+\s*$/m)
    expect(script).toContain("--tmpfs '/tmp:rw,nosuid,nodev,size=512m'")
  })

  it('writes the timeout shim from a quoted heredoc, not single-quoted expansions (SC2016)', () => {
    const script = scriptOf('Portable timeout (macOS runners have none)')
    expect(script).not.toMatch(/printf '%s\\n' '#!\/bin\/sh'/)
    expect(script).toContain(`cat > "$RUNNER_TEMP/bin/timeout" <<'SHIM'`)
  })

  it('writes a timeout shim that runs the command and passes its exit status', () => {
    const script = scriptOf('Portable timeout (macOS runners have none)')
    const env = {
      ...process.env,
      RUNNER_TEMP: dir,
      GITHUB_PATH: join(dir, 'path'),
    }
    const setup = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env,
    })
    expect(setup.stderr).toBe('')
    expect(setup.status).toBe(0)
    const shim = join(dir, 'bin', 'timeout')
    chmodSync(shim, 0o755)
    expect(readFileSync(shim, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
    const ok = spawnSync(
      shim,
      ['5', 'sh', '-c', 'echo "$0 $1"; exit 3', 'a', 'b'],
      {
        encoding: 'utf8',
      }
    )
    expect(ok.stdout).toBe('a b\n')
    expect(ok.status).toBe(3)
  })

  it('kills a command that outlives the shim timeout', () => {
    const r = spawnSync(join(dir, 'bin', 'timeout'), ['1', 'sleep', '5'], {
      encoding: 'utf8',
    })
    expect(r.signal).toBe('SIGALRM')
  })
})
