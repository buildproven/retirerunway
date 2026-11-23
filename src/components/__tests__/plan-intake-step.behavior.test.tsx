import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PlanIntakeStep } from '../plan-intake-step'

describe('PlanIntakeStep Social Security behavior', () => {
  it('warns that SSA estimates need a planned-stop-work adjustment', () => {
    render(<PlanIntakeStep onComplete={vi.fn()} onBack={vi.fn()} />)

    expect(
      screen.getByText(
        'SSA estimates can assume continued future earnings. If you plan to stop work before claiming, enter a benefit estimate recalculated for your planned stop-work age. RetireRunway does not infer that adjustment.'
      )
    ).toBeInTheDocument()
  })

  it('passes the selected benefit type and claim assumptions into the analysis', () => {
    const onComplete = vi.fn()
    render(<PlanIntakeStep onComplete={onComplete} onBack={vi.fn()} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Load conservative sample' })
    )
    fireEvent.change(screen.getByLabelText('Social Security benefit type'), {
      target: { value: 'spouse' },
    })
    fireEvent.change(screen.getByLabelText('Social Security start age'), {
      target: { value: '62' },
    })
    fireEvent.change(screen.getByLabelText('Associated worker claim age'), {
      target: { value: '67' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run retirement plan' }))

    expect(onComplete).toHaveBeenCalledOnce()
    expect(
      onComplete.mock.calls[0]?.[0].scenario.socialSecurityBenefits
    ).toEqual([
      expect.objectContaining({
        benefitType: 'spouse',
        claimAge: 62,
        associatedWorkerClaimAge: 67,
        fullRetirementAge: 67,
      }),
    ])
  }, 15_000)

  it('requires divorced-spouse eligibility confirmation before running', () => {
    const onComplete = vi.fn()
    render(<PlanIntakeStep onComplete={onComplete} onBack={vi.fn()} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Load conservative sample' })
    )
    fireEvent.change(screen.getByLabelText('Social Security benefit type'), {
      target: { value: 'divorced_spouse' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run retirement plan' }))

    expect(onComplete).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'Confirm that the divorced-spouse benefit eligibility requirements are met.'
      )
    ).toBeInTheDocument()
  })
})
