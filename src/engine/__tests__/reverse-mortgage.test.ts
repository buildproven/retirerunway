// Reverse mortgage standby line (REQ-MCP-86). Invented household only.
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { mortgagePaymentEndAge } from '../portfolio-math'
import { reviewPlan } from '../plan-review'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import {
  HECM_LIMIT,
  earliestReverseMortgageAge,
  principalLimitFactor,
  reverseMortgagePlan,
} from '../reverse-mortgage'
import type { Account, Portfolio, UserProfile } from '../types'

const account = (
  accountType: Account['accountType'],
  value: number
): Account => ({
  id: accountType,
  name: accountType,
  institution: 'Broker',
  accountType,
  holdings: [],
  cds: [],
  cashBalance: value,
})

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [account('401k', 700_000)],
}

// Runs short in the late 80s on the expected path.
const profile: UserProfile = {
  currentAge: 60,
  targetRetirementAge: 62,
  separationAge: 62,
  annualExpenses: 75_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2_500,
  spouse: {
    currentAge: 58,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_200,
  },
  home: { estimatedValue: 600_000 },
}

describe('REQ-MCP-86: principal limit and the plan', () => {
  it('REQ-MCP-86 follows the HUD factors and waits for the younger spouse to reach 62', () => {
    expect(principalLimitFactor(61)).toBe(0)
    expect(principalLimitFactor(62)).toBeCloseTo(0.357, 6)
    expect(principalLimitFactor(67)).toBeCloseTo((0.357 + 0.416) / 2, 6)
    expect(principalLimitFactor(95)).toBeCloseTo(0.618, 6)
    expect(earliestReverseMortgageAge(profile)).toBe(64)
    const plan = reverseMortgagePlan(
      { ...profile, reverseMortgage: { openAge: 62 } },
      '2026-11-17'
    )!
    expect(plan.openAge).toBe(64)
    expect(plan.youngestAge).toBe(62)
    // 35.7% of $600,000 = $214,200, less 3% ($18,000) costs, no mortgage.
    expect(plan.principalLimit).toBeCloseTo(214_200, 0)
    expect(plan.line).toBeCloseTo(196_200, 0)
    expect(plan.opens).toBe(true)
  })

  it('REQ-MCP-86 caps the home at the FHA limit and pays the mortgage off first', () => {
    const big = reverseMortgagePlan(
      {
        ...profile,
        home: { estimatedValue: 2_000_000 },
        reverseMortgage: { openAge: 64 },
      },
      '2026-11-17'
    )!
    expect(big.maxClaim).toBe(HECM_LIMIT.amount)
    const owing: UserProfile = {
      ...profile,
      mortgage: {
        balance: 150_000,
        asOfDate: '2026-11-17',
        rate: 0.03,
        monthlyPayment: 1_000,
        payoffDate: '2042-11-01',
      },
      reverseMortgage: { openAge: 64 },
    }
    const plan = reverseMortgagePlan(owing, '2026-11-17')!
    expect(plan.mortgagePayoff).toBeGreaterThan(90_000)
    expect(plan.line).toBeLessThan(196_200 - 90_000)
    // The mortgage payment stops when the line opens, not at payoff.
    expect(mortgagePaymentEndAge(owing, '2026-11-17')).toBe(64)
    const tooMuch = reverseMortgagePlan(
      {
        ...owing,
        mortgage: {
          ...owing.mortgage!,
          balance: 400_000,
          payoffDate: '2056-11-01',
        },
      },
      '2026-11-17'
    )!
    expect(tooMuch.opens).toBe(false)
    expect(
      projectionWarnings(portfolio, {
        ...owing,
        mortgage: {
          ...owing.mortgage!,
          balance: 400_000,
          payoffDate: '2056-11-01',
        },
      }).join(' ')
    ).toContain('does not open')
  })
})

describe('REQ-MCP-86: the standby line in the projection', () => {
  const run = { paths: 1 }
  it('REQ-MCP-86 covers a shortfall only once the accounts run short, adding no tax', () => {
    const base = projectRetirement(portfolio, profile, run)
    const withLine = projectRetirement(
      portfolio,
      { ...profile, reverseMortgage: { openAge: 64 } },
      run
    )
    const shortBase = base.expectedPath.years.filter(y => y.shortfall > 1)
    expect(shortBase.length).toBeGreaterThan(0)
    const firstShort = shortBase[0].age
    const shortLine = withLine.expectedPath.years.filter(y => y.shortfall > 1)
    expect(shortLine.length).toBeLessThan(shortBase.length)
    // Before the accounts run short the line is untouched: same taxes.
    const at = (r: typeof base, age: number) =>
      r.expectedPath.years.find(y => y.age === age)!
    expect(at(withLine, firstShort - 1).taxes.federal).toBe(
      at(base, firstShort - 1).taxes.federal
    )
    expect(
      (withLine.expectedPath.depletionAge ?? 200) >
        (base.expectedPath.depletionAge ?? 0)
    ).toBe(true)
  })

  it('REQ-MCP-86 opens a line set for the current age in the first projected year', () => {
    // Both borrowers are 62 or older today, so the line could open now; the
    // projection starts at 65, so it must open there and cover shortfalls.
    const older: UserProfile = {
      currentAge: 64,
      targetRetirementAge: 64,
      separationAge: 64,
      annualExpenses: 60_000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 2_000,
      spouse: {
        currentAge: 62,
        socialSecurityAge: 67,
        socialSecurityMonthly: 800,
      },
      home: { estimatedValue: 600_000 },
    }
    const roth: Portfolio = {
      ...portfolio,
      accounts: [account('roth_ira', 300_000)],
    }
    const plan = reverseMortgagePlan(
      { ...older, reverseMortgage: { openAge: 64 } },
      '2026-11-17'
    )!
    expect(plan.openAge).toBe(65)
    expect(plan.opens).toBe(true)
    const shortYears = (r: ReturnType<typeof projectRetirement>) =>
      r.expectedPath.years.filter(y => y.shortfall > 1).length
    const base = projectRetirement(roth, older, run)
    const now = projectRetirement(
      roth,
      { ...older, reverseMortgage: { openAge: 64 } },
      run
    )
    const next = projectRetirement(
      roth,
      { ...older, reverseMortgage: { openAge: 65 } },
      run
    )
    expect(shortYears(now)).toBeLessThan(shortYears(base))
    expect(shortYears(now)).toBe(shortYears(next))
  })

  it('REQ-MCP-86 validates the field and the review tests a standby line', () => {
    expect(
      userProfileSchema.safeParse({
        ...profile,
        reverseMortgage: { openAge: 64 },
      }).success
    ).toBe(true)
    expect(
      userProfileSchema.safeParse({
        ...profile,
        reverseMortgage: { openAge: 64.5 },
      }).success
    ).toBe(false)
    const review = reviewPlan(portfolio, profile, '2026-11-24', {
      seed: 42,
      paths: 200,
    })
    expect(review.reverseMortgageTest).not.toBeNull()
    expect(review.reverseMortgageTest!.openAge).toBe(64)
    expect(review.reverseMortgageTest!.change).toBeGreaterThanOrEqual(0)
    const selling = reviewPlan(
      portfolio,
      { ...profile, homeSale: { age: 70, replacementHomeCost: 300_000 } },
      '2026-11-24',
      { seed: 42, paths: 100 }
    )
    expect(selling.reverseMortgageTest).toBeNull()
  })
})
