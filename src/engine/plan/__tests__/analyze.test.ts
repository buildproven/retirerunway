import { describe, expect, it } from 'vitest'
import { findAcaDiscontinuityPoints } from '../analyze'
import { projectScenario } from '../projection'
import type { Scenario } from '../types'

const scenario: Scenario = {
  id: 'aca-cliff-feedback-fixture',
  profile: {
    currentAge: 60,
    targetRetirementAge: 60,
    filingStatus: 'single',
  },
  assumptions: {
    durationYears: 1,
    inflationRate: 0,
    asOfDate: '2026-01-01',
    baseCurrency: 'USD',
  },
  fxRates: [],
  accounts: [
    {
      id: 'pretax',
      name: 'Pretax reserve',
      type: '401k',
      currency: 'USD',
      balance: 200_000,
      annualReturnRate: 0,
      separationAge: 55,
    },
  ],
  incomeStreams: [
    {
      id: 'outside-income',
      name: 'Outside income',
      owner: 'primary',
      currency: 'USD',
      gross: 20_000,
      start: { age: 60 },
      annualGrowthRate: 0.02,
      taxCategory: 'ordinary',
      reliability: 1,
      includedInBase: true,
    },
  ],
  spendingStreams: [
    {
      id: 'living',
      category: 'Living expenses',
      owner: 'primary',
      currency: 'USD',
      amount: 60_000,
      start: { age: 60 },
      annualInflationRate: 0,
      essential: true,
      reduciblePercent: 0,
    },
  ],
  lifeEvents: [],
  healthcare: {
    annualInflationRate: 0,
    phases: [
      {
        id: 'aca',
        kind: 'aca',
        startMonth: '2027-01',
        endMonthExclusive: '2028-01',
        currency: 'USD',
        monthlyPremium: 1_000,
        monthlyOutOfPocket: 0,
      },
    ],
    aca: {
      householdSize: 1,
      residenceRegion: 'contiguous_us',
      rulesByTaxYear: {
        '2027': {
          id: 'feedback-rule',
          taxYear: 2027,
          fplYear: 2026,
          effectiveDate: '2026-01-01',
          residenceRegion: 'contiguous_us',
          annualBaseFpl: 20_000,
          annualAdditionalPersonFpl: 0,
          minimumFplPercent: 100,
          maximumFplPercent: 400,
          status: 'planning_estimate',
          source: 'test fixture',
        },
      },
      benchmarkAnnualPremium: 12_000,
      contributionRate: 0.1,
    },
  },
}

describe('ACA cliff candidate search', () => {
  it('finds a cliff after modeling pretax withdrawal feedback', () => {
    const baseProjection = projectScenario(scenario, 'nominal')
    const points = findAcaDiscontinuityPoints(
      scenario,
      baseProjection,
      'outside-income',
      0,
      200_000
    )
    const point = points[0]
    const baseAca = baseProjection.rows[0]?.healthcare?.acaByTaxYear?.['2027']
    expect(point).toBeDefined()
    expect(baseAca).toBeDefined()

    const candidateProjection = projectScenario(
      {
        ...scenario,
        incomeStreams: scenario.incomeStreams.map(stream =>
          stream.id === 'outside-income' ? { ...stream, gross: point! } : stream
        ),
      },
      'nominal'
    )
    const candidateAca =
      candidateProjection.rows[0]?.healthcare?.acaByTaxYear?.['2027']
    expect(candidateAca).toBeDefined()
    expect(
      Math.abs(candidateAca!.magi - candidateAca!.cliffThreshold)
    ).toBeLessThan(2)

    const naivePoint =
      scenario.incomeStreams[0]!.gross +
      (baseAca!.cliffThreshold - baseAca!.magi) /
        (baseProjection.rows[0]!.incomeBySource['outside-income']! /
          scenario.incomeStreams[0]!.gross)
    expect(point!).toBeGreaterThan(naivePoint + 1_000)
  })
})
