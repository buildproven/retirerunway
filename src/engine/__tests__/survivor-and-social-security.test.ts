// Survivor scenario (REQ-MCP-48) and Social Security claiming arithmetic
// (REQ-MCP-49).
import { describe, expect, it } from 'vitest'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import {
  benefitAtClaimAge,
  claimFactor,
  fullRetirementBenefit,
  survivorFactor,
} from '../social-security'
import type { Portfolio, UserProfile } from '../types'

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    {
      id: 'k',
      name: '401k',
      institution: 'Test',
      accountType: '401k',
      cds: [],
      cashBalance: 0,
      holdings: [
        {
          id: 'bd',
          symbol: 'BD',
          name: 'Bond',
          assetClass: 'us_bond',
          shares: 1,
          costBasis: 1_500_000,
          currentPrice: 1_500_000,
          currentValue: 1_500_000,
        },
      ],
    },
  ],
}

// Owner 60 and spouse 59, both retired: owner $50K/yr at 67, spouse $25K/yr at 67.
const couple: UserProfile = {
  currentAge: 60,
  targetRetirementAge: 60,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 50_000 / 12,
  spouse: {
    currentAge: 59,
    socialSecurityAge: 67,
    socialSecurityMonthly: 25_000 / 12,
  },
  preMedicareHealthcare: 20_000,
  planningAge: 90,
}

const yearAt = (profile: UserProfile, age: number) => {
  const year = projectRetirement(portfolio, profile, {
    paths: 10,
  }).expectedPath.years.find(y => y.age === age)
  if (year === undefined) throw new Error(`no year ${age}`)
  return year
}

describe('REQ-MCP-49 Social Security claiming factors (SSA, born 1960+)', () => {
  it('cuts 30% at 62 and adds 8% a year to 70', () => {
    expect(claimFactor(62)).toBeCloseTo(0.7, 10)
    expect(claimFactor(63)).toBeCloseTo(0.75, 10)
    expect(claimFactor(64)).toBeCloseTo(0.8, 10)
    expect(claimFactor(65)).toBeCloseTo(13 / 15, 10)
    expect(claimFactor(66)).toBeCloseTo(14 / 15, 10)
    expect(claimFactor(67)).toBe(1)
    expect(claimFactor(68)).toBeCloseTo(1.08, 10)
    expect(claimFactor(70)).toBeCloseTo(1.24, 10)
    expect(claimFactor(72)).toBeCloseTo(1.24, 10)
  })

  it('moves a quoted benefit between claiming ages through the full-retirement-age benefit', () => {
    expect(fullRetirementBenefit(1_240, 70)).toBeCloseTo(1_000, 6)
    expect(benefitAtClaimAge(1_000, 67, 62)).toBeCloseTo(700, 6)
    expect(benefitAtClaimAge(700, 62, 70)).toBeCloseTo(1_240, 6)
  })

  it('pays survivors 71.5% at 60 rising to 100% at 67, none before 60', () => {
    expect(survivorFactor(59)).toBe(0)
    expect(survivorFactor(60)).toBeCloseTo(0.715, 10)
    expect(survivorFactor(67)).toBe(1)
    expect(survivorFactor(63.5)).toBeCloseTo(0.8575, 10)
  })
})

describe('REQ-MCP-48 survivor scenario', () => {
  const ownerDies: UserProfile = {
    ...couple,
    survivor: { deceased: 'self', deathAge: 70 },
  }

  it('keeps both benefits through the year of death, then the larger one', () => {
    expect(yearAt(couple, 71).socialSecurity).toBe(75_000)
    expect(yearAt(ownerDies, 70).socialSecurity).toBe(75_000)
    // Spouse is 70 at owner 71: the survivor benefit (owner's $50K) beats her own $25K.
    expect(yearAt(ownerDies, 71).socialSecurity).toBe(50_000)
  })

  it('cuts spending to 75% after the death and files single', () => {
    expect(yearAt(ownerDies, 70).spending).toBe(80_000)
    expect(yearAt(ownerDies, 71).spending).toBe(60_000)
    const both = projectRetirement(portfolio, couple, { paths: 10 })
    const widowed = projectRetirement(portfolio, ownerDies, { paths: 10 })
    expect(both.filingStatus).toBe('married_filing_jointly')
    // Single brackets on similar income: more federal tax per dollar of withdrawal.
    const rate = (y: ReturnType<typeof yearAt>) =>
      y.taxes.federal / (y.withdrawals.total + y.socialSecurity)
    const coupleYear = both.expectedPath.years.find(y => y.age === 75)
    const widowYear = widowed.expectedPath.years.find(y => y.age === 75)
    expect(coupleYear && widowYear && rate(widowYear) > rate(coupleYear)).toBe(
      true
    )
  })

  it('pays a reduced survivor benefit before 67 when the spouse dies before claiming', () => {
    const spouseDies: UserProfile = {
      ...couple,
      survivor: { deceased: 'spouse', deathAge: 60, spendingShare: 0.8 },
    }
    // Owner 61 (the year after the death): own benefit not yet claimed;
    // survivor benefit = spouse's $25K × factor(61), kept at that rate.
    expect(yearAt(spouseDies, 61).socialSecurity).toBe(
      Math.round(25_000 * survivorFactor(61))
    )
    expect(yearAt(spouseDies, 62).socialSecurity).toBe(
      Math.round(25_000 * survivorFactor(61))
    )
    // From 67 the owner's own $50K is larger.
    expect(yearAt(spouseDies, 67).socialSecurity).toBe(50_000)
    // Healthcare for one before 65: half the household premium.
    expect(yearAt(spouseDies, 62).healthcare).toBe(10_000)
    expect(yearAt(couple, 62).healthcare).toBe(20_000)
    expect(yearAt(spouseDies, 62).spending).toBe(64_000)
  })

  it('keeps a survivor benefit started before 67 at its reduced rate for life (SSA)', () => {
    // Spouse dies at owner 59: the owner starts the survivor benefit at 60
    // (71.5%). A reduced survivor benefit does not rise at full retirement
    // age, so at 66 and 70 it is still 71.5% of $25K, not 95.9% or 100%.
    const early: UserProfile = {
      ...couple,
      currentAge: 58,
      targetRetirementAge: 58,
      socialSecurityMonthly: 10_000 / 12,
      spouse: {
        currentAge: 57,
        socialSecurityAge: 67,
        socialSecurityMonthly: 25_000 / 12,
      },
      survivor: { deceased: 'spouse', deathAge: 59 },
    }
    const started = Math.round(25_000 * 0.715)
    expect(yearAt(early, 59).socialSecurity).toBe(0)
    expect(yearAt(early, 60).socialSecurity).toBe(started)
    expect(yearAt(early, 66).socialSecurity).toBe(started)
    // Own $10K at 67 is smaller, so the survivor benefit stays.
    expect(yearAt(early, 70).socialSecurity).toBe(started)
  })

  it('waits for the unreduced survivor benefit at 67 when the survivor is already on their own', () => {
    // Owner on $20K from 62; spouse ($25K) dies at owner 62. The survivor
    // benefit is not started early (and reduced for life); it is $25K from 67.
    const ownFirst: UserProfile = {
      ...couple,
      socialSecurityAge: 62,
      socialSecurityMonthly: 20_000 / 12,
      survivor: { deceased: 'spouse', deathAge: 62 },
    }
    expect(yearAt(ownFirst, 63).socialSecurity).toBe(20_000)
    expect(yearAt(ownFirst, 66).socialSecurity).toBe(20_000)
    expect(yearAt(ownFirst, 67).socialSecurity).toBe(25_000)
    expect(yearAt(ownFirst, 80).socialSecurity).toBe(25_000)
  })

  it('takes an own benefit claimed before 67 first and the full survivor benefit at 67', () => {
    // Own $20K claimed at 64; spouse ($25K) dies at owner 61.
    const ownAt64: UserProfile = {
      ...couple,
      socialSecurityAge: 64,
      socialSecurityMonthly: 20_000 / 12,
      survivor: { deceased: 'spouse', deathAge: 61 },
    }
    expect(yearAt(ownAt64, 62).socialSecurity).toBe(0)
    expect(yearAt(ownAt64, 64).socialSecurity).toBe(20_000)
    expect(yearAt(ownAt64, 67).socialSecurity).toBe(25_000)
    // survivorClaimAge overrides: start at 62, reduced for life; own $20K is larger from 64.
    const early: UserProfile = {
      ...ownAt64,
      survivor: { deceased: 'spouse', deathAge: 61, survivorClaimAge: 62 },
    }
    expect(yearAt(early, 62).socialSecurity).toBe(
      Math.round(25_000 * survivorFactor(62))
    )
    expect(yearAt(early, 67).socialSecurity).toBe(20_000)
  })

  it('starts the survivor benefit in the first survivor year for a fractional death age', () => {
    const halfYear: UserProfile = {
      ...couple,
      survivor: { deceased: 'spouse', deathAge: 60.5 },
    }
    expect(yearAt(halfYear, 61).socialSecurity).toBe(
      Math.round(25_000 * survivorFactor(61))
    )
    expect(yearAt(halfYear, 64).socialSecurity).toBe(
      Math.round(25_000 * survivorFactor(61))
    )
  })

  it('credits delays earned before death when the deceased had not claimed', () => {
    const lateClaim: UserProfile = {
      ...couple,
      socialSecurityAge: 70,
      socialSecurityMonthly: (50_000 * 1.24) / 12,
      survivor: { deceased: 'self', deathAge: 68 },
    }
    // Owner died at 68 before claiming at 70: credits to 68 only (1.08 × $50K).
    expect(yearAt(lateClaim, 69).socialSecurity).toBe(54_000)
  })

  it('names its assumptions, and is ignored without a spouse', () => {
    expect(projectionWarnings(portfolio, ownerDies).join(' ')).toContain(
      'survivor scenario: you die at your age 70'
    )
    const single: UserProfile = {
      currentAge: 60,
      targetRetirementAge: 60,
      annualExpenses: 50_000,
      survivor: { deceased: 'spouse', deathAge: 70 },
    }
    expect(projectionWarnings(portfolio, single).join(' ')).toContain(
      'survivor is ignored'
    )
    expect(
      projectRetirement(portfolio, single, { paths: 10 }).filingStatus
    ).toBe('single')
  })
})
