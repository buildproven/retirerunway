import { boxMullerNormal, percentile, seededRandom } from '../stats'
import { projectScenario } from './projection'
import type { AnnualRateOverride, PlanAccount, Scenario } from './types'

export interface PlanMonteCarloConfig {
  readonly numPaths: number
  readonly seed: number
  /** Annual return standard deviation for invested accounts. */
  readonly investedStdDev: number
  /** Annual return standard deviation for cash accounts. */
  readonly cashStdDev: number
  /** Floor applied to a drawn annual return. */
  readonly minReturn: number
}

export interface PlanMonteCarloBand {
  readonly age: number
  readonly p10: number
  readonly p25: number
  readonly p50: number
  readonly p75: number
  readonly p90: number
}

export interface PlanMonteCarloResult {
  readonly config: PlanMonteCarloConfig
  /** Share of paths with no funding gap in any year, 0..1. */
  readonly successRate: number
  readonly medianFinalBalance: number
  /** Total balance by age in real dollars. */
  readonly bands: readonly PlanMonteCarloBand[]
}

export const PLAN_MONTE_CARLO_DEFAULTS: PlanMonteCarloConfig = {
  numPaths: 500,
  seed: 42,
  investedStdDev: 0.12,
  cashStdDev: 0.005,
  minReturn: -0.6,
}

/** Home equity is not a market-return account; it stays on its own rate. */
const NON_MARKET_TYPES: ReadonlySet<PlanAccount['type']> = new Set([
  'home_equity',
])

function meanReturn(account: PlanAccount, year: number): number {
  const override = account.returnSchedule?.find(
    entry => year >= entry.startYear && year <= entry.endYear
  )
  return override?.rate ?? account.annualReturnRate
}

/**
 * Cash and invested balances draw from two shared yearly shocks, so every
 * invested account falls together in a bad year. Any return schedule already
 * on the account supplies the yearly mean.
 */
function drawShocks(
  years: number,
  rand: () => number
): readonly { market: number; cash: number }[] {
  return Array.from({ length: years }, () => ({
    market: boxMullerNormal(rand),
    cash: boxMullerNormal(rand),
  }))
}

function scheduleFor(
  account: PlanAccount,
  shocks: readonly { market: number; cash: number }[],
  config: PlanMonteCarloConfig
): readonly AnnualRateOverride[] {
  const isCash = account.type === 'cash'
  const stdDev = isCash ? config.cashStdDev : config.investedStdDev
  return shocks.map((shock, index) => {
    const year = index + 1
    const draw = isCash ? shock.cash : shock.market
    return {
      startYear: year,
      endYear: year,
      rate: Math.max(
        config.minReturn,
        meanReturn(account, year) + stdDev * draw
      ),
    }
  })
}

function validateConfig(config: PlanMonteCarloConfig): void {
  if (!Number.isInteger(config.numPaths) || config.numPaths < 1) {
    throw new Error('Plan Monte Carlo numPaths must be a positive integer')
  }
  if (!Number.isFinite(config.seed)) {
    throw new Error('Plan Monte Carlo seed must be finite')
  }
  for (const [name, value] of [
    ['investedStdDev', config.investedStdDev],
    ['cashStdDev', config.cashStdDev],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Plan Monte Carlo ${name} must be zero or greater`)
    }
  }
  if (!Number.isFinite(config.minReturn) || config.minReturn <= -1) {
    throw new Error('Plan Monte Carlo minReturn must be above -100%')
  }
}

/**
 * Runs the deterministic plan projection over seeded random return paths.
 * The projection stays the calculator: each path only replaces the yearly
 * return of each market account (invested balances share one market shock,
 * all treated as a single diversified portfolio). Inflation is not randomised.
 */
export function runPlanMonteCarlo(
  scenario: Scenario,
  overrides: Partial<PlanMonteCarloConfig> = {}
): PlanMonteCarloResult {
  const config = { ...PLAN_MONTE_CARLO_DEFAULTS, ...overrides }
  validateConfig(config)
  const rand = seededRandom(config.seed)
  const years = scenario.assumptions.durationYears
  const ages: number[] = []
  const balancesByYear: number[][] = Array.from({ length: years }, () => [])
  let successes = 0

  for (let path = 0; path < config.numPaths; path += 1) {
    const shocks = drawShocks(years, rand)
    const pathScenario: Scenario = {
      ...scenario,
      accounts: scenario.accounts.map(account =>
        NON_MARKET_TYPES.has(account.type)
          ? account
          : {
              ...account,
              returnSchedule: scheduleFor(account, shocks, config),
            }
      ),
    }
    const rows = projectScenario(pathScenario, 'real').rows
    if (rows.every(row => row.fundingGap === 0)) successes += 1
    rows.forEach((row, index) => {
      if (path === 0) ages.push(row.age)
      balancesByYear[index]?.push(row.accessibleBalance + row.restrictedBalance)
    })
  }

  const bands = balancesByYear.map((balances, index) => {
    const sorted = [...balances].sort((left, right) => left - right)
    return {
      age: ages[index] ?? 0,
      p10: percentile(sorted, 10),
      p25: percentile(sorted, 25),
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
    }
  })
  return {
    config,
    successRate: successes / config.numPaths,
    medianFinalBalance: bands.at(-1)?.p50 ?? 0,
    bands,
  }
}
