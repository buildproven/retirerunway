import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanMonteCarloCard, successLabel } from '../plan-monte-carlo-card'
import { analyzePlan, buildScenario } from '@/engine/plan'

describe('successLabel', () => {
  it('bands the success rate', () => {
    expect(successLabel(0.9).text).toBe('Strong')
    expect(successLabel(0.7).text).toBe('Moderate')
    expect(successLabel(0.4).text).toBe('Weak')
  })
})

describe('PlanMonteCarloCard', () => {
  it('shows a run button and reports an unsupported environment', async () => {
    const analysis = analyzePlan(
      buildScenario({
        currentAge: 58,
        targetRetirementAge: 62,
        durationYears: 5,
        filingStatus: 'single',
        acaHouseholdSize: 1,
        acaResidenceRegion: 'contiguous_us',
        annualExpenses: 40_000,
        essentialExpenses: 30_000,
        cashBalance: 20_000,
        brokerageBalance: 300_000,
        traditionalBalance: 300_000,
        rothBalance: 100_000,
        annualWorkIncome: 80_000,
        annualOutsideIncome: 0,
        annualSocialSecurity: 0,
        annualSocialSecurityAtFullRetirementAge: 24_000,
        socialSecurityStartAge: 67,
        annualHealthcare: 8_000,
        reserveFloor: 50_000,
        housingProceeds: 0,
        housingEventAge: 70,
        housingCommitment: 'committed',
      })
    )
    render(<PlanMonteCarloCard analysis={analysis} />)
    fireEvent.click(screen.getByRole('button', { name: /run simulation/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /cannot run background simulations/i
    )
  })
})
