import type { PlanAnalysis } from './analyze'
import {
  SOCIAL_SECURITY_RULES_AS_OF,
  SOCIAL_SECURITY_RULES_SOURCE,
} from './social-security'
import type { ProjectionRow } from './types'

export const MEDICARE_ELIGIBILITY_AGE = 65
export const PENALTY_FREE_ACCESS_AGE = 59.5

export interface BridgeSummary {
  readonly exitAge: number
  readonly yearsToMedicare: number
  readonly yearsToSocialSecurity: number | null
  /** Real-dollar spending from the exit age until Social Security starts. */
  readonly bridgeSpending: number
  readonly accessibleAtExit: number
  readonly lowestBalance: { readonly age: number; readonly total: number }
  readonly firstFundingGapAge: number | null
}

export interface PlanMilestone {
  readonly age: number
  readonly label: string
  readonly detail: string
}

function total(row: ProjectionRow): number {
  return row.accessibleBalance + row.restrictedBalance
}

function money(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

export function buildBridgeSummary(analysis: PlanAnalysis): BridgeSummary {
  const rows = analysis.projections.real.rows
  const exitAge = analysis.scenario.profile.targetRetirementAge
  const ssAge = analysis.options.socialSecurityAge ?? null
  const bridgeEnd = ssAge ?? Number.POSITIVE_INFINITY
  const bridgeRows = rows.filter(
    row => row.age >= exitAge && row.age < bridgeEnd
  )
  const atExit = rows.find(row => row.age >= exitAge)
  let lowest = rows[0]
  for (const row of rows) {
    if (total(row) < total(lowest)) lowest = row
  }
  return {
    exitAge,
    yearsToMedicare: Math.max(0, MEDICARE_ELIGIBILITY_AGE - exitAge),
    yearsToSocialSecurity: ssAge === null ? null : Math.max(0, ssAge - exitAge),
    bridgeSpending: bridgeRows.reduce((sum, row) => sum + row.spending, 0),
    accessibleAtExit: atExit?.accessibleBalance ?? 0,
    lowestBalance: lowest
      ? { age: lowest.age, total: total(lowest) }
      : { age: exitAge, total: 0 },
    firstFundingGapAge: rows.find(row => row.fundingGap > 0)?.age ?? null,
  }
}

export function buildMilestones(analysis: PlanAnalysis): PlanMilestone[] {
  const rows = analysis.projections.real.rows
  if (rows.length === 0) return []
  const first = rows[0].age
  const last = rows[rows.length - 1].age
  const bridge = buildBridgeSummary(analysis)
  const milestones: PlanMilestone[] = [
    {
      age: bridge.exitAge,
      label: 'Work exit',
      detail: `${money(bridge.accessibleAtExit)} accessible (real dollars)`,
    },
    {
      age: PENALTY_FREE_ACCESS_AGE,
      label: 'Penalty-free retirement-account access',
      detail: 'Age 59½ unlocks pretax and Roth account withdrawals',
    },
    {
      age: MEDICARE_ELIGIBILITY_AGE,
      label: 'Medicare eligibility',
      detail: 'Marketplace coverage ends where Medicare begins',
    },
  ]
  const ssAge = analysis.options.socialSecurityAge
  if (ssAge !== undefined) {
    milestones.push({
      age: ssAge,
      label: 'Social Security starts',
      detail: 'Modeled claiming age',
    })
  }
  if (bridge.firstFundingGapAge !== null) {
    milestones.push({
      age: bridge.firstFundingGapAge,
      label: 'First funding gap',
      detail: 'Spending exceeds accessible funds',
    })
  }
  milestones.push({
    age: bridge.lowestBalance.age,
    label: 'Lowest projected balance',
    detail: `${money(bridge.lowestBalance.total)} total (real dollars)`,
  })
  milestones.push({
    age: last,
    label: 'Plan end',
    detail: 'Final modeled year',
  })
  return milestones
    .filter(milestone => milestone.age >= first && milestone.age <= last)
    .sort((a, b) => a.age - b.age || a.label.localeCompare(b.label))
}

export interface LifetimeChartPoint {
  readonly age: number
  readonly accessible: number
  readonly restricted: number
  readonly spending: number
}

export function buildLifetimeSeries(
  analysis: PlanAnalysis
): LifetimeChartPoint[] {
  return analysis.projections.real.rows.map(row => ({
    age: row.age,
    accessible: Math.round(row.accessibleBalance),
    restricted: Math.round(row.restrictedBalance),
    spending: Math.round(row.spending),
  }))
}

/**
 * Deterministic report: no clock reads. The caller supplies nothing that is
 * not already in the analysis, so equal inputs give byte-identical output.
 */
export function planToMarkdown(analysis: PlanAnalysis): string {
  const { verdict, incomeSolver } = analysis
  const bridge = buildBridgeSummary(analysis)
  const lines = [
    '# RetireRunway plan report',
    '',
    '> Educational modelling output. Not financial, tax, or legal advice.',
    '',
    `**Verdict:** ${verdict.verdict} (robustness ${verdict.robustnessScore}/10)`,
    '',
    ...verdict.delayReasons.map(reason => `- Delay: ${reason}`),
    ...verdict.cautionReasons.map(reason => `- Caution: ${reason}`),
    '',
    '## Bridge',
    '',
    `- Work exit age: ${bridge.exitAge}`,
    `- Years to Medicare: ${bridge.yearsToMedicare}`,
    `- Years to Social Security: ${bridge.yearsToSocialSecurity ?? 'not modeled'}`,
    `- Bridge spending (real dollars): ${money(bridge.bridgeSpending)}`,
    `- Accessible at exit: ${money(bridge.accessibleAtExit)}`,
    `- Lowest balance: ${money(bridge.lowestBalance.total)} at age ${bridge.lowestBalance.age}`,
    `- First funding gap: ${bridge.firstFundingGapAge === null ? 'none' : `age ${bridge.firstFundingGapAge}`}`,
    `- Minimum outside income: ${incomeSolver.minimumGrossIncome === null ? 'no solution' : money(incomeSolver.minimumGrossIncome)}`,
    '',
    '## Milestones',
    '',
    '| Age | Milestone | Detail |',
    '| --- | --- | --- |',
    ...buildMilestones(analysis).map(
      milestone =>
        `| ${milestone.age} | ${milestone.label} | ${milestone.detail} |`
    ),
    '',
    '## Stress scenarios',
    '',
    '| Scenario | Outcome | Final total balance |',
    '| --- | --- | --- |',
    ...analysis.stressResults.map(result => {
      const final = result.projection.rows.at(-1)
      return `| ${result.label} | ${result.solvent ? 'Solvent' : 'Funding gap'} | ${final ? money(total(final)) : '—'} |`
    }),
    '',
    '## Assumption sources',
    '',
    `- Social Security rules as of ${SOCIAL_SECURITY_RULES_AS_OF}: ${SOCIAL_SECURITY_RULES_SOURCE}`,
    '',
  ]
  return lines.join('\n')
}

export function planToJson(analysis: PlanAnalysis): string {
  return JSON.stringify(
    {
      schema: 'retire-runway.plan.v1',
      scenarioId: analysis.scenario.id,
      verdict: {
        verdict: analysis.verdict.verdict,
        robustnessScore: analysis.verdict.robustnessScore,
        delayReasons: analysis.verdict.delayReasons,
        cautionReasons: analysis.verdict.cautionReasons,
        metrics: analysis.verdict.metrics,
      },
      bridge: buildBridgeSummary(analysis),
      minimumOutsideIncome: analysis.incomeSolver.minimumGrossIncome,
      milestones: buildMilestones(analysis),
      stress: analysis.stressResults.map(result => ({
        id: result.id,
        solvent: result.solvent,
      })),
      projectionReal: buildLifetimeSeries(analysis),
      assumptions: {
        scenario: analysis.scenario,
        socialSecurityRulesAsOf: SOCIAL_SECURITY_RULES_AS_OF,
        socialSecurityRulesSource: SOCIAL_SECURITY_RULES_SOURCE,
      },
    },
    null,
    2
  )
}
