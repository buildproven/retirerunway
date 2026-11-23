// Historical backtest (REQ-MCP-50) and the Social Security claiming sweep
// (REQ-MCP-49).
import { describe, expect, it } from 'vitest'
import { ClaimingError, exploreClaimingAges } from '../claiming-explorer'
import { CPI_1927, MARKET_HISTORY } from '../data/market-history'
import { backtestHistory } from '../historical-backtest'
import { projectSequence } from '../retirement-projection'
import type { AccountType, AssetClass, Portfolio, UserProfile } from '../types'

function portfolioOf(
  accountType: AccountType,
  assetClass: AssetClass,
  value: number
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
            symbol: assetClass === 'us_equity' ? 'VOO' : 'BND',
            name: 'h',
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

const year = (y: number) => {
  const row = MARKET_HISTORY.find(r => r[0] === y)
  if (row === undefined) throw new Error(`no ${y}`)
  return row
}

describe('REQ-MCP-50 market history data', () => {
  it('covers 1928 to 2025 with the published values', () => {
    expect(MARKET_HISTORY).toHaveLength(98)
    expect(MARKET_HISTORY[0][0]).toBe(1928)
    expect(MARKET_HISTORY[97][0]).toBe(2025)
    expect(year(2008).slice(1, 3)).toEqual([-36.55, 20.1])
    expect(year(1931)[1]).toBe(-43.84)
    expect(year(2022).slice(1, 3)).toEqual([-18.04, -17.83])
    expect(year(1928)[3] / CPI_1927 - 1).toBeCloseTo(-0.0115, 4)
    expect(year(1980)[3] / year(1979)[3] - 1).toBeCloseTo(0.135, 3)
  })
})

describe('REQ-MCP-50 historical backtest', () => {
  it('replays the exact market years from retirement (hand check: all stocks, Roth, no spending)', () => {
    const portfolio = portfolioOf('roth_ira', 'us_equity', 100_000)
    const profile: UserProfile = {
      currentAge: 64,
      targetRetirementAge: 65,
      annualExpenses: 0,
      planningAge: 66,
    }
    const result = backtestHistory(portfolio, profile)
    const start2008 = result.results.find(r => r.startYear === 2008)
    const real = (y: number) =>
      (1 + year(y)[1] / 100) / (year(y)[3] / year(y - 1)[3])
    expect(start2008?.balanceAtPlanningAge).toBe(
      Math.round(100_000 * real(2008) * real(2009))
    )
    // 2025 runs past the data: the second year wraps to 1928.
    const start2025 = result.results.find(r => r.startYear === 2025)
    expect(start2025?.wrapped).toBe(true)
    expect(start2008?.wrapped).toBe(false)
    expect(result.startYears).toBe(98)
  })

  it('projectSequence uses the expected returns where no market year is given', () => {
    const portfolio = portfolioOf('roth_ira', 'us_equity', 100_000)
    const profile: UserProfile = {
      currentAge: 64,
      targetRetirementAge: 65,
      annualExpenses: 0,
      planningAge: 65,
    }
    expect(projectSequence(portfolio, profile, []).balanceAtPlanningAge).toBe(
      Math.round((100_000 * 1.07) / 1.03)
    )
  })

  it('fails the hard start years first and names them', () => {
    const portfolio = portfolioOf('401k', 'us_equity', 1_000_000)
    const profile: UserProfile = {
      currentAge: 59,
      targetRetirementAge: 60,
      annualExpenses: 60_000,
      planningAge: 95,
    }
    const result = backtestHistory(portfolio, profile)
    expect(result.retirementYears).toBe(36)
    expect(result.named.map(r => r.startYear)).toEqual([
      1929, 1937, 1966, 1973, 2000, 2008,
    ])
    const at = (y: number) => result.results.find(r => r.startYear === y)
    // A 1982 retirement (the long bull market) ends far richer than 1966 (stagflation).
    expect(
      (at(1982)?.balanceAtPlanningAge ?? 0) >
        (at(1966)?.balanceAtPlanningAge ?? 0)
    ).toBe(true)
    expect(at(1966)?.wrapped).toBe(false)
    expect(at(2000)?.wrapped).toBe(true)
    expect(result.unwrappedStartYears).toBe(63)
    // Worst start years are ordered by depletion age, then end balance.
    const worst = result.worst
    expect(worst).toHaveLength(5)
    for (let i = 1; i < worst.length; i++) {
      const prev = worst[i - 1].depletionAge ?? Infinity
      const next = worst[i].depletionAge ?? Infinity
      expect(prev <= next).toBe(true)
    }
    expect(result.successRate).toBeGreaterThan(0)
    expect(result.successRate).toBeLessThanOrEqual(1)
    expect(backtestHistory(portfolio, profile)).toEqual(result)
  })
})

describe('REQ-MCP-49 claiming sweep', () => {
  const portfolio = portfolioOf('401k', 'us_bond', 900_000)
  const profile: UserProfile = {
    currentAge: 60,
    targetRetirementAge: 60,
    annualExpenses: 85_000,
    socialSecurityAge: 67,
    socialSecurityMonthly: 50_000 / 12,
    spouse: {
      currentAge: 59,
      socialSecurityAge: 67,
      socialSecurityMonthly: 25_000 / 12,
    },
    planningAge: 95,
  }

  it('sweeps the default grid, moves benefits by the SSA factors and marks the current pair', () => {
    const result = exploreClaimingAges(portfolio, profile, { paths: 100 })
    expect(result.rows).toHaveLength(25)
    const current = result.current
    expect(current?.selfAge).toBe(67)
    expect(current?.spouseAge).toBe(67)
    const at70 = result.rows.find(r => r.selfAge === 70 && r.spouseAge === 67)
    expect(at70?.selfMonthly).toBe(Math.round((50_000 / 12) * 1.24))
    const at62 = result.rows.find(r => r.selfAge === 62 && r.spouseAge === 62)
    expect(at62?.spouseMonthly).toBe(Math.round((25_000 / 12) * 0.7))
    // Best is at least as good as every row on success rate.
    expect(
      result.rows.every(r => r.successRate <= result.best.successRate)
    ).toBe(true)
    expect(result.bestVsCurrent?.successRate).toBeGreaterThanOrEqual(0)
    expect(result.charts.successBySelfAge.series).toHaveLength(5)
  })

  it('under a survivor scenario, a later claim by the higher earner leaves the survivor more', () => {
    const result = exploreClaimingAges(portfolio, profile, {
      paths: 100,
      selfAges: [62, 70],
      spouseAges: [67],
      survivor: { deceased: 'self', deathAge: 75 },
    })
    const early = result.rows.find(r => r.selfAge === 62)
    const late = result.rows.find(r => r.selfAge === 70)
    expect(early?.survivorSuccessRate).not.toBeNull()
    expect(
      (late?.survivorSuccessRate ?? 0) >= (early?.survivorSuccessRate ?? 1)
    ).toBe(true)
    // Lifetime Social Security to 95 with the owner gone at 75 still counts the survivor benefit.
    expect(late?.lifetimeSocialSecurity ?? 0).toBeGreaterThan(0)
  })

  it('rejects bad ages and oversized grids', () => {
    expect(() =>
      exploreClaimingAges(portfolio, profile, { selfAges: [61] })
    ).toThrow(ClaimingError)
    expect(() =>
      exploreClaimingAges(portfolio, profile, {
        selfAges: [62, 63, 64, 65, 66, 67, 68],
        spouseAges: [62, 63, 64, 65, 66, 67, 68],
      })
    ).toThrow('at most 45')
    expect(() =>
      exploreClaimingAges(portfolio, {
        currentAge: 60,
        targetRetirementAge: 60,
        annualExpenses: 1,
      })
    ).toThrow('needs your benefit')
  })
})
