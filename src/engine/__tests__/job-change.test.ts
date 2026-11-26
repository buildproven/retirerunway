// A job change before retirement and the Rule of 55 (REQ-MCP-83).
// Invented household only.
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { reviewPlan } from '../plan-review'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import type { Account, Portfolio, UserProfile } from '../types'

function account(
  id: string,
  accountType: Account['accountType'],
  value: number
): Account {
  return {
    id,
    name: id,
    institution: 'Broker',
    accountType,
    cashBalance: value,
    cds: [],
    holdings: [],
  }
}

const portfolio = (...accounts: Account[]): Portfolio => ({
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts,
})

// Retires at 56, so the years 56-59 depend on the Rule of 55.
const profile: UserProfile = {
  currentAge: 50,
  targetRetirementAge: 56,
  separationAge: 56,
  annualExpenses: 70_000,
  annualContributions: 20_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  stateTaxRate: 0.0495,
}

const run = { paths: 1 }
const yearAt = (r: ReturnType<typeof projectRetirement>, age: number) =>
  r.expectedPath.years.find(y => y.age === age)!

describe('REQ-MCP-83: job change and the Rule of 55', () => {
  const p = portfolio(account('k', '401k', 1_200_000))

  it('REQ-MCP-83 keeps penalty-free access when the old 401(k) is rolled into the new plan', () => {
    const base = projectRetirement(p, profile, run)
    const rolled = projectRetirement(
      p,
      { ...profile, jobChange: { age: 53, oldPlan: 'rollIn' } },
      run
    )
    expect(base.expectedPath.lifetimePenalty).toBe(0)
    expect(rolled.expectedPath.lifetimePenalty).toBe(0)
    expect(yearAt(rolled, 57).endBalances.employerPlan).toBeCloseTo(
      yearAt(base, 57).endBalances.employerPlan,
      0
    )
  })

  it('REQ-MCP-83 moves an old 401(k) rolled to an IRA out of reach of the Rule of 55', () => {
    const ira = projectRetirement(
      p,
      { ...profile, jobChange: { age: 53, oldPlan: 'ira' } },
      run
    )
    // The old balance sits in the IRA from 53; only new savings stay in the plan.
    expect(yearAt(ira, 53).endBalances.ira).toBeGreaterThan(1_000_000)
    expect(yearAt(ira, 53).endBalances.employerPlan).toBeLessThan(30_000)
    // Spending from 56 runs the plan dry, then the IRA pays the 10% penalty.
    expect(ira.expectedPath.lifetimePenalty).toBeGreaterThan(0)
    const rolled = projectRetirement(
      p,
      { ...profile, jobChange: { age: 53, oldPlan: 'rollIn' } },
      run
    )
    expect(ira.expectedPath.balanceAtRetirement).toBeCloseTo(
      rolled.expectedPath.balanceAtRetirement,
      -2
    )
  })

  it('REQ-MCP-83 treats a plan left behind before 55 like an IRA, and at 55 or later as open', () => {
    const early = projectRetirement(
      p,
      { ...profile, jobChange: { age: 53, oldPlan: 'leave' } },
      run
    )
    expect(early.expectedPath.lifetimePenalty).toBeGreaterThan(0)
    const late = projectRetirement(
      p,
      {
        ...profile,
        targetRetirementAge: 57,
        separationAge: 57,
        jobChange: { age: 55, oldPlan: 'leave' },
      },
      run
    )
    expect(late.expectedPath.lifetimePenalty).toBe(0)
  })

  it('REQ-MCP-83 starts the deferred-comp payout when the old job ends', () => {
    const n = portfolio(
      account('k', '401k', 1_200_000),
      account('n', 'nqdc', 100_000)
    )
    const withPayout = { ...profile, nqdcPayout: { startAge: 56, years: 5 } }
    const stay = projectRetirement(n, withPayout, run)
    expect(yearAt(stay, 53).withdrawals.nqdc).toBe(0)
    const move = projectRetirement(
      n,
      { ...withPayout, jobChange: { age: 53, oldPlan: 'rollIn' } },
      run
    )
    expect(yearAt(move, 53).withdrawals.nqdc).toBeGreaterThan(0)
    expect(
      projectionWarnings(n, {
        ...withPayout,
        jobChange: { age: 53, oldPlan: 'rollIn' },
      }).join(' ')
    ).toContain('job change at 53')
    const kept = projectRetirement(
      n,
      {
        ...withPayout,
        jobChange: { age: 53, oldPlan: 'rollIn', nqdcStartsAtChange: false },
      },
      run
    )
    expect(yearAt(kept, 53).withdrawals.nqdc).toBe(0)
  })

  it('REQ-MCP-83 taxes deferred comp paid while working at the working rate, not from zero', () => {
    const n = portfolio(
      account('k', '401k', 1_200_000),
      account('n', 'nqdc', 100_000)
    )
    const move = {
      ...profile,
      nqdcPayout: { startAge: 56, years: 5 },
      jobChange: { age: 53, oldPlan: 'rollIn' as const },
    }
    const y = yearAt(projectRetirement(n, move, run), 53)
    // One fifth of the balance (grown a year) at 24%, plus nothing else
    // taxed that working year.
    expect(y.taxes.federal).toBeCloseTo(y.withdrawals.nqdc * 0.24, -1)
    const lower = yearAt(
      projectRetirement(n, { ...move, workingMarginalRate: 0.12 }, run),
      53
    )
    expect(lower.taxes.federal).toBeLessThan(y.taxes.federal)
  })

  it('REQ-MCP-83 validates the job change and the review compares roll-in with an IRA', () => {
    expect(
      userProfileSchema.safeParse({
        ...profile,
        jobChange: { age: 53, oldPlan: 'rollIn' },
      }).success
    ).toBe(true)
    expect(
      userProfileSchema.safeParse({
        ...profile,
        jobChange: { age: 53.5, oldPlan: 'ira' },
      }).success
    ).toBe(false)
    const review = reviewPlan(p, profile, '2026-11-24', {
      seed: 42,
      paths: 200,
    })
    // Retiring at 56 (before 59½) the review compares both ways.
    const roll = review.stressTests.find(t =>
      /roll the old 401\(k\) into/.test(t.name)
    )
    const ira = review.stressTests.find(t =>
      /move the old 401\(k\) to an IRA/.test(t.name)
    )
    expect(roll).toBeDefined()
    expect(ira).toBeDefined()
    expect(ira!.successRate).toBeLessThanOrEqual(roll!.successRate)
    expect(review.humanChecks.some(c => /accepts roll-ins/.test(c.what))).toBe(
      true
    )
  })
})
