// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

// `summary` is the only required status check (BUI-1215): it must fail when a
// job it needs failed or was cancelled, and pass when they succeeded or were
// skipped on purpose.
type Step = {
  name?: string
  if?: string
  env?: Record<string, string>
  run?: string
}
type Workflow = { jobs: { summary: { needs: string[]; steps: Step[] } } }

const workflow = load(
  readFileSync(
    resolve(__dirname, '../../../.github/workflows/quality.yml'),
    'utf8'
  )
) as Workflow
const summary = workflow.jobs.summary
const envName: Record<string, string> = {
  'detect-maturity': 'MATURITY_RESULT',
  security: 'SECURITY_RESULT',
  'audit-report': 'AUDIT_RESULT',
  tests: 'TESTS_RESULT',
  documentation: 'DOCS_RESULT',
}

/** Run every summary step's script with the given job results; return the exit code of the job. */
function runSummary(results: Record<string, string>): number {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '',
    GITHUB_STEP_SUMMARY: '/dev/null',
  }
  for (const [job, result] of Object.entries(results))
    env[envName[job]] = result
  for (const step of summary.steps) {
    if (!step.run) continue
    const script = step.run.replace(/\$\{\{[^}]*\}\}/g, 'x')
    try {
      execFileSync('bash', ['-e', '-c', script], { env, stdio: 'ignore' })
    } catch (error) {
      return (error as { status?: number }).status ?? 1
    }
  }
  return 0
}

const all = (result: string) =>
  Object.fromEntries(summary.needs.map(job => [job, result]))

describe('required summary check', () => {
  it('needs every job it reports on', () => {
    expect(summary.needs.sort()).toEqual(Object.keys(envName).sort())
  })

  it('passes when every needed job succeeded or was skipped', () => {
    expect(runSummary(all('success'))).toBe(0)
    expect(
      runSummary({
        ...all('success'),
        documentation: 'skipped',
        security: 'skipped',
      })
    ).toBe(0)
  })

  it.each([
    'security',
    'tests',
    'detect-maturity',
    'audit-report',
    'documentation',
  ])('fails when %s failed or was cancelled', job => {
    expect(runSummary({ ...all('success'), [job]: 'failure' })).not.toBe(0)
    expect(runSummary({ ...all('success'), [job]: 'cancelled' })).not.toBe(0)
  })

  // BUI-1755: when detect-maturity is skipped (it used to be, for Dependabot)
  // every job skips; the gate must not pass with nothing run.
  it('fails when detect-maturity was skipped', () => {
    expect(runSummary(all('skipped'))).not.toBe(0)
  })
})

describe('Dependabot pull requests', () => {
  it('run detect-maturity like any other pull request', () => {
    const jobs = (
      load(
        readFileSync(
          resolve(__dirname, '../../../.github/workflows/quality.yml'),
          'utf8'
        )
      ) as { jobs: Record<string, { if?: string }> }
    ).jobs
    expect(jobs['detect-maturity'].if ?? '').not.toContain('dependabot')
  })
})
