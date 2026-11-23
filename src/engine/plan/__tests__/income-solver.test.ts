import { describe, expect, it } from 'vitest'
import { solveMinimumOutsideIncome } from '../income-solver'
import type { Scenario } from '../types'
import type { PlanVerdictResult } from '../verdict'

const scenario: Scenario = {
  id: 'solver-fixture',
  profile: { currentAge: 50, targetRetirementAge: 55, filingStatus: 'single' },
  assumptions: {
    durationYears: 5,
    inflationRate: 0,
    asOfDate: '2026-01-01',
    baseCurrency: 'USD',
  },
  fxRates: [],
  accounts: [],
  incomeStreams: [
    {
      id: 'outside-income',
      name: 'Outside income',
      owner: 'primary',
      currency: 'USD',
      gross: 0,
      start: { age: 50 },
      annualGrowthRate: 0,
      taxCategory: 'ordinary',
      reliability: 1,
      includedInBase: true,
    },
  ],
  spendingStreams: [],
  lifeEvents: [],
}

function evaluate(candidate: Scenario): PlanVerdictResult {
  const gross = candidate.incomeStreams[0]?.gross ?? 0
  const verdict = gross >= 100_000 ? 'GO' : 'CAUTION'
  return {
    verdict,
    robustnessScore: verdict === 'GO' ? 10 : 5,
    metrics: [],
    baselineSolvent: verdict === 'GO',
    stressScenariosSolvent: verdict === 'GO' ? 5 : 2,
    bridgeLiquidityCovered: verdict === 'GO',
    postSocialSecurityCovered: verdict === 'GO',
    delayReasons: [],
    cautionReasons: verdict === 'GO' ? [] : ['income below threshold'],
  }
}

const options = {
  minGrossIncome: 0,
  maxGrossIncome: 200_000,
  tolerance: 1,
  maxIterations: 20,
  safetyMarginPercent: 0.1,
  operatingExpenseRate: 0.1,
  selfEmploymentTaxRate: 0.05,
  personalTaxRate: 0.2,
  retirementContributionRate: 0.05,
  maximumAffordableHousing: 400_000,
  minimumLiquidReserve: 75_000,
  findEarliestRobustExitAge: (candidate: Scenario) =>
    candidate.profile.targetRetirementAge,
} as const

describe('minimum outside-income solver', () => {
  it('bisects to the smallest gross income that flips the verdict', () => {
    const result = solveMinimumOutsideIncome(
      scenario,
      'outside-income',
      evaluate,
      options,
      200_000
    )
    expect(result.minimumGrossIncome).toBe(100_000)
    expect(result.recommendedGrossIncome).toBe(110_000)
    expect(result.minimumSpendableIncome).toBe(60_000)
    expect(result.recommendedSpendableIncome).toBe(66_000)
    expect(result.earliestRobustExitAge).toBe(55)
    expect(result.evaluations.length).toBeGreaterThan(2)
  })

  it('returns no solution when the upper bound cannot produce GO', () => {
    const result = solveMinimumOutsideIncome(
      scenario,
      'outside-income',
      () => ({ ...evaluate(scenario), verdict: 'CAUTION' }),
      options,
      200_000
    )
    expect(result.minimumGrossIncome).toBeNull()
    expect(result.recommendedGrossIncome).toBeNull()
  })

  it('rejects an unknown income stream instead of silently adding one', () => {
    expect(() =>
      solveMinimumOutsideIncome(scenario, 'missing', evaluate, options, 200_000)
    ).toThrow('Unknown outside-income stream')
  })

  it('rounds the minimum upward and rechecks that it still produces GO', () => {
    const result = solveMinimumOutsideIncome(
      scenario,
      'outside-income',
      candidate => ({
        ...evaluate(candidate),
        verdict:
          (candidate.incomeStreams[0]?.gross ?? 0) >= 100_000.005
            ? 'GO'
            : 'CAUTION',
      }),
      { ...options, tolerance: 0.0001, maxIterations: 40 },
      200_000
    )
    expect(result.minimumGrossIncome).toBeGreaterThanOrEqual(100_000.01)
    expect(result.evaluations.at(-1)?.verdict.verdict).toBe('GO')
  })

  it('rejects non-finite numeric inputs before searching', () => {
    expect(() =>
      solveMinimumOutsideIncome(
        scenario,
        'outside-income',
        evaluate,
        { ...options, tolerance: Number.NaN },
        200_000
      )
    ).toThrow('tolerance must be finite')
    expect(() =>
      solveMinimumOutsideIncome(
        scenario,
        'outside-income',
        evaluate,
        { ...options, personalTaxRate: Number.POSITIVE_INFINITY },
        200_000
      )
    ).toThrow('personalTaxRate must be finite')
  })

  it('returns no solution when the GO boundary cannot be represented below max', () => {
    const result = solveMinimumOutsideIncome(
      scenario,
      'outside-income',
      candidate => ({
        ...evaluate(candidate),
        verdict:
          (candidate.incomeStreams[0]?.gross ?? 0) >= 100_000.005
            ? 'GO'
            : 'CAUTION',
      }),
      {
        ...options,
        maxGrossIncome: 100_000.005,
        tolerance: 0.0001,
        maxIterations: 40,
      },
      200_000
    )
    expect(result.minimumGrossIncome).toBeNull()
    expect(result.recommendedGrossIncome).toBeNull()
  })

  it('searches both sides of a discontinuous verdict boundary', () => {
    const result = solveMinimumOutsideIncome(
      scenario,
      'outside-income',
      candidate => {
        const gross = candidate.incomeStreams[0]?.gross ?? 0
        const verdict =
          (gross >= 80_000 && gross < 100_000) || gross >= 150_000
            ? 'GO'
            : 'CAUTION'
        return { ...evaluate(candidate), verdict }
      },
      { ...options, discontinuityPoints: [100_000] },
      200_000
    )

    expect(result.minimumGrossIncome).toBeGreaterThanOrEqual(80_000)
    expect(result.minimumGrossIncome).toBeLessThan(80_001)
  })

  it('searches a lower GO interval when the upper bound is not GO', () => {
    const result = solveMinimumOutsideIncome(
      scenario,
      'outside-income',
      candidate => {
        const gross = candidate.incomeStreams[0]?.gross ?? 0
        const verdict = gross >= 80_000 && gross < 100_000 ? 'GO' : 'CAUTION'
        return { ...evaluate(candidate), verdict }
      },
      { ...options, discontinuityPoints: [100_000] },
      200_000
    )

    expect(result.minimumGrossIncome).toBeGreaterThanOrEqual(80_000)
    expect(result.minimumGrossIncome).toBeLessThan(80_001)
  })

  it('withholds the safety-margin recommendation when it crosses a cliff', () => {
    const result = solveMinimumOutsideIncome(
      scenario,
      'outside-income',
      candidate => {
        const gross = candidate.incomeStreams[0]?.gross ?? 0
        const verdict = gross >= 95_000 && gross < 100_000 ? 'GO' : 'CAUTION'
        return { ...evaluate(candidate), verdict }
      },
      { ...options, discontinuityPoints: [100_000] },
      200_000
    )

    expect(result.minimumGrossIncome).toBeGreaterThanOrEqual(95_000)
    expect(result.minimumGrossIncome).toBeLessThan(95_001)
    expect(result.recommendedGrossIncome).toBeNull()
  })
})
