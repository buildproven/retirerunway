import { describe, expect, it } from 'vitest'
import {
  calculateSocialSecurityBenefit,
  materializeSocialSecurityIncomeStreams,
  projectScenario,
} from '../index'
import type { Scenario, SocialSecurityBenefit } from '../types'

function benefit(
  overrides: Partial<SocialSecurityBenefit> = {}
): SocialSecurityBenefit {
  return {
    id: 'ss',
    name: 'Social Security',
    benefitType: 'worker',
    owner: 'primary',
    currency: 'USD',
    primaryInsuranceAmount: 2_000,
    fullRetirementAge: 67,
    claimantFullRetirementAge: 67,
    claimAge: 67,
    annualCOLARate: 0.02,
    reliability: 0.95,
    includedInBase: true,
    workerBirthYear: 1960,
    ...overrides,
  }
}

describe('Social Security claiming rules', () => {
  it('applies the SSA worker reduction at age 62 when FRA is 67', () => {
    const result = calculateSocialSecurityBenefit(benefit({ claimAge: 62 }))

    expect(result.monthlyBenefit).toBe(1_400)
    expect(result.annualBenefit).toBe(16_800)
    expect(result.adjustmentFactor).toBe(0.7)
  })

  it('applies worker delayed credits through age 70', () => {
    const result = calculateSocialSecurityBenefit(benefit({ claimAge: 70 }))

    expect(result.monthlyBenefit).toBe(2_480)
    expect(result.adjustmentFactor).toBe(1.24)
  })

  it('uses the spouse reduction and does not add worker delayed credits', () => {
    const early = calculateSocialSecurityBenefit(
      benefit({
        benefitType: 'spouse',
        claimAge: 62,
        associatedWorkerClaimAge: 62,
      })
    )
    const delayed = calculateSocialSecurityBenefit(
      benefit({
        benefitType: 'spouse',
        claimAge: 70,
        associatedWorkerClaimAge: 62,
      })
    )

    expect(early.monthlyBenefit).toBe(650)
    expect(delayed.monthlyBenefit).toBe(1_000)
    expect(delayed.adjustmentFactor).toBe(1)
  })

  it('defers spouse income until the associated worker is entitled', () => {
    const scenario: Scenario = {
      id: 'spouse-eligibility-fixture',
      profile: {
        currentAge: 61,
        targetRetirementAge: 62,
        filingStatus: 'married_filing_jointly',
      },
      assumptions: {
        durationYears: 8,
        inflationRate: 0,
        asOfDate: '2026-01-01',
        baseCurrency: 'USD',
      },
      fxRates: [],
      accounts: [],
      incomeStreams: [],
      socialSecurityBenefits: [
        benefit({
          benefitType: 'spouse',
          claimAge: 62,
          associatedWorkerClaimAge: 67,
        }),
      ],
      spendingStreams: [],
      lifeEvents: [],
    }

    const rows = projectScenario(scenario).rows
    expect(rows.find(row => row.age === 62)?.incomeBySource.ss).toBe(0)
    expect(rows.find(row => row.age === 66)?.incomeBySource.ss).toBe(0)
    expect(rows.find(row => row.age === 67)?.incomeBySource.ss).toBe(12_000)
  })

  it('requires the associated worker age for spouse benefits', () => {
    expect(() =>
      calculateSocialSecurityBenefit(benefit({ benefitType: 'spouse' }))
    ).toThrow('spouse associatedWorkerClaimAge must be between 62 and 70')
  })

  it('rejects delayed worker credits without a supported birth cohort', () => {
    expect(() =>
      calculateSocialSecurityBenefit(
        benefit({ claimAge: 70, workerBirthYear: 1942 })
      )
    ).toThrow('worker delayed credits require workerBirthYear 1943 or later')
  })

  it('rejects a worker birth-year and FRA mismatch', () => {
    expect(() =>
      calculateSocialSecurityBenefit(
        benefit({ claimAge: 70, fullRetirementAge: 67, workerBirthYear: 1943 })
      )
    ).toThrow('worker fullRetirementAge must match the birth-year ruleset (66)')
  })

  it('uses the claimant FRA for spouse reductions', () => {
    const result = calculateSocialSecurityBenefit(
      benefit({
        benefitType: 'spouse',
        claimAge: 62,
        associatedWorkerClaimAge: 62,
        fullRetirementAge: 67,
        claimantFullRetirementAge: 66,
      })
    )

    expect(result.monthlyBenefit).toBe(700)
  })

  it('does not gate divorced-spouse income on former-spouse filing', () => {
    const scenario: Scenario = {
      id: 'divorced-spouse-eligibility-fixture',
      profile: {
        currentAge: 61,
        targetRetirementAge: 62,
        filingStatus: 'single',
      },
      assumptions: {
        durationYears: 3,
        inflationRate: 0,
        asOfDate: '2026-01-01',
        baseCurrency: 'USD',
      },
      fxRates: [],
      accounts: [],
      incomeStreams: [],
      socialSecurityBenefits: [
        benefit({
          benefitType: 'divorced_spouse',
          claimAge: 62,
          divorcedSpouseEligibilityConfirmed: true,
        }),
      ],
      spendingStreams: [],
      lifeEvents: [],
    }

    const rows = projectScenario(scenario).rows
    expect(rows.find(row => row.age === 62)?.incomeBySource.ss).toBe(7_800)
  })

  it('uses the survivor minimum at age 60 and reaches the worker amount at FRA', () => {
    const early = calculateSocialSecurityBenefit(
      benefit({
        benefitType: 'survivor',
        claimAge: 60,
        deceasedWorkerBenefitAmount: 2_000,
      })
    )
    const atFRA = calculateSocialSecurityBenefit(
      benefit({
        benefitType: 'survivor',
        claimAge: 67,
        deceasedWorkerBenefitAmount: 2_000,
      })
    )

    expect(early.monthlyBenefit).toBe(1_430)
    expect(atFRA.monthlyBenefit).toBe(2_000)
  })

  it('uses the claimant FRA for survivor reductions', () => {
    const result = calculateSocialSecurityBenefit(
      benefit({
        benefitType: 'survivor',
        claimAge: 66,
        fullRetirementAge: 67,
        claimantFullRetirementAge: 66,
        deceasedWorkerBenefitAmount: 2_000,
      })
    )

    expect(result.monthlyBenefit).toBe(2_000)
  })

  it('spreads the survivor reduction across the longer FRA-67 window', () => {
    const result = calculateSocialSecurityBenefit(
      benefit({ benefitType: 'survivor', claimAge: 62 })
    )

    expect(result.monthlyBenefit).toBe(1_592.86)
  })

  it('feeds the adjusted benefit and its COLA assumption into projections', () => {
    const scenario: Scenario = {
      id: 'social-security-projection',
      profile: {
        currentAge: 61,
        targetRetirementAge: 62,
        filingStatus: 'single',
      },
      assumptions: {
        durationYears: 3,
        inflationRate: 0,
        asOfDate: '2026-01-01',
        baseCurrency: 'USD',
      },
      fxRates: [],
      accounts: [],
      incomeStreams: [],
      socialSecurityBenefits: [benefit({ claimAge: 62 })],
      spendingStreams: [],
      lifeEvents: [],
    }

    const rows = projectScenario(scenario).rows
    expect(rows.find(row => row.age === 61)?.incomeBySource.ss).toBeUndefined()
    expect(rows.find(row => row.age === 62)?.incomeBySource.ss).toBe(16_800)
    expect(rows.find(row => row.age === 63)?.incomeBySource.ss).toBe(17_136)
  })

  it('marks the current-law maximum taxable portion without reducing cash income', () => {
    const streams = materializeSocialSecurityIncomeStreams({
      id: 'tax-fixture',
      profile: {
        currentAge: 61,
        targetRetirementAge: 62,
        filingStatus: 'single',
      },
      assumptions: {
        durationYears: 1,
        inflationRate: 0,
        asOfDate: '2026-01-01',
        baseCurrency: 'USD',
      },
      fxRates: [],
      accounts: [],
      incomeStreams: [],
      socialSecurityBenefits: [benefit({ claimAge: 62 })],
      spendingStreams: [],
      lifeEvents: [],
    })

    expect(streams[0]).toMatchObject({
      gross: 16_800,
      taxableFraction: 0.85,
    })
  })

  it('rejects a worker claim after age 70', () => {
    expect(() =>
      calculateSocialSecurityBenefit(benefit({ claimAge: 70.5 }))
    ).toThrow('worker claimAge cannot exceed 70')
  })

  it('rejects duplicate benefit ids before projection can overwrite a source', () => {
    expect(() =>
      materializeSocialSecurityIncomeStreams({
        id: 'duplicate-id-fixture',
        profile: {
          currentAge: 61,
          targetRetirementAge: 62,
          filingStatus: 'single',
        },
        assumptions: {
          durationYears: 1,
          inflationRate: 0,
          asOfDate: '2026-01-01',
          baseCurrency: 'USD',
        },
        fxRates: [],
        accounts: [],
        incomeStreams: [],
        socialSecurityBenefits: [benefit(), benefit({ name: 'Second record' })],
        spendingStreams: [],
        lifeEvents: [],
      })
    ).toThrow(
      'Social Security benefit id ss collides with an income stream or another benefit'
    )
  })
})
