// ---------------------------------------------------------------------------
// RetireRunway – Scenario comparison on the v2 projection (REQ-MCP-43)
//
// Runs projectRetirement for a baseline profile and up to four named
// what-ifs (changes applied over the baseline), with the same portfolio and
// seed, and lines up the results and charts. Deterministic. No AI.
// ---------------------------------------------------------------------------

import { projectRetirement } from './retirement-projection'
import type { ChartSpec, RetirementProjection } from './retirement-projection'
import type { Portfolio, UserProfile } from './types'

export const MAX_SCENARIOS = 4
export const BASELINE_NAME = 'Current plan'

export interface ScenarioInput {
  readonly name: string
  /** Fields that replace the baseline's (nested objects replace whole). */
  readonly changes: Partial<UserProfile>
  /** Top-level baseline fields to drop, such as homeSale or spendingPhases. */
  readonly remove?: readonly (keyof UserProfile)[]
}

export interface ScenarioResult {
  readonly name: string
  readonly profile: UserProfile
  readonly successRate: number
  readonly depletionAgeOnFailingPaths: {
    readonly p10: number
    readonly p50: number
  } | null
  readonly medianBalanceAt: Readonly<Record<string, number>>
  readonly balanceAtRetirement: number
  readonly firstYearWithdrawalRate: number | null
  readonly lifetimeTax: number
  readonly lifetimeAcaCredit: number
  readonly lifetimeIrmaa: number
  readonly expectedPathDepletionAge: number | null
}

export interface ScenarioComparison {
  readonly seed: number
  readonly planningAge: number
  readonly scenarios: ScenarioResult[]
  readonly charts: {
    readonly successRates: ChartSpec
    readonly medianBalanceByAge: ChartSpec
    readonly poorMarketBalanceByAge: ChartSpec
  }
}

/** The baseline with a scenario's changes applied and its removals dropped. */
export function applyScenario(
  base: UserProfile,
  scenario: ScenarioInput
): UserProfile {
  const merged: Record<string, unknown> = { ...base, ...scenario.changes }
  for (const key of scenario.remove ?? []) delete merged[key]
  return merged as unknown as UserProfile
}

/** Ages at which the comparison reports the median balance. */
function checkpoints(
  projection: RetirementProjection,
  retirementAge: number
): number[] {
  const last = projection.planningAge
  return [...new Set([retirementAge, 70, 75, 80, 85, 90, last])]
    .filter(age => age >= retirementAge && age <= last)
    .sort((a, b) => a - b)
}

function summarize(
  name: string,
  profile: UserProfile,
  projection: RetirementProjection
): ScenarioResult {
  const bands = projection.monteCarlo.percentiles
  const medianBalanceAt: Record<string, number> = {}
  for (const age of checkpoints(projection, profile.targetRetirementAge)) {
    const band = bands.find(b => b.age === age)
    if (band !== undefined) medianBalanceAt[String(age)] = band.p50
  }
  const expected = projection.expectedPath
  return {
    name,
    profile,
    successRate: projection.monteCarlo.successRate,
    depletionAgeOnFailingPaths: projection.monteCarlo.depletionAge,
    medianBalanceAt,
    balanceAtRetirement: expected.balanceAtRetirement,
    firstYearWithdrawalRate:
      expected.firstRetirementYear?.withdrawalRate ?? null,
    lifetimeTax: expected.lifetimeTax,
    lifetimeAcaCredit: expected.lifetimeAcaCredit,
    lifetimeIrmaa: expected.lifetimeIrmaa,
    expectedPathDepletionAge: expected.depletionAge,
  }
}

/**
 * Compare the baseline and each scenario on one portfolio and seed. Each
 * profile is validated by the caller. Charts share one age axis: from the
 * year after the current age to the baseline's planning age.
 */
export function compareScenarios(
  portfolio: Portfolio,
  base: UserProfile,
  scenarios: readonly ScenarioInput[],
  options: { readonly seed: number; readonly paths?: number }
): ScenarioComparison {
  const runs: {
    name: string
    profile: UserProfile
    projection: RetirementProjection
  }[] = []
  const baseProjection = projectRetirement(portfolio, base, options)
  runs.push({ name: BASELINE_NAME, profile: base, projection: baseProjection })
  for (const scenario of scenarios.slice(0, MAX_SCENARIOS)) {
    const profile = applyScenario(base, scenario)
    runs.push({
      name: scenario.name,
      profile,
      projection: projectRetirement(
        portfolio,
        { ...profile, planningAge: baseProjection.planningAge },
        options
      ),
    })
  }
  const ages = baseProjection.monteCarlo.percentiles.map(band => band.age)
  const series = (pick: (band: { p10: number; p50: number }) => number) =>
    runs.map(run => ({
      name: run.name,
      values: ages.map(age => {
        const band = run.projection.monteCarlo.percentiles.find(
          b => b.age === age
        )
        return band === undefined ? 0 : pick(band)
      }),
    }))
  return {
    seed: options.seed,
    planningAge: baseProjection.planningAge,
    scenarios: runs.map(run =>
      summarize(run.name, run.profile, run.projection)
    ),
    charts: {
      successRates: {
        title: `Chance the money lasts to ${baseProjection.planningAge}`,
        style: 'bar',
        xLabel: 'Scenario',
        yLabel: 'Success rate (%)',
        x: runs.map(run => run.name),
        series: [
          {
            name: 'Success rate (%)',
            values: runs.map(
              run =>
                Math.round(run.projection.monteCarlo.successRate * 1000) / 10
            ),
          },
        ],
      },
      medianBalanceByAge: {
        title: 'Typical (median) savings by age, by scenario (today’s dollars)',
        style: 'line',
        xLabel: 'Age',
        yLabel: 'Today’s dollars',
        x: ages,
        series: series(band => band.p50),
      },
      poorMarketBalanceByAge: {
        title:
          'Savings in poor markets (10th percentile), by scenario (today’s dollars)',
        style: 'line',
        xLabel: 'Age',
        yLabel: 'Today’s dollars',
        x: ages,
        series: series(band => band.p10),
      },
    },
  }
}
