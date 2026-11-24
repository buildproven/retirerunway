// Withdrawal order (REQ-MCP-70) and stock-share glide path (REQ-MCP-71).
// Invented household only.
import { describe, expect, it } from 'vitest'
import { proposePlanPolicy } from '../plan-policy'
import { glideShareAt, projectRetirement } from '../retirement-projection'
import type { AccountType, Holding, Portfolio, UserProfile } from '../types'
import { exploreWithdrawalOrders } from '../withdrawal-order'

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
    shares: 1,
    costBasis: value * 0.6,
    currentPrice: value,
    currentValue: value,
  }
}
function account(
  id: string,
  accountType: AccountType,
  stocks: number,
  bonds: number
) {
  return {
    id,
    name: id,
    institution: 'Broker',
    accountType,
    cashBalance: 0,
    cds: [],
    holdings: [
      holding(`${id}s`, 'us_equity', stocks),
      holding(`${id}b`, 'us_bond', bonds),
    ],
  }
}
const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    account('k', '401k', 500_000, 250_000),
    account('t', 'brokerage', 150_000, 50_000),
    account('r', 'roth_ira', 40_000, 10_000),
  ],
}
const profile: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 60,
  annualExpenses: 60_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  stateTaxRate: 0.04,
  separationAge: 60,
}
const run = { seed: 42, paths: 200 }

describe('glideShareAt', () => {
  const path = [
    { age: 60, equityShare: 0.6 },
    { age: 70, equityShare: 0.4 },
  ]
  it('joins points with straight lines and holds the ends', () => {
    expect(glideShareAt(path, 55, 0.5)).toBe(0.6)
    expect(glideShareAt(path, 65, 0.5)).toBeCloseTo(0.5)
    expect(glideShareAt(path, 80, 0.5)).toBe(0.4)
    expect(glideShareAt(undefined, 65, 0.55)).toBe(0.55)
    // Unsorted input is sorted first.
    expect(glideShareAt([...path].reverse(), 62, 0)).toBeCloseTo(0.56)
  })

  it('changes the projection only when a path is saved', () => {
    const base = projectRetirement(portfolio, profile, run)
    const flatSame = projectRetirement(
      portfolio,
      { ...profile, glidePath: [{ age: 58, equityShare: 0.69 }] },
      run
    )
    // The snapshot is 69% stocks: a flat 69% path gives the same result.
    expect(flatSame.monteCarlo.successRate).toBe(base.monteCarlo.successRate)
    const allBonds = projectRetirement(
      portfolio,
      { ...profile, glidePath: [{ age: 58, equityShare: 0.2 }] },
      run
    )
    expect(allBonds.expectedPath.years.at(-1)?.endBalances.total).toBeLessThan(
      base.expectedPath.years.at(-1)?.endBalances.total ?? 0
    )
  })
})

describe('withdrawal order', () => {
  const at = (
    order: 'taxableFirst' | 'preTaxFirst' | 'proportional',
    age: number
  ) =>
    projectRetirement(
      portfolio,
      { ...profile, withdrawalOrder: order },
      run
    ).expectedPath.years.find(y => y.age === age)

  it('taxable first spends the brokerage account before the 401(k)', () => {
    const y = at('taxableFirst', 61)
    expect(y?.withdrawals.taxable).toBeGreaterThan(0)
    expect(y?.withdrawals.employerPlan).toBe(0)
  })

  it('pre-tax first spends the 401(k) before the brokerage account', () => {
    const y = at('preTaxFirst', 61)
    expect(y?.withdrawals.employerPlan).toBeGreaterThan(0)
    expect(y?.withdrawals.taxable).toBe(0)
  })

  it('proportional takes from every open account', () => {
    const y = at('proportional', 61)
    expect(y?.withdrawals.taxable).toBeGreaterThan(0)
    expect(y?.withdrawals.employerPlan).toBeGreaterThan(
      y?.withdrawals.taxable ?? 0
    )
    expect(y?.withdrawals.roth).toBeGreaterThan(0)
  })

  it('compares orders on one seed and is deterministic', () => {
    const a = exploreWithdrawalOrders(portfolio, profile, undefined, run)
    const b = exploreWithdrawalOrders(portfolio, profile, undefined, run)
    expect(a).toEqual(b)
    expect(a.orders.map(o => o.name)).toHaveLength(4)
    expect(a.current).toBe('taxableFirst')
    const current = a.orders.find(o => o.name === 'Taxable first')
    expect(current?.vsCurrent.successRate).toBe(0)
    const best = a.orders.find(o => o.name === a.best)
    for (const o of a.orders)
      expect(best?.successRate ?? 0).toBeGreaterThanOrEqual(o.successRate)
    // Pre-tax first pays more tax up front than taxable first, which spends basis.
    const preTax = a.orders.find(o => o.order === 'preTaxFirst')
    expect(preTax?.lifetimeTax).not.toBe(current?.lifetimeTax)
    expect(a.headline.length).toBeGreaterThan(10)
  })
})

describe('propose_plan_rules glide path test', () => {
  it('scores a constant share and the glide paths on one seed', () => {
    const p = proposePlanPolicy(
      portfolio,
      { ...profile, planRules: { targetEquityShare: 0.6 } },
      '2026-11-24',
      run
    )
    const t =
      (p.findings.find(f => f.rule === 'targetEquityShare')
        ?.proposed as number) ?? 0
    expect(p.glideTest.rows.map(r => r.name)).toEqual([
      `Constant ${(t * 100).toFixed(1)}%`,
      'Bond tent',
      'Rising after retirement',
    ])
    const tent = p.glideTest.rows[1]
    expect(tent.points.map(x => x.age)).toEqual([58, 60, 70])
    expect(tent.points[1].equityShare).toBeCloseTo(Math.max(0.2, t - 0.15))
    for (const r of p.glideTest.rows)
      expect(r.worse).toBe(Math.min(r.successRate, r.forecastSuccessRate))
    const finding = p.findings.find(f => f.rule === 'glidePath')
    if (p.glideTest.proposed === null) expect(finding).toBeUndefined()
    else expect(finding?.status).toBe('add')
  })
})
