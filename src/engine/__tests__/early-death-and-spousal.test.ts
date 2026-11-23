// Death before retirement with life insurance (REQ-MCP-55) and spousal
// benefits (REQ-MCP-54).
import { describe, expect, it } from 'vitest'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import { spousalExcess, spousalFactor } from '../social-security'
import type { Portfolio, UserProfile } from '../types'

function portfolioOf(
  accountType: '401k' | 'brokerage',
  value: number
): Portfolio {
  return {
    id: 'p',
    name: 'Test',
    asOfDate: '2026-11-17',
    accounts: [
      {
        id: 'a',
        name: 'a',
        institution: 'Test',
        accountType,
        cds: [],
        cashBalance: 0,
        holdings: [
          {
            id: 'h',
            symbol: 'BND',
            name: 'BND',
            assetClass: 'us_bond',
            shares: 1,
            costBasis: value,
            currentPrice: value,
            currentValue: value,
          },
        ],
      },
    ],
  }
}

const yearAt = (portfolio: Portfolio, profile: UserProfile, age: number) => {
  const y = projectRetirement(portfolio, profile, {
    paths: 5,
  }).expectedPath.years.find(r => r.age === age)
  if (y === undefined) throw new Error(`no ${age}`)
  return y
}

describe('REQ-MCP-54 spousal benefits', () => {
  it('reduces a spousal benefit 35% at 62 and not at all from 67', () => {
    expect(spousalFactor(62)).toBeCloseTo(0.65, 10)
    expect(spousalFactor(64)).toBeCloseTo(0.75, 10)
    expect(spousalFactor(67)).toBe(1)
    expect(spousalFactor(70)).toBe(1)
  })

  it('tops the lower benefit up to half the other full-retirement-age benefit', () => {
    // Own $800 at 67 vs half of $3,000: $700 more.
    expect(
      spousalExcess(
        { monthly: 800, claimAge: 67 },
        { monthly: 3_000, claimAge: 67 }
      )
    ).toBeCloseTo(700, 6)
    // The other claimed at 70: the top-up still uses the full-retirement-age $3,000.
    expect(
      spousalExcess(
        { monthly: 800, claimAge: 67 },
        { monthly: 3_720, claimAge: 70 }
      )
    ).toBeCloseTo(700, 6)
    // Half or more already: nothing.
    expect(
      spousalExcess(
        { monthly: 1_500, claimAge: 67 },
        { monthly: 3_000, claimAge: 67 }
      )
    ).toBe(0)
  })

  it('reduces the top-up by the age it starts, not the own claim age', () => {
    // Own $0 claimed at 62; the other files at 67, so the top-up starts at 67.
    expect(
      spousalExcess(
        { monthly: 0, claimAge: 62 },
        { monthly: 3_000, claimAge: 67 },
        67
      )
    ).toBeCloseTo(1_500, 6)
    // Started at 64: 75% of the $1,500.
    expect(
      spousalExcess(
        { monthly: 0, claimAge: 62 },
        { monthly: 3_000, claimAge: 67 },
        64
      )
    ).toBeCloseTo(1_125, 6)
    // A start before the own claim never applies: the own claim age is the floor.
    expect(
      spousalExcess(
        { monthly: 0, claimAge: 65 },
        { monthly: 3_000, claimAge: 67 },
        62
      )
    ).toBeCloseTo(1_500 * spousalFactor(65), 6)
  })

  it('pays an unreduced top-up when it starts at 67 after an early own claim', () => {
    // Same-age couple; the spouse has no record of their own and files at 62,
    // but the top-up waits for the owner's claim at 67, when both are 67.
    const profile: UserProfile = {
      currentAge: 60,
      targetRetirementAge: 60,
      annualExpenses: 40_000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 3_000,
      spouse: {
        currentAge: 60,
        socialSecurityAge: 62,
        socialSecurityMonthly: 0,
      },
      planningAge: 70,
    }
    const portfolio = portfolioOf('401k', 1_000_000)
    expect(yearAt(portfolio, profile, 66).socialSecurity).toBe(0)
    expect(yearAt(portfolio, profile, 67).socialSecurity).toBe(
      12 * (3_000 + 1_500)
    )
    // A spouse two years older is 69 then: still unreduced.
    const older: UserProfile = {
      ...profile,
      spouse: {
        currentAge: 62,
        socialSecurityAge: 62,
        socialSecurityMonthly: 0,
      },
    }
    expect(yearAt(portfolio, older, 67).socialSecurity).toBe(
      12 * (3_000 + 1_500)
    )
    // A spouse three years younger is 64 when the owner files at 67: 75%.
    const younger: UserProfile = {
      ...profile,
      spouse: {
        currentAge: 57,
        socialSecurityAge: 62,
        socialSecurityMonthly: 0,
      },
    }
    expect(yearAt(portfolio, younger, 67).socialSecurity).toBe(
      12 * (3_000 + 1_125)
    )
  })

  it('adds the top-up only once both have claimed', () => {
    const portfolio = portfolioOf('401k', 1_000_000)
    const profile: UserProfile = {
      currentAge: 66,
      targetRetirementAge: 66,
      annualExpenses: 50_000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 3_000,
      spouse: {
        currentAge: 66,
        socialSecurityAge: 68,
        socialSecurityMonthly: 800 * 1.08,
      },
      planningAge: 70,
    }
    // At 67 only the owner has claimed.
    expect(yearAt(portfolio, profile, 67).socialSecurity).toBe(36_000)
    // At 68 both: $3,000 + $864 + $700 top-up, a month.
    expect(yearAt(portfolio, profile, 68).socialSecurity).toBe(
      Math.round(12 * (3_000 + 864 + 700))
    )
  })
})

describe('REQ-MCP-55 death before retirement', () => {
  const portfolio = portfolioOf('401k', 800_000)
  const base: UserProfile = {
    currentAge: 53,
    targetRetirementAge: 60,
    annualExpenses: 90_000,
    annualContributions: 40_000,
    preMedicareHealthcare: 30_000,
    socialSecurityAge: 67,
    socialSecurityMonthly: 4_000,
    spouse: {
      currentAge: 52,
      socialSecurityAge: 67,
      socialSecurityMonthly: 2_000,
    },
    planningAge: 95,
  }
  const dies56: UserProfile = {
    ...base,
    survivor: { deceased: 'self', deathAge: 56 },
  }

  it('stops pay and savings and starts the survivor spending the next year, penalty-free', () => {
    expect(yearAt(portfolio, base, 57).spending).toBe(0)
    expect(yearAt(portfolio, dies56, 56).spending).toBe(0)
    // 75% of $90,000 from 57; health cover for one.
    expect(yearAt(portfolio, dies56, 57).spending).toBe(67_500)
    expect(yearAt(portfolio, dies56, 57).healthcare).toBe(15_000)
    // A beneficiary's 401(k) withdrawals at 57 pay no 10% penalty.
    expect(yearAt(portfolio, dies56, 57).taxes.penalty).toBe(0)
    // No Social Security until the survivor is 60 (owner age 61).
    expect(yearAt(portfolio, dies56, 60).socialSecurity).toBe(0)
    expect(yearAt(portfolio, dies56, 61).socialSecurity).toBe(
      Math.round(4_000 * 12 * 0.715)
    )
  })

  it('ends income-gap spending at the death: the survivor spending replaces it', () => {
    // Job ends at 55 with 36 months without pay; the owner dies at 56.
    const gapThenDeath: UserProfile = {
      ...dies56,
      incomeGap: { startAge: 55, months: 36 },
    }
    // While alive, the gap pays household spending and health insurance.
    expect(yearAt(portfolio, gapThenDeath, 56).spending).toBe(120_000)
    // From 57 only the survivor's 75% and health cover for one, as with no gap.
    for (const age of [57, 58]) {
      expect(yearAt(portfolio, gapThenDeath, age).spending).toBe(67_500)
      expect(yearAt(portfolio, gapThenDeath, age).healthcare).toBe(15_000)
    }
  })

  it('pays life insurance the year after the death and raises the chance of success', () => {
    const insured: UserProfile = {
      ...base,
      survivor: { deceased: 'self', deathAge: 56, lifeInsurance: 1_000_000 },
    }
    expect(yearAt(portfolio, insured, 57).endBalances.taxable).toBeGreaterThan(
      yearAt(portfolio, dies56, 57).endBalances.taxable
    )
    const without = projectRetirement(portfolio, dies56, { paths: 200 })
      .monteCarlo.successRate
    const withCover = projectRetirement(portfolio, insured, { paths: 200 })
      .monteCarlo.successRate
    expect(withCover).toBeGreaterThan(without)
    expect(projectionWarnings(portfolio, insured).join(' ')).toContain(
      'Life insurance of $1,000,000'
    )
    expect(projectionWarnings(portfolio, dies56).join(' ')).toContain(
      'The death comes before retirement'
    )
  })

  it('pays life insurance the year after a death at a fractional age', () => {
    // A death at 56.5 is treated as at 56 (dead from 57), so the payout lands at 57.
    const insured = (deathAge: number): UserProfile => ({
      ...base,
      survivor: { deceased: 'self', deathAge, lifeInsurance: 1_000_000 },
    })
    const uninsured: UserProfile = {
      ...base,
      survivor: { deceased: 'self', deathAge: 56.5 },
    }
    expect(
      yearAt(portfolio, insured(56.5), 57).endBalances.taxable
    ).toBeGreaterThan(yearAt(portfolio, uninsured, 57).endBalances.taxable)
    expect(yearAt(portfolio, insured(56.5), 57).endBalances).toEqual(
      yearAt(portfolio, insured(56), 57).endBalances
    )
  })
})
