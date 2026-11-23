import { describe, expect, it } from 'vitest'
import { evaluatePlanVerdict } from '../verdict'
import type { PlanProjection } from '../types'

function projection(
  fundingGap: number,
  endBalance: number,
  overrides: Partial<PlanProjection['rows'][number]> = {}
): PlanProjection {
  return {
    scenarioId: 'fixture',
    mode: 'real',
    rows: [
      {
        year: 1,
        date: '2027-01-01',
        age: 60,
        incomeBySource: {},
        spendingByCategory: { living: 20_000 },
        income: 20_000,
        spending: 20_000,
        essentialSpending: 20_000,
        taxes: 0,
        withdrawalsByAccount: {},
        accounts: {},
        accessibleBalance: endBalance,
        restrictedBalance: 0,
        fundingGap,
        ...overrides,
      },
    ],
  }
}

const options = {
  stressProjections: [
    projection(0, 100_000),
    projection(0, 100_000),
    projection(0, 100_000),
    projection(0, 100_000),
    projection(0, 100_000),
  ],
  socialSecurityAge: 60,
  reserveFloor: 50_000,
  sustainableWithdrawalRate: 0.04,
  demonstratedOutsideIncome: 20_000,
  requiredOutsideIncome: 10_000,
  healthcareFunded: true,
  taxesFunded: true,
  dependsOnUncommittedLever: false,
  reliesOnInheritance: false,
} as const

describe('outcome-based plan verdict', () => {
  it('returns GO only when baseline, liquidity, stresses, and post-SS coverage pass', () => {
    const result = evaluatePlanVerdict(projection(0, 100_000), options)
    expect(result.verdict).toBe('GO')
    expect(result.robustnessScore).toBe(10)
    expect(result.metrics).toHaveLength(7)
  })

  it('returns DELAY for a bridge gap even when average balances look healthy', () => {
    const result = evaluatePlanVerdict(projection(5_000, 100_000), options)
    expect(result.verdict).toBe('DELAY')
    expect(result.delayReasons).toContain(
      'baseline depletes or has an unfunded year'
    )
    expect(result.delayReasons).toContain(
      'accessible funds do not cover the bridge'
    )
  })

  it('returns CAUTION when stress resilience or an uncommitted lever is weak', () => {
    const result = evaluatePlanVerdict(projection(0, 100_000), {
      ...options,
      stressProjections: [
        projection(0, 100_000),
        projection(0, 100_000),
        projection(1, 100_000),
        projection(1, 100_000),
        projection(1, 100_000),
      ],
      dependsOnUncommittedLever: true,
    })
    expect(result.verdict).toBe('CAUTION')
    expect(result.stressScenariosSolvent).toBe(2)
  })

  it('never turns a plan green when inheritance is the only support', () => {
    const result = evaluatePlanVerdict(projection(0, 100_000), {
      ...options,
      reliesOnInheritance: true,
    })
    expect(result.verdict).toBe('DELAY')
    expect(result.delayReasons).toContain('base plan relies on inheritance')
  })

  it('does not treat a horizon ending before Social Security as covered', () => {
    const result = evaluatePlanVerdict(projection(0, 100_000), {
      ...options,
      socialSecurityAge: 61,
      reserveFloor: 0,
    })
    expect(result.verdict).toBe('CAUTION')
    expect(result.postSocialSecurityCovered).toBe(false)
    expect(result.cautionReasons).toContain(
      'post-Social-Security essential spending needs exceed sustainable draw'
    )
  })

  it('rejects stress sets that do not contain exactly five scenarios', () => {
    expect(() =>
      evaluatePlanVerdict(projection(0, 100_000), {
        ...options,
        stressProjections: options.stressProjections.slice(0, 4),
      })
    ).toThrow('stressProjections must contain exactly five scenarios')
  })

  it('allows fully income-funded plans with zero assets', () => {
    const result = evaluatePlanVerdict(projection(0, 0), {
      ...options,
      reserveFloor: 0,
      stressProjections: [
        projection(0, 0),
        projection(0, 0),
        projection(0, 0),
        projection(0, 0),
        projection(0, 0),
      ],
    })
    expect(result.baselineSolvent).toBe(true)
    expect(result.verdict).toBe('GO')
    expect(result.robustnessScore).toBe(10)
  })

  it('rejects nominal projections for a real-dollar reserve verdict', () => {
    expect(() =>
      evaluatePlanVerdict(
        { ...projection(0, 100_000), mode: 'nominal' },
        options
      )
    ).toThrow('plan verdict requires real-dollar projections')
  })
})
