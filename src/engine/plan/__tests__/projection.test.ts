import { describe, expect, it } from 'vitest'
import { projectScenario, projectScenarioBothModes } from '../projection'
import type { Scenario } from '../types'

const scenario: Scenario = {
  id: 'bridge-fixture',
  profile: {
    currentAge: 54,
    targetRetirementAge: 55,
    filingStatus: 'single',
  },
  assumptions: {
    durationYears: 8,
    inflationRate: 0.03,
    asOfDate: '2026-01-01',
    baseCurrency: 'USD',
  },
  fxRates: [],
  accounts: [
    {
      id: 'taxable',
      name: 'Bridge brokerage',
      type: 'brokerage',
      currency: 'USD',
      balance: 100_000,
      annualReturnRate: 0,
      capitalGainsRatio: 0,
    },
    {
      id: 'employer',
      name: 'Employer 401(k)',
      type: '401k',
      currency: 'USD',
      balance: 200_000,
      annualReturnRate: 0,
      separationAge: 55,
    },
    {
      id: 'roth',
      name: 'Roth IRA',
      type: 'roth_ira',
      currency: 'USD',
      balance: 50_000,
      annualReturnRate: 0,
    },
  ],
  incomeStreams: [
    {
      id: 'salary',
      name: 'Salary',
      owner: 'primary',
      currency: 'USD',
      gross: 0,
      start: { age: 1 },
      annualGrowthRate: 0,
      taxCategory: 'ordinary',
      reliability: 1,
      includedInBase: true,
    },
  ],
  spendingStreams: [
    {
      id: 'living',
      category: 'Living expenses',
      owner: 'household',
      currency: 'USD',
      amount: 30_000,
      start: { age: 55 },
      annualInflationRate: 0.03,
      essential: true,
      reduciblePercent: 0,
    },
  ],
  lifeEvents: [],
}

describe('plan projection kernel', () => {
  it('uses taxable assets as the bridge before the Rule-of-55 employer plan', () => {
    const result = projectScenario(scenario)
    const firstRetirementYear = result.rows.find(row => row.age === 55)
    expect(firstRetirementYear?.withdrawalsByAccount.taxable).toBe(30_000)
    expect(firstRetirementYear?.withdrawalsByAccount.employer ?? 0).toBe(0)
    expect(firstRetirementYear?.accessibleBalance).toBe(270_000)
  })

  it('opens the employer plan at the separation age and keeps Roth last', () => {
    const result = projectScenario(scenario)
    const age56 = result.rows.find(row => row.age === 56)
    expect(age56?.withdrawalsByAccount.taxable).toBe(30_900)
    expect(age56?.withdrawalsByAccount.employer ?? 0).toBe(0)
    const age60 = result.rows.find(row => row.age === 60)
    expect(age60?.accounts.employer.accessible).toBe(true)
    expect(age60?.withdrawalsByAccount.roth ?? 0).toBe(0)
  })

  it('treats 457(b) assets as accessible pre-tax funding', () => {
    const deferredCompScenario: Scenario = {
      ...scenario,
      id: '457b-fixture',
      assumptions: { ...scenario.assumptions, durationYears: 1 },
      accounts: [
        {
          id: 'deferred-comp',
          name: '457(b)',
          type: '457b',
          currency: 'USD',
          balance: 40_000,
          annualReturnRate: 0,
        },
      ],
    }

    const row = projectScenario(deferredCompScenario).rows[0]
    expect(row?.accounts['deferred-comp'].accessible).toBe(true)
    expect(row?.withdrawalsByAccount['deferred-comp']).toBeGreaterThan(30_000)
  })

  it('opens ordinary retirement accounts in the annual row containing age 59.5', () => {
    const ageThresholdScenario: Scenario = {
      ...scenario,
      id: 'age-threshold-fixture',
      assumptions: { ...scenario.assumptions, durationYears: 6 },
      accounts: [
        {
          id: 'traditional',
          name: 'Traditional IRA',
          type: 'traditional_ira',
          currency: 'USD',
          balance: 100_000,
          annualReturnRate: 0,
        },
      ],
      spendingStreams: [],
    }
    const result = projectScenario(ageThresholdScenario)
    const age59 = result.rows.find(row => row.age === 59)
    const age60 = result.rows.find(row => row.age === 60)

    expect(age59?.accounts.traditional.accessible).toBe(false)
    expect(age60?.accounts.traditional.accessible).toBe(true)
  })

  it('fails closed when tax-inclusive withdrawal gross-up does not converge', () => {
    const unstableTaxScenario: Scenario = {
      ...scenario,
      id: 'non-convergent-tax-fixture',
      profile: { ...scenario.profile, currentAge: 59, stateTaxRate: 1 },
      assumptions: { ...scenario.assumptions, durationYears: 1 },
      accounts: [
        {
          id: 'traditional',
          name: 'Traditional IRA',
          type: 'traditional_ira',
          currency: 'USD',
          balance: 1_000_000_000_000,
          annualReturnRate: 0,
        },
      ],
      spendingStreams: [
        {
          ...scenario.spendingStreams[0],
          amount: 50_000,
          start: { age: 60 },
          annualInflationRate: 0,
        },
      ],
    }

    expect(() => projectScenario(unstableTaxScenario)).toThrow(
      'Tax gross-up did not converge for scenario non-convergent-tax-fixture at age 60'
    )
  })

  it('converges ordinary tax gross-up near a marginal bracket boundary', () => {
    const bracketBoundaryScenario: Scenario = {
      ...scenario,
      id: 'bracket-boundary-fixture',
      profile: { ...scenario.profile, currentAge: 59, stateTaxRate: 0.2 },
      assumptions: { ...scenario.assumptions, durationYears: 1 },
      accounts: [
        {
          id: 'traditional',
          name: 'Traditional IRA',
          type: 'traditional_ira',
          currency: 'USD',
          balance: 1_000_000,
          annualReturnRate: 0,
        },
      ],
      spendingStreams: [
        {
          ...scenario.spendingStreams[0],
          amount: 100_000,
          annualInflationRate: 0,
          start: { age: 60 },
        },
      ],
    }

    const row = projectScenario(bracketBoundaryScenario).rows[0]
    expect(row?.fundingGap).toBeCloseTo(0, 1)
    expect(row?.taxes).toBeGreaterThan(0)
    expect(row?.withdrawalsByAccount.traditional).toBeGreaterThan(
      row?.spending ?? 0
    )
  })

  it('reports the exact shortfall after accessible assets are depleted', () => {
    const depletionScenario: Scenario = {
      ...scenario,
      id: 'depletion-fixture',
      assumptions: { ...scenario.assumptions, durationYears: 3 },
      accounts: [
        {
          id: 'cash',
          name: 'Cash reserve',
          type: 'cash',
          currency: 'USD',
          balance: 25_000,
          annualReturnRate: 0,
        },
      ],
      spendingStreams: [
        {
          ...scenario.spendingStreams[0],
          amount: 20_000,
          annualInflationRate: 0,
          start: { age: 55 },
        },
      ],
    }

    const rows = projectScenario(depletionScenario).rows
    expect(rows[0]?.fundingGap).toBe(0)
    expect(rows[0]?.accounts.cash.endBalance).toBe(5_000)
    expect(rows[1]?.fundingGap).toBe(15_000)
    expect(rows[1]?.accounts.cash.endBalance).toBe(0)
    expect(rows[2]?.fundingGap).toBe(20_000)
    expect(rows[2]?.accounts.cash.endBalance).toBe(0)
  })

  it('applies date-based stream boundaries at both the age and date gates', () => {
    const dateBoundaryScenario: Scenario = {
      ...scenario,
      id: 'date-boundary-fixture',
      assumptions: { ...scenario.assumptions, durationYears: 2 },
      spendingStreams: [
        {
          ...scenario.spendingStreams[0],
          amount: 10_000,
          annualInflationRate: 0,
          start: { date: '2027-07-01' },
        },
      ],
    }

    const rows = projectScenario(dateBoundaryScenario).rows
    expect(rows[0]?.date).toBe('2027-01-01')
    expect(rows[0]?.age).toBe(55)
    expect(rows[0]?.spending).toBe(0)
    expect(rows[1]?.date).toBe('2028-01-01')
    expect(rows[1]?.age).toBe(56)
    expect(rows[1]?.spending).toBe(10_000)
  })

  it('produces nominal and real rows that reconcile by the inflation factor', () => {
    const { nominal, real } = projectScenarioBothModes(scenario)
    const nominalRow = nominal.rows[2]
    const realRow = real.rows[2]
    expect(nominalRow.spending).toBe(31_827)
    expect(realRow.spending).toBe(29_126.21)
    expect(nominalRow.spending / realRow.spending).toBeCloseTo(1.03 ** 3, 6)
  })

  it('requires an effective FX rate instead of silently using a default', () => {
    const foreign = {
      ...scenario,
      accounts: [{ ...scenario.accounts[0], currency: 'AUD' }],
    }
    expect(() => projectScenario(foreign)).toThrow('Missing FX rate')
  })
})
