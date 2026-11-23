import { describe, expect, it } from 'vitest'
import { runPlanMonteCarlo } from '../monte-carlo'
import { buildScenario, type PlanIntakeValues } from '../intake'
import { projectScenario } from '../projection'

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

const FAST = { numPaths: 20 }

describe('plan Monte Carlo', () => {
  it('equals the deterministic projection when volatility is zero', () => {
    const scenario = buildScenario(values)
    const result = runPlanMonteCarlo(scenario, {
      ...FAST,
      investedStdDev: 0,
      cashStdDev: 0,
    })
    const rows = projectScenario(scenario, 'real').rows
    const last = rows.at(-1)
    expect(result.bands).toHaveLength(rows.length)
    expect(result.bands.at(-1)?.p10).toBeCloseTo(
      (last?.accessibleBalance ?? 0) + (last?.restrictedBalance ?? 0),
      2
    )
    expect(result.bands.at(-1)?.p10).toBe(result.bands.at(-1)?.p90)
    expect(result.successRate).toBe(rows.every(r => r.fundingGap === 0) ? 1 : 0)
  })

  it('succeeds on every path for a heavily funded plan', () => {
    const rich = buildScenario({
      ...values,
      brokerageBalance: 6_000_000,
      annualExpenses: 40_000,
      essentialExpenses: 30_000,
    })
    expect(runPlanMonteCarlo(rich, FAST).successRate).toBe(1)
  })

  it('fails on every path for an unfunded plan', () => {
    const broke = buildScenario({
      ...values,
      brokerageBalance: 0,
      traditionalBalance: 0,
      rothBalance: 0,
      cashBalance: 10_000,
      annualOutsideIncome: 0,
      annualSocialSecurityAtFullRetirementAge: 0,
      annualExpenses: 150_000,
      essentialExpenses: 100_000,
    })
    expect(runPlanMonteCarlo(broke, FAST).successRate).toBe(0)
  })

  it('is reproducible for the same seed and differs for another', () => {
    const scenario = buildScenario(values)
    const a = runPlanMonteCarlo(scenario, FAST)
    expect(runPlanMonteCarlo(scenario, FAST)).toEqual(a)
    expect(runPlanMonteCarlo(scenario, { ...FAST, seed: 7 }).bands).not.toEqual(
      a.bands
    )
  })

  it('orders the percentile bands and rejects a bad path count', () => {
    const result = runPlanMonteCarlo(buildScenario(values), FAST)
    for (const band of result.bands) {
      expect(band.p10).toBeLessThanOrEqual(band.p25)
      expect(band.p25).toBeLessThanOrEqual(band.p50)
      expect(band.p50).toBeLessThanOrEqual(band.p75)
      expect(band.p75).toBeLessThanOrEqual(band.p90)
    }
    expect(result.bands.some(b => b.p10 < b.p90)).toBe(true)
    expect(() =>
      runPlanMonteCarlo(buildScenario(values), { numPaths: 0 })
    ).toThrow('numPaths')
  })

  it('moves invested accounts together and keeps account schedules', () => {
    const light = {
      ...values,
      cashBalance: 0,
      annualExpenses: 1_000,
      essentialExpenses: 500,
      annualHealthcare: 1_000,
      annualWorkIncome: 0,
      annualOutsideIncome: 0,
      annualSocialSecurityAtFullRetirementAge: 0,
      reserveFloor: 0,
      traditionalBalance: 0,
    }
    const single = runPlanMonteCarlo(
      buildScenario({ ...light, brokerageBalance: 1_000_000, rothBalance: 0 }),
      FAST
    )
    const split = runPlanMonteCarlo(
      buildScenario({
        ...light,
        brokerageBalance: 500_000,
        rothBalance: 500_000,
      }),
      FAST
    )
    const lastSingle = single.bands.at(-1)
    const lastSplit = split.bands.at(-1)
    // Independent draws per account would diversify the split portfolio.
    expect(lastSplit?.p10).toBeCloseTo(lastSingle?.p10 ?? 0, -4)
    expect(lastSplit?.p90).toBeCloseTo(lastSingle?.p90 ?? 0, -4)

    const base = buildScenario(values)
    const scheduled = {
      ...base,
      accounts: base.accounts.map(account => ({
        ...account,
        returnSchedule: [{ startYear: 1, endYear: 1, rate: -0.5 }],
      })),
    }
    const crash = runPlanMonteCarlo(scheduled, {
      ...FAST,
      investedStdDev: 0,
      cashStdDev: 0,
    })
    const flat = runPlanMonteCarlo(base, {
      ...FAST,
      investedStdDev: 0,
      cashStdDev: 0,
    })
    expect(crash.bands[0]?.p50).toBeLessThan((flat.bands[0]?.p50 ?? 0) * 0.7)
  })

  it('rejects non-finite or negative settings', () => {
    const scenario = buildScenario(values)
    expect(() => runPlanMonteCarlo(scenario, { seed: Number.NaN })).toThrow(
      'seed'
    )
    expect(() => runPlanMonteCarlo(scenario, { investedStdDev: -0.1 })).toThrow(
      'investedStdDev'
    )
  })
})
