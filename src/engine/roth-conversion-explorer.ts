// ---------------------------------------------------------------------------
// RetireRunway – Roth conversion explorer on the v2 projection (REQ-MCP-46)
//
// Runs projectRetirement once per conversion strategy (no conversions, fill
// a tax bracket, stay under an IRMAA tier, stay under the ACA line then
// IRMAA tier 0) on the same portfolio, profile and seed, and lines up the
// success rate, lifetime tax, IRMAA, ACA credit, amount converted, the
// balance split at the planning age and each year's conversion. No AI.
// ---------------------------------------------------------------------------

import { projectRetirement } from './retirement-projection'
import type {
  ChartSpec,
  ProjectionOptions,
  RothConversionStrategy,
} from './retirement-projection'
import type { Portfolio, UserProfile } from './types'

export interface NamedStrategy {
  readonly name: string
  readonly strategy: RothConversionStrategy
}

export const DEFAULT_CONVERSION_STRATEGIES: readonly NamedStrategy[] = [
  { name: 'No conversions', strategy: { kind: 'none' } },
  {
    name: 'Fill the 12% bracket',
    strategy: { kind: 'fillBracket', rate: 0.12 },
  },
  {
    name: 'Fill the 22% bracket',
    strategy: { kind: 'fillBracket', rate: 0.22 },
  },
  {
    name: 'Up to the first IRMAA threshold',
    strategy: { kind: 'irmaaTier', tier: 0 },
  },
  {
    name: 'Under the ACA line, then IRMAA',
    strategy: { kind: 'acaThenIrmaa' },
  },
]

export const MAX_CONVERSION_STRATEGIES = 6

export interface ConversionStrategyResult {
  readonly name: string
  readonly strategy: RothConversionStrategy
  readonly successRate: number
  readonly depletionAgeOnFailingPaths: {
    readonly p10: number
    readonly p50: number
  } | null
  /** Monte Carlo median total balance at the planning age. */
  readonly medianBalanceAtPlanningAge: number
  /** Expected-return path balances at the planning age, by tax treatment. */
  readonly endBalances: {
    readonly preTax: number
    readonly roth: number
    readonly taxable: number
    readonly total: number
  }
  readonly lifetimeTax: number
  readonly lifetimeIrmaa: number
  readonly lifetimeAcaCredit: number
  readonly lifetimeRothConversion: number
  /** Each year's conversion on the expected path (years with none left out). */
  readonly conversionsByAge: readonly {
    readonly age: number
    readonly amount: number
    readonly irmaaTier: number
  }[]
}

export interface ConversionExploration {
  readonly planningAge: number
  readonly conversionEndAge: number
  readonly strategies: readonly ConversionStrategyResult[]
  /**
   * The strategy with the highest success rate; ties go to the larger median
   * balance at the planning age, then to the lower lifetime tax plus IRMAA.
   */
  readonly best: string
  readonly charts: {
    readonly successRates: ChartSpec
    readonly lifetimeCosts: ChartSpec
    readonly conversionsByAge: ChartSpec
  }
}

export function exploreRothConversions(
  portfolio: Portfolio,
  profile: UserProfile,
  strategies: readonly NamedStrategy[] = DEFAULT_CONVERSION_STRATEGIES,
  options: Pick<ProjectionOptions, 'seed' | 'paths' | 'conversionEndAge'> = {}
): ConversionExploration {
  const results = strategies.map(({ name, strategy }) => {
    const projection = projectRetirement(portfolio, profile, {
      ...options,
      rothConversion: strategy,
    })
    const expected = projection.expectedPath
    const last = expected.years.at(-1)
    const bands = projection.monteCarlo.percentiles
    return {
      planningAge: projection.planningAge,
      result: {
        name,
        strategy,
        successRate: projection.monteCarlo.successRate,
        depletionAgeOnFailingPaths: projection.monteCarlo.depletionAge,
        medianBalanceAtPlanningAge: bands.at(-1)?.p50 ?? 0,
        endBalances: {
          preTax:
            (last?.endBalances.employerPlan ?? 0) +
            (last?.endBalances.ira ?? 0),
          roth: last?.endBalances.roth ?? 0,
          taxable:
            (last?.endBalances.taxable ?? 0) + (last?.endBalances.nqdc ?? 0),
          total: last?.endBalances.total ?? 0,
        },
        lifetimeTax: expected.lifetimeTax,
        lifetimeIrmaa: expected.lifetimeIrmaa,
        lifetimeAcaCredit: expected.lifetimeAcaCredit,
        lifetimeRothConversion: expected.lifetimeRothConversion,
        conversionsByAge: expected.years
          .filter(y => y.rothConversion > 0)
          .map(y => ({
            age: y.age,
            amount: y.rothConversion,
            irmaaTier: y.irmaaTier,
          })),
      } satisfies ConversionStrategyResult,
      ages: expected.years.map(y => y.age),
      conversions: expected.years.map(y => y.rothConversion),
    }
  })

  const ranked = [...results].sort(
    (a, b) =>
      b.result.successRate - a.result.successRate ||
      b.result.medianBalanceAtPlanningAge -
        a.result.medianBalanceAtPlanningAge ||
      a.result.lifetimeTax +
        a.result.lifetimeIrmaa -
        (b.result.lifetimeTax + b.result.lifetimeIrmaa)
  )
  const names = results.map(r => r.result.name)
  const ages = results.at(0)?.ages ?? []

  return {
    planningAge: results.at(0)?.planningAge ?? profile.planningAge ?? 95,
    conversionEndAge: options.conversionEndAge ?? 74,
    strategies: results.map(r => r.result),
    best: ranked.at(0)?.result.name ?? '',
    charts: {
      successRates: {
        title: 'Chance the money lasts, by conversion strategy',
        style: 'bar',
        xLabel: 'Strategy',
        yLabel: 'Success rate (%)',
        x: names,
        series: [
          {
            name: 'Success rate (%)',
            values: results.map(
              r => Math.round(r.result.successRate * 1000) / 10
            ),
          },
        ],
      },
      lifetimeCosts: {
        title: 'Lifetime tax and Medicare IRMAA (today’s dollars)',
        style: 'bar',
        xLabel: 'Strategy',
        yLabel: 'Today’s dollars',
        x: names,
        series: [
          { name: 'Tax', values: results.map(r => r.result.lifetimeTax) },
          { name: 'IRMAA', values: results.map(r => r.result.lifetimeIrmaa) },
        ],
      },
      conversionsByAge: {
        title: 'Roth conversions by age (expected returns, today’s dollars)',
        style: 'bar',
        xLabel: 'Age',
        yLabel: 'Today’s dollars',
        x: ages,
        series: results
          .filter(r => r.result.lifetimeRothConversion > 0)
          .map(r => ({ name: r.result.name, values: r.conversions })),
      },
    },
  }
}
