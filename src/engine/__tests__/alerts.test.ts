import { describe, it, expect } from 'vitest'
import { generateAlerts, getAssetClassAllocation } from '../alerts'
import type { Portfolio, UserProfile, Account, Holding, CD } from '../types'

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

describe('generateAlerts', () => {
  it('returns alerts sorted by severity (critical first)', () => {
    const alerts = generateAlerts(makePortfolio(), makeProfile())
    for (let i = 0; i < alerts.length - 1; i++) {
      const severityOrder = { critical: 0, warning: 1, info: 2 } as const
      const current = severityOrder[alerts[i].severity]
      const next = severityOrder[alerts[i + 1].severity]
      expect(current).toBeLessThanOrEqual(next)
    }
  })

  it('detects high equity allocation drift', () => {
    // Portfolio is nearly all equity with target at 60%
    const highEquity = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 900000 })],
        cashBalance: 10000,
      }),
    ])
    const alerts = generateAlerts(highEquity, makeProfile(), {
      targetEquityAllocation: 0.6,
      equityDriftThreshold: 0.1,
    })
    const driftAlerts = alerts.filter(a => a.category === 'allocation_drift')
    expect(driftAlerts.length).toBeGreaterThan(0)
    expect(driftAlerts[0].message).toContain('above')
  })

  it('detects concentration risk', () => {
    // One holding is 80% of portfolio
    const concentrated = makePortfolio([
      makeAccount({
        holdings: [
          makeHolding({ id: 'big', currentValue: 800000 }),
          makeHolding({ id: 'small', currentValue: 50000 }),
        ],
        cashBalance: 150000,
      }),
    ])
    const alerts = generateAlerts(concentrated, makeProfile(), {
      concentrationThreshold: 0.25,
    })
    const concAlerts = alerts.filter(a => a.category === 'concentration')
    expect(concAlerts.length).toBeGreaterThan(0)
    expect(concAlerts[0].title).toContain('VTI')
  })

  it('detects low cash buffer', () => {
    const lowCash = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 500000 })],
        cashBalance: 10000,
      }),
    ])
    const alerts = generateAlerts(
      lowCash,
      makeProfile({ annualExpenses: 60000 }),
      { cashBufferMinYears: 1 }
    )
    const cashAlerts = alerts.filter(a => a.category === 'cash_buffer')
    expect(cashAlerts.length).toBeGreaterThan(0)
  })

  it('detects high withdrawal rate', () => {
    const smallPortfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 300000 })],
        cashBalance: 10000,
      }),
    ])
    const alerts = generateAlerts(
      smallPortfolio,
      makeProfile({ annualExpenses: 100000 }),
      { withdrawalRateMax: 0.05 }
    )
    const wrAlerts = alerts.filter(a => a.category === 'withdrawal_rate')
    expect(wrAlerts.length).toBeGreaterThan(0)
  })

  it('detects upcoming CD maturities', () => {
    // CD maturing in 30 days
    const soon = new Date()
    soon.setDate(soon.getDate() + 30)
    const cd: CD = {
      id: 'cd-1',
      institution: 'Ally',
      principal: 50000,
      apy: 0.045,
      termMonths: 12,
      maturityDate: soon.toISOString().split('T')[0],
      purchaseDate: '2025-06-01',
      earlyWithdrawalPenaltyMonths: 3,
    }
    const portfolioWithCD = makePortfolio([makeAccount({ cds: [cd] })])
    const alerts = generateAlerts(portfolioWithCD, makeProfile(), {
      cdMaturityWindowDays: 90,
    })
    const cdAlerts = alerts.filter(a => a.category === 'cd_maturity')
    expect(cdAlerts.length).toBe(1)
    expect(cdAlerts[0].title).toMatch(/\d+ days/)
  })

  it('returns no alerts for well-balanced portfolio', () => {
    const balanced = makePortfolio([
      makeAccount({
        holdings: [
          makeHolding({ id: 'eq', currentValue: 300000 }),
          makeHolding({
            id: 'bond',
            assetClass: 'us_bond',
            currentValue: 150000,
          }),
        ],
        cashBalance: 120000,
      }),
    ])
    const alerts = generateAlerts(
      balanced,
      makeProfile({ annualExpenses: 40000 }),
      {
        targetEquityAllocation: 0.53,
        equityDriftThreshold: 0.15,
        concentrationThreshold: 0.6,
        cashBufferMinYears: 1,
        withdrawalRateMax: 0.08,
      }
    )
    expect(alerts).toHaveLength(0)
  })

  it('handles empty portfolio', () => {
    const empty = makePortfolio([])
    const alerts = generateAlerts(empty, makeProfile())
    // Should not crash; may generate cash buffer alert
    expect(Array.isArray(alerts)).toBe(true)
  })

  it('includes money_market and cash holdings in cash buffer calculation', () => {
    const withMoneyMarket = makePortfolio([
      makeAccount({
        holdings: [
          makeHolding({ id: 'eq', currentValue: 300000 }),
          makeHolding({
            id: 'mm',
            assetClass: 'money_market',
            currentValue: 80000,
          }),
        ],
        cashBalance: 5000,
      }),
    ])
    // 85000 in cash-like / 60000 expenses = 1.42 years => above 1 year threshold
    const alerts = generateAlerts(
      withMoneyMarket,
      makeProfile({ annualExpenses: 60000 }),
      { cashBufferMinYears: 1 }
    )
    const cashAlerts = alerts.filter(a => a.category === 'cash_buffer')
    expect(cashAlerts).toHaveLength(0)
  })

  it('REQ-MCP-62 counts only liquid cash: cash inside a 401(k) does not stop the alert', () => {
    const inRetirement = makePortfolio([
      makeAccount({
        accountType: '401k',
        holdings: [makeHolding({ currentValue: 500000 })],
        cashBalance: 120000,
      }),
    ])
    const profile = makeProfile({ annualExpenses: 60000 })
    const cash = generateAlerts(inRetirement, profile, {
      cashBufferMinYears: 1,
    }).filter(a => a.category === 'cash_buffer')
    expect(cash).toHaveLength(1)
    expect(cash[0].metric).toBe(0)
    expect(cash[0].message).toContain(
      'Cash inside a 401(k) or IRA does not count'
    )
    // Bank savings outside the snapshot count toward it.
    const withSavings = generateAlerts(
      inRetirement,
      {
        ...profile,
        planRules: { targetEquityShare: 0.8, outsideCash: 60000 },
      },
      { cashBufferMinYears: 1 }
    ).filter(a => a.category === 'cash_buffer')
    expect(withSavings).toHaveLength(0)
  })

  it('detects critical cash buffer (< 0.5 years)', () => {
    const veryLowCash = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 500000 })],
        cashBalance: 1000,
      }),
    ])
    const alerts = generateAlerts(
      veryLowCash,
      makeProfile({ annualExpenses: 80000 }),
      { cashBufferMinYears: 1 }
    )
    const cashAlerts = alerts.filter(a => a.category === 'cash_buffer')
    expect(cashAlerts.length).toBeGreaterThan(0)
    expect(cashAlerts[0].severity).toBe('critical')
  })

  it('detects critical withdrawal rate (> 1.5x threshold)', () => {
    const tinyPortfolio = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 100000 })],
        cashBalance: 5000,
      }),
    ])
    const alerts = generateAlerts(
      tinyPortfolio,
      makeProfile({ annualExpenses: 100000 }),
      { withdrawalRateMax: 0.05 }
    )
    const wrAlerts = alerts.filter(a => a.category === 'withdrawal_rate')
    expect(wrAlerts.length).toBeGreaterThan(0)
    expect(wrAlerts[0].severity).toBe('critical')
  })

  it('detects equity below target (drift below)', () => {
    const lowEquity = makePortfolio([
      makeAccount({
        holdings: [
          makeHolding({
            id: 'eq',
            assetClass: 'us_equity',
            currentValue: 50000,
          }),
          makeHolding({
            id: 'bond',
            assetClass: 'us_bond',
            currentValue: 400000,
          }),
        ],
        cashBalance: 50000,
      }),
    ])
    const alerts = generateAlerts(lowEquity, makeProfile(), {
      targetEquityAllocation: 0.6,
      equityDriftThreshold: 0.1,
    })
    const driftAlerts = alerts.filter(a => a.category === 'allocation_drift')
    expect(driftAlerts.length).toBeGreaterThan(0)
    expect(driftAlerts[0].message).toContain('below')
  })

  it('detects critical concentration (> 40%)', () => {
    const superConcentrated = makePortfolio([
      makeAccount({
        holdings: [
          makeHolding({ id: 'big', currentValue: 500000 }),
          makeHolding({ id: 'small', currentValue: 10000 }),
        ],
        cashBalance: 10000,
      }),
    ])
    const alerts = generateAlerts(superConcentrated, makeProfile(), {
      concentrationThreshold: 0.25,
    })
    const concAlerts = alerts.filter(a => a.category === 'concentration')
    expect(concAlerts.find(a => a.severity === 'critical')).toBeDefined()
  })

  it('detects critical equity drift (> 2x threshold)', () => {
    const extremeEquity = makePortfolio([
      makeAccount({
        holdings: [makeHolding({ currentValue: 990000 })],
        cashBalance: 10000,
      }),
    ])
    const alerts = generateAlerts(extremeEquity, makeProfile(), {
      targetEquityAllocation: 0.4,
      equityDriftThreshold: 0.1,
    })
    const driftAlerts = alerts.filter(a => a.category === 'allocation_drift')
    expect(driftAlerts[0].severity).toBe('critical')
  })
})

describe('getAssetClassAllocation', () => {
  it('returns allocation percentages by asset class', () => {
    const portfolio = makePortfolio([
      makeAccount({
        holdings: [
          makeHolding({
            id: 'eq',
            assetClass: 'us_equity',
            currentValue: 600000,
          }),
          makeHolding({
            id: 'bond',
            assetClass: 'us_bond',
            currentValue: 200000,
          }),
        ],
        cashBalance: 200000,
      }),
    ])
    const allocation = getAssetClassAllocation(portfolio)
    expect(allocation.us_equity).toBeCloseTo(0.6, 1)
    expect(allocation.us_bond).toBeCloseTo(0.2, 1)
  })

  it('returns empty object for empty portfolio', () => {
    const empty = makePortfolio([])
    const allocation = getAssetClassAllocation(empty)
    expect(Object.keys(allocation)).toHaveLength(0)
  })
})
