import { describe, it, expect } from 'vitest'
import type { Portfolio, UserProfile, Account, Holding } from '../types'
import {
  runScenario,
  runAllScenarios,
  runCustomScenario,
  getDefaultScenarioParameters,
} from '../scenarios'

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

function makeBondHolding(): Holding {
  return makeHolding({
    id: 'h-2',
    symbol: 'BND',
    name: 'Vanguard Total Bond',
    assetClass: 'us_bond',
    shares: 500,
    costBasis: 50000,
    currentPrice: 100,
    currentValue: 50000,
  })
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    name: 'Brokerage',
    institution: 'Fidelity',
    accountType: 'brokerage',
    holdings: [makeHolding(), makeBondHolding()],
    cds: [],
    cashBalance: 50000,
    ...overrides,
  }
}

function makePortfolio(accounts?: Account[]): Portfolio {
  return {
    id: 'p-1',
    name: 'Test Portfolio',
    accounts: accounts ?? [makeAccount()],
    asOfDate: '2026-01-31',
  }
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    currentAge: 58,
    targetRetirementAge: 60,
    annualExpenses: 60000,
    ...overrides,
  }
}

describe('runScenario', () => {
  it('returns projections for the specified duration', () => {
    const result = runScenario('base', makePortfolio(), makeProfile())
    expect(result.projections.length).toBeGreaterThan(0)
    expect(result.projections.length).toBeLessThanOrEqual(30)
  })

  it('starts projections at age currentAge + 1', () => {
    const profile = makeProfile({ currentAge: 58 })
    const result = runScenario('base', makePortfolio(), profile)
    expect(result.projections[0].age).toBe(59)
  })

  it('does not withdraw before retirement age', () => {
    const profile = makeProfile({
      currentAge: 50,
      targetRetirementAge: 65,
    })
    const result = runScenario('base', makePortfolio(), profile)
    const preRetirement = result.projections.filter(p => p.age < 65)
    for (const year of preRetirement) {
      expect(year.withdrawal).toBe(0)
    }
  })

  it('withdraws at and after retirement age', () => {
    const result = runScenario('base', makePortfolio(), makeProfile())
    const retirementAndLater = result.projections.filter(p => p.age >= 60)

    expect(retirementAndLater).not.toHaveLength(0)
    for (const year of retirementAndLater) {
      expect(year.withdrawal).toBeGreaterThan(0)
    }
  })

  it('bull scenario has higher end balance than base', () => {
    const bigPortfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 1500000 }), makeBondHolding()],
        cashBalance: 100000,
      }),
    ])
    const profile = makeProfile({ annualExpenses: 40000 })
    const bull = runScenario('bull', bigPortfolio, profile)
    const base = runScenario('base', bigPortfolio, profile)
    const bullFinal = bull.projections[bull.projections.length - 1]
    const baseFinal = base.projections[base.projections.length - 1]
    expect(bullFinal.endBalance).toBeGreaterThan(baseFinal.endBalance)
  })

  it('early bear has negative growth in early years', () => {
    const result = runScenario('early_bear', makePortfolio(), makeProfile())
    expect(result.projections[0].growth).toBeLessThan(0)
  })

  it('prolonged bear has negative growth in first 5 years', () => {
    const result = runScenario('prolonged_bear', makePortfolio(), makeProfile())
    for (let i = 0; i < Math.min(5, result.projections.length); i++) {
      expect(result.projections[i].growth).toBeLessThan(0)
    }
  })

  it('sets depletionAge when money runs out', () => {
    const smallPortfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 50000 })],
        cashBalance: 0,
      }),
    ])
    const profile = makeProfile({ annualExpenses: 80000 })
    const result = runScenario('prolonged_bear', smallPortfolio, profile)
    expect(result.depletionAge).not.toBeNull()
    expect(result.runwayYears).toBeLessThan(30)
  })

  it('depletionAge is null when money lasts', () => {
    const bigPortfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 5000000 })],
        cashBalance: 500000,
      }),
    ])
    const profile = makeProfile({ annualExpenses: 40000 })
    const result = runScenario('base', bigPortfolio, profile)
    expect(result.depletionAge).toBeNull()
    expect(result.runwayYears).toBe(30)
  })

  it('accounts for social security income', () => {
    const profile = makeProfile({
      socialSecurityAge: 67,
      socialSecurityMonthly: 2500,
      currentAge: 58,
      targetRetirementAge: 60,
    })
    const result = runScenario('base', makePortfolio(), profile)
    const before67 = result.projections.find(p => p.age === 65)
    const after67 = result.projections.find(p => p.age === 68)
    if (before67 && after67) {
      expect(after67.withdrawal).toBeLessThan(before67.withdrawal)
    }
  })

  it('returns a valid risk score', () => {
    const result = runScenario('base', makePortfolio(), makeProfile())
    expect(result.sequenceOfReturnsRisk).toBeGreaterThanOrEqual(1)
    expect(result.sequenceOfReturnsRisk).toBeLessThanOrEqual(10)
  })

  it('accepts parameter overrides', () => {
    const result = runScenario('base', makePortfolio(), makeProfile(), {
      durationYears: 10,
    })
    expect(result.projections.length).toBeLessThanOrEqual(10)
    expect(result.parameters.durationYears).toBe(10)
  })
})

describe('runAllScenarios', () => {
  it('returns 4 scenarios', () => {
    const results = runAllScenarios(makePortfolio(), makeProfile())
    expect(results).toHaveLength(4)
  })

  it('includes all scenario types', () => {
    const results = runAllScenarios(makePortfolio(), makeProfile())
    const types = results.map(r => r.scenarioType)
    expect(types).toContain('bull')
    expect(types).toContain('base')
    expect(types).toContain('early_bear')
    expect(types).toContain('prolonged_bear')
  })
})

describe('runCustomScenario', () => {
  it('runs a scenario with custom parameters', () => {
    const params = getDefaultScenarioParameters('custom')
    params.equityReturnRate = 0.12
    params.durationYears = 20
    const result = runCustomScenario(makePortfolio(), makeProfile(), params)
    expect(result.scenarioType).toBe('custom')
    expect(result.projections.length).toBeLessThanOrEqual(20)
    expect(result.parameters.equityReturnRate).toBe(0.12)
  })

  it('handles zero drawdown as no crash', () => {
    const params = getDefaultScenarioParameters('custom')
    params.drawdownPercent = 0
    const result = runCustomScenario(makePortfolio(), makeProfile(), params)
    expect(result.projections[0].growth).toBeGreaterThan(0)
  })

  it('applies drawdown when set', () => {
    const params = getDefaultScenarioParameters('custom')
    params.drawdownPercent = 0.3
    const result = runCustomScenario(makePortfolio(), makeProfile(), params)
    expect(result.projections[0].growth).toBeLessThan(0)
  })
})

describe('getDefaultScenarioParameters', () => {
  it('returns parameters for base scenario', () => {
    const params = getDefaultScenarioParameters('base')
    expect(params.type).toBe('base')
    expect(params.equityReturnRate).toBe(0.07)
    expect(params.durationYears).toBe(30)
  })

  it('returns a copy (not the original)', () => {
    const a = getDefaultScenarioParameters('bull')
    const b = getDefaultScenarioParameters('bull')
    a.equityReturnRate = 999
    expect(b.equityReturnRate).not.toBe(999)
  })
})
