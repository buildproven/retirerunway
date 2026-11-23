// ACA premium tax credit (REQ-MCP-42) and scenario comparison (REQ-MCP-43)
// on the v2 projection: values, not shape.
import { describe, expect, it } from 'vitest'
import {
  ACA_SUBSIDY_CLIFF,
  applicablePercentage,
  povertyLine,
  premiumTaxCredit,
  projectRetirement,
} from '../retirement-projection'
import {
  BASELINE_NAME,
  applyScenario,
  compareScenarios,
} from '../scenario-comparison'
import type { AccountType, Portfolio, UserProfile } from '../types'

function account(
  id: string,
  accountType: AccountType,
  value: number,
  basis = value
) {
  return {
    id,
    name: id,
    institution: 'Test',
    accountType,
    cds: [],
    cashBalance: 0,
    holdings: [
      {
        id: `${id}-eq`,
        symbol: 'EQ',
        name: 'Equity',
        assetClass: 'us_equity' as const,
        shares: 1,
        costBasis: basis * 0.6,
        currentPrice: value * 0.6,
        currentValue: value * 0.6,
      },
      {
        id: `${id}-bd`,
        symbol: 'BD',
        name: 'Bond',
        assetClass: 'us_bond' as const,
        shares: 1,
        costBasis: basis * 0.4,
        currentPrice: value * 0.4,
        currentValue: value * 0.4,
      },
    ],
  }
}

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    account('k', '401k', 900_000),
    account('b', 'brokerage', 30_000, 20_000),
  ],
}

const base: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 90_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 4_000,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
  stateExemptsRetirementIncome: true,
  spouse: {
    currentAge: 52,
    socialSecurityAge: 67,
    socialSecurityMonthly: 2_000,
  },
  preMedicareHealthcare: 30_000,
  home: { estimatedValue: 900_000, low: 850_000, high: 950_000 },
}

const downsize: Partial<UserProfile> = {
  homeSale: {
    age: 60,
    salePrice: 900_000,
    sellingCostRate: 0.06,
    replacementHomeCost: 450_000,
  },
}

const yearAt = (result: ReturnType<typeof projectRetirement>, age: number) => {
  const year = result.expectedPath.years.find(y => y.age === age)
  if (year === undefined) throw new Error(`no year ${age}`)
  return year
}

describe('REQ-MCP-42: ACA premium tax credit', () => {
  it('REQ-MCP-42 uses the 2026 poverty line by household size', () => {
    expect(povertyLine(1)).toBe(15_960)
    expect(povertyLine(2)).toBe(21_640)
    expect(povertyLine(4)).toBe(33_000)
  })

  it('REQ-MCP-42 follows the 2027 applicable percentage table, with the 400% cliff', () => {
    expect(applicablePercentage(1)).toBeCloseTo(0.0215, 10)
    expect(applicablePercentage(1.5)).toBeCloseTo(0.043, 10)
    expect(applicablePercentage(1.75)).toBeCloseTo(0.0554, 10)
    expect(applicablePercentage(2.5)).toBeCloseTo(0.0866, 10)
    expect(applicablePercentage(3.5)).toBeCloseTo(0.1022, 10)
    expect(applicablePercentage(ACA_SUBSIDY_CLIFF)).toBeCloseTo(0.1022, 10)
    expect(applicablePercentage(4.01)).toBeUndefined()
  })

  it('REQ-MCP-42 figures the credit as benchmark less expected contribution, capped', () => {
    // 300% of the line for two: $64,920 MAGI at 10.22% = $6,634.82.
    expect(premiumTaxCredit(30_000, 64_920, 2)).toBeCloseTo(
      30_000 - 6_634.824,
      2
    )
    // Over the cliff: nothing.
    expect(premiumTaxCredit(30_000, 4 * 21_640 + 1, 2)).toBe(0)
    // Expected contribution above the premium: nothing, never negative.
    expect(premiumTaxCredit(5_000, 80_000, 2)).toBe(0)
    // Never more than the premium.
    expect(premiumTaxCredit(10_000, 0, 2)).toBe(10_000)
  })

  it('REQ-MCP-42 is off unless acaPremiumTaxCredit is set', () => {
    const result = projectRetirement(
      portfolio,
      { ...base, ...downsize },
      { paths: 1 }
    )
    expect(result.expectedPath.lifetimeAcaCredit).toBe(0)
    expect(yearAt(result, 61).acaCredit).toBe(0)
  })

  it('REQ-MCP-42 gives a credit when home-sale cash keeps MAGI under the cliff, and none over it', () => {
    const on = { ...base, acaPremiumTaxCredit: true }
    const keep = projectRetirement(portfolio, on, { paths: 1 })
    // Living on 401(k) withdrawals puts MAGI over 400% of the line.
    expect(yearAt(keep, 61).magi).toBeGreaterThan(4 * povertyLine(2))
    expect(yearAt(keep, 61).acaCredit).toBe(0)
    const sell = projectRetirement(
      portfolio,
      { ...on, ...downsize },
      { paths: 1 }
    )
    // Home-sale proceeds are basis, so spending them adds little MAGI.
    expect(yearAt(sell, 61).magi).toBeLessThan(4 * povertyLine(2))
    expect(yearAt(sell, 61).acaCredit).toBeGreaterThan(0)
    expect(yearAt(sell, 61).acaCredit).toBeLessThanOrEqual(
      yearAt(sell, 61).healthcare
    )
    // At 66 both are on Medicare: no premium, so no credit.
    expect(yearAt(sell, 66).acaCredit).toBe(0)
    expect(sell.expectedPath.lifetimeAcaCredit).toBeGreaterThan(0)
  })

  it('REQ-MCP-42 raises the success rate when the credit applies', () => {
    const without = projectRetirement(
      portfolio,
      { ...base, ...downsize },
      { paths: 300 }
    )
    const withCredit = projectRetirement(
      portfolio,
      { ...base, ...downsize, acaPremiumTaxCredit: true },
      { paths: 300 }
    )
    expect(withCredit.monteCarlo.successRate).toBeGreaterThanOrEqual(
      without.monteCarlo.successRate
    )
    expect(
      withCredit.expectedPath.years.at(-1)?.endBalances.total
    ).toBeGreaterThan(without.expectedPath.years.at(-1)?.endBalances.total ?? 0)
  })

  it('REQ-MCP-42 counts home-sale proceeds as basis, not taxable gain', () => {
    const sell = projectRetirement(
      portfolio,
      { ...base, ...downsize },
      { paths: 1 }
    )
    const keep = projectRetirement(portfolio, base, { paths: 1 })
    // Spending tax-free proceeds first lowers the tax at 61.
    expect(yearAt(sell, 61).taxes.federal).toBeLessThan(
      yearAt(keep, 61).taxes.federal
    )
  })

  it('REQ-MCP-42 stays deterministic with the credit on', () => {
    const profile = { ...base, ...downsize, acaPremiumTaxCredit: true }
    const a = projectRetirement(portfolio, profile, { seed: 3, paths: 100 })
    const b = projectRetirement(portfolio, profile, { seed: 3, paths: 100 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('REQ-MCP-43: scenario comparison', () => {
  it('REQ-MCP-43 applies changes over the baseline and drops removed fields', () => {
    const withSale = applyScenario(base, { name: 'Sell', changes: downsize })
    expect(withSale.homeSale?.replacementHomeCost).toBe(450_000)
    expect(withSale.currentAge).toBe(53)
    const removed = applyScenario(withSale, {
      name: 'Keep',
      changes: {},
      remove: ['homeSale', 'preMedicareHealthcare'],
    })
    expect(removed.homeSale).toBeUndefined()
    expect(removed.preMedicareHealthcare).toBeUndefined()
    expect(base.homeSale).toBeUndefined()
  })

  it('REQ-MCP-43 puts the current plan first, matches a direct run, and ranks scenarios', () => {
    const comparison = compareScenarios(
      portfolio,
      base,
      [
        { name: 'Spend more', changes: { annualExpenses: 120_000 } },
        { name: 'Downsize', changes: downsize },
      ],
      { seed: 42, paths: 300 }
    )
    expect(comparison.scenarios.map(s => s.name)).toEqual([
      BASELINE_NAME,
      'Spend more',
      'Downsize',
    ])
    const direct = projectRetirement(portfolio, base, { seed: 42, paths: 300 })
    expect(comparison.scenarios[0].successRate).toBe(
      direct.monteCarlo.successRate
    )
    const [current, spendMore, sell] = comparison.scenarios
    expect(spendMore.successRate).toBeLessThan(current.successRate)
    expect(sell.successRate).toBeGreaterThan(current.successRate)
  })

  it('REQ-MCP-43 builds charts with one value per scenario or per age', () => {
    const comparison = compareScenarios(
      portfolio,
      base,
      [{ name: 'Downsize', changes: downsize }],
      { seed: 42, paths: 50 }
    )
    const { successRates, medianBalanceByAge, poorMarketBalanceByAge } =
      comparison.charts
    expect(successRates.x).toEqual([BASELINE_NAME, 'Downsize'])
    expect(successRates.series[0].values).toEqual(
      comparison.scenarios.map(s => Math.round(s.successRate * 1000) / 10)
    )
    for (const chart of [medianBalanceByAge, poorMarketBalanceByAge]) {
      expect(chart.x).toHaveLength(95 - 53)
      expect(chart.series.map(s => s.name)).toEqual([BASELINE_NAME, 'Downsize'])
      for (const series of chart.series)
        expect(series.values).toHaveLength(chart.x.length)
    }
    // Median at least the poor-market line, age by age.
    medianBalanceByAge.series[0].values.forEach((value, i) => {
      expect(value).toBeGreaterThanOrEqual(
        poorMarketBalanceByAge.series[0].values[i]
      )
    })
  })

  it('REQ-MCP-43 runs every scenario to the baseline planning age and caps at four', () => {
    const comparison = compareScenarios(
      portfolio,
      { ...base, planningAge: 90 },
      [1, 2, 3, 4, 5].map(n => ({
        name: `S${n}`,
        changes: { planningAge: 99 },
      })),
      { seed: 42, paths: 20 }
    )
    expect(comparison.scenarios).toHaveLength(5)
    expect(comparison.planningAge).toBe(90)
    expect(comparison.charts.medianBalanceByAge.x.at(-1)).toBe(90)
  })
})
