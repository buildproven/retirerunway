import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  setUserProfile: vi.fn(),
}))

vi.mock('@/store/portfolio-store', () => ({
  usePortfolioStore: (selector: (state: unknown) => unknown) =>
    selector({ userProfile: null, setUserProfile: mocks.setUserProfile }),
}))

import { ProfileStep } from '../profile-step'

describe('ProfileStep behavior', () => {
  beforeEach(() => {
    mocks.setUserProfile.mockReset()
  })

  it('shows validation feedback and does not advance on an empty form', () => {
    const onComplete = vi.fn()
    render(<ProfileStep onComplete={onComplete} onBack={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run Scenarios' }))

    expect(screen.getByText('Enter your current age')).toBeInTheDocument()
    expect(screen.getByText('Enter your annual expenses')).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
    expect(mocks.setUserProfile).not.toHaveBeenCalled()
  })

  it('loads the explicit sample, persists it, and advances', () => {
    const onComplete = vi.fn()
    render(<ProfileStep onComplete={onComplete} onBack={vi.fn()} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Load conservative sample' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run Scenarios' }))

    expect(mocks.setUserProfile).toHaveBeenCalledWith({
      currentAge: 58,
      targetRetirementAge: 65,
      annualExpenses: 70000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 2000,
      pensionMonthly: undefined,
      federalTaxBracket: 0.22,
    })
    expect(onComplete).toHaveBeenCalledOnce()
  })
})
