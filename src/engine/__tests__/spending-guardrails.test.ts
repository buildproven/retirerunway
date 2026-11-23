// Spending guardrails (REQ-MCP-45): a dollar spending number at the target
// chance of success, and the portfolio values that trigger a cut or a raise.
import { describe, expect, it } from 'vitest'
import { calculatePortfolioValue } from '../portfolio-math'
import { projectRetirement } from '../retirement-projection'
import {
  scalePortfolio,
  scaleSpending,
  spendingGuardrails,
} from '../spending-guardrails'
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
        shares: 10,
        costBasis: value * 0.6,
        currentPrice: (value * 0.6) / 10,
        currentValue: value * 0.6,
      },
      {
        id: `${id}-bd`,
        symbol: 'BD',
        name: 'Bond',
        assetClass: 'us_bond' as const,
        shares: 10,
        costBasis: value * 0.4,
        currentPrice: (value * 0.4) / 10,
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
    account('k', '401k', 1_000_000),
    account('b', 'brokerage', 100_000),
  ],
}

const mortgage = {
  balance: 300_000,
  asOfDate: '2026-11-02',
  rate: 0.03,
  monthlyPayment: 1_500,
  payoffDate: '2050-11-01',
}

const plan: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 60,
  annualExpenses: 98_000, // includes the $18,000 mortgage payment
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_500,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
  mortgage,
}

const PATHS = 200

describe('scaleSpending and scalePortfolio', () => {
  it('scales spending but keeps the mortgage payment as it is', () => {
    const half = scaleSpending(
      { ...plan, spendingPhases: [{ startAge: 70, annualExpenses: 58_000 }] },
      0.5
    )
    expect(half.annualExpenses).toBe(18_000 + 0.5 * 80_000)
    expect(half.spendingPhases?.at(0)?.annualExpenses).toBe(
      18_000 + 0.5 * 40_000
    )
  })

  it('scales every balance', () => {
    expect(calculatePortfolioValue(scalePortfolio(book, 0.5))).toBeCloseTo(
      550_000,
      6
    )
  })
})

describe('spendingGuardrails', () => {
  const result = spendingGuardrails(book, plan, { paths: PATHS })

  it('reports the plan without the mortgage payment, per month', () => {
    expect(result.mortgagePaymentExcluded).toBe(18_000)
    expect(result.planned.monthlySpending).toBe(6_666.67)
  })

  it('finds the spending that meets the target, and no more', () => {
    const canSpend = result.canSpend
    expect(canSpend).not.toBeNull()
    if (canSpend === null) return
    expect(canSpend.successRate).toBeGreaterThanOrEqual(0.85)
    const more = projectRetirement(
      book,
      scaleSpending(plan, canSpend.shareOfPlan * 1.05),
      { paths: PATHS }
    )
    expect(more.monteCarlo.successRate).toBeLessThan(0.85)
    // shareOfPlan is rounded to 4 places, so allow a dollar.
    expect(
      Math.abs(canSpend.monthlySpending - (canSpend.shareOfPlan * 80_000) / 12)
    ).toBeLessThan(1)
  })

  it('puts the cut below today and shows that cutting helps', () => {
    const lower = result.lower
    expect(lower).not.toBeNull()
    if (lower === null || result.canSpend === null) return
    expect(lower.portfolioValue).toBeLessThan(result.portfolioToday)
    expect(lower.changeFromToday).toBeLessThan(0)
    expect(lower.successBefore).toBeGreaterThan(0.7)
    expect(lower.successBefore).toBeLessThan(0.85)
    expect(lower.newMonthlySpending).toBeCloseTo(
      result.canSpend.monthlySpending * 0.9,
      1
    )
    expect(lower.successAfter).toBeGreaterThan(lower.successBefore)
  })

  it('puts the raise above today and keeps success high after raising', () => {
    const upper = result.upper
    expect(upper).not.toBeNull()
    if (upper === null || result.canSpend === null) return
    expect(upper.portfolioValue).toBeGreaterThan(result.portfolioToday)
    expect(upper.successBefore).toBeGreaterThanOrEqual(0.99)
    expect(upper.newMonthlySpending).toBeCloseTo(
      result.canSpend.monthlySpending * 1.1,
      1
    )
    expect(upper.successAfter).toBeLessThanOrEqual(upper.successBefore)
  })

  it('returns no spending number when fixed costs alone miss the target', () => {
    const broke = spendingGuardrails(
      { ...book, accounts: [account('k', '401k', 50_000)] },
      { ...plan, socialSecurityMonthly: 0 },
      { paths: PATHS }
    )
    expect(broke.canSpend).toBeNull()
    expect(broke.lower).toBeNull()
    expect(broke.upper).toBeNull()
  })

  it('is deterministic', () => {
    expect(spendingGuardrails(book, plan, { paths: PATHS })).toEqual(result)
  })
})
