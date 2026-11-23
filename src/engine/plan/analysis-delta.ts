import type { PlanAnalysis } from './analyze'
import type { PlanVerdict } from './verdict'

export type PlanAnalysisChangeDirection = 'improved' | 'worsened' | 'changed'

export interface PlanAnalysisChange {
  readonly id: string
  readonly label: string
  readonly direction: PlanAnalysisChangeDirection
  readonly summary: string
}

export interface PlanAnalysisComparison {
  readonly assumptionChanges: readonly PlanAnalysisChange[]
  readonly outcomeChanges: readonly PlanAnalysisChange[]
}

interface GapSummary {
  readonly age: number
  readonly amount: number
}

interface RankedChange extends PlanAnalysisChange {
  readonly priority: number
}

function formatCurrency(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function formatOptionalCurrency(value: number | null): string {
  return value === null ? 'no solution' : formatCurrency(value)
}

function formatOptionalAge(value: number | null): string {
  return value === null ? 'not demonstrated' : `age ${value}`
}

function verdictRank(verdict: PlanVerdict): number {
  return { DELAY: 1, CAUTION: 2, GO: 3 }[verdict]
}

function directionForHigherIsBetter(
  previous: number | null,
  current: number | null
): PlanAnalysisChangeDirection {
  if (previous === current) return 'changed'
  if (previous === null) return 'improved'
  if (current === null) return 'worsened'
  if (current > previous) return 'improved'
  if (current < previous) return 'worsened'
  return 'changed'
}

function directionForLowerIsBetter(
  previous: number | null,
  current: number | null
): PlanAnalysisChangeDirection {
  if (previous === current) return 'changed'
  if (previous === null) return 'improved'
  if (current === null) return 'worsened'
  if (current < previous) return 'improved'
  if (current > previous) return 'worsened'
  return 'changed'
}

function firstFundingGap(analysis: PlanAnalysis): GapSummary | null {
  const row = analysis.projections.real.rows.find(
    candidate => candidate.fundingGap > 0
  )
  return row ? { age: row.age, amount: row.fundingGap } : null
}

function totalBalance(analysis: PlanAnalysis): number {
  const row = analysis.projections.real.rows.at(-1)
  return row ? row.accessibleBalance + row.restrictedBalance : 0
}

function retirementSpending(analysis: PlanAnalysis): number {
  return analysis.scenario.spendingStreams
    .filter(stream => stream.id !== 'healthcare-spending')
    .reduce((total, stream) => total + stream.amount, 0)
}

function outsideIncome(analysis: PlanAnalysis): number {
  return (
    analysis.scenario.incomeStreams.find(
      stream => stream.id === 'outside-income'
    )?.gross ?? 0
  )
}

function socialSecurityClaimAge(analysis: PlanAnalysis): number | null {
  return (
    analysis.scenario.socialSecurityBenefits?.find(
      benefit => benefit.includedInBase
    )?.claimAge ?? null
  )
}

function startingAssets(analysis: PlanAnalysis): number {
  return analysis.scenario.accounts.reduce(
    (total, account) => total + account.balance,
    0
  )
}

function healthcareCost(analysis: PlanAnalysis): number {
  return analysis.scenario.healthcare?.aca?.benchmarkAnnualPremium ?? 0
}

function stableSnapshot(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSnapshot(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSnapshot(record[key])}`)
    .join(',')}}`
}

function fullInputChanged(
  previous: PlanAnalysis,
  current: PlanAnalysis
): boolean {
  return (
    stableSnapshot({
      scenario: previous.scenario,
      options: previous.options,
    }) !==
    stableSnapshot({ scenario: current.scenario, options: current.options })
  )
}

function assumptionChanges(
  previous: PlanAnalysis,
  current: PlanAnalysis
): readonly PlanAnalysisChange[] {
  const changes: PlanAnalysisChange[] = []
  const previousRetirementAge = previous.scenario.profile.targetRetirementAge
  const currentRetirementAge = current.scenario.profile.targetRetirementAge
  if (previousRetirementAge !== currentRetirementAge) {
    changes.push({
      id: 'retirement-age',
      label: 'Target work-exit age',
      direction: 'changed',
      summary: `Target work-exit age changed from ${previousRetirementAge} to ${currentRetirementAge}.`,
    })
  }

  const previousSpending = retirementSpending(previous)
  const currentSpending = retirementSpending(current)
  if (previousSpending !== currentSpending) {
    changes.push({
      id: 'retirement-spending',
      label: 'Annual retirement spending',
      direction: 'changed',
      summary: `Annual modeled retirement spending changed from ${formatCurrency(previousSpending)} to ${formatCurrency(currentSpending)}.`,
    })
  }

  const previousOutsideIncome = outsideIncome(previous)
  const currentOutsideIncome = outsideIncome(current)
  if (previousOutsideIncome !== currentOutsideIncome) {
    changes.push({
      id: 'outside-income',
      label: 'Outside income',
      direction: 'changed',
      summary: `Modeled outside income changed from ${formatCurrency(previousOutsideIncome)} to ${formatCurrency(currentOutsideIncome)} per year.`,
    })
  }

  const previousClaimAge = socialSecurityClaimAge(previous)
  const currentClaimAge = socialSecurityClaimAge(current)
  if (previousClaimAge !== currentClaimAge) {
    changes.push({
      id: 'social-security-claim-age',
      label: 'Social Security claim age',
      direction: 'changed',
      summary: `Social Security claim age changed from ${formatOptionalAge(previousClaimAge)} to ${formatOptionalAge(currentClaimAge)}.`,
    })
  }

  const previousAssets = startingAssets(previous)
  const currentAssets = startingAssets(current)
  if (previousAssets !== currentAssets) {
    changes.push({
      id: 'starting-assets',
      label: 'Starting assets',
      direction: 'changed',
      summary: `Starting modeled assets changed from ${formatCurrency(previousAssets)} to ${formatCurrency(currentAssets)}.`,
    })
  }

  const previousHealthcare = healthcareCost(previous)
  const currentHealthcare = healthcareCost(current)
  if (previousHealthcare !== currentHealthcare) {
    changes.push({
      id: 'healthcare-cost',
      label: 'Annual healthcare cost',
      direction: 'changed',
      summary: `Annual healthcare cost changed from ${formatCurrency(previousHealthcare)} to ${formatCurrency(currentHealthcare)}.`,
    })
  }

  if (fullInputChanged(previous, current)) {
    changes.push({
      id: 'additional-modeled-changes',
      label: 'Additional modeled changes',
      direction: 'changed',
      summary:
        'Additional modeled inputs or derived values changed since the previous run; review the named assumption and outcome changes below.',
    })
  }

  return changes
}

function gapDirection(
  previous: GapSummary | null,
  current: GapSummary | null
): PlanAnalysisChangeDirection {
  if (!previous && current) return 'worsened'
  if (previous && !current) return 'improved'
  if (!previous || !current) return 'changed'

  const delayed = current.age > previous.age
  const smaller = current.amount < previous.amount
  const earlier = current.age < previous.age
  const larger = current.amount > previous.amount
  if ((delayed || smaller) && !(earlier || larger)) return 'improved'
  if ((earlier || larger) && !(delayed || smaller)) return 'worsened'
  return 'changed'
}

function gapSummary(gap: GapSummary | null): string {
  return gap ? `age ${gap.age} (${formatCurrency(gap.amount)})` : 'none'
}

function outcomeChanges(
  previous: PlanAnalysis,
  current: PlanAnalysis
): readonly PlanAnalysisChange[] {
  const changes: RankedChange[] = []
  if (previous.verdict.verdict !== current.verdict.verdict) {
    changes.push({
      id: 'verdict',
      label: 'Plan verdict',
      direction:
        verdictRank(current.verdict.verdict) >
        verdictRank(previous.verdict.verdict)
          ? 'improved'
          : 'worsened',
      summary: `The plan verdict changed from ${previous.verdict.verdict} to ${current.verdict.verdict}.`,
      priority: 1,
    })
  }

  if (previous.verdict.robustnessScore !== current.verdict.robustnessScore) {
    changes.push({
      id: 'robustness-score',
      label: 'Robustness score',
      direction: directionForHigherIsBetter(
        previous.verdict.robustnessScore,
        current.verdict.robustnessScore
      ),
      summary: `Robustness changed from ${previous.verdict.robustnessScore}/10 to ${current.verdict.robustnessScore}/10.`,
      priority: 2,
    })
  }

  if (
    previous.verdict.stressScenariosSolvent !==
    current.verdict.stressScenariosSolvent
  ) {
    changes.push({
      id: 'stress-survival',
      label: 'Stress scenarios solvent',
      direction: directionForHigherIsBetter(
        previous.verdict.stressScenariosSolvent,
        current.verdict.stressScenariosSolvent
      ),
      summary: `Solvent stress scenarios changed from ${previous.verdict.stressScenariosSolvent}/5 to ${current.verdict.stressScenariosSolvent}/5.`,
      priority: 3,
    })
  }

  const previousGap = firstFundingGap(previous)
  const currentGap = firstFundingGap(current)
  if (
    previousGap?.age !== currentGap?.age ||
    previousGap?.amount !== currentGap?.amount
  ) {
    changes.push({
      id: 'first-funding-gap',
      label: 'First funding gap',
      direction: gapDirection(previousGap, currentGap),
      summary: `The first modeled funding gap changed from ${gapSummary(previousGap)} to ${gapSummary(currentGap)}.`,
      priority: 4,
    })
  }

  const previousIncome = previous.incomeSolver.minimumGrossIncome
  const currentIncome = current.incomeSolver.minimumGrossIncome
  if (previousIncome !== currentIncome) {
    changes.push({
      id: 'minimum-outside-income',
      label: 'Minimum outside income',
      direction: directionForLowerIsBetter(previousIncome, currentIncome),
      summary: `Minimum gross outside income changed from ${formatOptionalCurrency(previousIncome)} to ${formatOptionalCurrency(currentIncome)}.`,
      priority: 5,
    })
  }

  const previousExit = previous.incomeSolver.earliestRobustExitAge
  const currentExit = current.incomeSolver.earliestRobustExitAge
  if (previousExit !== currentExit) {
    changes.push({
      id: 'earliest-robust-exit',
      label: 'Earliest robust exit',
      direction: directionForLowerIsBetter(previousExit, currentExit),
      summary: `Earliest robust work exit changed from ${formatOptionalAge(previousExit)} to ${formatOptionalAge(currentExit)}.`,
      priority: 6,
    })
  }

  const previousBalance = totalBalance(previous)
  const currentBalance = totalBalance(current)
  if (previousBalance !== currentBalance) {
    changes.push({
      id: 'final-balance',
      label: 'Final total balance',
      direction: directionForHigherIsBetter(previousBalance, currentBalance),
      summary: `Final modeled total balance changed from ${formatCurrency(previousBalance)} to ${formatCurrency(currentBalance)}.`,
      priority: 7,
    })
  }

  const ordered = changes.sort((left, right) => left.priority - right.priority)
  return ordered.slice(0, 5).map(({ priority: _priority, ...change }) => change)
}

export function comparePlanAnalyses(
  previous: PlanAnalysis,
  current: PlanAnalysis
): PlanAnalysisComparison {
  return {
    assumptionChanges: assumptionChanges(previous, current),
    outcomeChanges: outcomeChanges(previous, current),
  }
}
