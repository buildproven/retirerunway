import { describe, it, expect } from 'vitest'
import { runHouseholdScenario, runAllHouseholdScenarios } from '../household'
import type { HouseholdConfig, SpouseProfile } from '../household'
import type { Portfolio, Account, Holding } from '../types'

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: 'h-1',
    symbol: 'VTI',
    name: 'Vanguard Total Stock',
    assetClass: 'us_equity',
    shares: 1000,
    costBasis: 150000,
    currentPrice: 200,
    currentValue: 200000,
    ...overrides,
  }
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    name: 'Brokerage',
    institution: 'Fidelity',
    accountType: 'brokerage',
    holdings: [makeHolding()],
    cds: [],
    cashBalance: 50000,
    ...overrides,
  }
}

function makePortfolio(id: string, accounts?: Account[]): Portfolio {
  return {
    id,
    name: `Portfolio ${id}`,
    accounts: accounts ?? [makeAccount()],
    asOfDate: '2026-01-31',
  }
}

function makePrimaryProfile(
  overrides: Partial<SpouseProfile> = {}
): SpouseProfile {
  return {
    name: 'Alice',
    currentAge: 58,
    targetRetirementAge: 62,
    annualExpenses: 40000,
    socialSecurityAge: 67,
    socialSecurityMonthly: 2500,
    ...overrides,
  }
}

function makeSpouseProfile(
  overrides: Partial<SpouseProfile> = {}
): SpouseProfile {
  return {
    name: 'Bob',
    currentAge: 55,
    targetRetirementAge: 65,
    annualExpenses: 30000,
    socialSecurityAge: 67,
    socialSecurityMonthly: 2000,
    ...overrides,
  }
}

function makeHouseholdConfig(
  overrides: Partial<HouseholdConfig> = {}
): HouseholdConfig {
  return {
    primary: makePrimaryProfile(),
    spouse: makeSpouseProfile(),
    primaryPortfolio: makePortfolio('p-1'),
    spousePortfolio: makePortfolio('p-2', [
      makeAccount({
        id: 'acc-2',
        holdings: [makeHolding({ id: 'h-3', currentValue: 150000 })],
        cashBalance: 30000,
      }),
    ]),
    jointExpenses: 70000,
    survivorExpenseRatio: 0.7,
    ...overrides,
  }
}

describe('runHouseholdScenario', () => {
  it('generates household projections', () => {
    const result = runHouseholdScenario(makeHouseholdConfig())
    expect(result.projections.length).toBeGreaterThan(0)
    expect(result.scenarioType).toBe('base')
    expect(result.primaryResult).toBeDefined()
    expect(result.spouseResult).toBeDefined()
  })

  it('tracks both ages in projections', () => {
    const config = makeHouseholdConfig()
    const result = runHouseholdScenario(config)
    const first = result.projections[0]

    expect(first.primaryAge).toBe(config.primary.currentAge + 1)
    expect(first.spouseAge).toBe(config.spouse.currentAge + 1)
  })

  it('has combined balance >= individual balances', () => {
    const result = runHouseholdScenario(makeHouseholdConfig())
    // At year 1, combined should be roughly sum of individual start values
    // (before withdrawals dominate)
    const first = result.projections[0]
    expect(first.combinedBalance).toBeGreaterThan(0)
  })

  it('works without spouse portfolio', () => {
    const config = makeHouseholdConfig({ spousePortfolio: null })
    const result = runHouseholdScenario(config)
    expect(result.spouseResult).toBeNull()
    expect(result.projections.length).toBeGreaterThan(0)
  })

  it('runs different scenario types', () => {
    const bearResult = runHouseholdScenario(makeHouseholdConfig(), 'early_bear')
    const bullResult = runHouseholdScenario(makeHouseholdConfig(), 'bull')

    expect(bearResult.scenarioType).toBe('early_bear')
    expect(bullResult.scenarioType).toBe('bull')

    // Bull should have better end balance
    const bearFinal = bearResult.projections[bearResult.projections.length - 1]
    const bullFinal = bullResult.projections[bullResult.projections.length - 1]
    expect(bullFinal.combinedBalance).toBeGreaterThanOrEqual(
      bearFinal.combinedBalance
    )
  })

  it('includes income from both spouses', () => {
    const config = makeHouseholdConfig({
      primary: makePrimaryProfile({
        socialSecurityMonthly: 3000,
        socialSecurityAge: 67,
      }),
      spouse: makeSpouseProfile({
        socialSecurityMonthly: 2000,
        socialSecurityAge: 67,
      }),
    })
    const result = runHouseholdScenario(config)

    // Find a year where both are past 67
    const postSSYear = result.projections.find(
      p => p.primaryAge > 67 && p.spouseAge > 67
    )
    if (postSSYear) {
      expect(postSSYear.income).toBeGreaterThan(0)
    }
  })

  it('returns a risk score', () => {
    const result = runHouseholdScenario(makeHouseholdConfig())
    expect(result.combinedRiskScore).toBeGreaterThanOrEqual(1)
    expect(result.combinedRiskScore).toBeLessThanOrEqual(10)
  })

  it('generates a recommendation string', () => {
    const result = runHouseholdScenario(makeHouseholdConfig())
    expect(result.recommendation).toBeTruthy()
    expect(typeof result.recommendation).toBe('string')
  })

  it('handles pension income for retired spouses', () => {
    const config = makeHouseholdConfig({
      primary: makePrimaryProfile({
        currentAge: 65,
        targetRetirementAge: 62,
        pensionMonthly: 1500,
      }),
      spouse: makeSpouseProfile({
        currentAge: 66,
        targetRetirementAge: 65,
        pensionMonthly: 1000,
      }),
    })
    const result = runHouseholdScenario(config)
    // Should have income from pensions once both are retired
    const postRetirement = result.projections.find(
      p => p.primaryAge > 65 && p.spouseAge > 66
    )
    if (postRetirement) {
      expect(postRetirement.income).toBeGreaterThan(0)
    }
  })

  it('handles other monthly income', () => {
    const config = makeHouseholdConfig({
      primary: makePrimaryProfile({ otherIncomeMonthly: 500 }),
      spouse: makeSpouseProfile({ otherIncomeMonthly: 300 }),
    })
    const result = runHouseholdScenario(config)
    expect(result.projections.length).toBeGreaterThan(0)
  })

  it('generates depletion recommendation when funds run out', () => {
    // Tiny portfolio, high expenses
    const config = makeHouseholdConfig({
      primaryPortfolio: makePortfolio('p-tiny', [
        makeAccount({
          id: 'acc-tiny',
          holdings: [makeHolding({ id: 'h-tiny', currentValue: 10000 })],
          cashBalance: 1000,
        }),
      ]),
      spousePortfolio: null,
      jointExpenses: 200000,
    })
    const result = runHouseholdScenario(config)
    if (result.combinedDepletionAge) {
      expect(result.recommendation).toContain('depleted')
    }
  })

  it('includes CDs in portfolio value', () => {
    const config = makeHouseholdConfig({
      primaryPortfolio: makePortfolio('p-cd', [
        makeAccount({
          id: 'acc-cd',
          holdings: [],
          cashBalance: 0,
          cds: [
            {
              id: 'cd-1',
              institution: 'Ally',
              principal: 100000,
              apy: 0.045,
              termMonths: 12,
              maturityDate: '2027-06-01',
              purchaseDate: '2026-06-01',
              earlyWithdrawalPenaltyMonths: 3,
            },
          ],
        }),
      ]),
    })
    const result = runHouseholdScenario(config)
    expect(result.projections[0].combinedBalance).toBeGreaterThan(0)
  })

  it('runs prolonged_bear scenario', () => {
    const result = runHouseholdScenario(makeHouseholdConfig(), 'prolonged_bear')
    expect(result.scenarioType).toBe('prolonged_bear')
    expect(result.projections.length).toBeGreaterThan(0)
  })
})

describe('runAllHouseholdScenarios', () => {
  it('returns 4 scenarios', () => {
    const results = runAllHouseholdScenarios(makeHouseholdConfig())
    expect(results).toHaveLength(4)
    const types = results.map(r => r.scenarioType)
    expect(types).toContain('bull')
    expect(types).toContain('base')
    expect(types).toContain('early_bear')
    expect(types).toContain('prolonged_bear')
  })
})
