// Market data drives the forecast returns (REQ-MCP-75), a held-to-maturity
// TIPS or CD ladder can lock in the bridge years (REQ-MCP-76), and the
// review can stand on the engine's proposed rules (REQ-MCP-77). Invented
// household only.
import { describe, expect, it } from 'vitest'
import { marketDataSchema, userProfileSchema } from '../../mcp/schemas'
import {
  MARKET_FORECAST,
  marketDataAgeDays,
  marketDataMeans,
  resolveMarketAssumptions,
} from '../market-assumptions'
import { checkPlan } from '../plan-check'
import { compareMarket, proposePlanPolicy } from '../plan-policy'
import { reviewPlan } from '../plan-review'
import { calculatePortfolioValue } from '../portfolio-math'
import { projectRetirement } from '../retirement-projection'
import {
  cdYieldFor,
  chooseInstrument,
  ladderCost,
  rungCost,
  safeLadderIncomeAt,
  withoutLadderCost,
} from '../safe-ladder'
import type {
  AccountType,
  Holding,
  MarketData,
  Portfolio,
  SafeLadder,
  UserProfile,
} from '../types'

function holding(
  id: string,
  assetClass: Holding['assetClass'],
  value: number
): Holding {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    assetClass,
    shares: value / 100,
    costBasis: value,
    currentPrice: 100,
    currentValue: value,
  }
}

function account(
  id: string,
  accountType: AccountType,
  holdings: Holding[],
  cashBalance = 0
) {
  return {
    id,
    name: id,
    institution: 'Broker',
    accountType,
    cashBalance,
    cds: [],
    holdings,
  }
}

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    account(
      'window',
      '401k',
      [
        holding('spy', 'us_equity', 700_000),
        holding('bnd', 'us_bond', 150_000),
      ],
      20_000
    ),
    account('joint', 'brokerage', [holding('vti', 'us_equity', 60_000)]),
    account('ira', 'traditional_ira', [holding('vxus', 'intl_equity', 40_000)]),
  ],
}

const marketData: MarketData = {
  asOfDate: '2026-11-24',
  treasury10y: 0.05,
  tipsReal10y: 0.029,
  cdYields: [
    { termYears: 2, rate: 0.05 },
    { termYears: 5, rate: 0.05 },
  ],
  stockForecasts: [
    { source: 'Firm A', asOf: '2026-06-30', mean: 0.045 },
    { source: 'Firm B', asOf: '2026-09-30', mean: 0.075 },
  ],
  sources: ['test'],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 90_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_500,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
  stateExemptsRetirementIncome: true,
  preMedicareHealthcare: 25_000,
  separationAge: 60,
  spouse: {
    currentAge: 52,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_800,
  },
  marketData,
}

const run = { seed: 42, paths: 200 }

describe('REQ-MCP-75: market data drives the forecast returns', () => {
  it('REQ-MCP-75 sets stocks to the forecasts average, bonds to the Treasury yield and inflation to the breakeven', () => {
    const means = marketDataMeans(marketData)
    expect(means.equity).toBeCloseTo(0.06, 10)
    expect(means.bond).toBeCloseTo(0.05, 10)
    expect(means.inflation).toBeCloseTo(0.021, 10)
    expect(means.source).toContain('2026-11-24')
  })

  it('REQ-MCP-75 uses market data only under the forecast preset, and falls back without it', () => {
    const forecast = resolveMarketAssumptions(
      { preset: 'forecast' },
      marketData
    )
    expect(forecast.nearTerm.equity).toBeCloseTo(0.06, 10)
    const longRun = resolveMarketAssumptions({ preset: 'long_run' }, marketData)
    expect(longRun.nearTerm.equity).toBe(longRun.longRun.equity)
    const committed = resolveMarketAssumptions({ preset: 'forecast' })
    expect(committed.nearTerm.equity).toBe(MARKET_FORECAST.equityMean)
    const partial = marketDataMeans({
      asOfDate: '2026-11-24',
      treasury10y: 0.05,
    })
    expect(partial.equity).toBe(MARKET_FORECAST.equityMean)
    expect(partial.inflation).toBe(MARKET_FORECAST.inflationMean)
  })

  it('REQ-MCP-75 counts the data age in whole days', () => {
    expect(marketDataAgeDays(marketData, '2026-12-29')).toBe(35)
    expect(marketDataAgeDays(marketData, '2026-11-24')).toBe(0)
  })

  it('REQ-MCP-75 compares safe yields with the stock forecasts', () => {
    const c = compareMarket(marketData)
    expect(c).not.toBeNull()
    expect(c?.breakevenInflation).toBeCloseTo(0.021, 6)
    expect(c?.stockRealForecast).toBeCloseTo(0.039, 6)
    expect(c?.equityPremiumOverTips).toBeCloseTo(0.01, 6)
    expect(c?.bestCd).toEqual({ termYears: 2, rate: 0.05 })
    const thin = compareMarket({
      ...marketData,
      stockForecasts: [{ source: 'Low', asOf: '2026-06-30', mean: 0.045 }],
    })
    expect(thin?.equityPremiumOverTips).toBeLessThan(0)
    expect(thin?.headline).toMatch(/unusually well paid/)
    expect(compareMarket(undefined)).toBeNull()
  })

  it('REQ-MCP-75 validates market data and keeps it on the profile', () => {
    expect(marketDataSchema.safeParse(marketData).success).toBe(true)
    expect(
      marketDataSchema.safeParse({ ...marketData, treasury10y: 5 }).success
    ).toBe(false)
    expect(userProfileSchema.safeParse(profile).success).toBe(true)
  })

  it('REQ-MCP-75 lowers the forecast success rate when the saved forecasts are lower', () => {
    const forecast = (data: MarketData) =>
      projectRetirement(
        portfolio,
        {
          ...profile,
          marketData: data,
          marketAssumptions: { preset: 'forecast' },
        },
        run
      ).monteCarlo.successRate
    const high = forecast(marketData)
    const low = forecast({
      ...marketData,
      stockForecasts: [{ source: 'Low', asOf: '2026-06-30', mean: 0.03 }],
    })
    expect(low).toBeLessThan(high)
  })
})

describe('REQ-MCP-76: a held-to-maturity safe ladder', () => {
  const tips: SafeLadder = {
    instrument: 'tips',
    accountType: '401k',
    rungs: [
      { age: 60, amount: 100_000, yield: 0.029 },
      { age: 61, amount: 100_000, yield: 0.029 },
    ],
  }

  it('REQ-MCP-76 prices each rung at its yield', () => {
    expect(rungCost(tips.rungs[0], 53)).toBeCloseTo(100_000 / 1.029 ** 7, 6)
    expect(ladderCost(tips, 53)).toBeCloseTo(
      100_000 / 1.029 ** 7 + 100_000 / 1.029 ** 8,
      6
    )
  })

  it('REQ-MCP-76 charges nothing for a rung the projection never pays', () => {
    // The projection pays from currentAge + 1. At 61 the age-60 rung has paid
    // out and the age-61 rung pays this year, so neither is charged.
    expect(rungCost(tips.rungs[0], 61)).toBe(0)
    expect(rungCost(tips.rungs[1], 61)).toBe(0)
    expect(rungCost({ age: 61.5, amount: 50_000, yield: 0.02 }, 61)).toBe(0)
    expect(rungCost(tips.rungs[1], 60)).toBeCloseTo(100_000 / 1.029, 6)
    const older = { ...profile, currentAge: 61, safeLadder: tips }
    const { portfolio: rest, cost } = withoutLadderCost(portfolio, older)
    expect(cost).toBe(0)
    expect(calculatePortfolioValue(rest)).toBe(
      calculatePortfolioValue(portfolio)
    )
    // At 60 only the age-61 rung is left to pay, so only it is charged.
    expect(ladderCost(tips, 60)).toBeCloseTo(100_000 / 1.029, 6)
  })

  it('REQ-MCP-76 pays TIPS rungs with inflation and CD rungs fixed, taxed by account', () => {
    const withTips = { ...profile, safeLadder: tips }
    expect(safeLadderIncomeAt(withTips, 60, 1.2)).toEqual({
      taxed: 120_000,
      untaxed: 0,
    })
    expect(safeLadderIncomeAt(withTips, 62, 1.2)).toEqual({
      taxed: 0,
      untaxed: 0,
    })
    const cd: UserProfile = {
      ...profile,
      safeLadder: { ...tips, instrument: 'cd', accountType: 'brokerage' },
    }
    expect(safeLadderIncomeAt(cd, 60, 1.2)).toEqual({
      taxed: 0,
      untaxed: 100_000,
    })
  })

  it('REQ-MCP-76 takes the cost from cash and bonds before stocks, and reports a shortfall', () => {
    const withTips = { ...profile, safeLadder: tips }
    const {
      portfolio: rest,
      cost,
      shortfall,
    } = withoutLadderCost(portfolio, withTips)
    expect(shortfall).toBe(0)
    expect(calculatePortfolioValue(rest)).toBeCloseTo(
      calculatePortfolioValue(portfolio) - cost,
      4
    )
    const window = rest.accounts.find(a => a.id === 'window')
    expect(window?.cashBalance).toBe(0)
    const stocks = window?.holdings.find(h => h.id === 'spy')
    expect(stocks?.currentValue).toBe(700_000)
    const big: SafeLadder = {
      ...tips,
      rungs: [{ age: 60, amount: 5_000_000, yield: 0.029 }],
    }
    expect(
      withoutLadderCost(portfolio, { ...profile, safeLadder: big }).shortfall
    ).toBeGreaterThan(0)
  })

  it('REQ-MCP-76 cuts the bridge-year withdrawals by about the rung it pays', () => {
    const without = projectRetirement(portfolio, profile, run).expectedPath
      .years
    const withLadder = projectRetirement(
      portfolio,
      { ...profile, safeLadder: tips },
      run
    ).expectedPath.years
    const at = (years: typeof without, age: number) =>
      years.find(y => y.age === age)?.withdrawals.total ?? 0
    expect(at(without, 60) - at(withLadder, 60)).toBeGreaterThan(80_000)
    expect(at(withLadder, 62)).toBeGreaterThan(at(withLadder, 61))
  })

  it('REQ-MCP-76 picks TIPS unless a CD beats them after breakeven inflation, and matches CD terms closely', () => {
    expect(cdYieldFor(marketData, 5)).toBe(0.05)
    expect(cdYieldFor(marketData, 6)).toBe(0.05)
    expect(cdYieldFor(marketData, 8)).toBeUndefined()
    expect(chooseInstrument(marketData, 8)?.instrument).toBe('tips')
    expect(chooseInstrument(marketData, 5)?.instrument).toBe('tips')
    const richCd = {
      ...marketData,
      cdYields: [{ termYears: 5, rate: 0.06 }],
    }
    expect(chooseInstrument(richCd, 5)?.instrument).toBe('cd')
    expect(chooseInstrument({ asOfDate: '2026-11-24' }, 5)).toBeUndefined()
  })

  it('REQ-MCP-76 still weighs a saved TIPS yield when no 10-year Treasury yield is saved', () => {
    // 2.5% real TIPS against a 3.5% CD less the 3% default breakeven (0.5% real).
    const noTreasury: MarketData = {
      asOfDate: '2026-11-24',
      tipsReal10y: 0.025,
      cdYields: [{ termYears: 5, rate: 0.035 }],
    }
    const choice = chooseInstrument(noTreasury, 5)
    expect(choice?.instrument).toBe('tips')
    expect(choice?.realYield).toBe(0.025)
    // A CD paying well above 3% + 2.5% still wins at the default breakeven.
    const richCd = { ...noTreasury, cdYields: [{ termYears: 5, rate: 0.07 }] }
    expect(chooseInstrument(richCd, 5)?.instrument).toBe('cd')
    expect(chooseInstrument(richCd, 5)?.realYield).toBeCloseTo(0.04, 10)
    // TIPS alone, with no CD quote and no Treasury yield, is still a choice.
    const tipsOnly: MarketData = { asOfDate: '2026-11-24', tipsReal10y: 0.02 }
    expect(chooseInstrument(tipsOnly, 5)?.instrument).toBe('tips')
  })

  it('REQ-MCP-76 tests 3-year, 5-year and full-bridge ladders when market data is saved', () => {
    const proposal = proposePlanPolicy(portfolio, profile, '2026-11-24', run)
    expect(proposal.market?.asOfDate).toBe('2026-11-24')
    const rows = proposal.safeLadderTest.rows
    expect(rows.map(r => r.lastAge - r.firstAge + 1)).toEqual([3, 5, 7])
    for (const row of rows) {
      expect(row.firstAge).toBe(60)
      expect(row.cost).toBeGreaterThan(0)
      expect(row.equityShareOverall).toBeLessThanOrEqual(row.equityShareOfRest)
      expect(row.worse).toBe(Math.min(row.successRate, row.forecastSuccessRate))
    }
    expect(rows[2].cost).toBeGreaterThan(rows[0].cost)
    const winner = proposal.safeLadderTest.proposed
    expect(winner).not.toBeNull()
    expect(proposal.findings.some(f => f.rule === 'safeLadder')).toBe(true)
    expect(proposal.proposedRules.cdLadder?.firstYear).toBe(2033)
    // The glide test would ignore the ladder, so it is skipped.
    expect(proposal.glideTest.rows).toEqual([])
    expect(proposal.glideTest.proposed).toBeNull()
    expect(proposal.glideTest.basis).toMatch(/^not tested/)
    // Ages 64-66 are 2037-2039, the TIPS gap years: flagged as such and
    // given dated auction tasks (REQ-MCP-87), not as secondary-market buys.
    expect(
      proposal.notes.some(n =>
        /^no TIPS mature in 2037, 2038, 2039 yet \(ladder ages 64, 65, 66\)/.test(
          n
        )
      )
    ).toBe(true)
    expect(proposal.notes.some(n => /more than 10 years out/.test(n))).toBe(
      false
    )
  })

  it('REQ-MCP-76 keeps a saved ladder that matches the proposal', () => {
    const first = proposePlanPolicy(portfolio, profile, '2026-11-24', run)
    const saved = first.safeLadderTest.proposed as SafeLadder
    const again = proposePlanPolicy(
      portfolio,
      { ...profile, safeLadder: saved },
      '2026-11-24',
      run
    )
    expect(again.findings.find(f => f.rule === 'safeLadder')?.status).toBe(
      'keep'
    )
  })

  it('REQ-MCP-76 says to save market data when none is saved', () => {
    const bare = { ...profile, marketData: undefined }
    const proposal = proposePlanPolicy(portfolio, bare, '2026-11-24', run)
    expect(proposal.market).toBeNull()
    expect(proposal.safeLadderTest.rows).toEqual([])
    expect(proposal.safeLadderTest.basis).toMatch(/save_market_data/)
  })
})

describe('REQ-MCP-77: the review stands on the proposed rules when they are working settings', () => {
  it('REQ-MCP-77 approve mode asks the owner; auto mode applies the rules and asks nothing about them', () => {
    const approve = reviewPlan(portfolio, profile, '2026-11-24', run)
    expect(approve.rules.mode).toBe('approve')
    const auto = reviewPlan(
      portfolio,
      { ...profile, goals: { autoApplyRules: true } },
      '2026-11-24',
      run
    )
    expect(auto.rules.mode).toBe('auto')
    expect(
      auto.ownerDecisions.some(d => d.startsWith('Approve or decline'))
    ).toBe(false)
    expect(auto.rules.proposedRules.targetEquityShare).toBeGreaterThan(0)
    expect(auto.market.comparison?.asOfDate).toBe('2026-11-24')
    if (auto.rules.findings.length > 0)
      expect(auto.dataToRefresh[0]).toMatch(/working setting/)
    if (approve.rules.changes > 0)
      expect(
        approve.ownerDecisions.some(d => d.startsWith('Approve or decline'))
      ).toBe(true)
  })

  it('REQ-MCP-77 flags missing market data in the review', () => {
    const bare = reviewPlan(
      portfolio,
      { ...profile, marketData: undefined },
      '2026-11-24',
      run
    )
    expect(bare.dataToRefresh.some(d => d.startsWith('No market data'))).toBe(
      true
    )
    const stale = reviewPlan(portfolio, profile, '2027-02-01', run)
    expect(
      stale.dataToRefresh.some(d => /Market data is \d+ days old/.test(d))
    ).toBe(true)
  })
})

describe('REQ-MCP-76: plan_check buys follow the saved safe ladder', () => {
  it('REQ-MCP-76 sizes each rung at its cost today and labels it TIPS', () => {
    const ladder: SafeLadder = {
      instrument: 'tips',
      accountType: '401k',
      rungs: [
        { age: 60, amount: 100_000, yield: 0.029 },
        { age: 61, amount: 150_000, yield: 0.029 },
      ],
    }
    const cashy: Portfolio = {
      ...portfolio,
      accounts: [
        account(
          'window',
          '401k',
          [holding('spy', 'us_equity', 300_000)],
          400_000
        ),
      ],
    }
    const total = Math.floor(ladderCost(ladder, 53))
    const check = checkPlan(
      cashy,
      { ...profile, safeLadder: ladder },
      {
        targetEquityShare: 0.4,
        cdLadder: {
          accountType: '401k',
          firstYear: 2033,
          lastYear: 2034,
          total,
        },
      },
      '2026-11-24'
    )
    expect(check.cdLadder?.rungs.map(r => Math.round(r.target))).toEqual([
      Math.round(rungCost(ladder.rungs[0], 53)),
      Math.round(rungCost(ladder.rungs[1], 53)),
    ])
    const rec = check.recommendations.find(r => r.kind === 'cd_ladder')
    expect(rec?.action).toMatch(/TIPS maturing 2033, 2\.90% real/)
    expect(rec?.trades.every(t => t.symbol.startsWith('TIPS'))).toBe(true)
    expect(check.cdLadder?.rungs.some(r => r.note !== undefined)).toBe(false)
  })
})
