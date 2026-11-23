import { describe, expect, it } from 'vitest'
import { buildScenario, validatePlanIntake } from '../intake'
import { analyzePlan } from '../analyze'
import type { PlanIntakeValues } from '../intake'
import type { SocialSecurityBenefitType } from '../types'

const values: PlanIntakeValues = {
  currentAge: 58,
  targetRetirementAge: 65,
  durationYears: 35,
  filingStatus: 'married_filing_jointly',
  acaHouseholdSize: 2,
  acaResidenceRegion: 'contiguous_us',
  annualExpenses: 60_000,
  essentialExpenses: 40_000,
  cashBalance: 30_000,
  brokerageBalance: 400_000,
  traditionalBalance: 500_000,
  rothBalance: 200_000,
  annualWorkIncome: 100_000,
  annualOutsideIncome: 20_000,
  annualSocialSecurity: 0,
  annualSocialSecurityAtFullRetirementAge: 24_000,
  socialSecurityStartAge: 67,
  annualHealthcare: 12_000,
  reserveFloor: 100_000,
  housingProceeds: 200_000,
  housingEventAge: 70,
  housingCommitment: 'committed',
}

describe('plan intake adapter', () => {
  it('builds a deterministic scenario with explicit streams and events', () => {
    const first = buildScenario(values)
    const second = buildScenario(values)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.incomeStreams.map(stream => stream.id)).toEqual([
      'work-income',
      'outside-income',
    ])
    expect(first.socialSecurityBenefits).toEqual([
      expect.objectContaining({
        id: 'social-security',
        benefitType: 'worker',
        primaryInsuranceAmount: 2_000,
        fullRetirementAge: 67,
        claimAge: 67,
      }),
    ])
    expect(first.spendingStreams.map(stream => stream.id)).toContain(
      'healthcare-spending'
    )
    expect(first.lifeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'work_exit', commitment: 'committed' }),
        expect.objectContaining({
          kind: 'housing_transaction',
          amount: 200_000,
          commitment: 'committed',
        }),
      ])
    )
    expect(first.healthcare?.phases[0]).toMatchObject({
      kind: 'medicare',
      monthlyPremium: 1_000,
    })
    expect(first.healthcare?.aca).toMatchObject({
      householdSize: 2,
      residenceRegion: 'contiguous_us',
    })
  })

  it('rejects an essential budget larger than total spending', () => {
    expect(() =>
      validatePlanIntake({ ...values, essentialExpenses: 61_000 })
    ).toThrow('essentialExpenses cannot exceed annualExpenses')
  })

  it('ends built-in ACA coverage at Medicare eligibility', () => {
    const scenario = buildScenario({
      ...values,
      currentAge: 58,
      targetRetirementAge: 60,
    })

    expect(scenario.healthcare?.phases.map(phase => phase.kind)).toEqual([
      'aca',
      'medicare',
    ])
    expect(scenario.healthcare?.phases[0]?.endMonthExclusive).toBe('2033-01')
  })

  it('clips pre-Medicare coverage to a short projection horizon', () => {
    const scenario = buildScenario({
      ...values,
      currentAge: 50,
      targetRetirementAge: 55,
      durationYears: 5,
      housingProceeds: 0,
    })

    expect(scenario.healthcare?.phases).toHaveLength(1)
    expect(scenario.healthcare?.phases[0]).toMatchObject({
      kind: 'aca',
      endMonthExclusive: '2032-01',
    })
  })

  it('preserves legacy claimed Social Security amounts without FRA conversion', () => {
    const scenario = buildScenario({
      ...values,
      annualSocialSecurity: 24_000,
      annualSocialSecurityAtFullRetirementAge: 0,
      socialSecurityStartAge: 62,
    })

    expect(scenario.socialSecurityBenefits).toEqual([])
    expect(scenario.incomeStreams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'social-security',
          gross: 24_000,
          start: { age: 62 },
        }),
      ])
    )
  })

  it('does not validate Social Security claim age when no benefit is supplied', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        annualSocialSecurity: 0,
        annualSocialSecurityAtFullRetirementAge: 0,
        socialSecurityStartAge: 71,
      })
    ).not.toThrow()
  })

  it('validates the legacy Social Security start age', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        annualSocialSecurity: 24_000,
        annualSocialSecurityAtFullRetirementAge: undefined,
        socialSecurityStartAge: Number.NaN,
      })
    ).toThrow('socialSecurityStartAge must be an age at or after currentAge')
  })

  it('rejects an unsupported Social Security benefit type at intake', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        socialSecurityBenefitType:
          'other' as unknown as SocialSecurityBenefitType,
      })
    ).toThrow('Unsupported Social Security benefit type: other')
  })

  it('rejects worker claim ages above the projection rule', () => {
    expect(() =>
      validatePlanIntake({ ...values, socialSecurityStartAge: 71 })
    ).toThrow('worker socialSecurityStartAge must be between 62 and 70')
  })

  it('requires the associated worker claim age for spouse intake', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        socialSecurityBenefitType: 'spouse',
        socialSecurityStartAge: 62,
      })
    ).toThrow('spouse socialSecurityWorkerClaimAge must be between 62 and 70')
  })

  it('requires a supported birth cohort for delayed worker intake', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        socialSecurityStartAge: 70,
        socialSecurityWorkerBirthYear: 1942,
      })
    ).toThrow(
      'worker delayed credits require socialSecurityWorkerBirthYear 1943 or later'
    )
  })

  it('rejects a delayed worker birth-year and FRA mismatch', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        socialSecurityStartAge: 70,
        socialSecurityWorkerBirthYear: 1943,
      })
    ).toThrow('worker fullRetirementAge must match the birth-year ruleset (66)')
  })

  it('rejects auxiliary benefits without a claimant FRA', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        socialSecurityBenefitType: 'survivor',
        socialSecurityStartAge: 60,
        socialSecurityClaimantFullRetirementAge: undefined,
      })
    ).toThrow('survivor claimant full retirement age must be between 65 and 67')
  })

  it('requires explicit divorced-spouse eligibility confirmation', () => {
    expect(() =>
      validatePlanIntake({
        ...values,
        socialSecurityBenefitType: 'divorced_spouse',
        socialSecurityStartAge: 62,
      })
    ).toThrow('divorced_spouse eligibility must be explicitly confirmed')
  })
})

describe('plan analysis assembly', () => {
  it('connects projections, five verdict stresses, solver, and committed proceeds', () => {
    const analysis = analyzePlan(buildScenario(values), {
      reserveFloor: values.reserveFloor,
      socialSecurityAge: values.socialSecurityStartAge,
    })

    expect(analysis.projections.nominal.rows).toHaveLength(35)
    expect(analysis.projections.real.rows).toHaveLength(35)
    expect(analysis.stressResults).toHaveLength(5)
    expect(analysis.verdict.metrics).toHaveLength(7)
    expect(analysis.incomeSolver.evaluations.length).toBeGreaterThan(0)
    expect(analysis.committedEvents).toHaveLength(2)
    expect(
      analysis.projections.nominal.rows.find(row => row.age === 70)
        ?.incomeBySource['housing-transaction-net-proceeds']
    ).toBe(200_000)
  })
})
