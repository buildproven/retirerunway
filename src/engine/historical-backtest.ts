// Historical backtest (REQ-MCP-50): the plan replayed through actual US
// market history. Each start year is the year retirement begins: the years
// before retirement earn the expected returns, and from the retirement age
// the portfolio earns that year's S&P 500 and 10-year Treasury total returns
// with that year's inflation, then the next year's, and so on. A sequence
// that runs past the last data year continues from the first (wrapped), and
// the result says so. Deterministic. No AI.
import { CPI_1927, MARKET_HISTORY } from './data/market-history'
import {
  planningAgeOf,
  projectSequence,
  type MarketYear,
} from './retirement-projection'
import type { Portfolio, UserProfile } from './types'

/** Start years shown by name: the hard retirements. */
export const NAMED_START_YEARS: readonly number[] = [
  1929, 1937, 1966, 1973, 2000, 2008,
]

export const FIRST_DATA_YEAR = MARKET_HISTORY[0][0]
export const LAST_DATA_YEAR = MARKET_HISTORY[MARKET_HISTORY.length - 1][0]

const MARKET: readonly MarketYear[] = MARKET_HISTORY.map(
  ([, stocks, bonds, cpi], i) => {
    const previous = i === 0 ? CPI_1927 : MARKET_HISTORY[i - 1][3]
    return {
      stocks: stocks / 100,
      bonds: bonds / 100,
      inflation: cpi / previous - 1,
    }
  }
)

export interface StartYearResult {
  readonly startYear: number
  readonly succeeded: boolean
  readonly depletionAge: number | null
  readonly balanceAtPlanningAge: number
  /** The lowest year-end balance from retirement on, today's dollars. */
  readonly lowestBalance: number
  readonly lowestBalanceAge: number
  /** True when the sequence ran past the last data year and continued from the first. */
  readonly wrapped: boolean
}

export interface HistoricalBacktest {
  readonly firstDataYear: number
  readonly lastDataYear: number
  readonly retirementAge: number
  readonly planningAge: number
  readonly retirementYears: number
  readonly startYears: number
  /** Share of start years that pay every year's spending to the planning age. */
  readonly successRate: number
  /** Share of start years with a full, unwrapped history. */
  readonly unwrappedSuccessRate: number
  readonly unwrappedStartYears: number
  readonly named: readonly StartYearResult[]
  /** The five worst start years: earliest depletion first, then the lowest end balance. */
  readonly worst: readonly StartYearResult[]
  readonly results: readonly StartYearResult[]
  readonly charts: {
    /** Balance by age for each named start year, today's dollars. */
    readonly namedBalanceByAge: {
      readonly x: readonly number[]
      readonly series: readonly {
        readonly name: string
        readonly values: readonly number[]
      }[]
    }
  }
}

function sequenceFor(
  profile: UserProfile,
  startYear: number
): { sequence: (MarketYear | undefined)[]; wrapped: boolean } {
  const years = Math.max(0, planningAgeOf(profile) - profile.currentAge)
  const firstRetired = Math.max(
    profile.targetRetirementAge,
    profile.currentAge + 1
  )
  const sequence: (MarketYear | undefined)[] = []
  let wrapped = false
  for (let i = 0; i < years; i++) {
    const age = profile.currentAge + i + 1
    if (age < firstRetired) {
      sequence.push(undefined)
      continue
    }
    const offset = startYear - FIRST_DATA_YEAR + (age - firstRetired)
    if (offset >= MARKET.length) wrapped = true
    sequence.push(MARKET[offset % MARKET.length])
  }
  return { sequence, wrapped }
}

function rank(a: StartYearResult, b: StartYearResult): number {
  const depletion = (r: StartYearResult) => r.depletionAge ?? Infinity
  return (
    depletion(a) - depletion(b) ||
    a.balanceAtPlanningAge - b.balanceAtPlanningAge ||
    a.lowestBalance - b.lowestBalance ||
    a.startYear - b.startYear
  )
}

/** Replay the plan from every start year in the data, 1928 to the last year. */
export function backtestHistory(
  portfolio: Portfolio,
  profile: UserProfile
): HistoricalBacktest {
  const retirementAge = Math.max(
    profile.targetRetirementAge,
    profile.currentAge + 1
  )
  const planningAge = planningAgeOf(profile)
  const results: StartYearResult[] = []
  const curves = new Map<number, readonly { age: number; total: number }[]>()
  for (
    let startYear = FIRST_DATA_YEAR;
    startYear <= LAST_DATA_YEAR;
    startYear++
  ) {
    const { sequence, wrapped } = sequenceFor(profile, startYear)
    const run = projectSequence(portfolio, profile, sequence)
    const retired = run.balanceByAge.filter(point => point.age >= retirementAge)
    const lowest = retired.reduce(
      (min, point) => (point.total < min.total ? point : min),
      retired[0] ?? { age: retirementAge, total: 0 }
    )
    results.push({
      startYear,
      succeeded: run.depletionAge === null,
      depletionAge: run.depletionAge,
      balanceAtPlanningAge: run.balanceAtPlanningAge,
      lowestBalance: lowest.total,
      lowestBalanceAge: lowest.age,
      wrapped,
    })
    if (NAMED_START_YEARS.includes(startYear))
      curves.set(startYear, run.balanceByAge)
  }
  const share = (rows: readonly StartYearResult[]) =>
    rows.length === 0
      ? 0
      : Math.round(
          (rows.filter(r => r.succeeded).length / rows.length) * 10_000
        ) / 10_000
  const unwrapped = results.filter(r => !r.wrapped)
  const named = results.filter(r => NAMED_START_YEARS.includes(r.startYear))
  const ages = (curves.get(NAMED_START_YEARS[0]) ?? []).map(point => point.age)
  return {
    firstDataYear: FIRST_DATA_YEAR,
    lastDataYear: LAST_DATA_YEAR,
    retirementAge,
    planningAge,
    retirementYears: Math.max(0, planningAge - retirementAge + 1),
    startYears: results.length,
    successRate: share(results),
    unwrappedSuccessRate: share(unwrapped),
    unwrappedStartYears: unwrapped.length,
    named,
    worst: [...results].sort(rank).slice(0, 5),
    results,
    charts: {
      namedBalanceByAge: {
        x: ages,
        series: NAMED_START_YEARS.map(year => ({
          name: `Retire in ${year}`,
          values: (curves.get(year) ?? []).map(point => point.total),
        })),
      },
    },
  }
}
