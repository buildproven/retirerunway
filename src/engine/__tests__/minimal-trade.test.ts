import { describe, it, expect } from 'vitest'
import type { Portfolio, UserProfile, Account, Holding } from '../types'
import { generateMinimalTradePlan, generateTradePlan } from '../trade-plan'

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

describe('generateMinimalTradePlan', () => {
  it('returns empty trades when cash target is met', () => {
    const portfolio = makePortfolio([makeAccount({ cashBalance: 200000 })])
    const result = generateMinimalTradePlan(portfolio, makeProfile())
    expect(result.trades).toHaveLength(0)
  })

  it('prefers fewer larger trades over many small ones', () => {
    const holdings = [
      makeHolding({
        id: 'h-big',
        symbol: 'BIG',
        currentValue: 200000,
        costBasis: 150000,
      }),
      makeHolding({
        id: 'h-sm1',
        symbol: 'SM1',
        currentValue: 10000,
        costBasis: 8000,
      }),
      makeHolding({
        id: 'h-sm2',
        symbol: 'SM2',
        currentValue: 10000,
        costBasis: 8000,
      }),
      makeHolding({
        id: 'h-sm3',
        symbol: 'SM3',
        currentValue: 10000,
        costBasis: 8000,
      }),
    ]
    const portfolio = makePortfolio([makeAccount({ holdings, cashBalance: 0 })])
    const result = generateMinimalTradePlan(portfolio, makeProfile(), {
      targetCashPosition: 50000,
    })

    // Should use 1 trade from the big holding instead of multiple small ones
    expect(result.trades.length).toBeLessThanOrEqual(2)
    expect(result.trades[0].holdingId).toBe('h-big')
  })

  it('uses fewer trades than standard plan for same target', () => {
    const holdings = Array.from({ length: 10 }, (_, i) =>
      makeHolding({
        id: `h-${i}`,
        symbol: `S${i}`,
        currentValue: 20000,
        costBasis: 15000,
      })
    )
    // Add one large holding
    holdings.push(
      makeHolding({
        id: 'h-large',
        symbol: 'LARGE',
        currentValue: 200000,
        costBasis: 150000,
      })
    )

    const portfolio = makePortfolio([makeAccount({ holdings, cashBalance: 0 })])
    const profile = makeProfile()

    const standard = generateTradePlan(portfolio, profile, {
      targetCashPosition: 100000,
    })
    const minimal = generateMinimalTradePlan(portfolio, profile, {
      targetCashPosition: 100000,
    })

    expect(minimal.trades.length).toBeLessThanOrEqual(standard.trades.length)
  })

  it('respects max trades cap of 10', () => {
    const holdings = Array.from({ length: 20 }, (_, i) =>
      makeHolding({
        id: `h-${i}`,
        symbol: `S${i}`,
        currentValue: 5000,
        costBasis: 4000,
      })
    )
    const portfolio = makePortfolio([makeAccount({ holdings, cashBalance: 0 })])
    const result = generateMinimalTradePlan(portfolio, makeProfile(), {
      targetCashPosition: 200000,
    })
    expect(result.trades.length).toBeLessThanOrEqual(10)
  })

  it('uses $5K trade increments', () => {
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 500000, costBasis: 400000 })],
        cashBalance: 0,
      }),
    ])
    const result = generateMinimalTradePlan(portfolio, makeProfile(), {
      targetCashPosition: 47000,
    })

    for (const trade of result.trades) {
      // Should be a multiple of $5000 (or the full holding value)
      const remainder = trade.estimatedValue % 5000
      const isMultipleOf5K = remainder === 0 || trade.estimatedValue === 500000
      expect(isMultipleOf5K).toBe(true)
    }
  })

  it('sells from taxable before tax-advantaged', () => {
    const portfolio = makePortfolio([
      makeAccount({
        id: 'brokerage',
        accountType: 'brokerage',
        holdings: [makeHolding({ id: 'h-tax', currentValue: 100000 })],
        cashBalance: 0,
      }),
      makeAccount({
        id: 'ira',
        accountType: 'traditional_ira',
        holdings: [makeHolding({ id: 'h-ira', currentValue: 100000 })],
        cashBalance: 0,
      }),
    ])
    const result = generateMinimalTradePlan(portfolio, makeProfile(), {
      targetCashPosition: 50000,
    })
    expect(result.trades[0].accountId).toBe('brokerage')
  })

  it('assigns sequential priority numbers', () => {
    const holdings = Array.from({ length: 5 }, (_, i) =>
      makeHolding({
        id: `h-${i}`,
        symbol: `S${i}`,
        currentValue: 30000,
        costBasis: 25000,
      })
    )
    const portfolio = makePortfolio([makeAccount({ holdings, cashBalance: 0 })])
    const result = generateMinimalTradePlan(portfolio, makeProfile())
    for (let i = 0; i < result.trades.length; i++) {
      expect(result.trades[i].priority).toBe(i + 1)
    }
  })
})
