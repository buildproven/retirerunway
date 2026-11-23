import { describe, it, expect } from 'vitest'
import type { Portfolio, UserProfile, Account } from '../types'
import { analyzeRuleOf55 } from '../rule-of-55'

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    name: 'My 401k',
    institution: 'Fidelity',
    accountType: '401k',
    holdings: [
      {
        id: 'h-1',
        symbol: 'VTI',
        name: 'Vanguard Total Stock',
        assetClass: 'us_equity',
        shares: 1000,
        costBasis: 150000,
        currentPrice: 200,
        currentValue: 200000,
      },
    ],
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
    currentAge: 53,
    targetRetirementAge: 55,
    annualExpenses: 60000,
    ...overrides,
  }
}

describe('analyzeRuleOf55', () => {
  it('detects eligibility for 401k holder retiring at 55', () => {
    const result = analyzeRuleOf55(makePortfolio(), makeProfile())
    expect(result.eligible).toBe(true)
    expect(result.eligibleAccounts).toHaveLength(1)
    expect(result.totalEligibleValue).toBe(250000)
    expect(result.separationAge).toBe(55)
  })

  it('detects eligibility for 403b holder', () => {
    const portfolio = makePortfolio([
      makeAccount({ accountType: '403b', name: 'My 403b' }),
    ])
    const result = analyzeRuleOf55(portfolio, makeProfile())
    expect(result.eligible).toBe(true)
  })

  it('not eligible if retiring before 55', () => {
    const result = analyzeRuleOf55(
      makePortfolio(),
      makeProfile({ targetRetirementAge: 50 })
    )
    expect(result.eligible).toBe(false)
    expect(result.separationAge).toBeNull()
  })

  it('not needed if retiring at 60 (past 59.5)', () => {
    const result = analyzeRuleOf55(
      makePortfolio(),
      makeProfile({ targetRetirementAge: 60 })
    )
    expect(result.eligible).toBe(false)
    expect(result.guidancePoints[0]).toContain('59½')
  })

  it('not eligible with only IRA accounts', () => {
    const portfolio = makePortfolio([
      makeAccount({ accountType: 'traditional_ira', name: 'IRA' }),
    ])
    const result = analyzeRuleOf55(portfolio, makeProfile())
    expect(result.eligible).toBe(false)
    expect(result.guidancePoints[0]).toContain('No 401(k)')
  })

  it('includes multiple eligible accounts', () => {
    const portfolio = makePortfolio([
      makeAccount({ id: 'a1', name: '401k', accountType: '401k' }),
      makeAccount({ id: 'a2', name: 'Roth 401k', accountType: 'roth_401k' }),
    ])
    const result = analyzeRuleOf55(portfolio, makeProfile())
    expect(result.eligible).toBe(true)
    expect(result.eligibleAccounts).toHaveLength(2)
    expect(result.totalEligibleValue).toBe(500000)
  })

  it('mentions 457b supplement when present', () => {
    const portfolio = makePortfolio([
      makeAccount({ id: 'a1', accountType: '401k' }),
      makeAccount({ id: 'a2', accountType: '457b', name: '457b' }),
    ])
    const result = analyzeRuleOf55(portfolio, makeProfile())
    const has457bGuidance = result.guidancePoints.some(p =>
      p.includes('457(b)')
    )
    expect(has457bGuidance).toBe(true)
  })

  it('calculates gap funding correctly', () => {
    const bigPortfolio = makePortfolio([makeAccount({ cashBalance: 500000 })])
    const profile = makeProfile({
      targetRetirementAge: 55,
      annualExpenses: 60000,
    })
    const result = analyzeRuleOf55(bigPortfolio, profile)
    const gapPoint = result.guidancePoints.find(p =>
      p.toLowerCase().includes('gap')
    )
    expect(gapPoint).toBeDefined()
    expect(gapPoint).toContain('5-year')
  })

  it('identifies gap funding shortfall', () => {
    const smallPortfolio = makePortfolio([
      makeAccount({ holdings: [], cashBalance: 10000 }),
    ])
    const profile = makeProfile({ annualExpenses: 100000 })
    const result = analyzeRuleOf55(smallPortfolio, profile)
    const shortfall = result.guidancePoints.find(p => p.includes('shortfall'))
    expect(shortfall).toBeDefined()
  })
})
