import { describe, it, expect } from 'vitest'
import { runHouseholdScenario, type HouseholdConfig } from '../household'
import type { Portfolio } from '../types'

// ---------------------------------------------------------------------------
// `survivorExpenseRatio` was declared on HouseholdConfig, defaulted in config,
// and NEVER READ — the survivor case silently did not exist despite appearing
// in the API. These tests pin the behaviour now that it drives real spending.
// ---------------------------------------------------------------------------

function portfolio(id: string, value: number): Portfolio {
  return {
    id,
    name: id,
    asOfDate: '2026-01-31',
    accounts: [
      {
        id: `${id}-acc`,
        name: 'Brokerage',
        institution: 'Test',
        accountType: 'brokerage',
        holdings: [
          {
            id: `${id}-h`,
            symbol: 'VTI',
            name: 'Total Stock',
            assetClass: 'us_equity',
            shares: 1,
            costBasis: value,
            currentPrice: value,
            currentValue: value,
          },
        ],
        cds: [],
        cashBalance: 0,
      },
    ],
  }
}

function config(overrides: Partial<HouseholdConfig> = {}): HouseholdConfig {
  return {
    primary: {
      name: 'A',
      currentAge: 60,
      targetRetirementAge: 62,
      annualExpenses: 60000,
      pensionMonthly: 1000,
    },
    spouse: {
      name: 'B',
      currentAge: 60,
      targetRetirementAge: 62,
      annualExpenses: 60000,
      pensionMonthly: 1000,
    },
    primaryPortfolio: portfolio('p', 1000000),
    spousePortfolio: portfolio('s', 1000000),
    jointExpenses: 100000,
    survivorExpenseRatio: 0.7,
    ...overrides,
  }
}

describe('household survivor event', () => {
  it('spends less after a spouse dies than if both survive', () => {
    const both = runHouseholdScenario(config(), 'base')
    const widowed = runHouseholdScenario(
      config({ survivorEvent: { who: 'spouse', atAge: 70 } }),
      'base'
    )

    // Year 11 → spouseAge 71, the first year after death.
    const bothY11 = both.projections.find(p => p.year === 11)!
    const widowedY11 = widowed.projections.find(p => p.year === 11)!

    expect(widowedY11.spouseAge).toBe(71)
    expect(widowedY11.withdrawal).toBeLessThan(bothY11.withdrawal)
  })

  it('is identical to the baseline before the death age', () => {
    const both = runHouseholdScenario(config(), 'base')
    const widowed = runHouseholdScenario(
      config({ survivorEvent: { who: 'spouse', atAge: 70 } }),
      'base'
    )

    // Year 10 → spouseAge 70, still alive.
    const bothY10 = both.projections.find(p => p.year === 10)!
    const widowedY10 = widowed.projections.find(p => p.year === 10)!

    expect(widowedY10.spouseAge).toBe(70)
    expect(widowedY10.withdrawal).toBe(bothY10.withdrawal)
    expect(widowedY10.income).toBe(bothY10.income)
  })

  it('stops the deceased spouse income streams', () => {
    const widowed = runHouseholdScenario(
      config({ survivorEvent: { who: 'spouse', atAge: 70 } }),
      'base'
    )
    const before = widowed.projections.find(p => p.year === 10)!
    const after = widowed.projections.find(p => p.year === 11)!

    // Both pensions ($1000/mo each) run before; only the survivor's after.
    expect(before.income).toBe(24000)
    expect(after.income).toBe(12000)
  })

  it('scales survivor spending by exactly survivorExpenseRatio', () => {
    const strict = runHouseholdScenario(
      config({
        survivorExpenseRatio: 0.5,
        survivorEvent: { who: 'spouse', atAge: 70 },
      }),
      'base'
    )
    const lenient = runHouseholdScenario(
      config({
        survivorExpenseRatio: 1.0,
        survivorEvent: { who: 'spouse', atAge: 70 },
      }),
      'base'
    )

    const strictY11 = strict.projections.find(p => p.year === 11)!
    const lenientY11 = lenient.projections.find(p => p.year === 11)!

    // Income is identical, so the withdrawal gap is purely the spending ratio.
    const strictSpend = strictY11.withdrawal + strictY11.income
    const lenientSpend = lenientY11.withdrawal + lenientY11.income
    expect(strictSpend).toBeCloseTo(lenientSpend * 0.5, 0)
  })

  it('supports the primary spouse dying', () => {
    const widowed = runHouseholdScenario(
      config({ survivorEvent: { who: 'primary', atAge: 70 } }),
      'base'
    )
    const after = widowed.projections.find(p => p.year === 11)!
    expect(after.primaryAge).toBe(71)
    expect(after.income).toBe(12000)
  })
})
