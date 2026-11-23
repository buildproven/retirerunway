// Market assumptions (REQ-MCP-51) and the income gap (REQ-MCP-52).
import { describe, expect, it } from 'vitest'
import { backtestHistory } from '../historical-backtest'
import {
  MARKET_FORECAST,
  meansForYear,
  resolveMarketAssumptions,
} from '../market-assumptions'
import {
  projectRetirement,
  projectSequence,
  projectionWarnings,
} from '../retirement-projection'
import type { Portfolio, UserProfile } from '../types'

function portfolioOf(
  accountType: '401k' | 'roth_ira' | 'brokerage',
  value: number,
  assetClass: 'us_equity' | 'us_bond' = 'us_equity'
): Portfolio {
  return {
    id: 'p',
    name: 'Test',
    asOfDate: '2026-11-17',
    accounts: [
      {
        id: 'a',
        name: 'a',
        institution: 'Test',
        accountType,
        cds: [],
        cashBalance: 0,
        holdings: [
          {
            id: 'h',
            symbol: 'X',
            name: 'X',
            assetClass,
            shares: 1,
            costBasis: value,
            currentPrice: value,
            currentValue: value,
          },
        ],
      },
    ],
  }
}

describe('REQ-MCP-51 market assumptions', () => {
  it('resolves the forecast preset, overrides and the long-run reversion', () => {
    const forecast = resolveMarketAssumptions({ preset: 'forecast' })
    expect(forecast.nearTerm).toEqual({
      equity: 0.045,
      bond: 0.04,
      inflation: 0.03,
    })
    expect(forecast.years).toBe(10)
    expect(forecast.longRun).toEqual({
      equity: 0.07,
      bond: 0.04,
      inflation: 0.03,
    })
    const custom = resolveMarketAssumptions({
      preset: 'forecast',
      equityMean: 0.03,
      years: 5,
    })
    expect(custom.nearTerm.equity).toBe(0.03)
    expect(custom.years).toBe(5)
    expect(resolveMarketAssumptions(undefined).years).toBe(0)
    const profile: UserProfile = {
      currentAge: 60,
      targetRetirementAge: 60,
      annualExpenses: 0,
      marketAssumptions: { preset: 'forecast' },
    }
    expect(meansForYear(profile, 9).equity).toBe(MARKET_FORECAST.equityMean)
    expect(meansForYear(profile, 10).equity).toBe(0.07)
  })

  it('grows the expected path at the near-term means, then the long-run ones (hand check)', () => {
    const portfolio = portfolioOf('roth_ira', 100_000)
    const profile: UserProfile = {
      currentAge: 64,
      targetRetirementAge: 65,
      annualExpenses: 0,
      planningAge: 66,
      marketAssumptions: { equityMean: 0.02, inflationMean: 0.01, years: 1 },
    }
    // Year 1 at 2% with 1% inflation, year 2 at 7% with 3% inflation.
    expect(projectSequence(portfolio, profile, []).balanceAtPlanningAge).toBe(
      Math.round((100_000 * 1.02 * 1.07) / (1.01 * 1.03))
    )
  })

  it('lowers the success rate when the forecast is below the long-run means', () => {
    const portfolio = portfolioOf('401k', 1_200_000)
    const base: UserProfile = {
      currentAge: 59,
      targetRetirementAge: 60,
      annualExpenses: 70_000,
      planningAge: 95,
    }
    const longRun = projectRetirement(portfolio, base, { paths: 300 })
      .monteCarlo.successRate
    const forecast = projectRetirement(
      portfolio,
      { ...base, marketAssumptions: { preset: 'forecast' } },
      { paths: 300 }
    ).monteCarlo.successRate
    expect(forecast).toBeLessThan(longRun)
    // long_run preset is the same as no setting.
    expect(
      projectRetirement(
        portfolio,
        { ...base, marketAssumptions: { preset: 'long_run' } },
        { paths: 300 }
      ).monteCarlo.successRate
    ).toBe(longRun)
    expect(
      projectionWarnings(portfolio, {
        ...base,
        marketAssumptions: { preset: 'forecast' },
      }).join(' ')
    ).toContain(
      'stocks 4.5%, bonds 4.0% and inflation 3.0% a year for the first 10 years'
    )
  })

  it('applies to the pre-retirement years of the historical backtest', () => {
    const portfolio = portfolioOf('401k', 1_000_000)
    const base: UserProfile = {
      currentAge: 53,
      targetRetirementAge: 60,
      annualExpenses: 60_000,
    }
    const at1982 = (r: ReturnType<typeof backtestHistory>) =>
      r.results.find(x => x.startYear === 1982)?.balanceAtPlanningAge ?? 0
    const longRun = at1982(backtestHistory(portfolio, base))
    const forecast = at1982(
      backtestHistory(portfolio, {
        ...base,
        marketAssumptions: { preset: 'forecast' },
      })
    )
    expect(longRun).toBeGreaterThan(0)
    expect(forecast).toBeLessThan(longRun)
  })
})

describe('REQ-MCP-52 income gap', () => {
  const portfolio = portfolioOf('brokerage', 500_000, 'us_bond')
  const base: UserProfile = {
    currentAge: 55,
    targetRetirementAge: 60,
    annualExpenses: 60_000,
    annualContributions: 30_000,
    planningAge: 62,
  }
  const year = (profile: UserProfile, age: number) => {
    const y = projectRetirement(portfolio, profile, {
      paths: 5,
    }).expectedPath.years.find(r => r.age === age)
    if (y === undefined) throw new Error(`no ${age}`)
    return y
  }

  it('pays spending and health insurance from savings for the gap months, with no contributions', () => {
    const gapped: UserProfile = {
      ...base,
      incomeGap: {
        startAge: 56,
        months: 18,
        monthlySpending: 5_000,
        healthcareMonthly: 1_500,
      },
    }
    // Full gap year at 56: 12 × $6,500 of spending from savings.
    expect(year(gapped, 56).spending).toBe(78_000)
    // Six gap months at 57.
    expect(year(gapped, 57).spending).toBe(39_000)
    expect(year(gapped, 58).spending).toBe(0)
    expect(year(base, 56).spending).toBe(0)
    // The balance ends lower than with no gap.
    expect(year(gapped, 59).endBalances.total).toBeLessThan(
      year(base, 59).endBalances.total
    )
  })

  it('adds severance and the new job savings, and defaults spending from the profile', () => {
    const gapped: UserProfile = {
      ...base,
      preMedicareHealthcare: 24_000,
      incomeGap: {
        startAge: 56,
        months: 6,
        severance: 50_000,
        newAnnualContributions: 10_000,
      },
    }
    // Six months of annualExpenses / 12 plus preMedicareHealthcare / 12.
    expect(year(gapped, 56).spending).toBe(42_000)
    const more = year(
      {
        ...gapped,
        incomeGap: { ...gapped.incomeGap!, newAnnualContributions: 30_000 },
      },
      59
    )
    expect(year(gapped, 59).endBalances.total).toBeLessThan(
      more.endBalances.total
    )
  })

  it('opens the old 401(k) under the Rule of 55 only when the job ends at 55 or later', () => {
    const plan = portfolioOf('401k', 500_000, 'us_bond')
    const at = (startAge: number) =>
      projectRetirement(
        plan,
        { ...base, currentAge: 53, incomeGap: { startAge, months: 12 } },
        { paths: 5 }
      ).expectedPath.years.find(r => r.age === startAge)
    expect(at(56)?.taxes.penalty).toBe(0)
    expect(at(54)?.taxes.penalty ?? 0).toBeGreaterThan(0)
    expect(
      projectionWarnings(plan, {
        ...base,
        incomeGap: { startAge: 54, months: 12 },
      }).join(' ')
    ).toContain('10% penalty')
    expect(
      projectionWarnings(plan, {
        ...base,
        incomeGap: { startAge: 61, months: 12 },
      }).join(' ')
    ).toContain('incomeGap is ignored')
  })
})
