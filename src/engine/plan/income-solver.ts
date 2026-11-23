import type { PlanVerdictResult, VerdictOptions } from './verdict'
import type { IncomeStream, Scenario } from './types'

export interface IncomeSolverOptions {
  readonly minGrossIncome: number
  readonly maxGrossIncome: number
  readonly tolerance: number
  readonly maxIterations: number
  readonly safetyMarginPercent: number
  readonly operatingExpenseRate: number
  readonly selfEmploymentTaxRate: number
  readonly personalTaxRate: number
  readonly retirementContributionRate: number
  readonly maximumAffordableHousing: number
  readonly minimumLiquidReserve: number
  /** Candidate income values where a discontinuous verdict may occur. */
  readonly discontinuityPoints?: readonly number[]
  readonly findEarliestRobustExitAge?: (scenario: Scenario) => number | null
}

export interface IncomeSolverEvaluation {
  readonly grossIncome: number
  readonly verdict: PlanVerdictResult
}

export interface IncomeSolverResult {
  readonly minimumGrossIncome: number | null
  readonly recommendedGrossIncome: number | null
  readonly greatLifeIncome: number
  readonly maximumAffordableHousing: number
  readonly minimumLiquidReserve: number
  readonly earliestRobustExitAge: number | null
  readonly minimumSpendableIncome: number | null
  readonly recommendedSpendableIncome: number | null
  readonly evaluations: readonly IncomeSolverEvaluation[]
}

function replaceIncome(
  scenario: Scenario,
  streamId: string,
  gross: number
): Scenario {
  let found = false
  const incomeStreams: readonly IncomeStream[] = scenario.incomeStreams.map(
    stream => {
      if (stream.id !== streamId) return stream
      found = true
      return { ...stream, gross }
    }
  )
  if (!found) throw new Error(`Unknown outside-income stream: ${streamId}`)
  return { ...scenario, incomeStreams }
}

function spendableIncome(gross: number, options: IncomeSolverOptions): number {
  const deductions =
    options.operatingExpenseRate +
    options.selfEmploymentTaxRate +
    options.personalTaxRate +
    options.retirementContributionRate
  if (deductions < 0 || deductions >= 1) {
    throw new Error('Income solver deductions must be between 0 and 100%')
  }
  return Math.round(gross * (1 - deductions) * 100) / 100
}

function roundUpToCent(value: number): number {
  const scaled = value * 100
  const floatingPointSlack = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4
  return Math.ceil(scaled - floatingPointSlack) / 100
}

function validatedRecommendation(
  minimumGrossIncome: number,
  run: (grossIncome: number) => PlanVerdictResult,
  options: IncomeSolverOptions
): number | null {
  const candidate = roundUpToCent(
    minimumGrossIncome * (1 + options.safetyMarginPercent)
  )
  if (candidate > options.maxGrossIncome) return null
  return run(candidate).verdict === 'GO' ? candidate : null
}

function validateOptions(
  options: IncomeSolverOptions,
  greatLifeIncome: number
): void {
  const numericInputs: readonly [string, number][] = [
    ['minGrossIncome', options.minGrossIncome],
    ['maxGrossIncome', options.maxGrossIncome],
    ['tolerance', options.tolerance],
    ['maxIterations', options.maxIterations],
    ['safetyMarginPercent', options.safetyMarginPercent],
    ['operatingExpenseRate', options.operatingExpenseRate],
    ['selfEmploymentTaxRate', options.selfEmploymentTaxRate],
    ['personalTaxRate', options.personalTaxRate],
    ['retirementContributionRate', options.retirementContributionRate],
    ['maximumAffordableHousing', options.maximumAffordableHousing],
    ['minimumLiquidReserve', options.minimumLiquidReserve],
    ['greatLifeIncome', greatLifeIncome],
  ]
  for (const [name, value] of numericInputs) {
    if (!Number.isFinite(value)) {
      throw new Error(`Income solver ${name} must be finite`)
    }
  }
  if (!Number.isInteger(options.maxIterations)) {
    throw new Error('Income solver maxIterations must be an integer')
  }
  if (
    options.minGrossIncome < 0 ||
    options.maxGrossIncome <= options.minGrossIncome
  ) {
    throw new Error('Income solver bounds are invalid')
  }
  if (options.tolerance <= 0 || options.maxIterations < 1) {
    throw new Error('Income solver tolerance and iterations must be positive')
  }
  if (options.safetyMarginPercent < 0) {
    throw new Error('Income solver safety margin cannot be negative')
  }
  if (
    options.operatingExpenseRate < 0 ||
    options.operatingExpenseRate > 1 ||
    options.selfEmploymentTaxRate < 0 ||
    options.selfEmploymentTaxRate > 1 ||
    options.personalTaxRate < 0 ||
    options.personalTaxRate > 1 ||
    options.retirementContributionRate < 0 ||
    options.retirementContributionRate > 1
  ) {
    throw new Error('Income solver deduction rates must be between 0 and 100%')
  }
  if (
    options.maximumAffordableHousing < 0 ||
    options.minimumLiquidReserve < 0
  ) {
    throw new Error(
      'Income solver housing and reserve values cannot be negative'
    )
  }
  if (greatLifeIncome < 0) {
    throw new Error('Income solver great-life income cannot be negative')
  }
  for (const point of options.discontinuityPoints ?? []) {
    if (!Number.isFinite(point)) {
      throw new Error('Income solver discontinuity points must be finite')
    }
  }
}

export function solveMinimumOutsideIncome(
  scenario: Scenario,
  outsideIncomeStreamId: string,
  evaluate: (scenario: Scenario) => PlanVerdictResult,
  options: IncomeSolverOptions,
  greatLifeIncome: number
): IncomeSolverResult {
  validateOptions(options, greatLifeIncome)

  const evaluations: IncomeSolverEvaluation[] = []
  const run = (grossIncome: number): PlanVerdictResult => {
    const verdict = evaluate(
      replaceIncome(scenario, outsideIncomeStreamId, grossIncome)
    )
    evaluations.push({ grossIncome, verdict })
    return verdict
  }

  const lowVerdict = run(options.minGrossIncome)
  const highVerdict = run(options.maxGrossIncome)
  if (lowVerdict.verdict === 'GO') {
    const minimumGrossIncome = roundUpToCent(options.minGrossIncome)
    if (minimumGrossIncome > options.maxGrossIncome) {
      return buildResult(
        scenario,
        outsideIncomeStreamId,
        null,
        null,
        greatLifeIncome,
        evaluations,
        options
      )
    }
    if (run(minimumGrossIncome).verdict !== 'GO') {
      throw new Error('Income solver rounded minimum no longer produces GO')
    }
    const recommendedGrossIncome = validatedRecommendation(
      minimumGrossIncome,
      run,
      options
    )
    return buildResult(
      scenario,
      outsideIncomeStreamId,
      minimumGrossIncome,
      recommendedGrossIncome,
      greatLifeIncome,
      evaluations,
      options
    )
  }
  const partitionPoints = [...(options.discontinuityPoints ?? [])]
    .filter(
      point => point > options.minGrossIncome && point < options.maxGrossIncome
    )
    .sort((left, right) => left - right)
  const uniquePartitionPoints = partitionPoints.filter(
    (point, index) => index === 0 || point !== partitionPoints[index - 1]
  )
  if (highVerdict.verdict !== 'GO' && uniquePartitionPoints.length === 0) {
    return buildResult(
      scenario,
      outsideIncomeStreamId,
      null,
      null,
      greatLifeIncome,
      evaluations,
      options
    )
  }
  const boundaries = [
    options.minGrossIncome,
    ...uniquePartitionPoints.flatMap(point => {
      const epsilon = Math.min(0.01, (options.maxGrossIncome - point) / 2)
      return [point - epsilon, point, point + epsilon]
    }),
    options.maxGrossIncome,
  ].sort((left, right) => left - right)
  const uniqueBoundaries = boundaries.filter(
    (point, index) => index === 0 || point !== boundaries[index - 1]
  )

  let minimumGrossIncome: number | null = null
  for (let segment = 0; segment < uniqueBoundaries.length - 1; segment += 1) {
    const start = uniqueBoundaries[segment]
    const end = uniqueBoundaries[segment + 1]
    if (start === undefined || end === undefined || end < start) continue
    const startVerdict = run(start).verdict
    if (startVerdict === 'GO') {
      minimumGrossIncome = roundUpToCent(start)
      break
    }
    const endVerdict = run(end).verdict
    if (endVerdict !== 'GO') continue

    let low = start
    let high = end
    for (
      let iteration = 0;
      iteration < options.maxIterations && high - low > options.tolerance;
      iteration += 1
    ) {
      const mid = (low + high) / 2
      if (run(mid).verdict === 'GO') high = mid
      else low = mid
    }
    minimumGrossIncome = roundUpToCent(high)
    break
  }
  if (minimumGrossIncome === null) {
    return buildResult(
      scenario,
      outsideIncomeStreamId,
      null,
      null,
      greatLifeIncome,
      evaluations,
      options
    )
  }
  if (minimumGrossIncome > options.maxGrossIncome) {
    return buildResult(
      scenario,
      outsideIncomeStreamId,
      null,
      null,
      greatLifeIncome,
      evaluations,
      options
    )
  }
  if (run(minimumGrossIncome).verdict !== 'GO') {
    throw new Error('Income solver rounded minimum no longer produces GO')
  }
  const recommendedGrossIncome = validatedRecommendation(
    minimumGrossIncome,
    run,
    options
  )
  return buildResult(
    scenario,
    outsideIncomeStreamId,
    minimumGrossIncome,
    recommendedGrossIncome,
    greatLifeIncome,
    evaluations,
    options
  )
}

function buildResult(
  scenario: Scenario,
  outsideIncomeStreamId: string,
  minimumGrossIncome: number | null,
  recommendedGrossIncome: number | null,
  greatLifeIncome: number,
  evaluations: readonly IncomeSolverEvaluation[],
  options: IncomeSolverOptions
): IncomeSolverResult {
  const resolvedScenario = replaceIncome(
    scenario,
    outsideIncomeStreamId,
    minimumGrossIncome ?? 0
  )
  return {
    minimumGrossIncome,
    recommendedGrossIncome,
    greatLifeIncome,
    maximumAffordableHousing: options.maximumAffordableHousing,
    minimumLiquidReserve: options.minimumLiquidReserve,
    earliestRobustExitAge:
      options.findEarliestRobustExitAge?.(resolvedScenario) ?? null,
    minimumSpendableIncome:
      minimumGrossIncome === null
        ? null
        : spendableIncome(minimumGrossIncome, options),
    recommendedSpendableIncome:
      recommendedGrossIncome === null
        ? null
        : spendableIncome(recommendedGrossIncome, options),
    evaluations,
  }
}

export type IncomeSolverEvaluator = (
  scenario: Scenario,
  options: VerdictOptions
) => PlanVerdictResult
