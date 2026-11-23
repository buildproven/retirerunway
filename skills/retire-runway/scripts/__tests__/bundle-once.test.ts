// BUI-1452: the skill bundle is built once, by vitest globalSetup, before any
// worker starts. Per-file builds let two workers rewrite dist/*.mjs while the
// other ran node on it.
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import vitestConfig from '../../../../vitest.config'
import setup, { buildSkillBundle } from '../../../../test/global-setup'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const bundleScript = resolve(
  repoRoot,
  'skills/retire-runway/scripts/bundle.mjs'
)

describe('skill bundle is built once per vitest run (BUI-1452)', () => {
  it('REQ-TEST-1: vitest.config.ts registers test/global-setup.ts as globalSetup', () => {
    const globalSetup = vitestConfig.test?.globalSetup
    const entries = Array.isArray(globalSetup) ? globalSetup : [globalSetup]
    expect(entries.map(e => (e ? resolve(repoRoot, e) : e))).toContain(
      resolve(repoRoot, 'test/global-setup.ts')
    )
    expect(typeof setup).toBe('function')
  })

  it.each(['skill.test.ts', 'correctness.test.ts'])(
    'REQ-TEST-2: %s does not build the bundle itself',
    file => {
      const source = readFileSync(resolve(here, file), 'utf8')
      expect(source).not.toContain('bundle.mjs')
    }
  )

  it('REQ-TEST-1: buildSkillBundle runs scripts/bundle.mjs with node', () => {
    const calls: Array<{ command: string; args: string[] }> = []
    buildSkillBundle((command, args) => {
      calls.push({ command, args })
    })
    expect(calls).toEqual([{ command: process.execPath, args: [bundleScript] }])
  })

  it('REQ-TEST-3: a failing build throws the build error and stops the suite', () => {
    const failingBuild = () => {
      throw new Error('esbuild: Could not resolve "missing-module"')
    }
    expect(() => buildSkillBundle(failingBuild)).toThrow(
      /skill bundle build failed[\s\S]*Could not resolve "missing-module"/
    )
  })

  it('REQ-TEST-3: a non-Error build failure is still reported, not swallowed', () => {
    const failingBuild = () => {
      throw 'exit code 1'
    }
    expect(() => buildSkillBundle(failingBuild)).toThrow(
      /skill bundle build failed[\s\S]*exit code 1/
    )
  })
})
