import {
  buildStressScenarioSuite,
  type ProjectedStressScenario,
} from './stress-scenarios'
import { evaluatePlanVerdict, type PlanVerdictResult } from './verdict'
import { projectScenario, projectScenarioBothModes } from './projection'
import {
  solveMinimumOutsideIncome,
  type IncomeSolverResult,
} from './income-solver'
import type { PlanProjection, PlanProjectionPair, Scenario } from './types'

const VERDICT_STRESS_IDS = [
  'market-shock-20-first-retirement-year',
  'two-year-high-inflation',
  'healthcare-double-two-years',
  'outside-income-half-three-years',
  'combined-bad-start',
] as const

export interface PlanAnalysisOptions {
  readonly outsideIncomeStreamId?: string
  readonly healthcareStreamIds?: readonly string[]
  readonly workIncomeStreamIds?: readonly string[]
  readonly socialSecurityAge?: number
  readonly reserveFloor?: number
  readonly maximumAffordableHousing?: number
  readonly maxGrossIncome?: number
  readonly greatLifeIncome?: number
}

export interface PlanStressResult {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly projection: ProjectedStressScenario['projection']
  readonly solvent: boolean
}

export interface PlanAnalysis {
  readonly scenario: Scenario
  readonly options: PlanAnalysisOptions
  readonly projections: PlanProjectionPair
  readonly stressResults: readonly PlanStressResult[]
  readonly verdict: PlanVerdictResult
  readonly incomeSolver: IncomeSolverResult
  readonly committedEvents: Scenario['lifeEvents']
  readonly downsizeComparison: ReturnType<
    typeof buildStressScenarioSuite
  >['downsizeComparison']
}

function totalBalanceAtEnd(
  projection: ProjectedStressScenario['projection']
): number {
  const row = projection.rows.at(-1)
  return row ? row.accessibleBalance + row.restrictedBalance : 0
}

function isSolvent(projection: ProjectedStressScenario['projection']): boolean {
  return projection.rows.every(row => row.fundingGap === 0)
}

function healthcareIsFunded(scenario: Scenario): boolean {
  return Boolean(
    scenario.healthcare?.phases.some(phase => {
      if ('medicareComponents' in phase && phase.medicareComponents) {
        return phase.medicareComponents.some(
          component =>
            component.monthlyPremium + (component.monthlyOutOfPocket ?? 0) > 0
        )
      }
      return (
        'monthlyPremium' in phase &&
        phase.monthlyPremium + phase.monthlyOutOfPocket > 0
      )
    })
  )
}

function outsideIncomeId(scenario: Scenario, requested?: string): string {
  const candidate = requested
    ? scenario.incomeStreams.find(stream => stream.id === requested)
    : scenario.incomeStreams.find(stream =>
        /consult|business|contract|outside|retainer/i.test(
          `${stream.id} ${stream.name}`
        )
      )
  if (!candidate)
    throw new Error('Plan analysis requires an outside-income stream')
  return candidate.id
}

const ACA_CLIFF_SCAN_SEGMENTS = 32
const ACA_CLIFF_ROOT_ITERATIONS = 24

interface AcaCliffTarget {
  readonly year: number
  readonly taxYear: number
  readonly cliffThreshold: number
}

function scenarioWithOutsideIncome(
  scenario: Scenario,
  outsideIncomeStreamId: string,
  gross: number
): Scenario {
  let found = false
  const incomeStreams = scenario.incomeStreams.map(stream => {
    if (stream.id !== outsideIncomeStreamId) return stream
    found = true
    return { ...stream, gross }
  })
  if (!found)
    throw new Error(`Unknown outside-income stream: ${outsideIncomeStreamId}`)
  return { ...scenario, incomeStreams }
}

export function findAcaDiscontinuityPoints(
  scenario: Scenario,
  projection: PlanProjection,
  outsideIncomeStreamId: string,
  minGrossIncome: number,
  maxGrossIncome: number
): readonly number[] {
  if (!Number.isFinite(minGrossIncome) || !Number.isFinite(maxGrossIncome)) {
    throw new Error('ACA cliff search bounds must be finite')
  }
  if (maxGrossIncome <= minGrossIncome) return []

  const targets: readonly AcaCliffTarget[] = projection.rows.flatMap(row =>
    Object.values(row.healthcare?.acaByTaxYear ?? {}).map(aca => ({
      year: row.year,
      taxYear: aca.taxYear,
      cliffThreshold: aca.cliffThreshold,
    }))
  )
  if (targets.length === 0) return []

  const projectionCache = new Map<number, PlanProjection>()
  const projectionAt = (gross: number): PlanProjection => {
    const cached = projectionCache.get(gross)
    if (cached) return cached
    const next = projectScenario(
      scenarioWithOutsideIncome(scenario, outsideIncomeStreamId, gross),
      'nominal'
    )
    projectionCache.set(gross, next)
    return next
  }
  const magiDifferenceAt = (
    gross: number,
    target: AcaCliffTarget
  ): number | null => {
    const row = projectionAt(gross).rows.find(
      candidate => candidate.year === target.year
    )
    const aca = row?.healthcare?.acaByTaxYear?.[String(target.taxYear)]
    return aca ? aca.magi - target.cliffThreshold : null
  }
  const roots: number[] = []
  const addRoot = (root: number): void => {
    if (!Number.isFinite(root)) return
    const rounded = Math.round(root * 100) / 100
    if (rounded >= minGrossIncome && rounded <= maxGrossIncome) {
      roots.push(rounded)
    }
  }

  for (const target of targets) {
    let lowerGross = minGrossIncome
    let lowerDifference = magiDifferenceAt(lowerGross, target)
    for (let index = 1; index <= ACA_CLIFF_SCAN_SEGMENTS; index += 1) {
      const upperGross =
        minGrossIncome +
        ((maxGrossIncome - minGrossIncome) * index) / ACA_CLIFF_SCAN_SEGMENTS
      const upperDifference = magiDifferenceAt(upperGross, target)
      if (lowerDifference === null || upperDifference === null) {
        lowerGross = upperGross
        lowerDifference = upperDifference
        continue
      }
      if (Math.abs(lowerDifference) <= 0.01) addRoot(lowerGross)
      if (Math.abs(upperDifference) <= 0.01) addRoot(upperGross)
      if (lowerDifference * upperDifference < 0) {
        let left = lowerGross
        let right = upperGross
        let leftDifference = lowerDifference
        for (
          let iteration = 0;
          iteration < ACA_CLIFF_ROOT_ITERATIONS;
          iteration += 1
        ) {
          const middle = (left + right) / 2
          const middleDifference = magiDifferenceAt(middle, target)
          if (middleDifference === null) break
          if (Math.abs(middleDifference) <= 0.01) {
            left = middle
            right = middle
            break
          }
          if (leftDifference * middleDifference <= 0) {
            right = middle
          } else {
            left = middle
            leftDifference = middleDifference
          }
        }
        addRoot((left + right) / 2)
      }
      lowerGross = upperGross
      lowerDifference = upperDifference
    }
  }
  return roots
}

function socialSecurityAge(scenario: Scenario, requested?: number): number {
  if (requested !== undefined) return requested
  const firstBenefit = scenario.socialSecurityBenefits
    ?.filter(benefit => benefit.includedInBase)
    .sort((left, right) => left.claimAge - right.claimAge)[0]
  return firstBenefit?.claimAge ?? scenario.profile.targetRetirementAge + 5
}

function scenarioForExitAge(scenario: Scenario, targetAge: number): Scenario {
  const workStreams = scenario.incomeStreams.map(stream =>
    /salary|wage|employment|work/i.test(`${stream.id} ${stream.name}`)
      ? { ...stream, end: { age: targetAge - 1 } }
      : stream
  )
  return {
    ...scenario,
    id: `${scenario.id}--exit-age-${targetAge}`,
    profile: { ...scenario.profile, targetRetirementAge: targetAge },
    incomeStreams: workStreams,
  }
}

function analysisForScenario(
  scenario: Scenario,
  options: PlanAnalysisOptions
): {
  projections: PlanProjectionPair
  stressResults: readonly PlanStressResult[]
  verdict: PlanVerdictResult
  downsizeComparison: ReturnType<
    typeof buildStressScenarioSuite
  >['downsizeComparison']
} {
  const suite = buildStressScenarioSuite(scenario, {
    allowMissingDownsize: true,
    healthcareStreamIds: options.healthcareStreamIds,
    outsideIncomeStreamIds: [
      outsideIncomeId(scenario, options.outsideIncomeStreamId),
    ],
    workIncomeStreamIds: options.workIncomeStreamIds,
  })
  const projections = projectScenarioBothModes(scenario)
  const stressResults = VERDICT_STRESS_IDS.map(id => {
    const definition = suite.scenarios.find(candidate => candidate.id === id)
    if (!definition) throw new Error(`Missing stress scenario ${id}`)
    const projection = projectScenario(definition.scenario, 'real')
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      projection,
      solvent: isSolvent(projection),
    }
  })
  const outsideIncome = scenario.incomeStreams.find(
    stream => stream.id === (options.outsideIncomeStreamId ?? 'outside-income')
  )
  const demonstratedOutsideIncome = outsideIncome?.gross ?? 0
  const verdict = evaluatePlanVerdict(projections.real, {
    stressProjections: stressResults.map(result => result.projection),
    socialSecurityAge: socialSecurityAge(scenario, options.socialSecurityAge),
    reserveFloor: options.reserveFloor ?? 0,
    sustainableWithdrawalRate: 0.04,
    demonstratedOutsideIncome,
    requiredOutsideIncome: 0,
    healthcareFunded: healthcareIsFunded(scenario),
    taxesFunded: true,
    dependsOnUncommittedLever: false,
    reliesOnInheritance: false,
  })
  return {
    projections,
    stressResults,
    verdict,
    downsizeComparison: suite.downsizeComparison,
  }
}

export function analyzePlan(
  scenario: Scenario,
  options: PlanAnalysisOptions = {}
): PlanAnalysis {
  const outsideIncomeIdValue = outsideIncomeId(
    scenario,
    options.outsideIncomeStreamId
  )
  const resolvedOptions = {
    ...options,
    outsideIncomeStreamId: outsideIncomeIdValue,
  }
  const evaluate = (candidate: Scenario): PlanVerdictResult =>
    analysisForScenario(candidate, resolvedOptions).verdict
  const current = analysisForScenario(scenario, resolvedOptions)
  const outsideIncome = scenario.incomeStreams.find(
    stream => stream.id === outsideIncomeIdValue
  )
  const annualSpending = scenario.spendingStreams.reduce(
    (total, stream) => total + stream.amount,
    0
  )
  const incomeSolver = solveMinimumOutsideIncome(
    scenario,
    outsideIncomeIdValue,
    evaluate,
    {
      minGrossIncome: 0,
      maxGrossIncome: options.maxGrossIncome ?? 500_000,
      tolerance: 100,
      maxIterations: 20,
      safetyMarginPercent: 0.1,
      operatingExpenseRate: 0.15,
      selfEmploymentTaxRate: 0.03,
      personalTaxRate: 0.22,
      retirementContributionRate: 0.05,
      maximumAffordableHousing: options.maximumAffordableHousing ?? 0,
      minimumLiquidReserve: options.reserveFloor ?? 0,
      discontinuityPoints: findAcaDiscontinuityPoints(
        scenario,
        current.projections.nominal,
        outsideIncomeIdValue,
        0,
        options.maxGrossIncome ?? 500_000
      ),
      findEarliestRobustExitAge: candidate => {
        for (
          let age = candidate.profile.currentAge + 1;
          age <= candidate.profile.targetRetirementAge;
          age += 1
        ) {
          if (evaluate(scenarioForExitAge(candidate, age)).verdict === 'GO') {
            return age
          }
        }
        return null
      },
    },
    options.greatLifeIncome ?? Math.round(annualSpending * 1.25)
  )
  const requiredOutsideIncome = incomeSolver.minimumGrossIncome ?? 0
  const demonstratedOutsideIncome = outsideIncome?.gross ?? 0
  const verdict = evaluatePlanVerdict(current.projections.real, {
    stressProjections: current.stressResults.map(result => result.projection),
    socialSecurityAge: socialSecurityAge(scenario, options.socialSecurityAge),
    reserveFloor: options.reserveFloor ?? 0,
    sustainableWithdrawalRate: 0.04,
    demonstratedOutsideIncome,
    requiredOutsideIncome,
    healthcareFunded: healthcareIsFunded(scenario),
    taxesFunded: true,
    dependsOnUncommittedLever: false,
    reliesOnInheritance: false,
  })

  return {
    scenario,
    options: resolvedOptions,
    projections: current.projections,
    stressResults: current.stressResults,
    verdict,
    incomeSolver,
    committedEvents: scenario.lifeEvents.filter(
      event => event.commitment === 'committed'
    ),
    downsizeComparison: current.downsizeComparison,
  }
}

export function stressFinalBalances(analysis: PlanAnalysis): readonly {
  id: string
  label: string
  finalBalance: number
  solvent: boolean
}[] {
  return analysis.stressResults.map(result => ({
    id: result.id,
    label: result.label,
    finalBalance: totalBalanceAtEnd(result.projection),
    solvent: result.solvent,
  }))
}
