import { describe, it, expect } from 'vitest'
import type { Portfolio, UserProfile, Account, Holding } from '../types'
import { generateTradePlan } from '../trade-plan'

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

describe('generateTradePlan', () => {
  it('returns empty trades when cash target is already met', () => {
    const portfolio = makePortfolio([makeAccount({ cashBalance: 200000 })])
    const result = generateTradePlan(portfolio, makeProfile())
    expect(result.trades).toHaveLength(0)
    expect(result.totalProceeds).toBe(0)
  })

  it('generates trades to meet cash target', () => {
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 500000, costBasis: 400000 })],
        cashBalance: 10000,
      }),
    ])
    const result = generateTradePlan(portfolio, makeProfile())
    expect(result.trades.length).toBeGreaterThan(0)
    expect(result.totalProceeds).toBeGreaterThan(0)
  })

  it('defaults to 2x annual expenses as target', () => {
    const profile = makeProfile({ annualExpenses: 60000 })
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 500000 })],
        cashBalance: 0,
      }),
    ])
    const result = generateTradePlan(portfolio, profile)
    expect(result.targetCashPosition).toBe(120000)
  })

  it('respects custom target cash position', () => {
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 500000 })],
        cashBalance: 0,
      }),
    ])
    const result = generateTradePlan(portfolio, makeProfile(), {
      targetCashPosition: 50000,
    })
    expect(result.targetCashPosition).toBe(50000)
  })

  it('respects max trades limit', () => {
    const holdings = Array.from({ length: 20 }, (_, i) =>
      makeHolding({
        id: `h-${i}`,
        symbol: `SYM${i}`,
        currentValue: 10000,
        costBasis: 8000,
      })
    )
    const portfolio = makePortfolio([makeAccount({ holdings, cashBalance: 0 })])
    const result = generateTradePlan(portfolio, makeProfile(), {
      maxTrades: 5,
      targetCashPosition: 200000,
    })
    expect(result.trades.length).toBeLessThanOrEqual(5)
  })

  it('sells from taxable accounts before tax-advantaged', () => {
    const portfolio = makePortfolio([
      makeAccount({
        id: 'brokerage',
        name: 'Taxable Brokerage',
        accountType: 'brokerage',
        holdings: [
          makeHolding({ id: 'h-tax', currentValue: 50000, costBasis: 40000 }),
        ],
        cashBalance: 0,
      }),
      makeAccount({
        id: 'ira',
        name: 'Traditional IRA',
        accountType: 'traditional_ira',
        holdings: [
          makeHolding({ id: 'h-ira', currentValue: 50000, costBasis: 40000 }),
        ],
        cashBalance: 0,
      }),
    ])
    const result = generateTradePlan(portfolio, makeProfile(), {
      targetCashPosition: 30000,
    })
    expect(result.trades.length).toBeGreaterThan(0)
    expect(result.trades[0].accountId).toBe('brokerage')
  })

  it('estimates tax impact for taxable sells', () => {
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 200000, costBasis: 100000 })],
        cashBalance: 0,
      }),
    ])
    const result = generateTradePlan(
      portfolio,
      makeProfile({ federalTaxBracket: 0.22 })
    )
    expect(result.totalTaxImpact).toBeGreaterThan(0)
  })

  it('has zero tax impact for Roth sells', () => {
    const portfolio = makePortfolio([
      makeAccount({
        accountType: 'roth_ira',
        name: 'Roth IRA',
        holdings: [makeHolding({ currentValue: 200000, costBasis: 100000 })],
        cashBalance: 0,
      }),
    ])
    const result = generateTradePlan(portfolio, makeProfile())
    expect(result.totalTaxImpact).toBe(0)
  })

  it('skips non-equity holdings', () => {
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [
          makeHolding({
            id: 'bond',
            assetClass: 'us_bond',
            currentValue: 500000,
          }),
        ],
        cashBalance: 0,
      }),
    ])
    const result = generateTradePlan(portfolio, makeProfile(), {
      targetCashPosition: 50000,
    })
    expect(result.trades).toHaveLength(0)
  })

  it('assigns sequential priority numbers', () => {
    const holdings = Array.from({ length: 5 }, (_, i) =>
      makeHolding({
        id: `h-${i}`,
        symbol: `SYM${i}`,
        currentValue: 30000,
        costBasis: 25000,
      })
    )
    const portfolio = makePortfolio([makeAccount({ holdings, cashBalance: 0 })])
    const result = generateTradePlan(portfolio, makeProfile())
    for (let i = 0; i < result.trades.length; i++) {
      expect(result.trades[i].priority).toBe(i + 1)
    }
  })

  it('includes rationale for each trade', () => {
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 200000 })],
        cashBalance: 0,
      }),
    ])
    const result = generateTradePlan(portfolio, makeProfile())
    for (const trade of result.trades) {
      expect(trade.rationale.length).toBeGreaterThan(0)
      expect(trade.rationale).toContain('VTI')
    }
  })
})
