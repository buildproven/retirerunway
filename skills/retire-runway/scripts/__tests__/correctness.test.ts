// Value-range and correctness assertions — catch regressions where the
// structure still matches but the numbers become nonsense.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(here, '..', '..')
const dist = resolve(skillRoot, 'dist')
const analyze = resolve(dist, 'analyze.mjs')
const loadPortfolio = resolve(dist, 'load-portfolio.mjs')

const fixture = (f: string) => resolve(skillRoot, 'fixtures', f)
const csvFixture = (f: string) => resolve(skillRoot, 'fixtures/csv', f)

type Trade = {
  holdingId: string
  accountId: string
  action: string
  shares: number
  estimatedValue: number
  estimatedTaxImpact: number
}
type Analysis = {
  monteCarlo: {
    successRate: number
    medianRunwayYears: number
    percentiles: Array<{
      year: number
      p10: number
      p25: number
      p50: number
      p75: number
      p90: number
    }>
    config: { durationYears: number }
  }
  rothConversion: {
    totalConverted: number
    totalTaxPaid: number
    averageTaxRate: number
  }
  ruleOf55: { eligible: boolean; totalEligibleValue: number }
  tradePlan: {
    trades: Trade[]
    totalProceeds: number
    totalTaxImpact: number
    targetCashPosition: number
  }
}

const runAnalyze = (portfolio: string, profile: string): Analysis => {
  const out = execFileSync('node', [analyze, portfolio, profile], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as Analysis
}

describe('retire-runway — output correctness (not just shape)', () => {
  it('Monte Carlo successRate is in [0, 1]', () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    expect(r.monteCarlo.successRate).toBeGreaterThanOrEqual(0)
    expect(r.monteCarlo.successRate).toBeLessThanOrEqual(1)
  })

  it('Monte Carlo medianRunwayYears is positive and <= durationYears', () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    expect(r.monteCarlo.medianRunwayYears).toBeGreaterThan(0)
    expect(r.monteCarlo.medianRunwayYears).toBeLessThanOrEqual(
      r.monteCarlo.config.durationYears
    )
  })

  it('Monte Carlo percentile bands are monotonic (p10 <= p25 <= p50 <= p75 <= p90)', () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    for (const band of r.monteCarlo.percentiles) {
      expect(band.p10).toBeLessThanOrEqual(band.p25)
      expect(band.p25).toBeLessThanOrEqual(band.p50)
      expect(band.p50).toBeLessThanOrEqual(band.p75)
      expect(band.p75).toBeLessThanOrEqual(band.p90)
    }
  })

  it('Roth conversion totalTaxPaid is non-negative and never exceeds totalConverted', () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    expect(r.rothConversion.totalTaxPaid).toBeGreaterThanOrEqual(0)
    // When the optimizer chooses zero conversions, both are 0 — use <=, not <.
    // A separate test below asserts non-zero conversions on the sample fixture.
    expect(r.rothConversion.totalTaxPaid).toBeLessThanOrEqual(
      r.rothConversion.totalConverted
    )
    expect(r.rothConversion.averageTaxRate).toBeGreaterThanOrEqual(0)
    expect(r.rothConversion.averageTaxRate).toBeLessThanOrEqual(0.5)
  })

  it('Roth conversion on sample fixture recommends a non-trivial conversion amount', () => {
    // Sample fixture: 58yo retiring at 62 with $210k Traditional IRA — the
    // 4-year window + low bracket before SS should trigger conversions. This
    // is the positive-case partner to the bounds test above.
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    expect(r.rothConversion.totalConverted).toBeGreaterThan(0)
    expect(r.rothConversion.totalTaxPaid).toBeGreaterThan(0)
  })

  it('Rule-of-55: fixture user retires at 62 with 401k present — NOT eligible (retired past 59.5 standard age)', () => {
    // Rule-of-55 requires retirement between ages 55 and 59.5. At 62 the
    // standard penalty-free age (59.5) already applies, so Rule-of-55 is moot.
    // This is the intended engine behavior and will catch a regression that
    // e.g. extends eligibility past 59.5.
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    expect(r.ruleOf55.eligible).toBe(false)
  })

  it('Rule-of-55 eligibility triggers when targetRetirementAge is in [55, 59.5]', () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('early-ret-profile.json')
    )
    expect(r.ruleOf55.eligible).toBe(true)
  })

  it('trade plan: sum of estimatedValue equals totalProceeds', () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    const sum = r.tradePlan.trades.reduce((acc, t) => acc + t.estimatedValue, 0)
    expect(Math.round(sum)).toBe(Math.round(r.tradePlan.totalProceeds))
  })

  it('trade plan: no trade exceeds the current value of its holding (cross-referencing portfolio)', async () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    const portfolio = JSON.parse(
      readFileSync(fixture('sample-portfolio.json'), 'utf8')
    ).portfolio
    const holdingsById = new Map<string, { currentValue: number }>()
    for (const acct of portfolio.accounts) {
      for (const h of acct.holdings) holdingsById.set(h.id, h)
    }
    for (const t of r.tradePlan.trades) {
      const h = holdingsById.get(t.holdingId)
      expect(h, `trade references unknown holding ${t.holdingId}`).toBeDefined()
      expect(t.estimatedValue).toBeLessThanOrEqual(
        (h as { currentValue: number }).currentValue + 1
      ) // +1 for rounding
    }
  })

  it('trade plan: targetCashPosition equals 2x annualExpenses (default) when not overridden', () => {
    const r = runAnalyze(
      fixture('sample-portfolio.json'),
      fixture('sample-profile.json')
    )
    expect(r.tradePlan.targetCashPosition).toBe(90_000 * 2)
  })
})

describe('retire-runway — empty portfolio (graceful degradation)', () => {
  it('empty portfolio produces structurally valid output with zero/empty values', () => {
    const r = runAnalyze(
      fixture('empty-portfolio.json'),
      fixture('minimal-profile.json')
    )
    expect(r.monteCarlo.successRate).toBe(0)
    expect(r.tradePlan.trades).toEqual([])
    expect(r.tradePlan.totalProceeds).toBe(0)
    expect(r.ruleOf55.eligible).toBe(false)
  })
})

describe('retire-runway load-portfolio — real CSV formats', () => {
  const formats = ['fidelity', 'schwab', 'vanguard', 'generic'] as const

  for (const fmt of formats) {
    it(`parses ${fmt} CSV with correct format detection`, () => {
      const out = execFileSync(
        'node',
        [loadPortfolio, csvFixture(`${fmt}-sample.csv`)],
        {
          encoding: 'utf8',
          env: { ...process.env, SKILL_AS_OF_DATE: '2026-04-18' },
        }
      )
      const parsed = JSON.parse(out) as {
        import: { format: string; rowsImported: number }
        portfolio: { accounts: Array<{ holdings: unknown[] }> }
      }
      expect(parsed.import.format).toBe(fmt)
      expect(parsed.import.rowsImported).toBeGreaterThan(0)
      expect(parsed.portfolio.accounts.length).toBeGreaterThan(0)
    })
  }

  it('load-portfolio produces deterministic output across runs (env-pinned asOfDate)', () => {
    const env = { ...process.env, SKILL_AS_OF_DATE: '2026-04-18' }
    const r1 = execFileSync(
      'node',
      [loadPortfolio, csvFixture('fidelity-sample.csv')],
      { encoding: 'utf8', env }
    )
    const r2 = execFileSync(
      'node',
      [loadPortfolio, csvFixture('fidelity-sample.csv')],
      { encoding: 'utf8', env }
    )
    const strip = (s: string) => {
      const obj = JSON.parse(s)
      obj.provenance.forEach((p: { timestamp?: string }) => delete p.timestamp)
      return JSON.stringify(obj)
    }
    expect(strip(r1)).toBe(strip(r2))
  })
})
