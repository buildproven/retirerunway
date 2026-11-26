// TIPS gap years (REQ-MCP-87): no TIPS mature 2037-2039 until the January
// 10-year auctions create them. Invented household only.
import { describe, expect, it } from 'vitest'
import { proposePlanPolicy } from '../plan-policy'
import {
  lastTipsMaturityBelowGap,
  tipsGapRungs,
  tipsGapYears,
} from '../safe-ladder'
import type { Portfolio, SafeLadder, UserProfile } from '../types'

describe('REQ-MCP-87: TIPS gap years', () => {
  it('REQ-MCP-87 closes one gap year at each January 10-year auction', () => {
    expect(lastTipsMaturityBelowGap('2026-11-25')).toBe(2036)
    expect(tipsGapYears('2026-11-25')).toEqual([2037, 2038, 2039])
    expect(tipsGapYears('2027-01-10')).toEqual([2037, 2038, 2039])
    expect(tipsGapYears('2027-02-01')).toEqual([2038, 2039])
    expect(tipsGapYears('2029-03-01')).toEqual([])
  })

  const profile: UserProfile = {
    currentAge: 53,
    targetRetirementAge: 60,
    annualExpenses: 90_000,
    socialSecurityAge: 67,
    socialSecurityMonthly: 3_500,
  }
  const ladder: SafeLadder = {
    instrument: 'tips',
    accountType: '401k',
    rungs: [60, 61, 62, 63, 64, 65, 66].map(age => ({
      age,
      amount: 100_000,
      yield: 0.03,
    })),
  }

  it('REQ-MCP-87 finds the rungs in gap years, priced at today’s cost', () => {
    const gap = tipsGapRungs(ladder, profile, '2026-11-25')
    expect(gap.map(r => [r.year, r.age, r.auctionYear])).toEqual([
      [2037, 64, 2027],
      [2038, 65, 2028],
      [2039, 66, 2029],
    ])
    // $100,000 in 11 years at 3% real costs $100,000 / 1.03^11 today.
    expect(gap[0].cost).toBeCloseTo(100_000 / Math.pow(1.03, 11), 2)
    expect(
      tipsGapRungs({ ...ladder, instrument: 'cd' }, profile, '2026-11-25')
    ).toEqual([])
  })

  it('REQ-MCP-87 adds one dated auction task per gap rung, once', () => {
    const portfolio: Portfolio = {
      id: 'p',
      name: 'Test',
      asOfDate: '2026-11-17',
      accounts: [
        {
          id: 'k',
          name: 'k',
          institution: 'Broker',
          accountType: '401k',
          cashBalance: 900_000,
          cds: [],
          holdings: [],
        },
      ],
    }
    const withLadder = { ...profile, safeLadder: ladder }
    const run = { seed: 42, paths: 50 }
    const first = proposePlanPolicy(portfolio, withLadder, '2026-11-25', run)
    const tasks = (first.proposedRules.tasks ?? []).filter(t =>
      t.id.startsWith('tips-gap-')
    )
    expect(tasks.map(t => [t.id, t.dueDate])).toEqual([
      ['tips-gap-2037', '2027-01-15'],
      ['tips-gap-2038', '2028-01-15'],
      ['tips-gap-2039', '2029-01-15'],
    ])
    expect(tasks[0].action).toMatch(/January 2027 auction, for the age-64/)
    // Saved, they are not added again.
    const again = proposePlanPolicy(
      portfolio,
      { ...withLadder, planRules: { ...first.proposedRules } },
      '2026-11-25',
      run
    )
    expect(
      (again.proposedRules.tasks ?? []).filter(t =>
        t.id.startsWith('tips-gap-')
      )
    ).toHaveLength(3)
    expect(again.findings.some(f => f.rule === 'tasks')).toBe(false)
  })
})
