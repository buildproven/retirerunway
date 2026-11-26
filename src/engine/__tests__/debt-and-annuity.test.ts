// Debt against safe yields (REQ-MCP-79) and a lifetime income annuity
// (REQ-MCP-80). Invented household only.
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { proposePlanPolicy } from '../plan-policy'
import { reviewPlan } from '../plan-review'
import { projectRetirement } from '../retirement-projection'
import type { Holding, Portfolio, UserProfile } from '../types'

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

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    {
      id: 'window',
      name: 'window',
      institution: 'Broker',
      accountType: '401k',
      cashBalance: 0,
      cds: [],
      holdings: [
        holding('voo', 'us_equity', 600_000),
        holding('bnd', 'us_bond', 300_000),
      ],
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
  spouse: {
    currentAge: 52,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_800,
  },
  mortgage: {
    balance: 300_000,
    asOfDate: '2026-11-24',
    rate: 0.02875,
    monthlyPayment: 1_500,
    payoffDate: '2050-11-01',
  },
  marketData: {
    asOfDate: '2026-11-24',
    treasury10y: 0.05,
    tipsReal10y: 0.029,
    annuityQuotes: [
      {
        age: 65,
        payoutRate: 0.065,
        joint: true,
        source: 'Broker',
        asOf: '2026-11-05',
      },
      {
        age: 65,
        payoutRate: 0.077,
        joint: false,
        source: 'Broker',
        asOf: '2026-11-05',
      },
    ],
  },
}

const run = { seed: 42, paths: 200 }

describe('REQ-MCP-79: debt against safe yields', () => {
  it('REQ-MCP-79 says pay a card above the Treasury yield first and keep a cheap mortgage', () => {
    const review = reviewPlan(
      portfolio,
      { ...profile, consumerDebt: 18_000, consumerDebtRate: 0.22 },
      '2026-11-24',
      run
    )
    const card = review.debt.find(d => d.name === 'Card and loan debt')
    expect(card?.verdict).toBe('pay off first')
    expect(card?.safeYield).toBe(0.05)
    const mortgage = review.debt.find(d => d.name === 'Mortgage')
    expect(mortgage?.verdict).toBe('keep')
    expect(review.actions[0]).toMatch(
      /^Card and loan debt \(\$18,000 at 22\.00%\)/
    )
  })

  it('REQ-MCP-79 asks for the APR when it is missing, and flags a mortgage above safe yields', () => {
    const review = reviewPlan(
      portfolio,
      {
        ...profile,
        consumerDebt: 18_000,
        mortgage: {
          ...(profile.mortgage as NonNullable<UserProfile['mortgage']>),
          rate: 0.07,
        },
      },
      '2026-11-24',
      run
    )
    expect(
      review.debt.find(d => d.name === 'Card and loan debt')?.verdict
    ).toBe('rate needed')
    expect(
      review.dataToRefresh.some(d => d.startsWith('Card and loan APR missing'))
    ).toBe(true)
    expect(review.debt.find(d => d.name === 'Mortgage')?.verdict).toBe(
      'pay off first'
    )
    expect(
      userProfileSchema.safeParse({ ...profile, consumerDebtRate: 0.22 })
        .success
    ).toBe(true)
  })
})

describe('REQ-MCP-80: a lifetime income annuity', () => {
  const annuity = {
    purchaseAge: 67,
    premium: 200_000,
    payoutRate: 0.065,
    accountType: '401k' as const,
    joint: true,
  }

  it('REQ-MCP-80 takes the premium in its year and pays a fixed amount every year after', () => {
    const plain = projectRetirement(portfolio, profile, run).expectedPath.years
    const withAnnuity = projectRetirement(
      portfolio,
      { ...profile, incomeAnnuity: annuity },
      run
    ).expectedPath.years
    const at = (ys: typeof plain, age: number) =>
      ys.find(y => y.age === age) as (typeof plain)[number]
    // The premium leaves the 401(k) at 67.
    expect(
      at(plain, 67).endBalances.employerPlan -
        at(withAnnuity, 67).endBalances.employerPlan
    ).toBeGreaterThan(150_000)
    // Income at 70 includes the payout; in today's dollars it shrinks as prices rise.
    expect(at(withAnnuity, 70).otherIncome).toBeGreaterThan(
      at(plain, 70).otherIncome
    )
    expect(at(withAnnuity, 80).otherIncome).toBeLessThan(
      at(withAnnuity, 70).otherIncome
    )
    expect(
      userProfileSchema.safeParse({ ...profile, incomeAnnuity: annuity })
        .success
    ).toBe(true)
  })

  it('REQ-MCP-80 tests none, 25% and 50% at Social Security age with the joint quote for a couple', () => {
    const proposal = proposePlanPolicy(portfolio, profile, '2026-11-24', run)
    expect(proposal.annuityTest.purchaseAge).toBe(67)
    expect(proposal.annuityTest.payoutRate).toBe(0.065)
    expect(proposal.annuityTest.rows.map(r => r.share)).toEqual([0, 0.25, 0.5])
    expect(proposal.annuityTest.rows[0].premium).toBe(0)
    expect(proposal.annuityTest.rows[2].premium).toBeGreaterThan(
      proposal.annuityTest.rows[1].premium
    )
    for (const row of proposal.annuityTest.rows)
      expect(row.worse).toBe(Math.min(row.successRate, row.forecastSuccessRate))
    if (proposal.annuityTest.proposed !== null)
      expect(proposal.findings.some(f => f.rule === 'incomeAnnuity')).toBe(true)
    const noQuotes = proposePlanPolicy(
      portfolio,
      { ...profile, marketData: { ...profile.marketData!, annuityQuotes: [] } },
      '2026-11-24',
      run
    )
    expect(noQuotes.annuityTest.rows).toEqual([])
    expect(noQuotes.annuityTest.basis).toMatch(/^no annuity quotes/)
  })
})

describe('REQ-MCP-81: health cover rising faster than prices', () => {
  it('REQ-MCP-81 raises bridge healthcare costs and the review stresses it', () => {
    const at = (p: UserProfile, age: number) =>
      projectRetirement(portfolio, p, run).expectedPath.years.find(
        y => y.age === age
      )?.healthcare ?? 0
    const flat = at(profile, 62)
    const rising = at({ ...profile, healthcareRealGrowth: 0.02 }, 62)
    expect(rising / flat).toBeCloseTo(Math.pow(1.02, 9), 3)
    const review = reviewPlan(portfolio, profile, '2026-11-24', run)
    const health = review.stressTests.filter(t =>
      /^Health cover rises 2 points/.test(t.name)
    )
    expect(health).toHaveLength(1)
    expect(health[0].change).toBeLessThanOrEqual(0)
    const own = reviewPlan(
      portfolio,
      { ...profile, healthcareRealGrowth: 0.01 },
      '2026-11-24',
      run
    )
    expect(own.stressTests.some(t => /^Health cover/.test(t.name))).toBe(false)
  })
})
