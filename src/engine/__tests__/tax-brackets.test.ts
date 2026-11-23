import { describe, it, expect } from 'vitest'
import {
  calculateOrdinaryTax,
  calculateCapitalGainsTax,
  calculateTaxBreakdown,
  estimateWithdrawalTax,
  getStandardDeduction,
  getFederalBrackets,
} from '../tax-brackets'
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
    name: 'Brokerage',
    institution: 'Fidelity',
    accountType: 'brokerage',
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
    currentAge: 58,
    targetRetirementAge: 60,
    annualExpenses: 60000,
    ...overrides,
  }
}

describe('calculateOrdinaryTax', () => {
  it('returns 0 for 0 income', () => {
    const result = calculateOrdinaryTax(0, 'single')
    expect(result.total).toBe(0)
    expect(result.brackets).toHaveLength(0)
  })

  it('calculates tax in the lowest bracket', () => {
    const result = calculateOrdinaryTax(10000, 'single')
    expect(result.total).toBe(1000) // 10% of $10,000
    expect(result.marginalRate).toBe(0.1)
    expect(result.brackets).toHaveLength(1)
  })

  it('calculates tax spanning multiple brackets for single filer', () => {
    // $50,000 taxable income (single):
    // 10% on first $11,925 = $1,192.50
    // 12% on $11,925–$48,475 = $4,386.00
    // 22% on $48,475–$50,000 = $335.50
    const result = calculateOrdinaryTax(50000, 'single')
    expect(result.total).toBeCloseTo(5914, 0)
    expect(result.marginalRate).toBe(0.22)
    expect(result.brackets).toHaveLength(3)
  })

  it('handles married filing jointly brackets', () => {
    const result = calculateOrdinaryTax(50000, 'married_filing_jointly')
    // $50,000 MFJ: 10% on $23,850 + 12% on remainder
    expect(result.total).toBeCloseTo(5523, 0)
    expect(result.marginalRate).toBe(0.12)
  })

  it('handles head of household brackets', () => {
    const result = calculateOrdinaryTax(50000, 'head_of_household')
    expect(result.total).toBeGreaterThan(0)
    expect(result.marginalRate).toBe(0.12)
  })
})

describe('calculateCapitalGainsTax', () => {
  it('returns 0 for zero capital gains', () => {
    const result = calculateCapitalGainsTax(0, 50000, 'single')
    expect(result).toBe(0)
  })

  it('returns 0 for negative capital gains', () => {
    const result = calculateCapitalGainsTax(-5000, 50000, 'single')
    expect(result).toBe(0)
  })

  it('applies 0% rate for gains within the 0% bracket', () => {
    // Single: 0% up to $48,350. If ordinary income is $30,000,
    // gains up to $18,350 should be at 0%
    const result = calculateCapitalGainsTax(10000, 30000, 'single')
    expect(result).toBe(0)
  })

  it('applies 15% rate for gains in the middle bracket', () => {
    // Single with $60,000 ordinary income: all gains are in the 15% bracket
    const result = calculateCapitalGainsTax(50000, 60000, 'single')
    expect(result).toBe(7500) // 15% of $50,000
  })
})

describe('calculateTaxBreakdown', () => {
  it('returns a full breakdown with all fields', () => {
    const result = calculateTaxBreakdown(80000, 20000, 'single', 0.05)
    expect(result.filingStatus).toBe('single')
    expect(result.ordinaryIncome).toBe(80000)
    expect(result.capitalGainsIncome).toBe(20000)
    expect(result.ordinaryTax).toBeGreaterThan(0)
    expect(result.totalTax).toBeGreaterThan(result.ordinaryTax)
    expect(result.effectiveRate).toBeGreaterThan(0)
    expect(result.effectiveRate).toBeLessThan(0.4)
    expect(result.stateTax).toBeCloseTo(5000, 0)
  })

  it('applies standard deduction to ordinary income', () => {
    const deduction = getStandardDeduction('single')
    // Income below standard deduction = no ordinary tax
    const result = calculateTaxBreakdown(deduction - 100, 0, 'single')
    expect(result.ordinaryTax).toBe(0)
  })

  it('handles zero income', () => {
    const result = calculateTaxBreakdown(0, 0, 'single')
    expect(result.totalTax).toBe(0)
    expect(result.effectiveRate).toBe(0)
  })
})

describe('estimateWithdrawalTax', () => {
  it('estimates tax for brokerage withdrawals (partial gains)', () => {
    const portfolio = makePortfolio([makeAccount()])
    const profile = makeProfile()
    const estimates = estimateWithdrawalTax(portfolio, profile, 60000, 'single')
    expect(estimates).toHaveLength(1)
    expect(estimates[0].accountType).toBe('brokerage')
    expect(estimates[0].taxableAmount).toBeLessThan(
      estimates[0].withdrawalAmount
    )
  })

  it('estimates Roth withdrawals as tax-free', () => {
    const portfolio = makePortfolio([
      makeAccount({ id: 'roth-1', accountType: 'roth_ira', name: 'Roth IRA' }),
    ])
    const profile = makeProfile()
    const estimates = estimateWithdrawalTax(portfolio, profile, 60000, 'single')
    expect(estimates[0].taxableAmount).toBe(0)
    expect(estimates[0].estimatedTax).toBe(0)
  })

  it('estimates pre-tax withdrawals as fully taxable', () => {
    const portfolio = makePortfolio([
      makeAccount({
        id: 'trad-1',
        accountType: 'traditional_ira',
        name: 'Trad IRA',
      }),
    ])
    const profile = makeProfile({ federalTaxBracket: 0.22 })
    const estimates = estimateWithdrawalTax(portfolio, profile, 60000, 'single')
    expect(estimates[0].taxableAmount).toBe(estimates[0].withdrawalAmount)
    expect(estimates[0].estimatedTax).toBeGreaterThan(0)
  })

  it('handles empty portfolio', () => {
    const portfolio = makePortfolio([])
    const profile = makeProfile()
    const estimates = estimateWithdrawalTax(portfolio, profile, 60000, 'single')
    expect(estimates).toHaveLength(0)
  })
})

describe('getStandardDeduction', () => {
  it('returns correct deductions for each filing status', () => {
    expect(getStandardDeduction('single')).toBe(15700)
    expect(getStandardDeduction('married_filing_jointly')).toBe(31400)
    expect(getStandardDeduction('head_of_household')).toBe(23550)
  })
})

describe('getFederalBrackets', () => {
  it('returns 7 brackets for single', () => {
    const brackets = getFederalBrackets('single')
    expect(brackets).toHaveLength(7)
    expect(brackets[0].rate).toBe(0.1)
    expect(brackets[6].rate).toBe(0.37)
  })

  it('returns a copy, not the original', () => {
    const a = getFederalBrackets('single')
    const b = getFederalBrackets('single')
    a[0].rate = 999
    expect(b[0].rate).toBe(0.1)
  })
})
