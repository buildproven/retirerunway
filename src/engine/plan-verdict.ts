// Plan verdict (REQ-MCP-56): one GO / CAUTION / DELAY call for the month,
// from the engine's own results on the same portfolio, profile and seed:
// the v2 success rate at the long-run means and at the 10-year forecast
// means (REQ-MCP-51), the share of 1928-2025 start years that last
// (REQ-MCP-50), the monthly spending the plan supports at 85% (REQ-MCP-45)
// and, with saved planRules, the plan check (REQ-MCP-47). The thresholds are
// fixed and published in the result. Deterministic. No AI; nothing traded.
import { backtestHistory } from './historical-backtest'
import { checkPlan, type PlanStatus } from './plan-check'
import { projectRetirement } from './retirement-projection'
import { spendingGuardrails } from './spending-guardrails'
import type { Portfolio, UserProfile } from './types'

export type Verdict = 'GO' | 'CAUTION' | 'DELAY'

/** GO needs every GO line met; DELAY follows from any DELAY line; else CAUTION. */
export const VERDICT_THRESHOLDS = {
  go: {
    successRate: 0.85,
    forecastSuccessRate: 0.75,
    historicalSuccessRate: 0.9,
  },
  delay: {
    successRate: 0.6,
    forecastSuccessRate: 0.45,
    historicalSuccessRate: 0.7,
  },
} as const

export const MAX_VERDICT_ACTIONS = 5

export interface PlanVerdict {
  readonly verdict: Verdict
  readonly headline: string
  readonly asOfDate: string
  readonly snapshotDate: string
  readonly measures: {
    readonly successRate: number
    readonly forecastSuccessRate: number
    readonly historicalSuccessRate: number
    readonly historicalUnwrappedSuccessRate: number
    readonly plannedMonthlySpending: number
    readonly canSpendMonthly: number | null
    readonly cutAtPortfolioValue: number | null
    readonly planStatus: PlanStatus | null
  }
  /** Why the verdict is what it is, worst first. */
  readonly reasons: readonly string[]
  /** At most five next actions, most urgent first. */
  readonly actions: readonly string[]
  readonly thresholds: typeof VERDICT_THRESHOLDS
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const dollars = (value: number) =>
  `$${Math.round(value).toLocaleString('en-US')}`

export function planVerdict(
  portfolio: Portfolio,
  profile: UserProfile,
  asOfDate: string,
  options: { readonly seed?: number; readonly paths?: number } = {}
): PlanVerdict {
  const run = {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  }
  const successRate = projectRetirement(portfolio, profile, run).monteCarlo
    .successRate
  const forecastProfile: UserProfile = {
    ...profile,
    marketAssumptions: { ...profile.marketAssumptions, preset: 'forecast' },
  }
  const forecastSuccessRate = projectRetirement(portfolio, forecastProfile, run)
    .monteCarlo.successRate
  const history = backtestHistory(portfolio, profile)
  const guardrails = spendingGuardrails(portfolio, profile, run)
  const check =
    profile.planRules === undefined
      ? null
      : checkPlan(portfolio, profile, profile.planRules, asOfDate)

  const go = VERDICT_THRESHOLDS.go
  const delay = VERDICT_THRESHOLDS.delay
  const reasons: string[] = []
  const delayed =
    successRate < delay.successRate ||
    forecastSuccessRate < delay.forecastSuccessRate ||
    history.successRate < delay.historicalSuccessRate
  if (successRate < go.successRate) {
    reasons.push(
      `chance the money lasts is ${pct(successRate)} (GO needs ${pct(go.successRate)})`
    )
  }
  if (forecastSuccessRate < go.forecastSuccessRate) {
    reasons.push(
      `at the 10-year forecast returns it is ${pct(forecastSuccessRate)} (GO needs ${pct(go.forecastSuccessRate)})`
    )
  }
  if (history.successRate < go.historicalSuccessRate) {
    reasons.push(
      `${pct(history.successRate)} of 1928-2025 start years last (GO needs ${pct(go.historicalSuccessRate)})`
    )
  }
  const canSpend = guardrails.canSpend
  if (
    canSpend !== null &&
    canSpend.monthlySpending < guardrails.planned.monthlySpending - 0.5
  ) {
    reasons.push(
      `planned spending ${dollars(guardrails.planned.monthlySpending)}/mo is above the ${dollars(canSpend.monthlySpending)}/mo the plan supports at 85%`
    )
  }
  if (check?.status === 'action_needed')
    reasons.push(`plan check: ${check.headline}`)

  const verdict: Verdict = delayed
    ? 'DELAY'
    : reasons.length === 0 && check?.status !== 'action_needed'
      ? 'GO'
      : 'CAUTION'

  const actions: string[] = []
  for (const rec of check?.recommendations ?? []) {
    if (rec.amount > 0 || rec.kind === 'refresh_snapshot')
      actions.push(rec.action)
  }
  if (
    canSpend !== null &&
    canSpend.monthlySpending < guardrails.planned.monthlySpending - 0.5
  ) {
    actions.push(
      `Plan spending at or below ${dollars(canSpend.monthlySpending)}/mo (without the mortgage payment), or add a lever: compare_retirement_scenarios for downsizing, a later retirement or side income`
    )
  }
  if (forecastSuccessRate < go.forecastSuccessRate) {
    actions.push(
      'Test the levers at the forecast returns too: add marketAssumptions { preset: "forecast" } to each scenario'
    )
  }
  if (guardrails.lower !== null) {
    actions.push(
      `Cut spending 10% if the portfolio falls to ${dollars(guardrails.lower.portfolioValue)}`
    )
  }
  if (profile.planRules === undefined) {
    actions.push(
      'Save planRules (target stock share, sell schedule) so the verdict can check trades'
    )
  }

  const headline =
    verdict === 'GO'
      ? `GO: ${pct(successRate)} chance, ${pct(forecastSuccessRate)} at forecast returns, ${pct(history.successRate)} of historical start years`
      : `${verdict}: ${reasons[0] ?? 'see the measures'}`

  return {
    verdict,
    headline,
    asOfDate,
    snapshotDate: portfolio.asOfDate,
    measures: {
      successRate,
      forecastSuccessRate,
      historicalSuccessRate: history.successRate,
      historicalUnwrappedSuccessRate: history.unwrappedSuccessRate,
      plannedMonthlySpending: guardrails.planned.monthlySpending,
      canSpendMonthly: canSpend?.monthlySpending ?? null,
      cutAtPortfolioValue: guardrails.lower?.portfolioValue ?? null,
      planStatus: check?.status ?? null,
    },
    reasons,
    actions: actions.slice(0, MAX_VERDICT_ACTIONS),
    thresholds: VERDICT_THRESHOLDS,
  }
}
