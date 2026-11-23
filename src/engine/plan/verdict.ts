import type { PlanProjection, ProjectionRow } from './types'

export type PlanVerdict = 'GO' | 'CAUTION' | 'DELAY'

export interface VerdictOptions {
  readonly stressProjections: readonly PlanProjection[]
  readonly socialSecurityAge: number
  readonly reserveFloor: number
  readonly sustainableWithdrawalRate: number
  readonly demonstratedOutsideIncome: number
  readonly requiredOutsideIncome: number
  readonly healthcareFunded: boolean
  readonly taxesFunded: boolean
  readonly dependsOnUncommittedLever: boolean
  readonly reliesOnInheritance: boolean
}

export interface VerdictMetric {
  readonly name: string
  readonly value: number
  readonly weight: number
  readonly passed: boolean
  readonly evidence: string
}

export interface PlanVerdictResult {
  readonly verdict: PlanVerdict
  readonly robustnessScore: number
  readonly metrics: readonly VerdictMetric[]
  readonly baselineSolvent: boolean
  readonly stressScenariosSolvent: number
  readonly bridgeLiquidityCovered: boolean
  readonly postSocialSecurityCovered: boolean
  readonly delayReasons: readonly string[]
  readonly cautionReasons: readonly string[]
}

function totalBalance(row: ProjectionRow): number {
  return row.accessibleBalance + row.restrictedBalance
}

function finalRow(projection: PlanProjection): ProjectionRow | undefined {
  return projection.rows[projection.rows.length - 1]
}

function rowAtOrAfter(
  projection: PlanProjection,
  age: number
): readonly ProjectionRow[] {
  return projection.rows.filter(row => row.age >= age)
}

function baselineSolvent(projection: PlanProjection): boolean {
  const final = finalRow(projection)
  return (
    Boolean(final) &&
    projection.rows.every(row => row.fundingGap === 0 && totalBalance(row) >= 0)
  )
}

function postSocialSecurityCovered(
  projection: PlanProjection,
  options: VerdictOptions
): boolean {
  const requiredRows = rowAtOrAfter(projection, options.socialSecurityAge)
  return (
    requiredRows.length > 0 &&
    requiredRows.every(row => {
      const sustainableDraw =
        totalBalance(row) * options.sustainableWithdrawalRate
      return (
        row.essentialSpending <= row.income + sustainableDraw &&
        row.fundingGap === 0
      )
    })
  )
}

function metric(
  name: string,
  value: number,
  weight: number,
  passed: boolean,
  evidence: string
): VerdictMetric {
  return { name, value, weight, passed, evidence }
}

export function evaluatePlanVerdict(
  baseline: PlanProjection,
  options: VerdictOptions
): PlanVerdictResult {
  if (options.stressProjections.length !== 5) {
    throw new Error('stressProjections must contain exactly five scenarios')
  }
  if (
    baseline.mode !== 'real' ||
    options.stressProjections.some(projection => projection.mode !== 'real')
  ) {
    throw new Error('plan verdict requires real-dollar projections')
  }
  if (options.reserveFloor < 0) {
    throw new Error('reserveFloor must be non-negative')
  }
  const baselineIsSolvent = baselineSolvent(baseline)
  const stressResults = options.stressProjections.map(projection =>
    baselineSolvent(projection)
  )
  const stressScenariosSolvent = stressResults.filter(Boolean).length
  const bridgeLiquidityCovered = baseline.rows.every(
    row => row.fundingGap === 0
  )
  const postSSCovered = postSocialSecurityCovered(baseline, options)
  const reserveRow = baseline.rows.find(
    row => row.age >= options.socialSecurityAge
  )
  const reserveValue = reserveRow ? totalBalance(reserveRow) : 0
  const reserveMetricValue =
    options.reserveFloor === 0
      ? reserveValue >= 0
        ? 1
        : 0
      : Math.min(1, reserveValue / options.reserveFloor)
  const incomeCovered =
    options.requiredOutsideIncome <= options.demonstratedOutsideIncome
  const committedLeverCovered = !options.dependsOnUncommittedLever

  const metrics: VerdictMetric[] = [
    metric(
      'baseline solvency',
      baselineIsSolvent ? 1 : 0,
      0.25,
      baselineIsSolvent,
      `funding gaps=${baseline.rows.filter(row => row.fundingGap > 0).length}`
    ),
    metric(
      'stress survival',
      stressScenariosSolvent / options.stressProjections.length,
      0.25,
      stressScenariosSolvent >= 4,
      `${stressScenariosSolvent}/${options.stressProjections.length} stress scenarios solvent`
    ),
    metric(
      'bridge liquidity',
      bridgeLiquidityCovered ? 1 : 0,
      0.15,
      bridgeLiquidityCovered,
      `funding gaps=${baseline.rows.filter(row => row.fundingGap > 0).length}`
    ),
    metric(
      'post-social-security coverage',
      postSSCovered ? 1 : 0,
      0.15,
      postSSCovered,
      `sustainable draw rate=${options.sustainableWithdrawalRate}`
    ),
    metric(
      'real reserve at social security',
      reserveMetricValue,
      0.1,
      reserveValue >= options.reserveFloor,
      `reserve=${reserveValue}; floor=${options.reserveFloor}`
    ),
    metric(
      'outside-income quality',
      incomeCovered ? 1 : 0,
      0.05,
      incomeCovered,
      `required=${options.requiredOutsideIncome}; demonstrated=${options.demonstratedOutsideIncome}`
    ),
    metric(
      'committed levers',
      committedLeverCovered ? 1 : 0,
      0.05,
      committedLeverCovered,
      committedLeverCovered
        ? 'no uncommitted lever required'
        : 'depends on an uncommitted lever'
    ),
  ]
  const robustnessScore = Math.max(
    1,
    Math.min(
      10,
      Math.round(
        metrics.reduce((total, item) => total + item.value * item.weight, 0) *
          10
      )
    )
  )

  const delayReasons: string[] = []
  if (!baselineIsSolvent)
    delayReasons.push('baseline depletes or has an unfunded year')
  if (!bridgeLiquidityCovered)
    delayReasons.push('accessible funds do not cover the bridge')
  if (!options.healthcareFunded)
    delayReasons.push('healthcare is not explicitly funded')
  if (!options.taxesFunded) delayReasons.push('taxes are not explicitly funded')
  if (options.reliesOnInheritance)
    delayReasons.push('base plan relies on inheritance')
  if (!incomeCovered)
    delayReasons.push('required outside income exceeds demonstrated income')

  const cautionReasons: string[] = []
  if (stressScenariosSolvent < 4)
    cautionReasons.push('fewer than four of five stress scenarios are solvent')
  if (options.dependsOnUncommittedLever)
    cautionReasons.push('plan depends on an uncommitted lever')
  if (reserveValue < options.reserveFloor)
    cautionReasons.push('reserve at Social Security age is below the floor')
  if (!postSSCovered)
    cautionReasons.push(
      'post-Social-Security essential spending needs exceed sustainable draw'
    )

  const verdict: PlanVerdict =
    delayReasons.length > 0
      ? 'DELAY'
      : cautionReasons.length > 0
        ? 'CAUTION'
        : 'GO'

  return {
    verdict,
    robustnessScore,
    metrics,
    baselineSolvent: baselineIsSolvent,
    stressScenariosSolvent,
    bridgeLiquidityCovered,
    postSocialSecurityCovered: postSSCovered,
    delayReasons,
    cautionReasons,
  }
}
