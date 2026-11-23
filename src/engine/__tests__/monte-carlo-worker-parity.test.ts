// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runMonteCarlo } from '../monte-carlo'
import type { Portfolio, UserProfile } from '../types'

// ---------------------------------------------------------------------------
// Guards against the defect where monte-carlo.worker.ts hand-copied the
// simulation from monte-carlo.ts and drifted: it used Math.pow(1 + draw, i)
// for inflation (making every year depend on ONE random draw) and gated
// withdrawals on `age >` instead of `age >=`. The unit tests covered
// monte-carlo.ts while the UI rendered the worker, so nothing caught it.
//
// The worker cannot be imported directly here (it calls `self.onmessage` at
// module scope, which does not exist in the node test environment), so these
// tests assert structurally that the worker delegates rather than duplicates.
// ---------------------------------------------------------------------------

const workerSource = readFileSync(
  fileURLToPath(new URL('../monte-carlo.worker.ts', import.meta.url)),
  'utf-8'
)

describe('monte-carlo worker parity', () => {
  it('delegates to the canonical runMonteCarlo implementation', () => {
    expect(workerSource).toMatch(/import\s*\{\s*runMonteCarlo\s*\}\s*from/)
    expect(workerSource).toContain(
      'runMonteCarlo(portfolio, profile, overrides)'
    )
  })

  it('does not reimplement the simulation loop', () => {
    // Each of these appearing in the worker means logic was copied back in.
    const duplicatedLogicMarkers = [
      'boxMullerNormal',
      'seededRandom',
      'cumulativeInflation',
      'equityFraction',
      'successCount',
      'percentile(',
    ]
    for (const marker of duplicatedLogicMarkers) {
      expect(
        workerSource,
        `worker must not reimplement "${marker}" — import from monte-carlo.ts instead`
      ).not.toContain(marker)
    }
  })

  it('does not reintroduce either documented invariant violation', () => {
    // Invariant 1: inflation compounds via a running product, never Math.pow
    // of a single year's draw.
    expect(workerSource).not.toContain('Math.pow')
    // Invariant 2: withdrawals start AT the target age, not the year after.
    expect(workerSource).not.toMatch(/age\s*>\s*profile\.targetRetirementAge/)
  })

  it('does not duplicate config constants', () => {
    // Defaults belong in config.ts; a local DEFAULT_CONFIG is how the previous
    // copy silently diverged from the canonical parameters.
    expect(workerSource).not.toContain('DEFAULT_CONFIG')
  })
})

// ---------------------------------------------------------------------------
// Correctness assertions on the canonical implementation, covering exactly the
// two invariants the worker copy violated.
// ---------------------------------------------------------------------------

const portfolio: Portfolio = {
  id: 'parity-1',
  name: 'Parity',
  asOfDate: '2026-01-31',
  accounts: [
    {
      id: 'acc-1',
      name: 'Brokerage',
      institution: 'Test',
      accountType: 'brokerage',
      holdings: [
        {
          id: 'h-1',
          symbol: 'VTI',
          name: 'Vanguard Total Stock',
          assetClass: 'us_equity',
          shares: 100,
          costBasis: 200000,
          currentPrice: 2500,
          currentValue: 250000,
        },
      ],
      cds: [],
      cashBalance: 50000,
    },
  ],
}

const profile: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 62,
  annualExpenses: 40000,
}

describe('monte-carlo invariants', () => {
  it('is deterministic for a fixed seed', () => {
    const a = runMonteCarlo(portfolio, profile, { numPaths: 50, seed: 42 })
    const b = runMonteCarlo(portfolio, profile, { numPaths: 50, seed: 42 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('produces different results for different seeds', () => {
    const a = runMonteCarlo(portfolio, profile, { numPaths: 50, seed: 42 })
    const b = runMonteCarlo(portfolio, profile, { numPaths: 50, seed: 43 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('withdraws starting AT the target retirement age, not the year after', () => {
    // currentAge 58, target 62 → age reaches 62 at year index 3 (i+1 = 4).
    // A plan with expenses far exceeding the portfolio depletes fast; the
    // off-by-one bug delays depletion by exactly one year.
    const broke: UserProfile = {
      currentAge: 58,
      targetRetirementAge: 62,
      annualExpenses: 300000,
    }
    const result = runMonteCarlo(portfolio, broke, {
      numPaths: 20,
      seed: 42,
      equityStdDev: 0,
      bondStdDev: 0,
      inflationStdDev: 0,
    })
    const byYear = (y: number) => result.percentiles.find(p => p.year === y)

    // Ages 59-61 are pre-retirement: the balance only grows.
    expect(byYear(3)?.age).toBe(61)
    expect(byYear(3)!.p50).toBeGreaterThan(byYear(2)!.p50)

    // Year 4 is age 62 — the first withdrawal year. The balance must DROP here.
    // Under the off-by-one bug (`age >`) the first withdrawal slips to age 63
    // and year 4 would still be growing.
    expect(byYear(4)?.age).toBe(62)
    expect(byYear(4)!.p50).toBeLessThan(byYear(3)!.p50)
  })

  it('compounds inflation across years rather than raising one draw to a power', () => {
    // NOTE: inflation volatility must be non-zero for this test to discriminate.
    // With inflationStdDev: 0 every draw is identical, so raising a single draw
    // to the power `i` and compounding a running product give the SAME answer —
    // the bug is invisible. It only manifests when draws differ year to year.
    const marginal: UserProfile = {
      currentAge: 58,
      targetRetirementAge: 59,
      annualExpenses: 30000,
    }
    const opts = {
      numPaths: 200,
      seed: 42,
      equityStdDev: 0,
      bondStdDev: 0,
      inflationMean: 0.03,
      inflationStdDev: 0.02,
    }

    const result = runMonteCarlo(portfolio, marginal, opts)
    const spread = (year: number) =>
      result.percentiles[year - 1].p90 - result.percentiles[year - 1].p10

    // The bug's fingerprint is in YEAR 1. With `Math.pow(1 + draw, i)` the
    // exponent at i=0 is zero, so the multiplier is exactly 1.0 on every path
    // regardless of that path's inflation draw — year 1 collapses to a single
    // value with no dispersion at all. Correct compounding applies the first
    // draw immediately, so paths already differ in year 1.
    //
    // Withdrawals are live from year 1 here (currentAge 58, target 59), so this
    // difference is observable in the balance distribution.
    expect(spread(1)).toBeGreaterThan(0)

    // Dispersion must then widen as more independent draws accumulate.
    expect(spread(5)).toBeGreaterThan(spread(1))
  })
})
