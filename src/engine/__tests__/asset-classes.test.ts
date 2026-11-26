// Asset classes beyond stocks and bonds (REQ-MCP-78): gold and other
// alternatives are their own sleeve, REITs count as stocks, asset-class
// forecasts set the sleeve means from the classes held and are compared
// with TIPS. Invented household only.
import { describe, expect, it } from 'vitest'
import { marketDataSchema } from '../../mcp/schemas'
import {
  ALT_DEFAULTS,
  compareAssets,
  sleeveForecast,
  sleeveOf,
  sleeveShares,
  withAltShare,
} from '../asset-classes'
import { proposePlanPolicy } from '../plan-policy'
import {
  calculateEquityFraction,
  calculatePortfolioValue,
} from '../portfolio-math'
import { projectRetirement } from '../retirement-projection'
import type { Holding, MarketData, Portfolio, UserProfile } from '../types'

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

function portfolioOf(holdings: Holding[], cash = 0): Portfolio {
  return {
    id: 'p',
    name: 'Test',
    asOfDate: '2026-11-17',
    accounts: [
      {
        id: 'window',
        name: 'window',
        institution: 'Broker',
        accountType: '401k',
        cashBalance: cash,
        cds: [],
        holdings,
      },
    ],
  }
}

const withGold = portfolioOf([
  holding('voo', 'us_equity', 600_000),
  holding('vxus', 'intl_equity', 100_000),
  holding('gld', 'commodity', 60_000),
  holding('bnd', 'us_bond', 240_000),
])

const marketData: MarketData = {
  asOfDate: '2026-11-24',
  treasury10y: 0.05,
  tipsReal10y: 0.029,
  stockForecasts: [{ source: 'Firm A', asOf: '2026-09-30', mean: 0.06 }],
  assetForecasts: [
    {
      name: 'US large cap',
      assetClass: 'us_equity',
      mean: 0.06,
      source: 'Firm A',
      asOf: '2026-09-30',
    },
    {
      name: 'Non-US developed',
      assetClass: 'intl_equity',
      mean: 0.07,
      source: 'Firm A',
      asOf: '2026-09-30',
    },
    {
      name: 'Gold',
      assetClass: 'commodity',
      mean: 0.055,
      source: 'Firm A',
      asOf: '2026-09-30',
    },
    {
      name: 'Gold',
      assetClass: 'commodity',
      mean: 0.035,
      source: 'Firm B',
      asOf: '2026-06-30',
    },
    {
      name: 'Broad commodities',
      assetClass: 'commodity',
      mean: 0.048,
      source: 'Firm A',
      asOf: '2026-09-30',
    },
    {
      name: 'US REITs',
      assetClass: 'reit',
      mean: 0.082,
      source: 'Firm A',
      asOf: '2026-09-30',
    },
  ],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_500,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
  stateExemptsRetirementIncome: true,
  preMedicareHealthcare: 25_000,
  separationAge: 60,
  marketData,
}

const run = { seed: 42, paths: 200 }

describe('REQ-MCP-78: three sleeves', () => {
  it('REQ-MCP-78 puts REITs with stocks and gold, commodities and crypto in alternatives', () => {
    expect(sleeveOf('reit')).toBe('equity')
    expect(sleeveOf('commodity')).toBe('alt')
    expect(sleeveOf('crypto')).toBe('alt')
    expect(sleeveOf('tips')).toBe('safe')
    expect(sleeveOf('cash')).toBe('safe')
    const p = portfolioOf([
      holding('vnq', 'reit', 100_000),
      holding('bnd', 'us_bond', 100_000),
    ])
    expect(calculateEquityFraction(p, calculatePortfolioValue(p))).toBe(0.5)
    expect(sleeveShares(withGold)).toEqual({ equity: 0.7, alt: 0.06 })
  })

  it('REQ-MCP-78 models gold with its own return, not as a bond', () => {
    const asBonds = portfolioOf([
      holding('voo', 'us_equity', 600_000),
      holding('vxus', 'intl_equity', 100_000),
      holding('bnd', 'us_bond', 300_000),
    ])
    const gold = projectRetirement(withGold, profile, run).monteCarlo
      .successRate
    const bonds = projectRetirement(asBonds, profile, run).monteCarlo
      .successRate
    expect(gold).not.toBe(bonds)
    // Same inputs and seed, same result.
    expect(
      projectRetirement(withGold, profile, run).monteCarlo.successRate
    ).toBe(gold)
  })

  it('REQ-MCP-78 sets the near-term stock and gold means from the classes held', () => {
    expect(sleeveForecast(withGold, marketData, 'equity', 0.05)).toBeCloseTo(
      (600_000 * 0.06 + 100_000 * 0.07) / 700_000,
      10
    )
    // Two gold forecasts and one broad commodities forecast all apply to 'commodity'.
    expect(
      sleeveForecast(withGold, marketData, 'alt', ALT_DEFAULTS.mean)
    ).toBeCloseTo((0.055 + 0.035 + 0.048) / 3, 10)
    const forecast = (data: MarketData) =>
      projectRetirement(
        withGold,
        {
          ...profile,
          marketData: data,
          marketAssumptions: { preset: 'forecast' },
        },
        run
      ).expectedPath.years[0].endBalances.total
    const lowGold: MarketData = {
      ...marketData,
      assetForecasts: (marketData.assetForecasts ?? []).map(f =>
        f.assetClass === 'commodity' ? { ...f, mean: 0 } : f
      ),
    }
    expect(forecast(lowGold)).toBeLessThan(forecast(marketData))
  })
})

describe('REQ-MCP-78: each asset class against TIPS', () => {
  it('REQ-MCP-78 ranks classes by premium over TIPS per unit of risk', () => {
    const rows = compareAssets(marketData)
    const gold = rows.find(r => r.name === 'Gold')
    expect(gold?.forecast).toBeCloseTo(0.045, 6)
    expect(gold?.realForecast).toBeCloseTo(0.024, 6)
    expect(gold?.premiumOverTips).toBeCloseTo(-0.005, 6)
    expect(gold?.verdict).toBe('below TIPS')
    expect(gold?.sources).toHaveLength(2)
    const reit = rows.find(r => r.name === 'US REITs')
    expect(reit?.premiumOverTips).toBeCloseTo(0.032, 6)
    expect(reit?.verdict).toBe('fair')
    for (let i = 1; i < rows.length; i++)
      expect(rows[i - 1].rewardPerRisk).toBeGreaterThanOrEqual(
        rows[i].rewardPerRisk
      )
    expect(compareAssets({ asOfDate: '2026-11-24' })).toEqual([])
  })

  it('REQ-MCP-78 validates asset forecasts', () => {
    expect(marketDataSchema.safeParse(marketData).success).toBe(true)
    expect(
      marketDataSchema.safeParse({
        ...marketData,
        assetForecasts: [
          {
            name: 'Gold',
            assetClass: 'gold',
            mean: 0.05,
            source: 'x',
            asOf: '2026-01-01',
          },
        ],
      }).success
    ).toBe(false)
  })
})

describe('REQ-MCP-78: testing an alternatives share', () => {
  it('REQ-MCP-78 rescales the alternatives sleeve against cash and bonds, stocks untouched', () => {
    const total = calculatePortfolioValue(withGold)
    for (const share of [0, 0.03, 0.1]) {
      const test = withAltShare(withGold, share)
      expect(calculatePortfolioValue(test)).toBeCloseTo(total, 4)
      expect(sleeveShares(test).alt).toBeCloseTo(share, 6)
      expect(sleeveShares(test).equity).toBeCloseTo(0.7, 6)
    }
    const none = portfolioOf([holding('voo', 'us_equity', 100_000)])
    expect(withAltShare(none, 0.05)).toBe(none)
  })

  it('REQ-MCP-78 tests none, today, 5% and 10% and says why', () => {
    const proposal = proposePlanPolicy(withGold, profile, '2026-11-24', run)
    expect(proposal.altTest.currentShare).toBe(0.06)
    expect(proposal.altTest.rows.map(r => r.share)).toEqual([
      0, 0.05, 0.06, 0.1,
    ])
    for (const row of proposal.altTest.rows)
      expect(row.worse).toBe(Math.min(row.successRate, row.forecastSuccessRate))
    expect(proposal.altTest.basis.length).toBeGreaterThan(0)
    if (proposal.altTest.proposed !== null)
      expect(proposal.findings.some(f => f.rule === 'altShare')).toBe(true)
    expect(proposal.market?.assets.length).toBeGreaterThan(0)
    const noAlt = proposePlanPolicy(
      portfolioOf([
        holding('voo', 'us_equity', 700_000),
        holding('bnd', 'us_bond', 300_000),
      ]),
      profile,
      '2026-11-24',
      run
    )
    expect(noAlt.altTest.rows).toEqual([])
    expect(noAlt.altTest.basis).toMatch(/^no gold/)
  })
})
