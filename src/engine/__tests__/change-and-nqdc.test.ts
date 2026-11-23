// What moved the number (REQ-MCP-58) and an NQDC payout from separation (REQ-MCP-57).
import { describe, expect, it } from 'vitest'
import { explainChange } from '../change-explainer'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import type { Holding, Portfolio, UserProfile } from '../types'

const holding = (
  id: string,
  symbol: string,
  assetClass: Holding['assetClass'],
  value: number
): Holding => ({
  id,
  symbol,
  name: symbol,
  assetClass,
  shares: 1,
  costBasis: value,
  currentPrice: value,
  currentValue: value,
})

const snapshot = (asOfDate: string, voo: number, bnd: number): Portfolio => ({
  id: 'p',
  name: 'Test',
  asOfDate,
  accounts: [
    {
      id: 'k',
      name: '401k',
      institution: 'Fidelity',
      accountType: '401k',
      cds: [],
      cashBalance: 0,
      holdings: [
        holding('v', 'VOO', 'us_equity', voo),
        holding('b', 'BND', 'us_bond', bnd),
      ],
    },
  ],
})

const profile: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 60,
  annualExpenses: 60_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2_500,
  planningAge: 92,
}

describe('REQ-MCP-58 explain change', () => {
  it('attributes a market drop to the portfolio and names the biggest moves', () => {
    const before = snapshot('2026-10-17', 700_000, 300_000)
    const after = snapshot('2026-11-17', 600_000, 310_000)
    const r = explainChange(before, after, profile, { seed: 42 })
    expect(r.valueChange).toBe(-90_000)
    expect(r.from.equityShare).toBe(0.7)
    expect(r.to.equityShare).toBeCloseTo(0.6593, 4)
    expect(r.portfolioEffect).toBeLessThan(0)
    expect(r.portfolioEffect).toBeCloseTo(
      r.to.successRate - r.from.successRate,
      6
    )
    expect(r.biggestMoves[0]).toEqual({
      symbol: 'VOO',
      from: 700_000,
      to: 600_000,
      change: -100_000,
    })
    expect(r.recorded).toBeNull()
    expect(r.headline).toMatch(/: portfolio -\d/)
  })

  it('splits the total change from a recorded rate into portfolio and everything else', () => {
    const before = snapshot('2026-10-17', 600_000, 400_000)
    const r = explainChange(before, before, profile, {
      seed: 42,
      previousSuccessRate: 0.5,
    })
    expect(r.portfolioEffect).toBe(0)
    expect(r.recorded?.otherEffect).toBeCloseTo(r.to.successRate - 0.5, 4)
    expect(r.biggestMoves).toEqual([])
  })
})

describe('REQ-MCP-57 NQDC payout from separation', () => {
  const plan: Portfolio = {
    id: 'p',
    name: 'Test',
    asOfDate: '2026-11-17',
    accounts: [
      {
        id: 'n',
        name: 'NQDC',
        institution: 'Employer',
        accountType: 'nqdc',
        cds: [],
        cashBalance: 0,
        holdings: [holding('n1', 'STABLE', 'us_bond', 100_000)],
      },
    ],
  }
  const base: UserProfile = {
    currentAge: 54,
    targetRetirementAge: 60,
    annualExpenses: 0,
    nqdcPayout: { startAge: 60, years: 5 },
    planningAge: 70,
  }
  const payoutAt = (p: UserProfile, age: number) =>
    projectRetirement(plan, p, { paths: 5 }).expectedPath.years.find(
      y => y.age === age
    )?.withdrawals.nqdc ?? 0

  it('starts at startAge by default and at the gap start when tied to separation', () => {
    expect(payoutAt(base, 56)).toBe(0)
    expect(payoutAt(base, 60)).toBeGreaterThan(0)
    const tied: UserProfile = {
      ...base,
      nqdcPayout: { startAge: 60, years: 5, onSeparation: true },
      incomeGap: { startAge: 56, months: 6 },
    }
    expect(payoutAt(tied, 56)).toBeGreaterThan(0)
    expect(projectionWarnings(plan, tied).join(' ')).toContain(
      'NQDC payout starts when you leave the job (age 56)'
    )
  })
})
