import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PlanResultsStep } from '../plan-results-step'
import {
  analyzePlan,
  buildScenario,
  type PlanIntakeValues,
} from '@/engine/plan'

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

describe('PlanResultsStep comparison behavior', () => {
  it('shows deterministic assumption and outcome changes after a recalculation', () => {
    const previous = analyze(baseValues)
    const current = analyze({
      ...baseValues,
      targetRetirementAge: 64,
      annualExpenses: 70_000,
      annualOutsideIncome: 30_000,
    })

    render(
      <PlanResultsStep
        analysis={current}
        previousAnalysis={previous}
        onBack={vi.fn()}
      />
    )

    expect(
      screen.getByText('What changed from your previous run')
    ).toBeInTheDocument()
    expect(screen.getByText('Assumptions changed')).toBeInTheDocument()
    expect(
      screen.getByText('Target work-exit age changed from 65 to 64.')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Highest-priority modeled outcome changes')
    ).toBeInTheDocument()
  }, 15_000)
})

describe('PlanResultsStep outputs', () => {
  it('renders the bridge summary, milestones, and export actions', () => {
    render(<PlanResultsStep analysis={analyze(baseValues)} onBack={vi.fn()} />)

    expect(
      screen.getByText('Bridge to Social Security and Medicare')
    ).toBeTruthy()
    expect(screen.getByText('Years to Medicare')).toBeTruthy()
    expect(screen.getByText('Medicare eligibility')).toBeTruthy()
    expect(screen.getByText('Plan end')).toBeTruthy()
    expect(screen.getByRole('img', { name: /lifetime chart/i })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Download Markdown' })
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeTruthy()
  })
})
