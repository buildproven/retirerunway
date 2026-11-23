import { describe, it, expect } from 'vitest'
import { runMonteCarlo } from '../monte-carlo'
import type { Portfolio, UserProfile } from '../types'

const testPortfolio: Portfolio = {
  id: 'test-1',
  name: 'Test',
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
        {
          id: 'h-2',
          symbol: 'BND',
          name: 'Vanguard Total Bond',
          assetClass: 'us_bond',
          shares: 500,
          costBasis: 40000,
          currentPrice: 100,
          currentValue: 50000,
        },
      ],
      cds: [],
      cashBalance: 50000,
    },
  ],
}

const testProfile: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 62,
  annualExpenses: 80000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2500,
}

describe('runMonteCarlo', () => {
  it('returns correct structure with default config', () => {
    const result = runMonteCarlo(testPortfolio, testProfile)

    expect(result.paths).toBe(1000)
    expect(result.percentiles).toHaveLength(30)
    expect(result.successRate).toBeGreaterThanOrEqual(0)
    expect(result.successRate).toBeLessThanOrEqual(1)
    expect(result.medianRunwayYears).toBeGreaterThan(0)
  })

  it('percentile bands are ordered correctly (p10 <= p25 <= p50 <= p75 <= p90)', () => {
    const result = runMonteCarlo(testPortfolio, testProfile)

    for (const band of result.percentiles) {
      expect(band.p10).toBeLessThanOrEqual(band.p25)
      expect(band.p25).toBeLessThanOrEqual(band.p50)
      expect(band.p50).toBeLessThanOrEqual(band.p75)
      expect(band.p75).toBeLessThanOrEqual(band.p90)
    }
  })

  it('is deterministic with same seed', () => {
    const r1 = runMonteCarlo(testPortfolio, testProfile, { seed: 123 })
    const r2 = runMonteCarlo(testPortfolio, testProfile, { seed: 123 })

    expect(r1.successRate).toBe(r2.successRate)
    expect(r1.medianRunwayYears).toBe(r2.medianRunwayYears)
    expect(r1.percentiles[0].p50).toBe(r2.percentiles[0].p50)
  })

  it('different seeds produce different results', () => {
    const r1 = runMonteCarlo(testPortfolio, testProfile, { seed: 1 })
    const r2 = runMonteCarlo(testPortfolio, testProfile, { seed: 999 })

    const earlyP50a = r1.percentiles[2].p50
    const earlyP50b = r2.percentiles[2].p50
    expect(earlyP50a).not.toBe(earlyP50b)
  })

  it('accepts custom number of paths', () => {
    const result = runMonteCarlo(testPortfolio, testProfile, { numPaths: 100 })
    expect(result.paths).toBe(100)
  })

  it('accepts custom duration', () => {
    const result = runMonteCarlo(testPortfolio, testProfile, {
      durationYears: 10,
      numPaths: 100,
    })
    expect(result.percentiles).toHaveLength(10)
  })

  it('age starts at currentAge + 1', () => {
    const result = runMonteCarlo(testPortfolio, testProfile)
    expect(result.percentiles[0].age).toBe(testProfile.currentAge + 1)
  })

  it('success rate is reasonable for well-funded portfolio', () => {
    const wealthyPortfolio: Portfolio = {
      ...testPortfolio,
      accounts: [
        {
          ...testPortfolio.accounts[0],
          holdings: [
            {
              id: 'h-big',
              symbol: 'VTI',
              name: 'Vanguard Total Stock',
              assetClass: 'us_equity',
              shares: 1000,
              costBasis: 2000000,
              currentPrice: 2500,
              currentValue: 2500000,
            },
          ],
          cashBalance: 500000,
        },
      ],
    }
    const result = runMonteCarlo(wealthyPortfolio, testProfile)
    expect(result.successRate).toBeGreaterThan(0.3)
  })

  it('handles zero-value portfolio', () => {
    const emptyPortfolio: Portfolio = {
      id: 'test-empty',
      name: 'Empty',
      asOfDate: '2026-01-31',
      accounts: [],
    }
    const result = runMonteCarlo(emptyPortfolio, testProfile, { numPaths: 10 })
    expect(result.percentiles[0].p50).toBe(0)
    expect(result.successRate).toBe(0)
  })
})

describe('runMonteCarlo — regression tests for financial correctness', () => {
  // Zero-return, zero-volatility scaffold — isolates inflation/withdrawal math
  const zeroMarket = {
    seed: 42,
    numPaths: 1,
    equityMean: 0,
    equityStdDev: 0,
    bondMean: 0,
    bondStdDev: 0,
    inflationMean: 0,
    inflationStdDev: 0,
    durationYears: 30,
  } as const

  const singleCashPortfolio = (cash: number): Portfolio => ({
    id: 't',
    name: 't',
    asOfDate: '2026-01-31',
    accounts: [
      {
        id: 'a',
        name: 'a',
        institution: 't',
        accountType: 'brokerage',
        holdings: [],
        cds: [],
        cashBalance: cash,
      },
    ],
  })

  it('inflation compounds cumulatively (year-30 expense = base * (1+r)^30)', () => {
    // At 3% fixed inflation, year-k expense = $80k * 1.03^k (BOY convention:
    // inflation is compounded BEFORE withdrawal in year 1).
    // Total funding needed = sum(80k * 1.03^k for k=1..30) ≈ $3,920,214.
    // Linear funding ($80k * 30 = $2.4M) is massively insufficient under true
    // cumulative compounding but would have been adequate under the old
    // (1+draw)^year_index bug when stdev=0 (which produced flat $80k/yr).
    const profile: UserProfile = {
      currentAge: 61,
      targetRetirementAge: 62,
      annualExpenses: 80_000,
    }
    const y30 = 80_000 * Math.pow(1.03, 30)
    expect(y30).toBeGreaterThan(190_000)
    expect(y30).toBeLessThan(200_000)

    const linear = runMonteCarlo(singleCashPortfolio(2_400_000), profile, {
      ...zeroMarket,
      inflationMean: 0.03,
    })
    expect(linear.successRate).toBe(0)

    // $4.0M > $3.92M required; should survive under true cumulative compounding.
    const compounded = runMonteCarlo(singleCashPortfolio(4_000_000), profile, {
      ...zeroMarket,
      inflationMean: 0.03,
    })
    expect(compounded.successRate).toBe(1)
  })

  it('withdrawals begin AT targetRetirementAge, not the year after', () => {
    // $2.39M at $80k/yr zero-inflation:
    // - Post-fix (age >= target): withdraws 30 years = $2.4M; $2.39M fails.
    // - Pre-fix (age > target): withdraws 29 years = $2.32M; $2.39M succeeds.
    const profile: UserProfile = {
      currentAge: 61,
      targetRetirementAge: 62,
      annualExpenses: 80_000,
    }
    const result = runMonteCarlo(
      singleCashPortfolio(2_390_000),
      profile,
      zeroMarket
    )
    expect(result.successRate).toBe(0)
  })

  it('growth applies to post-withdrawal balance (BOY convention)', () => {
    // $100k equity portfolio, $90k withdrawal, 10% return, 0% inflation.
    // EOY (old): 100 * 1.10 - 90 = $20k
    // BOY (new): (100 - 90) * 1.10 = $11k
    const profile: UserProfile = {
      currentAge: 61,
      targetRetirementAge: 62,
      annualExpenses: 90_000,
    }
    const equityPortfolio: Portfolio = {
      id: 't',
      name: 't',
      asOfDate: '2026-01-31',
      accounts: [
        {
          id: 'a',
          name: 'a',
          institution: 't',
          accountType: 'brokerage',
          holdings: [
            {
              id: 'h',
              symbol: 'X',
              name: 'X',
              assetClass: 'us_equity',
              shares: 1,
              costBasis: 100_000,
              currentPrice: 100_000,
              currentValue: 100_000,
            },
          ],
          cds: [],
          cashBalance: 0,
        },
      ],
    }
    const result = runMonteCarlo(equityPortfolio, profile, {
      ...zeroMarket,
      equityMean: 0.1,
      durationYears: 1,
    })
    expect(result.percentiles[0].p50).toBe(11_000)
  })
})
