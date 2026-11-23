import { describe, expect, it } from 'vitest'
import {
  buildStressScenarioSuite,
  committedLifeEvents,
  materializeStressScenarios,
  projectStressScenarioSuite,
} from '..'
import type { Scenario } from '../types'

const baseline: Scenario = {
  id: 'stress-fixture',
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
      id: 'portfolio',
      name: 'Portfolio',
      type: 'brokerage',
      currency: 'USD',
      balance: 500_000,
      annualReturnRate: 0.05,
    },
    {
      id: 'cash',
      name: 'Cash reserve',
      type: 'cash',
      currency: 'USD',
      balance: 100_000,
      annualReturnRate: 0,
    },
  ],
  incomeStreams: [
    {
      id: 'salary',
      name: 'Salary',
      owner: 'primary',
      currency: 'USD',
      gross: 100_000,
      start: { age: 54 },
      end: { age: 55 },
      annualGrowthRate: 0,
      taxCategory: 'ordinary',
      reliability: 1,
      includedInBase: true,
    },
    {
      id: 'consulting',
      name: 'Consulting business',
      owner: 'primary',
      currency: 'USD',
      gross: 40_000,
      start: { age: 55 },
      end: { age: 57 },
      annualGrowthRate: 0,
      taxCategory: 'ordinary',
      reliability: 0.8,
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
    {
      id: 'healthcare',
      category: 'Healthcare',
      owner: 'household',
      currency: 'USD',
      amount: 6_000,
      start: { age: 55 },
      annualInflationRate: 0.03,
      essential: true,
      reduciblePercent: 0,
    },
  ],
  lifeEvents: [
    {
      id: 'downsize-home',
      kind: 'housing_transaction',
      name: 'Downsize home',
      date: { age: 56 },
      amount: 200_000,
      currency: 'USD',
      commitment: 'available',
    },
  ],
}

const options = {
  healthcareStreamIds: ['healthcare'],
  outsideIncomeStreamIds: ['consulting'],
  workIncomeStreamIds: ['salary'],
  downsizeEventId: 'downsize-home',
  highInflationRate: 0.08,
} as const

describe('deterministic stress scenario suite', () => {
  it('builds the ten P0 requirements and a materialized downsize comparison', () => {
    const suite = buildStressScenarioSuite(baseline, options)

    expect(suite.scenarios).toHaveLength(10)
    expect(suite.scenarios.map(scenario => scenario.id)).toEqual([
      'baseline',
      'market-shock-20-first-retirement-year',
      'market-shock-30-first-retirement-year',
      'two-year-high-inflation',
      'healthcare-double-two-years',
      'outside-income-half-three-years',
      'combined-bad-start',
      'work-exit-delay-one-year',
      'work-exit-delay-three-years',
      'downsize',
    ])
    expect(materializeStressScenarios(suite)).toHaveLength(11)
    expect(suite.downsizeComparison.committed.scenario.id).toContain(
      'downsize-committed'
    )
    expect(suite.downsizeComparison.notUsed.scenario.id).toContain(
      'downsize-not-used'
    )
    expect(suite.downsizeComparison.committed.id).toBe('downsize-committed')
    expect(suite.downsizeComparison.notUsed.id).toBe('downsize-not-used')
  })

  it('applies a market shock only in the first retirement year', () => {
    const suite = buildStressScenarioSuite(baseline, options)
    const projections = projectStressScenarioSuite(suite, 'nominal')
    const baselineRow = projections[0]?.projection.rows[0]
    const shockRow = projections[1]?.projection.rows[0]
    const laterShockRow = projections[1]?.projection.rows[1]

    expect(baselineRow?.accounts.portfolio.growth).toBe(25_000)
    expect(shockRow?.accounts.portfolio.growth).toBe(-100_000)
    expect(laterShockRow?.accounts.portfolio.growth).toBe(20_000)
    expect(shockRow?.accounts.cash.growth).toBe(0)
  })

  it('compounds high inflation for two years and then returns to baseline', () => {
    const suite = buildStressScenarioSuite(baseline, options)
    const projections = projectStressScenarioSuite(suite, 'nominal')
    const baselineRows = projections[0]?.projection.rows
    const highInflationRows = projections[3]?.projection.rows

    expect(highInflationRows?.[0]?.spending).toBe(baselineRows?.[0]?.spending)
    expect(highInflationRows?.[1]?.spending).toBe(38_880)
    expect(highInflationRows?.[2]?.spending).toBe(41_990.4)
  })

  it('honors prepended stress rates over overlapping baseline schedules', () => {
    const scheduled = buildStressScenarioSuite(
      {
        ...baseline,
        spendingStreams: baseline.spendingStreams.map(stream =>
          stream.id === 'living'
            ? {
                ...stream,
                annualInflationRateSchedule: [
                  { startYear: 1, endYear: 1, rate: 0.04 },
                ],
              }
            : stream
        ),
      },
      options
    )
    const highInflation = projectStressScenarioSuite(scheduled, 'nominal')[3]
      ?.projection

    expect(highInflation?.rows[1]?.spendingByCategory.living).toBe(32_400)
  })

  it('doubles healthcare and halves outside income only for their defined windows', () => {
    const suite = buildStressScenarioSuite(baseline, options)
    const projections = projectStressScenarioSuite(suite, 'nominal')
    const healthcareRows = projections[4]?.projection.rows
    const incomeRows = projections[5]?.projection.rows

    expect(healthcareRows?.[0]?.spendingByCategory.healthcare).toBe(12_000)
    expect(healthcareRows?.[1]?.spendingByCategory.healthcare).toBe(12_360)
    expect(healthcareRows?.[2]?.spendingByCategory.healthcare).toBe(6_365.4)
    expect(incomeRows?.[0]?.incomeBySource.consulting).toBe(20_000)
    expect(incomeRows?.[2]?.incomeBySource.consulting).toBe(20_000)
    expect(incomeRows?.[3]?.incomeBySource.consulting).toBe(0)
  })

  it('combines market, inflation, and outside-income shocks deterministically', () => {
    const suite = buildStressScenarioSuite(baseline, options)
    const combined = suite.scenarios.find(
      scenario => scenario.id === 'combined-bad-start'
    )
    if (!combined || combined.id === 'downsize')
      throw new Error('missing combined stress')

    expect(combined.scenario.accounts[0]?.returnSchedule?.[0]).toEqual({
      startYear: 1,
      endYear: 1,
      rate: -0.25,
    })
    expect(combined.scenario.assumptions.inflationRateSchedule?.[0]).toEqual({
      startYear: 1,
      endYear: 2,
      rate: 0.08,
    })
    expect(
      combined.scenario.incomeStreams[1]?.amountMultiplierSchedule?.[0]
    ).toEqual({
      startYear: 1,
      endYear: 3,
      multiplier: 0.5,
    })
  })

  it('moves work exit boundaries without changing the baseline', () => {
    const suite = buildStressScenarioSuite(baseline, options)
    const oneYear = suite.scenarios.find(
      scenario => scenario.id === 'work-exit-delay-one-year'
    )
    const threeYears = suite.scenarios.find(
      scenario => scenario.id === 'work-exit-delay-three-years'
    )

    expect(baseline.incomeStreams[0]?.end).toEqual({ age: 55 })
    expect(oneYear?.scenario.incomeStreams[0]?.end).toEqual({ age: 56 })
    expect(threeYears?.scenario.incomeStreams[0]?.end).toEqual({ age: 58 })
  })

  it('compares committed downsize proceeds with the unused option', () => {
    const suite = buildStressScenarioSuite(baseline, options)
    const committed = suite.downsizeComparison.committed.scenario
    const notUsed = suite.downsizeComparison.notUsed.scenario
    const committedRows = projectStressScenarioSuite(suite, 'nominal').filter(
      projection => projection.scenario.id === committed.id
    )
    const committedProjection = committedRows[0]?.projection
    const notUsedProjection = projectStressScenarioSuite(suite, 'nominal').find(
      projection => projection.scenario.id === notUsed.id
    )?.projection

    expect(committedLifeEvents(committed)).toHaveLength(1)
    expect(committedLifeEvents(notUsed)).toHaveLength(0)
    expect(
      committedProjection?.rows.find(row => row.age === 56)?.incomeBySource[
        'downsize-home-net-proceeds'
      ]
    ).toBe(200_000)
    expect(
      committedProjection?.rows.find(row => row.age === 57)?.incomeBySource[
        'downsize-home-net-proceeds'
      ]
    ).toBe(0)
    expect(
      notUsedProjection?.rows.find(row => row.age === 56)?.incomeBySource[
        'downsize-home-net-proceeds'
      ]
    ).toBeUndefined()
  })

  it('places dated downsize proceeds in the matching annual bucket', () => {
    const dated = buildStressScenarioSuite(
      {
        ...baseline,
        lifeEvents: [
          {
            ...baseline.lifeEvents[0]!,
            date: { date: '2028-06-15' },
          },
        ],
      },
      options
    )
    const committed = dated.downsizeComparison.committed.scenario
    const projection = projectStressScenarioSuite(dated, 'nominal').find(
      result => result.scenario.id === committed.id
    )?.projection

    expect(
      projection?.rows.find(row => row.age === 56)?.incomeBySource[
        'downsize-home-net-proceeds'
      ]
    ).toBe(200_000)
  })

  it('fails closed when required stress inputs are ambiguous or missing', () => {
    expect(() =>
      buildStressScenarioSuite(
        {
          ...baseline,
          spendingStreams: baseline.spendingStreams.filter(
            stream => stream.id !== 'healthcare'
          ),
        },
        options
      )
    ).toThrow('Unknown healthcare stream IDs')

    expect(() =>
      buildStressScenarioSuite(baseline, {
        ...options,
        workIncomeStreamIds: ['missing-work'],
      })
    ).toThrow('Unknown work stream IDs')

    expect(() =>
      buildStressScenarioSuite(
        {
          ...baseline,
          lifeEvents: [
            ...baseline.lifeEvents,
            {
              ...baseline.lifeEvents[0],
              id: 'second-home',
              name: 'Second home',
            },
          ],
        },
        {
          healthcareStreamIds: options.healthcareStreamIds,
          outsideIncomeStreamIds: options.outsideIncomeStreamIds,
          workIncomeStreamIds: options.workIncomeStreamIds,
        }
      )
    ).toThrow('multiple housing transactions')

    expect(() =>
      buildStressScenarioSuite(
        {
          ...baseline,
          incomeStreams: [
            ...baseline.incomeStreams,
            {
              ...baseline.incomeStreams[0],
              id: 'downsize-home-net-proceeds',
              name: 'Existing proceeds stream',
            },
          ],
        },
        options
      )
    ).toThrow('collides with an existing income stream')

    expect(() =>
      buildStressScenarioSuite(
        {
          ...baseline,
          lifeEvents: [
            {
              ...baseline.lifeEvents[0]!,
              date: { age: 70 },
            },
          ],
        },
        options
      )
    ).toThrow('within projection years')
  })

  it('clamps leap-day work exits when delaying into a non-leap year', () => {
    const leapDay = buildStressScenarioSuite(
      {
        ...baseline,
        incomeStreams: baseline.incomeStreams.map(stream =>
          stream.id === 'salary'
            ? { ...stream, end: { date: '2028-02-29' } }
            : stream
        ),
      },
      options
    )
    const delayed = leapDay.scenarios.find(
      scenario => scenario.id === 'work-exit-delay-one-year'
    )
    expect(delayed?.scenario.incomeStreams[0]?.end).toEqual({
      date: '2029-02-28',
    })
  })

  it('is byte-stable for identical inputs', () => {
    const first = buildStressScenarioSuite(baseline, options)
    const second = buildStressScenarioSuite(baseline, options)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})
