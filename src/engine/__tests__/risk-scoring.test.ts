import { describe, it, expect } from 'vitest'
import type { Portfolio, UserProfile, Account, Holding } from '../types'
import { calculateSequenceRisk } from '../risk-scoring'
import { calculatePortfolioTotals } from '../portfolio-math'

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

function makePortfolio(accounts: Account[] = [makeAccount()]): Portfolio {
  return {
    id: 'p-1',
    name: 'Test Portfolio',
    accounts,
    asOfDate: '2026-01-31',
  }
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    currentAge: 58,
    targetRetirementAge: 60,
    annualExpenses: 80000,
    ...overrides,
  }
}

describe('calculateSequenceRisk', () => {
  it('returns a score between 1 and 10', () => {
    const result = calculateSequenceRisk(makePortfolio(), makeProfile())
    expect(result.score).toBeGreaterThanOrEqual(1)
    expect(result.score).toBeLessThanOrEqual(10)
  })

  it('returns high risk for all-equity near retirement with high withdrawal', () => {
    const equityHolding = makeHolding({
      currentValue: 500000,
      assetClass: 'us_equity',
    })
    const portfolio = makePortfolio([
      makeAccount({ holdings: [equityHolding], cashBalance: 0 }),
    ])
    const profile = makeProfile({
      currentAge: 60,
      targetRetirementAge: 60,
      annualExpenses: 50000,
    })
    const result = calculateSequenceRisk(portfolio, profile)
    expect(result.score).toBeGreaterThanOrEqual(7)
    expect(result.label).toMatch(/High/)
  })

  it('returns low risk for bond-heavy portfolio with large cash buffer', () => {
    const bondHolding = makeHolding({
      currentValue: 800000,
      assetClass: 'us_bond',
    })
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [bondHolding],
        cashBalance: 200000,
        cds: [
          {
            id: 'cd-1',
            institution: 'Fidelity',
            principal: 100000,
            apy: 0.05,
            termMonths: 12,
            maturityDate: '2027-01-01',
            purchaseDate: '2026-01-01',
            earlyWithdrawalPenaltyMonths: 3,
          },
        ],
      }),
    ])
    const profile = makeProfile({
      currentAge: 45,
      targetRetirementAge: 60,
      annualExpenses: 40000,
    })
    const result = calculateSequenceRisk(portfolio, profile)
    expect(result.score).toBeLessThanOrEqual(3)
    expect(result.label).toBe('Low')
  })

  it('penalizes concentrated single-holding portfolios', () => {
    const bigHolding = makeHolding({
      id: 'big',
      currentValue: 400000,
      assetClass: 'us_equity',
    })
    const smallHolding = makeHolding({
      id: 'small',
      currentValue: 10000,
      assetClass: 'us_bond',
    })
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [bigHolding, smallHolding],
        cashBalance: 10000,
      }),
    ])
    const result = calculateSequenceRisk(portfolio, makeProfile())
    expect(result.factors.concentrationPenalty).toBeGreaterThanOrEqual(6)
  })

  it('accounts for years to retirement', () => {
    const portfolio = makePortfolio()
    const nearRetirement = calculateSequenceRisk(
      portfolio,
      makeProfile({ currentAge: 59, targetRetirementAge: 60 })
    )
    const farFromRetirement = calculateSequenceRisk(
      portfolio,
      makeProfile({ currentAge: 40, targetRetirementAge: 65 })
    )
    expect(nearRetirement.score).toBeGreaterThan(farFromRetirement.score)
  })

  it('returns label and description', () => {
    const result = calculateSequenceRisk(makePortfolio(), makeProfile())
    expect(typeof result.label).toBe('string')
    expect(result.label.length).toBeGreaterThan(0)
    expect(typeof result.description).toBe('string')
  })

  it('handles empty portfolio gracefully', () => {
    const portfolio = makePortfolio([
      makeAccount({ holdings: [], cds: [], cashBalance: 0 }),
    ])
    const result = calculateSequenceRisk(portfolio, makeProfile())
    expect(result.score).toBeGreaterThanOrEqual(1)
  })

  it('handles zero annual expenses', () => {
    const result = calculateSequenceRisk(
      makePortfolio(),
      makeProfile({ annualExpenses: 0 })
    )
    expect(result.score).toBeGreaterThanOrEqual(1)
  })
})

// BUI-1830: money-market (and cash-class) holdings are cash equivalents, so
// they must count toward totalCash and the sequence-risk cash buffer. Brokers
// such as Fidelity list the core position (SPAXX/FDRXX) as a fund row with no
// separate cashBalance.
describe('BUI-1830 money-market holdings count toward the cash buffer', () => {
  const moneyMarketAccount = (): Account =>
    makeAccount({
      cashBalance: 0,
      holdings: [
        makeHolding({ id: 'h-eq', currentValue: 100000 }),
        makeHolding({
          id: 'h-spaxx',
          symbol: 'SPAXX',
          name: 'Fidelity Government Money Market',
          assetClass: 'money_market',
          shares: 10000,
          costBasis: 10000,
          currentPrice: 1,
          currentValue: 10000,
        }),
        makeHolding({
          id: 'h-fdrxx',
          symbol: 'FDRXX',
          name: 'Fidelity Government Cash Reserves',
          assetClass: 'money_market',
          shares: 3763,
          costBasis: 3763,
          currentPrice: 1,
          currentValue: 3763,
        }),
      ],
    })

  it('counts money-market holdings as cash', () => {
    const summary = calculatePortfolioTotals(
      makePortfolio([moneyMarketAccount()])
    )
    expect(summary.totalCash).toBe(13763)
    // Not double-counted in the total.
    expect(summary.totalValue).toBe(113763)
    expect(summary.allocationByAssetClass.money_market).toBe(13763)
  })

  it('adds money-market holdings to an existing cashBalance', () => {
    const account = { ...moneyMarketAccount(), cashBalance: 2000 }
    const summary = calculatePortfolioTotals(makePortfolio([account]))
    expect(summary.totalCash).toBe(15763)
    expect(summary.totalValue).toBe(115763)
  })

  it('counts cash-class holdings as cash', () => {
    const account = makeAccount({
      cashBalance: 0,
      holdings: [
        makeHolding({ id: 'h-cash', assetClass: 'cash', currentValue: 4000 }),
      ],
    })
    const summary = calculatePortfolioTotals(makePortfolio([account]))
    expect(summary.totalCash).toBe(4000)
  })

  it('does not count equity or bond holdings as cash', () => {
    const account = makeAccount({
      cashBalance: 0,
      holdings: [
        makeHolding({ id: 'h-eq', assetClass: 'us_equity' }),
        makeHolding({ id: 'h-bd', assetClass: 'us_bond' }),
      ],
    })
    const summary = calculatePortfolioTotals(makePortfolio([account]))
    expect(summary.totalCash).toBe(0)
  })

  it('cash buffer includes money-market holdings', () => {
    const result = calculateSequenceRisk(
      makePortfolio([moneyMarketAccount()]),
      makeProfile({ annualExpenses: 100000 })
    )
    expect(result.factors.cashBufferYears).toBeCloseTo(0.13763, 5)
  })
})
