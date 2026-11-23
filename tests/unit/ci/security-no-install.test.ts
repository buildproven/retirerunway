// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

// The blocking security job must not install packages at run time (BUI-1222/1223,
// qa-architect BUI-1216): without Docker it uses the runner image's preinstalled,
// hash-pinned semgrep 1.185.0 (machine-setup REQ-CI-4, BUI-1954), and fails
// closed when that is missing.
type Step = { name?: string; run?: string }
type Workflow = { jobs: { security: { steps: Step[] } } }

const workflow = load(
  readFileSync(
    resolve(__dirname, '../../../.github/workflows/quality.yml'),
    'utf8'
  )
) as Workflow
const security = workflow.jobs.security.steps.map(s => s.run ?? '').join('\n')

describe('security job', () => {
  it('installs no package at run time', () => {
    // A quote may sit between the binary and `install` ("$VENV/bin/pip" install).
    expect(security).not.toMatch(
      /\bpip3?["']?\s+install|npx semgrep|\buv pip\b|\bpipx\b|\buvx\b/
    )
  })

  it('uses the preinstalled semgrep only at exactly 1.185.0, else fails closed', () => {
    expect(security).toMatch(/semgrep --version 2>\/dev\/null\)" = '1\.185\.0'/)
    expect(security).toMatch(
      /::error::semgrep is not available[^\n]*no preinstalled semgrep 1\.185\.0[^\n]*\n\s*exit 1/
    )
  })
})
