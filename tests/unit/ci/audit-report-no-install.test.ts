// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

// NFR-07 (BUI-1232): the advisory audit-report job must not install Semgrep or
// its transitive dependencies at run time (an unhashed pip install). Its only
// consumer, setup.js, does not exist in this repo, so the job installs no scanner.
type Step = { name?: string; run?: string }
type Workflow = { jobs: { 'audit-report': { steps: Step[] } } }

const workflow = load(
  readFileSync(
    resolve(__dirname, '../../../.github/workflows/quality.yml'),
    'utf8'
  )
) as Workflow
const steps = workflow.jobs['audit-report'].steps
const scripts = steps.map(s => s.run ?? '').join('\n')

describe('NFR-07 audit-report job', () => {
  it('runs no pip, venv, pipx, uv or npx semgrep install', () => {
    expect(scripts).not.toMatch(
      /\bpip3?["']?\s+install|\bvenv\b|npx semgrep|\buv pip\b|\bpipx\b|\buvx\b/
    )
  })

  it('has no semgrep install step', () => {
    expect(steps.map(s => s.name ?? '')).not.toContain(
      'Install semgrep CLI for vibe-audit'
    )
  })

  it('keeps the advisory npm audit on the lockfile install', () => {
    expect(scripts).toMatch(/npm audit --audit-level high --omit=dev/)
  })

  it('says no vibe-code audit ran when setup.js is absent', () => {
    const step = steps.find(s => s.name === 'QA Architect vibe-code audit')
    expect(step?.run).toMatch(/if \[ -f setup\.js \]/)
    expect(step?.run).toMatch(
      /consumer CI does not execute mutable external CLI code/
    )
  })
})
