import { describe, it, expect } from 'vitest'
import { calculateOtherIncome } from '../portfolio-math'
import type { UserProfile } from '../types'

// ---------------------------------------------------------------------------
// `otherIncomeMonthly` previously had NO age gate: it paid out at every age,
// including pre-retirement, and never ended — unlike pension and Social
// Security, which are both gated. Any plan using the field was overstated.
// ---------------------------------------------------------------------------

const base: UserProfile = {
  currentAge: 55,
  targetRetirementAge: 62,
  annualExpenses: 50000,
}

describe('calculateOtherIncome — otherIncomeMonthly gating', () => {
  it('does not pay other income before retirement', () => {
    const profile = { ...base, otherIncomeMonthly: 1000 }
    expect(calculateOtherIncome(profile, 55)).toBe(0)
    expect(calculateOtherIncome(profile, 61)).toBe(0)
  })

  it('pays other income from the retirement year onward by default', () => {
    const profile = { ...base, otherIncomeMonthly: 1000 }
    expect(calculateOtherIncome(profile, 62)).toBe(12000)
    expect(calculateOtherIncome(profile, 80)).toBe(12000)
  })

  it('honours an explicit start age', () => {
    const profile = {
      ...base,
      otherIncomeMonthly: 1000,
      otherIncomeStartAge: 57,
    }
    expect(calculateOtherIncome(profile, 56)).toBe(0)
    expect(calculateOtherIncome(profile, 57)).toBe(12000)
  })

  it('honours an explicit end age, inclusive', () => {
    const profile = {
      ...base,
      otherIncomeMonthly: 1000,
      otherIncomeStartAge: 57,
      otherIncomeEndAge: 60,
    }
    expect(calculateOtherIncome(profile, 60)).toBe(12000)
    expect(calculateOtherIncome(profile, 61)).toBe(0)
  })

  it('still gates pension and Social Security independently', () => {
    const profile: UserProfile = {
      ...base,
      pensionMonthly: 500,
      socialSecurityMonthly: 2000,
      socialSecurityAge: 67,
    }
    // Pre-retirement: nothing.
    expect(calculateOtherIncome(profile, 60)).toBe(0)
    // Retired, pre-SS: pension only.
    expect(calculateOtherIncome(profile, 62)).toBe(6000)
    // Post-SS: both.
    expect(calculateOtherIncome(profile, 67)).toBe(6000 + 24000)
  })
})
