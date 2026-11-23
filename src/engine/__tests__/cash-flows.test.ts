import { describe, it, expect } from 'vitest'
import type { Portfolio, UserProfile, ScenarioParameters } from '../types'
import {
  annualExpensesAt,
  baseExpensesAt,
  cashInflowAt,
  homeSaleAt,
  impliedMortgagePayoffMonth,
  mortgageBalanceAtYearStart,
  mortgagePayoffWarning,
  mortgagePaymentEndAge,
} from '../portfolio-math'
import { runCustomScenario } from '../scenarios'
import { runMonteCarlo } from '../monte-carlo'
import { UserProfileSchema } from '../../lib/validation-schemas'

// ---------------------------------------------------------------------------
// Pre-retirement contributions, spending phases and a planned home sale.
// Before these, projections assumed no saving before retirement, one flat
// spending level for life and a home that is never sold.
// ---------------------------------------------------------------------------

const AS_OF = '2026-11-17'

function portfolio(value: number): Portfolio {
  return {
    id: 'p-1',
    name: 'Test',
    asOfDate: AS_OF,
    accounts: [
      {
        id: 'a-1',
        name: '401k',
        institution: 'Fidelity',
        accountType: '401k',
        holdings: [],
        cds: [],
        cashBalance: value,
      },
    ],
  }
}

const base: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 58,
  annualExpenses: 100000,
}

/** No growth and no inflation, so every balance change is a cash flow. */
const flat: ScenarioParameters = {
  type: 'custom',
  label: 'Flat',
  equityReturnRate: 0,
  bondReturnRate: 0,
  inflationRate: 0,
  durationYears: 10,
  drawdownPercent: 0,
}

describe('backward compatibility', () => {
  it('a profile with none of the new fields spends annualExpenses × inflation', () => {
    expect(annualExpensesAt(base, 60, 1.25, AS_OF)).toBe(125000)
    expect(cashInflowAt(base, 54, AS_OF)).toBe(0)
  })

  it('projection years carry no cashInflow key when nothing flows in', () => {
    const result = runCustomScenario(portfolio(1_000_000), base, flat)
    expect(result.projections.every(p => !('cashInflow' in p))).toBe(true)
  })
})

describe('annualContributions', () => {
  const profile: UserProfile = { ...base, annualContributions: 50000 }

  it('adds the contribution only before targetRetirementAge', () => {
    expect(cashInflowAt(profile, 54, AS_OF)).toBe(50000)
    expect(cashInflowAt(profile, 57, AS_OF)).toBe(50000)
    expect(cashInflowAt(profile, 58, AS_OF)).toBe(0)
  })

  it('grows a flat projection by exactly the contributions before retirement', () => {
    const result = runCustomScenario(portfolio(1_000_000), profile, flat)
    // Ages 54..57 contribute 4 × 50k; age 58 is the first withdrawal year.
    const age57 = result.projections.find(p => p.age === 57)
    expect(age57?.endBalance).toBe(1_200_000)
    expect(age57?.cashInflow).toBe(50000)
    const age58 = result.projections.find(p => p.age === 58)
    expect(age58?.endBalance).toBe(1_100_000)
  })

  it('raises the Monte Carlo success rate for the same seed', () => {
    // An all-cash portfolio earns the bond draws; this spending fails on
    // some paths but not all.
    const tight: UserProfile = {
      ...base,
      annualExpenses: 60000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 3000,
    }
    const without = runMonteCarlo(portfolio(1_000_000), tight, { seed: 42 })
    const withContrib = runMonteCarlo(
      portfolio(1_000_000),
      { ...tight, annualContributions: 50000 },
      { seed: 42 }
    )
    expect(withContrib.successRate).toBeGreaterThan(without.successRate)
  })
})

describe('spendingPhases', () => {
  const profile: UserProfile = {
    ...base,
    annualExpenses: 144000,
    spendingPhases: [
      { startAge: 60, annualExpenses: 108000 },
      { startAge: 65, annualExpenses: 96000 },
    ],
  }

  it('uses annualExpenses before the first phase and each phase from its startAge', () => {
    expect(baseExpensesAt(profile, 59)).toBe(144000)
    expect(baseExpensesAt(profile, 60)).toBe(108000)
    expect(baseExpensesAt(profile, 64)).toBe(108000)
    expect(baseExpensesAt(profile, 65)).toBe(96000)
    expect(baseExpensesAt(profile, 90)).toBe(96000)
  })

  it('withdraws the phase spending in a flat projection', () => {
    const result = runCustomScenario(portfolio(2_000_000), profile, flat)
    const byAge = new Map(result.projections.map(p => [p.age, p.withdrawal]))
    expect(byAge.get(59)).toBe(144000)
    expect(byAge.get(60)).toBe(108000)
    expect(byAge.get(63)).toBe(108000)
  })
})

describe('mortgage amortization', () => {
  // Example mortgage: $300,000 at 2.875%, $1,450.00/month, paid off 2031-08.
  const profile: UserProfile = {
    ...base,
    mortgage: {
      balance: 300000,
      asOfDate: '2026-11-02',
      rate: 0.02875,
      monthlyPayment: 1450.0,
      payoffDate: '2031-08-01',
    },
  }

  it('declines every year and is 0 after the payoff year', () => {
    const balances = [2027, 2028, 2029, 2030, 2031].map(year =>
      mortgageBalanceAtYearStart(profile, year)
    )
    for (let i = 1; i < balances.length; i++) {
      expect(balances[i]).toBeLessThan(balances[i - 1])
    }
    expect(balances[0]).toBeLessThan(300000)
    expect(balances[4]).toBeGreaterThan(0)
    expect(mortgageBalanceAtYearStart(profile, 2032)).toBe(0)
  })

  it('matches the closed-form amortization on 1 Jan 2028 (14 payments)', () => {
    const r = 0.02875 / 12
    const g = Math.pow(1 + r, 14)
    const expected = 300000 * g - (1450.0 * (g - 1)) / r
    expect(mortgageBalanceAtYearStart(profile, 2028)).toBeCloseTo(expected, 6)
  })

  it('pays down linearly at a 0% rate and holds the balance with no payment', () => {
    const zero: UserProfile = {
      ...base,
      mortgage: {
        balance: 120000,
        asOfDate: '2026-01-15',
        monthlyPayment: 1000,
      },
    }
    expect(mortgageBalanceAtYearStart(zero, 2028)).toBe(120000 - 24000)
    const noPayment: UserProfile = {
      ...base,
      mortgage: { balance: 120000, asOfDate: '2026-01-15' },
    }
    expect(mortgageBalanceAtYearStart(noPayment, 2030)).toBe(120000)
  })
})

describe('mortgage payoff check', () => {
  const mortgage = {
    balance: 300000,
    asOfDate: '2026-11-02',
    rate: 0.02875,
    monthlyPayment: 1450.0,
  }

  it('implies the payoff month from balance, rate and payment', () => {
    // About 287 payments from Dec 2026: the last one falls in
    // October 2050.
    expect(impliedMortgagePayoffMonth({ ...base, mortgage })).toBe('2050-10')
    expect(
      impliedMortgagePayoffMonth({
        ...base,
        mortgage: {
          balance: 12000,
          asOfDate: '2026-01-15',
          monthlyPayment: 1000,
        },
      })
    ).toBe('2027-01')
  })

  it('warns on a payoffDate decades from the implied payoff, not on a close one', () => {
    const typo = mortgagePayoffWarning({
      ...base,
      mortgage: { ...mortgage, payoffDate: '2031-08-01' },
    })
    expect(typo).toMatch(/2031-08-01.*2050-10/)
    expect(
      mortgagePayoffWarning({
        ...base,
        mortgage: { ...mortgage, payoffDate: '2051-08-01' },
      })
    ).toBeUndefined()
  })

  it('gives no implied payoff when the payment does not cover interest', () => {
    expect(
      impliedMortgagePayoffMonth({
        ...base,
        mortgage: { ...mortgage, monthlyPayment: 500 },
      })
    ).toBeUndefined()
  })
})

describe('homeSale', () => {
  const profile: UserProfile = {
    ...base,
    home: { estimatedValue: 900000 },
    mortgage: {
      balance: 120000,
      asOfDate: '2026-01-15',
      monthlyPayment: 1000,
      payoffDate: '2035-12-01',
    },
    homeSale: {
      age: 55,
      replacementHomeCost: 450000,
      annualHousingCostChange: -8000,
    },
  }

  it('computes net proceeds from price, 6% selling costs, mortgage and new home', () => {
    const sale = homeSaleAt(profile, AS_OF)
    // Age 55 is calendar 2028: 24 payments of $1,000 at 0% leave $96,000.
    expect(sale).toEqual({
      age: 55,
      year: 2028,
      salePrice: 900000,
      sellingCosts: 54000,
      mortgageBalancePaid: 96000,
      replacementHomeCost: 450000,
      netProceeds: 900000 - 54000 - 96000 - 450000,
      annualHousingCostChange: -8000,
    })
  })

  it('stops the mortgage payment at the sale age, before the payoff date', () => {
    expect(mortgagePaymentEndAge(profile, AS_OF)).toBe(55)
    // Before the sale: 100k includes the 12k payment.
    expect(annualExpensesAt(profile, 54, 1, AS_OF)).toBe(100000)
    // From the sale: payment gone and housing cost 8k lower.
    expect(annualExpensesAt(profile, 55, 1, AS_OF)).toBe(100000 - 12000 - 8000)
  })

  it('adds the net proceeds to the portfolio in the sale year', () => {
    const result = runCustomScenario(portfolio(1_000_000), profile, flat)
    const age55 = result.projections.find(p => p.age === 55)
    expect(age55?.cashInflow).toBe(300000)
    expect(age55?.endBalance).toBe(1_300_000)
  })

  it('a sale that costs cash lowers the portfolio', () => {
    const upsize: UserProfile = {
      ...profile,
      homeSale: { age: 55, replacementHomeCost: 1_000_000 },
    }
    expect(homeSaleAt(upsize, AS_OF)?.netProceeds).toBeLessThan(0)
  })
})

describe('UserProfileSchema value rules', () => {
  it('accepts the new fields', () => {
    const parsed = UserProfileSchema.safeParse({
      ...base,
      annualContributions: 54000,
      spendingPhases: [
        { startAge: 60, annualExpenses: 108000 },
        { startAge: 65, annualExpenses: 96000 },
      ],
      home: { estimatedValue: 900000 },
      homeSale: { age: 58, replacementHomeCost: 450000 },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects out-of-order phases, a past sale and a sale with no price', () => {
    const unsorted = UserProfileSchema.safeParse({
      ...base,
      spendingPhases: [
        { startAge: 65, annualExpenses: 96000 },
        { startAge: 60, annualExpenses: 108000 },
      ],
    })
    expect(unsorted.success).toBe(false)
    const past = UserProfileSchema.safeParse({
      ...base,
      home: { estimatedValue: 900000 },
      homeSale: { age: 53 },
    })
    expect(past.success).toBe(false)
    const noPrice = UserProfileSchema.safeParse({
      ...base,
      homeSale: { age: 58 },
    })
    expect(noPrice.success).toBe(false)
    const negative = UserProfileSchema.safeParse({
      ...base,
      annualContributions: -1,
    })
    expect(negative.success).toBe(false)
  })
})

describe('Social Security COLA and withdrawal tax', () => {
  const inflating: ScenarioParameters = { ...flat, inflationRate: 0.03 }
  const retired: UserProfile = {
    currentAge: 66,
    targetRetirementAge: 66,
    annualExpenses: 100000,
    socialSecurityAge: 67,
    socialSecurityMonthly: 5000,
  }

  it('grows Social Security with inflation by default (today’s dollars)', () => {
    const result = runCustomScenario(portfolio(2_000_000), retired, inflating)
    const age70 = result.projections.find(p => p.age === 70)
    // Year index 3 → multiplier 1.03^3 on both spending and the benefit.
    const multiplier = Math.pow(1.03, 3)
    expect(age70?.withdrawal).toBeCloseTo((100000 - 60000) * multiplier, 1)
  })

  it('keeps the benefit fixed with socialSecurityCola: false', () => {
    const result = runCustomScenario(
      portfolio(2_000_000),
      { ...retired, socialSecurityCola: false },
      inflating
    )
    const age70 = result.projections.find(p => p.age === 70)
    expect(age70?.withdrawal).toBeCloseTo(100000 * Math.pow(1.03, 3) - 60000, 1)
  })

  it('COLA raises the Monte Carlo success rate against a fixed benefit', () => {
    const p = portfolio(1_200_000)
    const young: UserProfile = {
      ...retired,
      annualExpenses: 80000,
      currentAge: 55,
      targetRetirementAge: 55,
    }
    const cola = runMonteCarlo(p, young, { seed: 42 }).successRate
    const fixed = runMonteCarlo(
      p,
      { ...young, socialSecurityCola: false },
      { seed: 42 }
    ).successRate
    expect(cola).toBeGreaterThan(fixed)
  })

  it('grosses withdrawals up by 1 / (1 − withdrawalTaxRate)', () => {
    const taxed: UserProfile = {
      ...base,
      targetRetirementAge: 54,
      withdrawalTaxRate: 0.2,
    }
    const result = runCustomScenario(portfolio(2_000_000), taxed, flat)
    expect(result.projections[0].withdrawal).toBe(125000)
    const untaxed = runCustomScenario(
      portfolio(2_000_000),
      { ...taxed, withdrawalTaxRate: undefined },
      flat
    )
    expect(untaxed.projections[0].withdrawal).toBe(100000)
  })

  it('rejects a withdrawalTaxRate above 0.6', () => {
    expect(
      UserProfileSchema.safeParse({ ...base, withdrawalTaxRate: 0.7 }).success
    ).toBe(false)
  })
})
