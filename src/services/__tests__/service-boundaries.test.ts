import { describe, expect, it } from 'vitest'
import type { Account, Holding, Portfolio, UserProfile } from '@/engine/types'
import {
  generateReport,
  generateTradePlans,
  getRuleOf55Analysis,
  getScenarioDefaults,
  getSequenceOfReturnsRisk,
  projectAllScenarios,
  projectWithModifiedProfile,
} from '../index'

function makePortfolio(): Portfolio {
  const equity: Holding = {
    id: 'holding-equity',
    symbol: 'VTI',
    name: 'Total US Stock Market',
    assetClass: 'us_equity',
    shares: 1_000,
    costBasis: 150_000,
    currentPrice: 200,
    currentValue: 200_000,
  }
  const bonds: Holding = {
    id: 'holding-bonds',
    symbol: 'BND',
    name: 'Total US Bond Market',
    assetClass: 'us_bond',
    shares: 500,
    costBasis: 45_000,
    currentPrice: 100,
    currentValue: 50_000,
  }
  const account: Account = {
    id: 'account-1',
    name: 'Brokerage',
    institution: 'Fidelity',
    accountType: 'brokerage',
    holdings: [equity, bonds],
    cds: [],
    cashBalance: 30_000,
  }

  return {
    id: 'portfolio-1',
    name: 'Boundary fixture',
    accounts: [account],
    asOfDate: '2026-01-31',
  }
}

const profile: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 60,
  annualExpenses: 60_000,
  federalTaxBracket: 0.22,
}

describe('service boundaries', () => {
  it('assembles standard and custom scenario projections', () => {
    const portfolio = makePortfolio()
    const scenarios = projectAllScenarios(
      portfolio,
      profile,
      getScenarioDefaults('custom')
    )
    const modified = projectWithModifiedProfile(portfolio, profile, {
      annualExpenses: 50_000,
    })

    expect(scenarios.scenarios).toHaveLength(5)
    expect(scenarios.baseCase?.scenarioType).toBe('base')
    expect(scenarios.worstCase?.scenarioType).toBe('prolonged_bear')
    expect(scenarios.bestCase?.scenarioType).toBe('bull')
    expect(modified).toHaveLength(4)
  })

  it('connects risk, Rule of 55, trade plans, and report generation', () => {
    const portfolio = makePortfolio()
    const scenarios = projectAllScenarios(portfolio, profile).scenarios
    const risk = getSequenceOfReturnsRisk(portfolio, profile)
    const tradePlans = generateTradePlans(portfolio, profile)
    const ruleOf55 = getRuleOf55Analysis(portfolio, profile)
    const report = generateReport({
      portfolio,
      userProfile: profile,
      scenarios,
      riskScore: risk,
      tradePlan: tradePlans.standardPlan,
      ladderPlan: tradePlans.ladder,
    })

    expect(risk.score).toBeGreaterThanOrEqual(1)
    expect(ruleOf55).toMatchObject({ eligible: false })
    expect(tradePlans.standardPlan.trades.length).toBeGreaterThan(0)
    expect(tradePlans.minimalPlan.totalProceeds).toBeGreaterThanOrEqual(0)
    expect(tradePlans.ladder.rungs.length).toBeGreaterThan(0)
    expect(report).toContain('RetireRunway')
  })
})
