import { describe, it, expect } from 'vitest'
import type {
  Portfolio,
  Account,
  Holding,
  CD,
  UserProfile,
  ScenarioParameters,
  ScenarioResult,
  Trade,
  TradePlan,
  CDBreakAnalysis,
  CashLadder,
  LadderRung,
  PortfolioSummary,
  ImportResult,
} from '@/engine/types'

describe('engine/types', () => {
  const holding: Holding = {
    id: 'h1',
    symbol: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    assetClass: 'us_equity',
    shares: 100,
    costBasis: 15000,
    currentPrice: 250,
    currentValue: 25000,
  }

  const cd: CD = {
    id: 'cd1',
    institution: 'Marcus',
    principal: 50000,
    apy: 0.045,
    termMonths: 12,
    maturityDate: '2027-01-15',
    purchaseDate: '2026-01-15',
    earlyWithdrawalPenaltyMonths: 6,
  }

  const account: Account = {
    id: 'a1',
    name: 'Fidelity Brokerage',
    institution: 'Fidelity',
    accountType: 'brokerage',
    holdings: [holding],
    cds: [cd],
    cashBalance: 10000,
  }

  const portfolio: Portfolio = {
    id: 'p1',
    name: 'My Retirement Portfolio',
    accounts: [account],
    asOfDate: '2026-01-30',
  }

  it('constructs a valid Portfolio', () => {
    expect(portfolio.accounts).toHaveLength(1)
    expect(portfolio.accounts[0].holdings[0].symbol).toBe('VTI')
  })

  it('constructs a valid CD with penalty info', () => {
    expect(cd.earlyWithdrawalPenaltyMonths).toBe(6)
    expect(cd.apy).toBe(0.045)
    expect(cd.termMonths).toBe(12)
  })

  it('constructs a valid UserProfile', () => {
    const profile: UserProfile = {
      currentAge: 55,
      targetRetirementAge: 60,
      annualExpenses: 80000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 3200,
    }
    expect(profile.currentAge).toBe(55)
    expect(profile.socialSecurityMonthly).toBe(3200)
  })

  it('constructs valid ScenarioParameters', () => {
    const params: ScenarioParameters = {
      type: 'base',
      label: 'Base Case',
      equityReturnRate: 0.07,
      bondReturnRate: 0.04,
      inflationRate: 0.03,
      durationYears: 30,
      drawdownPercent: 0.04,
    }
    expect(params.equityReturnRate).toBe(0.07)
  })

  it('constructs a ScenarioResult with nullable depletionAge', () => {
    const result: ScenarioResult = {
      scenarioType: 'bull',
      parameters: {
        type: 'bull',
        label: 'Bull Market',
        equityReturnRate: 0.1,
        bondReturnRate: 0.05,
        inflationRate: 0.025,
        durationYears: 30,
        drawdownPercent: 0.035,
      },
      projections: [
        {
          year: 1,
          age: 56,
          startBalance: 1000000,
          growth: 80000,
          withdrawal: 35000,
          endBalance: 1045000,
          inflationAdjustedWithdrawal: 35000,
          cumulativeWithdrawals: 35000,
        },
      ],
      runwayYears: 30,
      depletionAge: null,
      sequenceOfReturnsRisk: 3,
    }
    expect(result.depletionAge).toBeNull()
    expect(result.runwayYears).toBe(30)
  })

  it('constructs a TradePlan', () => {
    const trade: Trade = {
      holdingId: 'h1',
      accountId: 'a1',
      action: 'sell',
      shares: 20,
      estimatedValue: 5000,
      estimatedTaxImpact: 400,
      priority: 1,
      rationale: 'Reduce equity exposure',
    }
    const plan: TradePlan = {
      trades: [trade],
      totalProceeds: 5000,
      totalTaxImpact: 400,
      targetCashPosition: 80000,
    }
    expect(plan.trades).toHaveLength(1)
    expect(plan.totalProceeds).toBe(5000)
  })

  it('constructs a CDBreakAnalysis', () => {
    const analysis: CDBreakAnalysis = {
      cdId: 'cd1',
      penaltyAmount: 1125,
      penaltyMonths: 6,
      accruedInterest: 750,
      netProceeds: 49625,
      breakEvenDate: '2026-07-15',
      recommendation: 'hold',
      rationale: 'CD matures in 6 months, penalty exceeds remaining interest',
    }
    expect(analysis.recommendation).toBe('hold')
    expect(analysis.penaltyAmount).toBe(1125)
  })

  it('constructs a CashLadder', () => {
    const rung: LadderRung = {
      year: 1,
      source: 'cd',
      amount: 50000,
      maturityDate: '2027-01-15',
      cdId: 'cd1',
    }
    const ladder: CashLadder = {
      rungs: [rung],
      totalFunded: 50000,
      yearsOfExpensesCovered: 0.625,
      annualExpenseTarget: 80000,
    }
    expect(ladder.rungs).toHaveLength(1)
    expect(ladder.yearsOfExpensesCovered).toBeCloseTo(0.625)
  })

  it('constructs a PortfolioSummary', () => {
    const summary: PortfolioSummary = {
      totalValue: 85000,
      totalCash: 10000,
      totalCDs: 50000,
      totalEquity: 25000,
      totalBonds: 0,
      allocationByAssetClass: {
        us_equity: 25000,
        intl_equity: 0,
        emerging_equity: 0,
        us_bond: 0,
        intl_bond: 0,
        tips: 0,
        money_market: 0,
        cd: 50000,
        reit: 0,
        commodity: 0,
        crypto: 0,
        cash: 10000,
        other: 0,
      },
      allocationByAccountType: {
        brokerage: 85000,
        traditional_ira: 0,
        roth_ira: 0,
        rollover_ira: 0,
        '401k': 0,
        roth_401k: 0,
        '403b': 0,
        '457b': 0,
        nqdc: 0,
        hsa: 0,
      },
    }
    expect(summary.totalValue).toBe(85000)
  })

  it('constructs an ImportResult', () => {
    const result: ImportResult = {
      accounts: [account],
      format: 'fidelity',
      warnings: ['Skipped row 5: missing symbol'],
      rowsImported: 12,
      rowsSkipped: 1,
    }
    expect(result.rowsImported).toBe(12)
    expect(result.warnings).toHaveLength(1)
  })
})
