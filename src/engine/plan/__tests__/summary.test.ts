import { describe, expect, it } from 'vitest'
import {
  analyzePlan,
  buildBridgeSummary,
  buildLifetimeSeries,
  buildMilestones,
  buildScenario,
  planToJson,
  planToMarkdown,
  type PlanIntakeValues,
} from '@/engine/plan'

const values: PlanIntakeValues = {
  currentAge: 58,
  targetRetirementAge: 62,
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
  housingProceeds: 0,
  housingEventAge: 70,
  housingCommitment: 'committed',
}

function analyze(overrides: Partial<PlanIntakeValues> = {}) {
  const v = { ...values, ...overrides }
  return analyzePlan(buildScenario(v), {
    reserveFloor: v.reserveFloor,
    socialSecurityAge: v.socialSecurityStartAge,
  })
}

describe('plan summary', () => {
  const analysis = analyze()

  it('computes bridge distances from the exit age', () => {
    const bridge = buildBridgeSummary(analysis)
    expect(bridge.exitAge).toBe(62)
    expect(bridge.yearsToMedicare).toBe(3)
    expect(bridge.yearsToSocialSecurity).toBe(5)
  })

  it('sums bridge spending only over exit..Social Security rows', () => {
    const bridge = buildBridgeSummary(analysis)
    const expected = analysis.projections.real.rows
      .filter(row => row.age >= 62 && row.age < 67)
      .reduce((sum, row) => sum + row.spending, 0)
    expect(bridge.bridgeSpending).toBeCloseTo(expected, 6)
    expect(bridge.bridgeSpending).toBeGreaterThan(5 * 40_000)
  })

  it('finds the true lowest total balance', () => {
    const bridge = buildBridgeSummary(analysis)
    const min = Math.min(
      ...analysis.projections.real.rows.map(
        row => row.accessibleBalance + row.restrictedBalance
      )
    )
    expect(bridge.lowestBalance.total).toBe(min)
  })

  it('orders milestones by age and includes the key transitions', () => {
    const milestones = buildMilestones(analysis)
    const ages = milestones.map(m => m.age)
    expect(ages).toEqual([...ages].sort((a, b) => a - b))
    const labels = milestones.map(m => m.label)
    expect(labels).toEqual(
      expect.arrayContaining([
        'Work exit',
        'Medicare eligibility',
        'Social Security starts',
        'Plan end',
      ])
    )
  })

  it('drops milestones outside the modeled horizon', () => {
    const short = analyze({ durationYears: 5 })
    expect(
      buildMilestones(short).some(m => m.label === 'Medicare eligibility')
    ).toBe(false)
  })

  it('splits lifetime balances into accessible and restricted', () => {
    const series = buildLifetimeSeries(analysis)
    expect(series).toHaveLength(analysis.projections.real.rows.length)
    expect(series[0].accessible + series[0].restricted).toBeGreaterThan(0)
    expect(series.every(point => point.accessible >= 0)).toBe(true)
  })

  it('produces byte-identical exports for equal inputs', () => {
    // `analysis` and `second` come from two independent analyze() runs.
    const second = analyze()
    expect(planToMarkdown(second)).toBe(planToMarkdown(analysis))
    expect(planToJson(second)).toBe(planToJson(analysis))
  })

  it('exports the verdict, disclaimer, and valid JSON', () => {
    const markdown = planToMarkdown(analysis)
    expect(markdown).toContain(`**Verdict:** ${analysis.verdict.verdict}`)
    expect(markdown).toContain('Not financial, tax, or legal advice')
    const parsed = JSON.parse(planToJson(analysis)) as {
      schema: string
      verdict: { verdict: string }
    }
    expect(parsed.schema).toBe('retire-runway.plan.v1')
    expect(parsed.verdict.verdict).toBe(analysis.verdict.verdict)
  })

  it('reflects a changed plan in the export', () => {
    expect(planToMarkdown(analyze({ annualExpenses: 140_000 }))).not.toBe(
      planToMarkdown(analysis)
    )
  })
})
