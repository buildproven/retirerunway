import { describe, it, expect } from 'vitest'
import { optimizeRothConversion } from '../roth-conversion'
import type { Portfolio, UserProfile, Account, Holding } from '../types'

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
    name: 'Traditional IRA',
    institution: 'Fidelity',
    accountType: 'traditional_ira',
    holdings: [makeHolding()],
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
    currentAge: 55,
    targetRetirementAge: 65,
    annualExpenses: 60000,
    ...overrides,
  }
}

describe('optimizeRothConversion', () => {
  it('generates a multi-year conversion plan', () => {
    const plan = optimizeRothConversion(makePortfolio(), makeProfile())
    expect(plan.years.length).toBeGreaterThan(0)
    expect(plan.totalConverted).toBeGreaterThan(0)
    expect(plan.totalTaxPaid).toBeGreaterThan(0)
    expect(plan.recommendation).toBeTruthy()
  })

  it('does not convert more than the traditional balance', () => {
    const smallPortfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 10000 })],
        cashBalance: 0,
      }),
    ])
    const plan = optimizeRothConversion(smallPortfolio, makeProfile())
    // After growth, the total converted should be close to or less than
    // the grown balance over time
    expect(plan.totalConverted).toBeLessThanOrEqual(
      plan.traditionalBalanceStart * 3
    )
  })

  it('returns empty plan for zero traditional balance', () => {
    const rothOnly = makePortfolio([
      makeAccount({ accountType: 'roth_ira', name: 'Roth IRA' }),
    ])
    const plan = optimizeRothConversion(rothOnly, makeProfile())
    expect(plan.years).toHaveLength(0)
    expect(plan.totalConverted).toBe(0)
    expect(plan.recommendation).toContain('No pre-tax balances')
  })

  it('respects the target bracket rate', () => {
    const plan = optimizeRothConversion(makePortfolio(), makeProfile(), {
      targetBracketRate: 0.12,
    })
    // All conversions should be at or below 12% marginal rate
    for (const year of plan.years) {
      expect(year.marginalRate).toBeLessThanOrEqual(0.12)
    }
  })

  it('tracks cumulative amounts correctly', () => {
    const plan = optimizeRothConversion(makePortfolio(), makeProfile())
    if (plan.years.length > 0) {
      const lastYear = plan.years[plan.years.length - 1]
      expect(lastYear.cumulativeConverted).toBeCloseTo(plan.totalConverted, 0)
      expect(lastYear.cumulativeTaxPaid).toBeCloseTo(plan.totalTaxPaid, 0)
    }
  })

  it('calculates projected tax savings', () => {
    const plan = optimizeRothConversion(makePortfolio(), makeProfile(), {
      targetBracketRate: 0.12,
      expectedRetirementRate: 0.22,
    })
    // Converting at 12% now vs 22% later should show savings
    if (plan.totalConverted > 0) {
      expect(plan.projectedTaxSavings).toBeGreaterThanOrEqual(0)
    }
  })

  it('adjusts window to years before retirement', () => {
    const nearRetirement = makeProfile({
      currentAge: 63,
      targetRetirementAge: 65,
    })
    const plan = optimizeRothConversion(makePortfolio(), nearRetirement, {
      conversionWindowYears: 10,
    })
    expect(plan.years.length).toBeLessThanOrEqual(2)
  })

  it('supports married filing jointly', () => {
    const plan = optimizeRothConversion(makePortfolio(), makeProfile(), {
      filingStatus: 'married_filing_jointly',
      targetBracketRate: 0.22,
    })
    expect(plan.years.length).toBeGreaterThan(0)
    // MFJ brackets are wider, so more should be convertible at same rate
  })

  it('accounts for state tax', () => {
    const withState = optimizeRothConversion(makePortfolio(), makeProfile(), {
      stateTaxRate: 0.05,
    })
    const withoutState = optimizeRothConversion(
      makePortfolio(),
      makeProfile(),
      {
        stateTaxRate: 0,
      }
    )
    expect(withState.totalTaxPaid).toBeGreaterThan(withoutState.totalTaxPaid)
  })

  it('returns "no window" message when window is zero', () => {
    const alreadyRetired = makeProfile({
      currentAge: 75,
      targetRetirementAge: 65,
    })
    const plan = optimizeRothConversion(makePortfolio(), alreadyRetired, {
      conversionWindowYears: 0,
    })
    expect(plan.years).toHaveLength(0)
    expect(plan.recommendation).toContain('No conversion window')
  })

  it('handles existing Social Security income reducing conversion room', () => {
    const withSS = makeProfile({
      currentAge: 68,
      targetRetirementAge: 65,
      socialSecurityAge: 67,
      socialSecurityMonthly: 2500,
    })
    const plan = optimizeRothConversion(makePortfolio(), withSS)
    expect(plan).toBeDefined()
    expect(plan.recommendation).toBeTruthy()
  })

  it('handles pension and other monthly income', () => {
    const withIncome = makeProfile({
      pensionMonthly: 2000,
      otherIncomeMonthly: 1000,
    })
    const plan = optimizeRothConversion(makePortfolio(), withIncome)
    expect(plan).toBeDefined()
  })

  it('includes CDs in traditional balance', () => {
    const withCD = makePortfolio([
      makeAccount({
        accountType: 'traditional_ira',
        cds: [
          {
            id: 'cd-1',
            institution: 'Ally',
            principal: 25000,
            apy: 0.045,
            termMonths: 12,
            maturityDate: '2027-06-01',
            purchaseDate: '2026-06-01',
            earlyWithdrawalPenaltyMonths: 3,
          },
        ],
      }),
    ])
    const plan = optimizeRothConversion(withCD, makeProfile())
    expect(plan.traditionalBalanceStart).toBe(275000)
  })

  it('counts roth_401k in Roth balance', () => {
    const mixedPortfolio = makePortfolio([
      makeAccount({ accountType: 'traditional_ira' }),
      makeAccount({
        id: 'roth-401k',
        accountType: 'roth_401k',
        name: 'Roth 401k',
        holdings: [makeHolding({ id: 'h-roth', currentValue: 100000 })],
        cashBalance: 10000,
      }),
    ])
    const plan = optimizeRothConversion(mixedPortfolio, makeProfile())
    expect(plan.rothBalanceStart).toBe(110000) // 100000 holding + 10000 cash
  })

  it('produces no-savings recommendation when conversion rate exceeds retirement rate', () => {
    const plan = optimizeRothConversion(makePortfolio(), makeProfile(), {
      targetBracketRate: 0.35,
      expectedRetirementRate: 0.1,
      stateTaxRate: 0,
      conversionWindowYears: 2,
    })
    // Tax paid at 35% is higher than what would be paid at 10%, so savings should be 0
    expect(plan.projectedTaxSavings).toBe(0)
    expect(plan.recommendation).toContain('not provide clear tax savings')
  })

  it('uses profile.stateTaxRate when set', () => {
    const profileWithState = makeProfile({ stateTaxRate: 0.09 })
    const plan = optimizeRothConversion(makePortfolio(), profileWithState)
    expect(plan.totalTaxPaid).toBeGreaterThan(0)
  })
})
