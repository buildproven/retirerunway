import { describe, it, expect } from 'vitest'
import type { Portfolio, UserProfile, Account, Holding, CD } from '../types'
import { generateLadderPlan } from '../ladder-plan'

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

function makeCD(overrides: Partial<CD> = {}): CD {
  return {
    id: 'cd-1',
    institution: 'Fidelity',
    principal: 50000,
    apy: 0.05,
    termMonths: 12,
    maturityDate: '2027-06-15',
    purchaseDate: '2026-06-15',
    earlyWithdrawalPenaltyMonths: 3,
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

describe('generateLadderPlan', () => {
  it('returns empty ladder for zero expenses', () => {
    const result = generateLadderPlan(
      makePortfolio(),
      makeProfile({ annualExpenses: 0 })
    )
    expect(result.rungs).toHaveLength(0)
    expect(result.totalFunded).toBe(0)
    expect(result.yearsOfExpensesCovered).toBe(0)
  })

  it('returns empty ladder for zero coverage years', () => {
    const result = generateLadderPlan(makePortfolio(), makeProfile(), {
      yearsOfCoverage: 0,
    })
    expect(result.rungs).toHaveLength(0)
  })

  it('uses cash first for year 1', () => {
    const portfolio = makePortfolio([
      makeAccount({ cashBalance: 100000, holdings: [], cds: [] }),
    ])
    const result = generateLadderPlan(portfolio, makeProfile(), {
      yearsOfCoverage: 1,
    })
    expect(result.rungs).toHaveLength(1)
    expect(result.rungs[0].source).toBe('cash')
    expect(result.rungs[0].amount).toBe(60000)
  })

  it('includes money market holdings as cash', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 10000,
        holdings: [
          makeHolding({
            id: 'mm-1',
            symbol: 'SPAXX',
            assetClass: 'money_market',
            currentValue: 50000,
          }),
        ],
        cds: [],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 60000 }),
      { yearsOfCoverage: 1 }
    )
    expect(result.rungs[0].source).toBe('cash')
    expect(result.rungs[0].amount).toBe(60000)
  })

  it('assigns CDs to the year they mature', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 60000,
        holdings: [],
        cds: [
          makeCD({ id: 'cd-1', principal: 60000, maturityDate: '2028-06-15' }),
        ],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 60000 }),
      { yearsOfCoverage: 3 }
    )

    const cashRung = result.rungs.find(r => r.source === 'cash')
    const cdRung = result.rungs.find(r => r.source === 'cd')
    expect(cashRung).toBeDefined()
    expect(cdRung).toBeDefined()
    expect(cdRung!.year).toBe(2028)
    expect(cdRung!.cdId).toBe('cd-1')
  })

  it('falls back to bonds when cash and CDs are insufficient', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 0,
        holdings: [
          makeHolding({
            id: 'bond-1',
            symbol: 'BND',
            assetClass: 'us_bond',
            currentValue: 100000,
          }),
        ],
        cds: [],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 40000 }),
      { yearsOfCoverage: 2 }
    )
    const bondRungs = result.rungs.filter(r => r.source === 'bond')
    expect(bondRungs.length).toBeGreaterThan(0)
  })

  it('falls back to equity sells as last resort', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 0,
        holdings: [
          makeHolding({ currentValue: 500000, assetClass: 'us_equity' }),
        ],
        cds: [],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 60000 }),
      { yearsOfCoverage: 2 }
    )
    const equityRungs = result.rungs.filter(r => r.source === 'sell_equity')
    expect(equityRungs.length).toBeGreaterThan(0)
  })

  it('builds multi-source rungs in priority order', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 30000,
        holdings: [
          makeHolding({
            id: 'bond-1',
            symbol: 'BND',
            assetClass: 'us_bond',
            currentValue: 50000,
          }),
          makeHolding({
            id: 'eq-1',
            symbol: 'VTI',
            assetClass: 'us_equity',
            currentValue: 200000,
          }),
        ],
        cds: [],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 60000 }),
      { yearsOfCoverage: 3 }
    )
    // Year 1: 30k cash + 30k bond
    // Year 2: 20k bond + 40k equity
    // Year 3: 60k equity
    expect(result.totalFunded).toBe(180000)
    expect(result.yearsOfExpensesCovered).toBe(3)
  })

  it('defaults to 5 years of coverage', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 500000,
        holdings: [],
        cds: [],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 60000 })
    )
    expect(result.yearsOfExpensesCovered).toBe(5)
    expect(result.totalFunded).toBe(300000)
  })

  it('reports partial coverage when assets are insufficient', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 30000,
        holdings: [],
        cds: [],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 60000 }),
      { yearsOfCoverage: 3 }
    )
    expect(result.totalFunded).toBe(30000)
    expect(result.yearsOfExpensesCovered).toBe(0.5)
  })

  it('handles empty portfolio', () => {
    const portfolio = makePortfolio([
      makeAccount({ cashBalance: 0, holdings: [], cds: [] }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 60000 }),
      { yearsOfCoverage: 3 }
    )
    expect(result.rungs).toHaveLength(0)
    expect(result.totalFunded).toBe(0)
    expect(result.yearsOfExpensesCovered).toBe(0)
  })

  it('sets annualExpenseTarget from profile', () => {
    const result = generateLadderPlan(
      makePortfolio(),
      makeProfile({ annualExpenses: 75000 })
    )
    expect(result.annualExpenseTarget).toBe(75000)
  })

  it('spreads cash across multiple years', () => {
    const portfolio = makePortfolio([
      makeAccount({ cashBalance: 150000, holdings: [], cds: [] }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 50000 }),
      { yearsOfCoverage: 3 }
    )
    expect(result.rungs).toHaveLength(3)
    expect(result.rungs.every(r => r.source === 'cash')).toBe(true)
    expect(result.totalFunded).toBe(150000)
  })

  it('includes TIPS and international bonds as bond sources', () => {
    const portfolio = makePortfolio([
      makeAccount({
        cashBalance: 0,
        holdings: [
          makeHolding({
            id: 'tips-1',
            symbol: 'VTIP',
            assetClass: 'tips',
            currentValue: 30000,
          }),
          makeHolding({
            id: 'intl-bond-1',
            symbol: 'BNDX',
            assetClass: 'intl_bond',
            currentValue: 30000,
          }),
        ],
        cds: [],
      }),
    ])
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 50000 }),
      { yearsOfCoverage: 1 }
    )
    const bondRungs = result.rungs.filter(r => r.source === 'bond')
    expect(bondRungs.length).toBeGreaterThan(0)
    expect(result.totalFunded).toBe(50000)
  })

  it('assigns correct year numbers starting from portfolio date + 1', () => {
    const portfolio = makePortfolio([
      makeAccount({ cashBalance: 200000, holdings: [], cds: [] }),
    ])
    portfolio.asOfDate = '2026-06-15'
    const result = generateLadderPlan(
      portfolio,
      makeProfile({ annualExpenses: 50000 }),
      { yearsOfCoverage: 3 }
    )
    expect(result.rungs[0].year).toBe(2027)
    expect(result.rungs[1].year).toBe(2028)
    expect(result.rungs[2].year).toBe(2029)
  })
})
