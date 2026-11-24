// The plan review (REQ-MCP-69): the living plan in one result. Where the
// plan stands, when the owner can retire, which levers bring it forward, what
// the rules engine would change, what is due, what data is stale, what only
// the owner can decide, what a human professional should check, and when to
// review next. It reads the other engine parts; it changes nothing.
import { proposePlanPolicy } from './plan-policy'
import { planVerdict, type PlanVerdict } from './plan-verdict'
import { goalsOf, rankLevers, type LeverRanking } from './retirement-timing'
import type { Portfolio, UserProfile } from './types'
import { exploreWithdrawalOrders } from './withdrawal-order'

export const REVIEW_DEFAULTS = {
  reviewEveryDays: 30,
  staleSnapshotDays: 35,
  topLevers: 5,
  /** Pre-tax money above this share makes Roth conversions worth a professional check. */
  preTaxShareForRothCheck: 0.7,
  /** A withdrawal order this many points better than the current one is a decision. */
  orderGain: 0.01,
  /** Free cash under this many months of spending is flagged. */
  minCashMonths: 3,
} as const

export interface HumanCheck {
  /** Who to ask. */
  readonly who: string
  readonly what: string
  readonly why: string
}

export interface PlanReview {
  readonly asOfDate: string
  readonly snapshotDate: string
  readonly headline: string
  readonly standing: Pick<
    PlanVerdict,
    'verdict' | 'headline' | 'measures' | 'reasons'
  >
  readonly timing: {
    readonly targetAge: number
    readonly earliestAge: number | null
    readonly yearsFromTarget: number | null
    readonly goals: ReturnType<typeof goalsOf>
  }
  readonly levers: LeverRanking['levers']
  readonly combinedLevers: LeverRanking['combined']
  readonly rules: {
    readonly changes: number
    readonly changed: readonly string[]
    readonly needsInput: readonly string[]
  }
  /** Due now, from the owner's rules (plan_check trades and tasks first). */
  readonly actions: readonly string[]
  readonly dataToRefresh: readonly string[]
  /** Decisions only the owner can make, in the order to make them. */
  readonly ownerDecisions: readonly string[]
  /** What a human professional should check before the plan is final. */
  readonly humanChecks: readonly HumanCheck[]
  /** Which accounts to spend from first (REQ-MCP-70). */
  readonly withdrawalOrder: {
    readonly current: string
    readonly best: string
    readonly headline: string
  }
  /** Free cash against card debt and spending (REQ-MCP-72). */
  readonly liquidity: {
    readonly outsideCash: number | null
    readonly consumerDebt: number | null
    readonly monthsOfSpending: number | null
  }
  readonly nextReviewDate: string
}

function dayNumber(iso: string): number {
  return Math.round(
    Date.UTC(
      Number(iso.slice(0, 4)),
      Number(iso.slice(5, 7)) - 1,
      Number(iso.slice(8, 10))
    ) / 86_400_000
  )
}

function isoOf(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10)
}

function preTaxShare(portfolio: Portfolio): number {
  let preTax = 0
  let total = 0
  for (const account of portfolio.accounts) {
    let value = Math.max(0, account.cashBalance)
    for (const h of account.holdings) value += h.currentValue
    for (const cd of account.cds) value += cd.principal
    total += value
    if (
      [
        '401k',
        '403b',
        '457b',
        'traditional_ira',
        'rollover_ira',
        'nqdc',
      ].includes(account.accountType)
    )
      preTax += value
  }
  return total <= 0 ? 0 : preTax / total
}

/** What a fee-only planner, CPA, attorney or the agencies should check. */
export function humanChecksFor(
  portfolio: Portfolio,
  profile: UserProfile
): HumanCheck[] {
  const checks: HumanCheck[] = [
    {
      who: 'Fee-only CFP (one-off project fee)',
      what: 'Review this plan, its assumptions and the levers you choose before you give notice',
      why: 'a second pair of eyes on the inputs that move the result most: spending, healthcare and the retirement date',
    },
  ]
  if (
    profile.acaPremiumTaxCredit === true ||
    (profile.preMedicareHealthcare ?? 0) > 0
  )
    checks.push({
      who: 'healthcare.gov or a licensed broker',
      what: `Get a real Marketplace quote for your household at ${profile.targetRetirementAge}`,
      why: 'healthcare before 65 is the largest bridge cost, and the premium credit depends on income staying under the limit',
    })
  if (profile.nqdcPayout !== undefined)
    checks.push({
      who: 'Plan administrator and a CPA',
      what: 'Confirm the deferred-compensation payout election, when it can change, and the tax each year',
      why: 'the payout schedule is fixed by the election and is taxed as wages',
    })
  for (const lump of profile.lumpSums ?? [])
    checks.push({
      who: 'CPA',
      what: `US tax on "${lump.name}" at ${lump.age}`,
      why: 'the plan counts it as after-tax money; a different treatment changes the result',
    })
  if (preTaxShare(portfolio) > REVIEW_DEFAULTS.preTaxShareForRothCheck)
    checks.push({
      who: 'CPA',
      what: 'Confirm Roth conversion amounts each autumn against your actual tax return',
      why: 'most of the money is pre-tax, so the low-income years before Social Security set lifetime tax',
    })
  if (profile.spouse !== undefined)
    checks.push({
      who: 'Fee-only CFP or insurance agent',
      what: 'Life cover and the survivor case (run the survivor scenario first)',
      why: 'one Social Security benefit stops at the first death',
    })
  checks.push(
    {
      who: 'ssa.gov (my Social Security)',
      what: 'Check both earnings records and benefit estimates before choosing claim ages',
      why: 'every Social Security figure in the plan starts from these estimates',
    },
    {
      who: 'Estate attorney',
      what: 'Wills, beneficiary designations on every account, powers of attorney and healthcare directives',
      why: 'the engine does not model estate or incapacity planning',
    }
  )
  return checks
}

export function reviewPlan(
  portfolio: Portfolio,
  profile: UserProfile,
  asOfDate: string,
  options: { readonly seed?: number; readonly paths?: number } = {}
): PlanReview {
  const verdict = planVerdict(portfolio, profile, asOfDate, options)
  const ranking = rankLevers(portfolio, profile, options)
  const policy = proposePlanPolicy(portfolio, profile, asOfDate, options)
  const orders = exploreWithdrawalOrders(portfolio, profile, undefined, options)
  const goals = goalsOf(profile)
  const earliest = ranking.baseline.earliestAge
  const target = profile.targetRetirementAge

  const today = dayNumber(asOfDate)
  const snapshotAge = today - dayNumber(portfolio.asOfDate)
  const dataToRefresh: string[] = []
  if (snapshotAge > REVIEW_DEFAULTS.staleSnapshotDays)
    dataToRefresh.push(
      `Positions are ${snapshotAge} days old (${portfolio.asOfDate}): import a fresh positions CSV`
    )
  const doneAfterSnapshot = (profile.planRules?.sellSchedule ?? []).some(
    s =>
      s.done === true && dayNumber(s.dueDate) >= dayNumber(portfolio.asOfDate)
  )
  if (doneAfterSnapshot)
    dataToRefresh.push(
      'Sales marked done after the snapshot: import a fresh positions CSV so the measures include them'
    )
  if (
    profile.mortgage !== undefined &&
    today - dayNumber(profile.mortgage.asOfDate) > 365
  )
    dataToRefresh.push('Mortgage balance is over a year old: update it')

  const helping = ranking.levers.filter(
    l => (l.yearsEarlier ?? 0) > 0 || l.successChange > 0.005
  )
  const ownerDecisions: string[] = []
  if (policy.changes > 0)
    ownerDecisions.push(
      `Approve or decline ${policy.changes} proposed rule ${policy.changes === 1 ? 'change' : 'changes'} (${policy.findings
        .filter(f => f.status === 'change' || f.status === 'add')
        .map(f => f.rule)
        .join(', ')})`
    )
  if (helping.length > 0)
    ownerDecisions.push(
      `Choose which levers to adopt: ${helping
        .slice(0, 3)
        .map(l => l.name)
        .join('; ')}`
    )
  if (earliest !== null && earliest < target)
    ownerDecisions.push(
      `Decide whether to move the target from ${target} to ${earliest}: it already reaches your goals`
    )
  if (earliest === null || earliest > target)
    ownerDecisions.push(
      `Decide how to close the gap: the target of ${target} does not reach your goals${earliest === null ? '' : `; ${earliest} does`}`
    )
  for (const f of policy.findings.filter(f => f.status === 'needs_input'))
    ownerDecisions.push(`Give ${f.rule}: ${f.reason}`)
  const bestOrder = orders.orders.find(o => o.name === orders.best)
  if (
    bestOrder !== undefined &&
    bestOrder.vsCurrent.successRate > REVIEW_DEFAULTS.orderGain
  )
    ownerDecisions.push(`Withdrawal order: ${orders.headline}`)
  const outsideCash = profile.planRules?.outsideCash
  const debt = profile.consumerDebt
  const monthly = profile.annualExpenses / 12
  const months =
    outsideCash === undefined || monthly <= 0
      ? null
      : Math.round((outsideCash / monthly) * 10) / 10
  if (debt !== undefined && outsideCash !== undefined && debt > outsideCash)
    ownerDecisions.push(
      `Card and loan debt $${Math.round(debt).toLocaleString('en-US')} is more than free cash $${Math.round(outsideCash).toLocaleString('en-US')}: decide the payoff plan before buying anything long-term`
    )
  if (months !== null && months < REVIEW_DEFAULTS.minCashMonths)
    dataToRefresh.push(
      `Free cash covers ${months} months of spending: build it to ${REVIEW_DEFAULTS.minCashMonths} or more before locking money into CDs; check with import_balances when balances change`
    )

  // Next review: the cadence, or sooner when something is due before it.
  const every =
    profile.goals?.reviewEveryDays ?? REVIEW_DEFAULTS.reviewEveryDays
  const dues = [
    ...(profile.planRules?.sellSchedule ?? [])
      .filter(s => s.done !== true)
      .map(s => s.dueDate),
    ...(profile.planRules?.tasks ?? [])
      .filter(t => t.done !== true)
      .map(t => t.dueDate),
  ]
    .map(dayNumber)
    .filter(day => day > today)
  const nextReview = Math.min(today + every, ...dues)

  const timingText =
    earliest === null
      ? `no age up to ${goals.latestAge} reaches your goals yet`
      : earliest <= target
        ? `you can retire at ${earliest}`
        : `the earliest age that reaches your goals is ${earliest} (target ${target})`
  const leverText =
    ranking.combined?.earliestAge != null
      ? `; with the best levers together, ${ranking.combined.earliestAge}`
      : helping[0] !== undefined && helping[0].earliestAge !== null
        ? `; best single lever: ${helping[0].name}, ${helping[0].earliestAge}`
        : ''

  return {
    asOfDate,
    snapshotDate: portfolio.asOfDate,
    headline: `${verdict.verdict}: ${timingText}${leverText}`,
    standing: {
      verdict: verdict.verdict,
      headline: verdict.headline,
      measures: verdict.measures,
      reasons: verdict.reasons,
    },
    timing: {
      targetAge: target,
      earliestAge: earliest,
      yearsFromTarget: earliest === null ? null : earliest - target,
      goals,
    },
    levers: ranking.levers.slice(0, REVIEW_DEFAULTS.topLevers),
    combinedLevers: ranking.combined,
    rules: {
      changes: policy.changes,
      changed: policy.findings
        .filter(f => f.status === 'change' || f.status === 'add')
        .map(f => f.rule),
      needsInput: policy.findings
        .filter(f => f.status === 'needs_input')
        .map(f => f.rule),
    },
    actions: verdict.actions,
    dataToRefresh,
    ownerDecisions,
    humanChecks: humanChecksFor(portfolio, profile),
    withdrawalOrder: {
      current: orders.current,
      best: orders.best,
      headline: orders.headline,
    },
    liquidity: {
      outsideCash: outsideCash ?? null,
      consumerDebt: debt ?? null,
      monthsOfSpending: months,
    },
    nextReviewDate: isoOf(nextReview),
  }
}
