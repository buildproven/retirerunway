import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const scriptPath = join(repositoryRoot, 'scripts/run-semgrep.sh')

describe('run-semgrep CI mode', () => {
  it('passes --error to Semgrep so findings fail the CI scan', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'retire-runway-semgrep-'))
    const fakeBin = join(tempRoot, 'bin')
    const capturedArgs = join(tempRoot, 'args')
    const fakeSemgrep = join(fakeBin, 'semgrep')

    try {
      mkdirSync(fakeBin)
      writeFileSync(
        fakeSemgrep,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SEMGREP_CAPTURE"\n'
      )
      chmodSync(fakeSemgrep, 0o755)

      const result = spawnSync('bash', [scriptPath, '--ci', '.'], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          SEMGREP_CAPTURE: capturedArgs,
        },
        encoding: 'utf8',
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)

      const args = readFileSync(capturedArgs, 'utf8').trim().split('\n')
      expect(args).toContain('--error')
      expect(args).toContain('--json')
      expect(args).toContain('--config')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
