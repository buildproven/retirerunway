import { describe, it, expect, vi } from 'vitest'
import type {
  Portfolio,
  UserProfile,
  Account,
  Holding,
  ScenarioResult,
  TradePlan,
  CashLadder,
} from '../types'
import type { RiskScoreBreakdown } from '../risk-scoring'
import { generateMarkdownReport } from '../report-generator'

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: 'h-1',
    symbol: 'VTI',
    name: 'Vanguard Total Stock',
    assetClass: 'us_equity',
    shares: 100,
    costBasis: 15000,
    currentPrice: 200,
    currentValue: 20000,
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
    cashBalance: 5000,
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
    federalTaxBracket: 0.22,
    ...overrides,
  }
}

function makeScenarioResult(
  overrides: Partial<ScenarioResult> = {}
): ScenarioResult {
  return {
    scenarioType: 'base',
    parameters: {
      type: 'base',
      label: 'Base Case',
      equityReturnRate: 0.07,
      bondReturnRate: 0.04,
      inflationRate: 0.03,
      durationYears: 30,
      drawdownPercent: 0,
    },
    projections: [
      {
        year: 2027,
        age: 59,
        startBalance: 25000,
        growth: 1750,
        withdrawal: 0,
        endBalance: 26750,
        inflationAdjustedWithdrawal: 0,
        cumulativeWithdrawals: 0,
      },
    ],
    runwayYears: 30,
    depletionAge: null,
    sequenceOfReturnsRisk: 5,
    ...overrides,
  }
}

function makeRiskScore(): RiskScoreBreakdown {
  return {
    score: 5 as const,
    factors: {
      equityAllocation: 7,
      withdrawalRate: 3,
      yearsToRetirement: 6,
      cashBufferYears: 4,
      concentrationPenalty: 2,
    },
    label: 'Moderate',
    description: 'Risk driven by: high equity allocation.',
  }
}

function makeTradePlan(): TradePlan {
  return {
    trades: [
      {
        holdingId: 'h-1',
        accountId: 'acc-1',
        action: 'sell',
        shares: 50,
        estimatedValue: 10000,
        estimatedTaxImpact: 550,
        priority: 1,
        rationale: 'Sell VTI from Brokerage',
      },
    ],
    totalProceeds: 10000,
    totalTaxImpact: 550,
    targetCashPosition: 120000,
  }
}

function makeLadderPlan(): CashLadder {
  return {
    rungs: [
      { year: 2027, source: 'cash', amount: 5000 },
      { year: 2028, source: 'sell_equity', amount: 55000 },
    ],
    totalFunded: 60000,
    yearsOfExpensesCovered: 1,
    annualExpenseTarget: 60000,
  }
}

describe('generateMarkdownReport', () => {
  it('does not depend on the wall clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'))
    const first = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile(),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: makeTradePlan(),
      ladderPlan: makeLadderPlan(),
    })

    vi.setSystemTime(new Date('2026-08-22T12:00:00Z'))
    const second = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile(),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: makeTradePlan(),
      ladderPlan: makeLadderPlan(),
    })
    vi.useRealTimers()

    expect(second).toBe(first)
    expect(first).toContain('**Generated:** 2026-01-31')
  })

  it('generates a complete markdown report', () => {
    const report = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile(),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: makeTradePlan(),
      ladderPlan: makeLadderPlan(),
    })

    expect(report).toContain('# RetireRunway')
    expect(report).toContain('## Profile')
    expect(report).toContain('## Portfolio Summary')
    expect(report).toContain('## Sequence-of-Returns Risk')
    expect(report).toContain('## Scenario Projections')
    expect(report).toContain('## De-Risk Trade Plan')
    expect(report).toContain('## Cash Ladder Plan')
    expect(report).toContain('informational purposes only')
  })

  it('includes portfolio value and account details', () => {
    const report = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile(),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: makeTradePlan(),
      ladderPlan: makeLadderPlan(),
    })

    expect(report).toContain('Test Portfolio')
    expect(report).toContain('VTI')
    expect(report).toContain('Brokerage')
  })

  it('includes risk score and label', () => {
    const report = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile(),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: makeTradePlan(),
      ladderPlan: makeLadderPlan(),
    })

    expect(report).toContain('5/10')
    expect(report).toContain('Moderate')
  })

  it('omits trade plan section when no trades', () => {
    const report = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile(),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: {
        trades: [],
        totalProceeds: 0,
        totalTaxImpact: 0,
        targetCashPosition: 120000,
      },
      ladderPlan: makeLadderPlan(),
    })

    expect(report).not.toContain('## De-Risk Trade Plan')
  })

  it('omits ladder plan section when no rungs', () => {
    const report = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile(),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: makeTradePlan(),
      ladderPlan: {
        rungs: [],
        totalFunded: 0,
        yearsOfExpensesCovered: 0,
        annualExpenseTarget: 60000,
      },
    })

    expect(report).not.toContain('## Cash Ladder Plan')
  })

  it('includes social security info when provided', () => {
    const report = generateMarkdownReport({
      portfolio: makePortfolio(),
      userProfile: makeProfile({
        socialSecurityMonthly: 2500,
        socialSecurityAge: 67,
      }),
      scenarios: [makeScenarioResult()],
      riskScore: makeRiskScore(),
      tradePlan: makeTradePlan(),
      ladderPlan: makeLadderPlan(),
    })

    expect(report).toContain('Social Security')
    expect(report).toContain('67')
  })
})
