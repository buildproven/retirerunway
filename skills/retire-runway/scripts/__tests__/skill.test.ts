import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(here, '..', '..')
const distDir = resolve(skillRoot, 'dist')
const analyze = resolve(distDir, 'analyze.mjs')
const portfolio = resolve(skillRoot, 'fixtures/sample-portfolio.json')
const profile = resolve(skillRoot, 'fixtures/sample-profile.json')

type ProvEntry = {
  tool: string
  version: string
  inputHash: string
  outputHash: string
  timestamp: string
  seed?: number
}
type AnalyzeOutput = {
  monteCarlo: { config: { seed: number } }
  rothConversion: unknown
  ruleOf55: unknown
  tradePlan: {
    trades: Array<{
      action: string
      shares: number
      holdingId: string
      accountId: string
      rationale: string
    }>
  }
  provenance: ProvEntry[]
  disclaimer: string
}

const runAnalyze = (): AnalyzeOutput => {
  const out = execFileSync('node', [analyze, portfolio, profile], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as AnalyzeOutput
}

describe('retire-runway skill', () => {
  it('produces all four analyses with provenance', () => {
    const r = runAnalyze()
    expect(r.monteCarlo).toBeDefined()
    expect(r.rothConversion).toBeDefined()
    expect(r.ruleOf55).toBeDefined()
    expect(r.tradePlan).toBeDefined()
    expect(r.provenance).toHaveLength(4)
    expect(r.disclaimer).toContain('not investment advice')
  })

  it('stamps every tool call with version, input/output hash, and timestamp', () => {
    const r = runAnalyze()
    for (const p of r.provenance) {
      expect(p.tool).toBeTruthy()
      expect(p.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(p.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(p.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(p.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('is deterministic — same input + seed produces identical output', () => {
    const strip = (r: AnalyzeOutput) => {
      const clone = JSON.parse(JSON.stringify(r)) as AnalyzeOutput
      clone.provenance.forEach(p => {
        ;(p as Partial<ProvEntry>).timestamp = undefined
      })
      return clone
    }
    const a = strip(runAnalyze())
    const b = strip(runAnalyze())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces a trade plan with concrete holding-level actions', () => {
    const r = runAnalyze()
    expect(r.tradePlan.trades.length).toBeGreaterThan(0)
    for (const t of r.tradePlan.trades) {
      expect(t.action).toMatch(/^(sell|buy)$/)
      expect(t.shares).toBeGreaterThan(0)
      expect(t.holdingId).toBeTruthy()
      expect(t.accountId).toBeTruthy()
      expect(t.rationale).toBeTruthy()
    }
  })

  it('Monte Carlo records seed for reproducibility', () => {
    const r = runAnalyze()
    const mcStamp = r.provenance.find(p => p.tool === 'runMonteCarlo')
    expect(mcStamp?.seed).toBeDefined()
    expect(typeof mcStamp?.seed).toBe('number')
  })
})

import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('retire-runway skill — input validation', () => {
  const tmpArray = join(tmpdir(), 'skill-test-array.json')
  const tmpPrimitive = join(tmpdir(), 'skill-test-primitive.json')

  beforeAll(() => {
    writeFileSync(tmpArray, '[1,2,3]')
    writeFileSync(tmpPrimitive, '42')
  })

  it('rejects portfolio JSON that is an array', () => {
    expect(() =>
      execFileSync('node', [analyze, tmpArray, profile], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).toThrow()
  })

  it('rejects portfolio JSON that is a primitive', () => {
    expect(() =>
      execFileSync('node', [analyze, tmpPrimitive, profile], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).toThrow()
  })

  it('cleanup', () => {
    try {
      unlinkSync(tmpArray)
      unlinkSync(tmpPrimitive)
    } catch {
      /* ignore */
    }
  })
})
