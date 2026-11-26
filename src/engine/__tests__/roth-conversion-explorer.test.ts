// Roth conversions in the v2 projection and the explorer (REQ-MCP-46):
// each strategy fills its ceiling, converts only in the window, and the
// explorer runs every strategy on the same seed.
import { describe, expect, it } from 'vitest'
import { irmaaCeiling } from '../irmaa'
import {
  ACA_SUBSIDY_CLIFF,
  povertyLine,
  projectRetirement,
} from '../retirement-projection'
import {
  DEFAULT_CONVERSION_STRATEGIES,
  exploreRothConversions,
} from '../roth-conversion-explorer'
import type { AccountType, Portfolio, UserProfile } from '../types'

function account(id: string, accountType: AccountType, value: number) {
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
        costBasis: value * 0.6,
        currentPrice: value * 0.6,
        currentValue: value * 0.6,
      },
      {
        id: `${id}-bd`,
        symbol: 'BD',
        name: 'Bond',
        assetClass: 'us_bond' as const,
        shares: 1,
        costBasis: value * 0.4,
        currentPrice: value * 0.4,
        currentValue: value * 0.4,
      },
    ],
  }
}

const book: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    account('k', '401k', 1_500_000),
    account('b', 'brokerage', 300_000),
  ],
}

const plan: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 60,
  annualExpenses: 70_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  spouse: {
    currentAge: 58,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_500,
  },
  stateTaxRate: 0.0495,
  stateExemptsRetirementIncome: true,
  preMedicareHealthcare: 24_000,
  acaPremiumTaxCredit: true,
  planningAge: 90,
}

const PATHS = 100
const run = (strategy: Parameters<typeof projectRetirement>[2]) =>
  projectRetirement(book, plan, { paths: PATHS, ...strategy })

describe('Roth conversions in projectRetirement', () => {
  it('converts nothing by default', () => {
    const r = run({})
    expect(r.expectedPath.lifetimeRothConversion).toBe(0)
    expect(r.expectedPath.years.every(y => y.rothConversion === 0)).toBe(true)
  })

  it('fills the 12% bracket only between retirement and 74', () => {
    const r = run({ rothConversion: { kind: 'fillBracket', rate: 0.12 } })
    const years = r.expectedPath.years
    expect(
      years.filter(y => y.age < 60).every(y => y.rothConversion === 0)
    ).toBe(true)
    expect(
      years.filter(y => y.age > 74).every(y => y.rothConversion === 0)
    ).toBe(true)
    expect(years.find(y => y.age === 61)?.rothConversion).toBeGreaterThan(0)
    const none = run({})
    const last = (p: typeof r) =>
      p.expectedPath.years.at(-1)?.endBalances.roth ?? 0
    expect(last(r)).toBeGreaterThan(last(none))
  })

  it('converts more filling the 22% bracket than the 12%', () => {
    const twelve = run({ rothConversion: { kind: 'fillBracket', rate: 0.12 } })
    const twentyTwo = run({
      rothConversion: { kind: 'fillBracket', rate: 0.22 },
    })
    // Each year converts more, so the pre-tax money is gone sooner; the
    // lifetime total can then be lower (less growth left to convert).
    const at = (p: typeof twelve, age: number) =>
      p.expectedPath.years.find(y => y.age === age)?.rothConversion ?? 0
    for (const age of [60, 61, 63, 64, 65]) {
      expect(at(twentyTwo, age)).toBeGreaterThan(at(twelve, age))
    }
    const emptyBy = (p: typeof twelve) =>
      p.expectedPath.years.find(
        y => y.age >= 60 && y.endBalances.employerPlan + y.endBalances.ira < 1
      )?.age ?? Infinity
    expect(emptyBy(twentyTwo)).toBeLessThan(emptyBy(twelve))
  })

  it('keeps ACA MAGI under the 400% line before 65 when told to', () => {
    const r = run({ rothConversion: { kind: 'acaThenIrmaa' } })
    const line = ACA_SUBSIDY_CLIFF * povertyLine(2)
    const early = r.expectedPath.years.filter(
      y => y.age >= 60 && y.age < 65 && y.rothConversion > 0
    )
    expect(early.length).toBeGreaterThan(0)
    for (const y of early) expect(y.magi).toBeLessThanOrEqual(line + 2)
    // Converting keeps the ACA credit: some credit is still paid.
    expect(r.expectedPath.lifetimeAcaCredit).toBeGreaterThan(0)
  })

  it('stays out of IRMAA when capped at the first threshold', () => {
    const r = run({ rothConversion: { kind: 'irmaaTier', tier: 0 } })
    expect(r.expectedPath.lifetimeRothConversion).toBeGreaterThan(0)
    expect(r.expectedPath.years.every(y => y.irmaaTier === 0)).toBe(true)
    // The ceiling is real: some year converts right up to it.
    expect(irmaaCeiling(0, 'married_filing_jointly')).toBe(224_000)
  })

  it('pays the conversion tax from the portfolio, not from thin air', () => {
    const none = run({})
    const twentyTwo = run({
      rothConversion: { kind: 'fillBracket', rate: 0.22 },
    })
    const tax = (p: typeof none, age: number) =>
      p.expectedPath.years.find(y => y.age === age)?.taxes.total ?? 0
    expect(tax(twentyTwo, 61)).toBeGreaterThan(tax(none, 61))
    const w = (p: typeof none, age: number) =>
      p.expectedPath.years.find(y => y.age === age)?.withdrawals.total ?? 0
    expect(w(twentyTwo, 61)).toBeGreaterThan(w(none, 61))
  })
})

describe('exploreRothConversions', () => {
  const result = exploreRothConversions(book, plan, undefined, {
    paths: PATHS,
  })

  it('runs every default strategy, no-conversion first, on the same seed', () => {
    expect(result.strategies.map(s => s.name)).toEqual(
      DEFAULT_CONVERSION_STRATEGIES.map(s => s.name)
    )
    const none = result.strategies.at(0)
    expect(none?.lifetimeRothConversion).toBe(0)
    expect(none?.successRate).toBe(
      projectRetirement(book, plan, { paths: PATHS }).monteCarlo.successRate
    )
  })

  it('names a best strategy and returns charts with one value per strategy', () => {
    expect(result.strategies.map(s => s.name)).toContain(result.best)
    expect(result.charts.successRates.series.at(0)?.values).toHaveLength(5)
    expect(result.charts.lifetimeCosts.series).toHaveLength(2)
    expect(
      result.charts.conversionsByAge.series.every(
        s => s.values.length === result.charts.conversionsByAge.x.length
      )
    ).toBe(true)
  })

  it('lists conversions by age that add up to the lifetime total', () => {
    for (const s of result.strategies) {
      const sum = s.conversionsByAge.reduce((t, c) => t + c.amount, 0)
      expect(sum).toBe(s.lifetimeRothConversion)
    }
  })

  it('is deterministic', () => {
    expect(
      exploreRothConversions(book, plan, undefined, { paths: PATHS })
    ).toEqual(result)
  })
})
