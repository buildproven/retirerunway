import { describe, expect, it } from 'vitest'
import {
  analyzePlan,
  buildScenario,
  comparePlanAnalyses,
  type PlanIntakeValues,
} from '..'

const baseValues: PlanIntakeValues = {
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

function analyze(values: PlanIntakeValues) {
  return analyzePlan(buildScenario(values), {
    reserveFloor: values.reserveFloor,
    socialSecurityAge: values.socialSecurityStartAge,
  })
}

describe('plan analysis comparison', () => {
  it('reports changed assumptions and the highest-priority outcome deltas', () => {
    const previous = analyze(baseValues)
    const current = analyze({
      ...baseValues,
      targetRetirementAge: 64,
      annualExpenses: 70_000,
      annualOutsideIncome: 30_000,
    })

    const comparison = comparePlanAnalyses(previous, current)

    expect(comparison.assumptionChanges.map(change => change.id)).toEqual([
      'retirement-age',
      'retirement-spending',
      'outside-income',
      'additional-modeled-changes',
    ])
    expect(comparison.outcomeChanges.length).toBeGreaterThan(0)
    expect(comparison.outcomeChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'minimum-outside-income' }),
      ])
    )
    expect(
      comparison.outcomeChanges.every(change => change.summary.length > 0)
    ).toBe(true)
  }, 15_000)

  it('returns no changes when the same deterministic analysis is compared', () => {
    const analysis = analyze(baseValues)

    expect(comparePlanAnalyses(analysis, analysis)).toEqual({
      assumptionChanges: [],
      outcomeChanges: [],
    })
  }, 15_000)

  it('reports additional modeled changes with tracked and untracked inputs', () => {
    const previous = analyze(baseValues)
    const current = analyze({
      ...baseValues,
      annualExpenses: 70_000,
      reserveFloor: 150_000,
    })

    expect(
      comparePlanAnalyses(previous, current).assumptionChanges
    ).toContainEqual(
      expect.objectContaining({
        id: 'additional-modeled-changes',
        direction: 'changed',
      })
    )
  }, 15_000)
})
