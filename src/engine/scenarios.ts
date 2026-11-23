import type {
  Portfolio,
  UserProfile,
  ScenarioType,
  ScenarioParameters,
  ScenarioResult,
  ProjectionYear,
  RiskLevel,
} from './types'
import { calculateSequenceRisk } from './risk-scoring'
import {
  calculatePortfolioValue,
  calculateEquityFraction,
  calculateOtherIncome,
  annualExpensesAt,
  cashInflowAt,
  grossWithdrawal,
} from './portfolio-math'
import { MARKET_RETURNS, PROJECTION_DEFAULTS } from './config'

const DEFAULT_SCENARIOS: Record<ScenarioType, ScenarioParameters> = {
  custom: {
    type: 'custom',
    label: 'Custom',
    equityReturnRate: MARKET_RETURNS.EQUITY_RETURN,
    bondReturnRate: MARKET_RETURNS.BOND_RETURN,
    inflationRate: MARKET_RETURNS.INFLATION_RATE,
    durationYears: PROJECTION_DEFAULTS.DURATION_YEARS,
    drawdownPercent: 0,
  },
  bull: {
    type: 'bull',
    label: 'Bull Market',
    equityReturnRate: MARKET_RETURNS.BULL_MARKET.equityReturn,
    bondReturnRate: MARKET_RETURNS.BULL_MARKET.bondReturn,
    inflationRate: MARKET_RETURNS.BULL_MARKET.inflation,
    durationYears: PROJECTION_DEFAULTS.DURATION_YEARS,
    drawdownPercent: 0,
  },
  base: {
    type: 'base',
    label: 'Base Case',
    equityReturnRate: MARKET_RETURNS.EQUITY_RETURN,
    bondReturnRate: MARKET_RETURNS.BOND_RETURN,
    inflationRate: MARKET_RETURNS.INFLATION_RATE,
    durationYears: PROJECTION_DEFAULTS.DURATION_YEARS,
    drawdownPercent: 0,
  },
  early_bear: {
    type: 'early_bear',
    label: 'Early Bear',
    equityReturnRate: MARKET_RETURNS.EQUITY_RETURN,
    bondReturnRate: MARKET_RETURNS.BOND_RETURN,
    inflationRate: MARKET_RETURNS.INFLATION_RATE,
    durationYears: PROJECTION_DEFAULTS.DURATION_YEARS,
    drawdownPercent: PROJECTION_DEFAULTS.EARLY_BEAR_DRAWDOWN,
  },
  prolonged_bear: {
    type: 'prolonged_bear',
    label: 'Prolonged Bear',
    equityReturnRate: MARKET_RETURNS.PROLONGED_BEAR.equityReturn,
    bondReturnRate: MARKET_RETURNS.PROLONGED_BEAR.bondReturn,
    inflationRate: MARKET_RETURNS.PROLONGED_BEAR.inflation,
    durationYears: PROJECTION_DEFAULTS.DURATION_YEARS,
    drawdownPercent: PROJECTION_DEFAULTS.PROLONGED_BEAR_DRAWDOWN,
  },
}

function projectScenario(
  params: ScenarioParameters,
  portfolio: Portfolio,
  profile: UserProfile
): ProjectionYear[] {
  const totalValue = calculatePortfolioValue(portfolio)
  const equityFraction = calculateEquityFraction(portfolio, totalValue)
  const bondFraction = 1 - equityFraction

  const projections: ProjectionYear[] = []
  let balance = totalValue
  let cumulativeWithdrawals = 0
  const startAge = profile.currentAge

  for (let i = 0; i < params.durationYears; i++) {
    const year = i + 1
    const age = startAge + year
    const startBalance = balance

    let yearReturn: number
    if (
      params.type === 'early_bear' &&
      i < PROJECTION_DEFAULTS.EARLY_BEAR_YEARS
    ) {
      yearReturn =
        equityFraction * -params.drawdownPercent +
        bondFraction * params.bondReturnRate
    } else if (
      params.type === 'prolonged_bear' &&
      i < PROJECTION_DEFAULTS.PROLONGED_BEAR_YEARS
    ) {
      yearReturn =
        equityFraction * (-params.drawdownPercent / 2) +
        bondFraction * params.bondReturnRate
    } else if (
      params.type === 'custom' &&
      params.drawdownPercent > 0 &&
      i < PROJECTION_DEFAULTS.EARLY_BEAR_YEARS
    ) {
      yearReturn =
        equityFraction * -params.drawdownPercent +
        bondFraction * params.bondReturnRate
    } else {
      yearReturn =
        equityFraction * params.equityReturnRate +
        bondFraction * params.bondReturnRate
    }

    const growth = startBalance * yearReturn

    const inflationMultiplier = Math.pow(1 + params.inflationRate, i)
    const inflationAdjustedExpenses = annualExpensesAt(
      profile,
      age,
      inflationMultiplier,
      portfolio.asOfDate
    )
    const otherIncome = calculateOtherIncome(profile, age, inflationMultiplier)
    const withdrawal =
      age >= profile.targetRetirementAge
        ? grossWithdrawal(
            profile,
            Math.max(0, inflationAdjustedExpenses - otherIncome)
          )
        : 0

    // Contributions and home sale proceeds land the same year and earn no
    // growth until the next year (conservative).
    const cashInflow = cashInflowAt(profile, age, portfolio.asOfDate)
    balance = Math.max(0, startBalance + growth + cashInflow - withdrawal)
    cumulativeWithdrawals += withdrawal

    projections.push({
      year,
      age,
      startBalance: Math.round(startBalance * 100) / 100,
      growth: Math.round(growth * 100) / 100,
      withdrawal: Math.round(withdrawal * 100) / 100,
      endBalance: Math.round(balance * 100) / 100,
      inflationAdjustedWithdrawal:
        Math.round(inflationAdjustedExpenses * 100) / 100,
      cumulativeWithdrawals: Math.round(cumulativeWithdrawals * 100) / 100,
      ...(cashInflow === 0
        ? {}
        : { cashInflow: Math.round(cashInflow * 100) / 100 }),
    })

    if (balance === 0) break
  }

  return projections
}

export function runScenario(
  scenarioType: ScenarioType,
  portfolio: Portfolio,
  profile: UserProfile,
  overrides?: Partial<ScenarioParameters>
): ScenarioResult {
  const params = { ...DEFAULT_SCENARIOS[scenarioType], ...overrides }
  const projections = projectScenario(params, portfolio, profile)

  const depletedYear = projections.find(p => p.endBalance === 0)
  const depletionAge = depletedYear ? depletedYear.age : null
  const runwayYears = depletedYear ? depletedYear.year : params.durationYears

  const riskResult = calculateSequenceRisk(portfolio, profile)

  return {
    scenarioType,
    parameters: params,
    projections,
    runwayYears,
    depletionAge,
    sequenceOfReturnsRisk: riskResult.score as RiskLevel,
  }
}

export function runAllScenarios(
  portfolio: Portfolio,
  profile: UserProfile
): ScenarioResult[] {
  const types: ScenarioType[] = ['bull', 'base', 'early_bear', 'prolonged_bear']
  return types.map(t => runScenario(t, portfolio, profile))
}

export function runCustomScenario(
  portfolio: Portfolio,
  profile: UserProfile,
  params: ScenarioParameters
): ScenarioResult {
  const projections = projectScenario(params, portfolio, profile)

  const depletedYear = projections.find(p => p.endBalance === 0)
  const depletionAge = depletedYear ? depletedYear.age : null
  const runwayYears = depletedYear ? depletedYear.year : params.durationYears

  const riskResult = calculateSequenceRisk(portfolio, profile)

  return {
    scenarioType: 'custom',
    parameters: params,
    projections,
    runwayYears,
    depletionAge,
    sequenceOfReturnsRisk: riskResult.score as RiskLevel,
  }
}

export function getDefaultScenarioParameters(
  type: ScenarioType
): ScenarioParameters {
  return { ...DEFAULT_SCENARIOS[type] }
}
