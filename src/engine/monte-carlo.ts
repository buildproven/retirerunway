import type { Portfolio, UserProfile } from './types'
import {
  calculatePortfolioValue,
  calculateEquityFraction,
  calculateOtherIncome,
  annualExpensesAt,
  cashInflowAt,
  grossWithdrawal,
} from './portfolio-math'
import { MONTE_CARLO_DEFAULTS } from './config'
import { boxMullerNormal, percentile, seededRandom } from './stats'

export interface MonteCarloConfig {
  numPaths: number
  durationYears: number
  equityMean: number
  equityStdDev: number
  bondMean: number
  bondStdDev: number
  inflationMean: number
  inflationStdDev: number
  seed?: number
}

export interface MonteCarloResult {
  config: MonteCarloConfig
  percentiles: PercentileBand[]
  successRate: number
  medianRunwayYears: number
  paths: number
}

export interface PercentileBand {
  year: number
  age: number
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
}

const DEFAULT_CONFIG: MonteCarloConfig = {
  numPaths: MONTE_CARLO_DEFAULTS.NUM_PATHS,
  durationYears: MONTE_CARLO_DEFAULTS.DURATION_YEARS,
  equityMean: MONTE_CARLO_DEFAULTS.EQUITY_MEAN,
  equityStdDev: MONTE_CARLO_DEFAULTS.EQUITY_STD_DEV,
  bondMean: MONTE_CARLO_DEFAULTS.BOND_MEAN,
  bondStdDev: MONTE_CARLO_DEFAULTS.BOND_STD_DEV,
  inflationMean: MONTE_CARLO_DEFAULTS.INFLATION_MEAN,
  inflationStdDev: MONTE_CARLO_DEFAULTS.INFLATION_STD_DEV,
  seed: MONTE_CARLO_DEFAULTS.DEFAULT_SEED,
}

export function runMonteCarlo(
  portfolio: Portfolio,
  profile: UserProfile,
  overrides?: Partial<MonteCarloConfig>
): MonteCarloResult {
  const config = { ...DEFAULT_CONFIG, ...overrides }
  const totalValue = calculatePortfolioValue(portfolio)
  const equityFraction = calculateEquityFraction(portfolio, totalValue)
  const bondFraction = 1 - equityFraction

  const rand = seededRandom(config.seed ?? 42)
  const endBalances: number[][] = Array.from(
    { length: config.durationYears },
    () => []
  )
  let successCount = 0
  const runwayYears: number[] = []

  for (let path = 0; path < config.numPaths; path++) {
    let balance = totalValue
    let depleted = false
    let pathRunway = config.durationYears
    let cumulativeInflation = 1

    for (let i = 0; i < config.durationYears; i++) {
      const age = profile.currentAge + i + 1

      const equityReturn =
        config.equityMean + config.equityStdDev * boxMullerNormal(rand)
      const bondReturn =
        config.bondMean + config.bondStdDev * boxMullerNormal(rand)
      const inflation =
        config.inflationMean + config.inflationStdDev * boxMullerNormal(rand)

      // Clamp to zero to disallow deflation. Brief deflation is historically
      // real, but unclamped negative draws make retirement projections oscillate
      // in ways that confuse users. Treat this as conservative bias; revisit if
      // users ask for more realistic short-term deflation modelling.
      cumulativeInflation *= 1 + Math.max(inflation, 0)

      const portfolioReturn =
        equityFraction * equityReturn + bondFraction * bondReturn
      const inflationAdjustedExpenses = annualExpensesAt(
        profile,
        age,
        cumulativeInflation,
        portfolio.asOfDate
      )
      const otherIncome = calculateOtherIncome(
        profile,
        age,
        cumulativeInflation
      )
      // Withdrawals begin the year retirement starts (age >= targetRetirementAge),
      // not the year after. withdrawalTaxRate grosses the need up for tax;
      // without it annualExpenses is read as the gross withdrawal.
      const withdrawal =
        age >= profile.targetRetirementAge
          ? grossWithdrawal(
              profile,
              Math.max(0, inflationAdjustedExpenses - otherIncome)
            )
          : 0

      // Withdraw first, then grow the remaining balance. This mid-year
      // convention is closer to reality than growing the full start-of-year
      // balance (which over-credits return on money that's been spent).
      // Contributions and home sale proceeds arrive before the withdrawal.
      const cashInflow = cashInflowAt(profile, age, portfolio.asOfDate)
      const afterWithdrawal = Math.max(0, balance + cashInflow - withdrawal)
      // Balance can't go negative: afterWithdrawal >= 0 and within the model's
      // parameter space portfolioReturn > -1.
      balance = Math.max(0, afterWithdrawal * (1 + portfolioReturn))

      endBalances[i].push(Math.round(balance))

      if (balance === 0 && !depleted) {
        depleted = true
        pathRunway = i + 1
      }
    }

    if (!depleted) successCount++
    runwayYears.push(pathRunway)
  }

  runwayYears.sort((a, b) => a - b)
  const medianRunwayYears = percentile(runwayYears, 50)

  const percentiles: PercentileBand[] = endBalances.map((yearBalances, i) => {
    yearBalances.sort((a, b) => a - b)
    return {
      year: i + 1,
      age: profile.currentAge + i + 1,
      p10: percentile(yearBalances, 10),
      p25: percentile(yearBalances, 25),
      p50: percentile(yearBalances, 50),
      p75: percentile(yearBalances, 75),
      p90: percentile(yearBalances, 90),
    }
  })

  return {
    config,
    percentiles,
    successRate: successCount / config.numPaths,
    medianRunwayYears,
    paths: config.numPaths,
  }
}
