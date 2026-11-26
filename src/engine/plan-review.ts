// The plan review (REQ-MCP-69): the living plan in one result. Where the
// plan stands, when the owner can retire, which levers bring it forward, what
// the rules engine would change, what is due, what data is stale, what only
// the owner can decide, what a human professional should check, and when to
// review next. It reads the other engine parts; it changes nothing.
import {
  earliestReverseMortgageAge,
  reverseMortgagePlan,
} from './reverse-mortgage'
import { assetLocation, type AssetLocationResult } from './asset-location'
import { lawTablesMessage } from './law-tables'
import { MONTE_CARLO_DEFAULTS } from './config'
import { projectRetirement } from './retirement-projection'
import { MARKET_DATA_STALE_DAYS, marketDataAgeDays } from './market-assumptions'
import {
  proposePlanPolicy,
  type MarketComparison,
  type PolicyFinding,
  type SafeLadderTestRow,
} from './plan-policy'
import { planVerdict, type PlanVerdict } from './plan-verdict'
import { goalsOf, rankLevers, type LeverRanking } from './retirement-timing'
import type {
  GlidePoint,
  PlanRules,
  Portfolio,
  SafeLadder,
  UserProfile,
} from './types'
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
  /** REQ-MCP-81: health cover rising this much a year faster than prices, as a stress. */
  healthcareStress: 0.02,
  /**
   * REQ-MCP-82: stocks and bonds falling together (2022-style); the firms'
   * 2026-27 outlooks (J.P. Morgan, T. Rowe Price) see positive correlation.
   */
  correlationStress: 0.5,
  /**
   * REQ-MCP-82: a care need of the national median assisted-living cost
   * ($74,400 a year, CareScout 2025 Cost of Care Survey) for 3 years from 85.
   */
  careStress: { startAge: 85, years: 3, annualCost: 74_400 },
  /** REQ-MCP-82: a year out of work from 55, no severance, then a job like this one. */
  jobGapStress: { startAge: 55, months: 12 },
  /** REQ-MCP-83: a job change at this age, the year before the Rule of 55. */
  jobChangeStressAge: 54,
  /** REQ-MCP-82: lump sums (such as an overseas pension) worth this much less. */
  lumpSumStress: 0.2,
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
    /**
     * REQ-MCP-77: 'auto' when profile goals.autoApplyRules is set: the
     * standing, actions and headline already use the proposed rules, and
     * the agent saves them (proposedRules, safeLadder, glidePath). 'approve':
     * the owner approves each change first.
     */
    readonly mode: 'auto' | 'approve'
    readonly changes: number
    readonly changed: readonly string[]
    readonly needsInput: readonly string[]
    /** Each change or addition: rule, reason, current and proposed values. */
    readonly findings: readonly PolicyFinding[]
    readonly proposedRules: PlanRules
    /** Profile safeLadder to save; null leaves it as it is. */
    readonly safeLadder: SafeLadder | null
    /** Profile glidePath to save; null leaves it as it is. */
    readonly glidePath: readonly GlidePoint[] | null
  }
  /** Safe yields against stocks and the locked-ladder test (REQ-MCP-75, REQ-MCP-76). */
  readonly market: {
    readonly comparison: MarketComparison | null
    readonly safeLadderRows: readonly SafeLadderTestRow[]
    readonly safeLadderBasis: string
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
  /**
   * REQ-MCP-79: each debt's rate against what safe money pays (the 10-year
   * Treasury yield from market data, else the engine's 4% bond mean): pay
   * down debt that costs more, keep debt that costs less.
   */
  /**
   * REQ-MCP-81: the plan under stresses the base case leaves out, same
   * seed: health cover rising 2 points a year faster than prices (when the
   * profile does not set its own rate).
   */
  readonly stressTests: readonly {
    readonly name: string
    readonly successRate: number
    readonly change: number
  }[]
  /** REQ-MCP-86: a standby reverse mortgage line against none. */
  readonly reverseMortgageTest: {
    readonly openAge: number
    readonly line: number
    readonly mortgagePayoff: number
    readonly successRate: number
    readonly change: number
  } | null
  /** REQ-MCP-85: where bonds and stocks sit, and swaps that keep the mix. */
  readonly assetLocation: AssetLocationResult
  readonly debt: readonly {
    readonly name: string
    readonly balance: number
    readonly rate: number | null
    readonly safeYield: number
    readonly verdict: 'pay off first' | 'keep' | 'rate needed'
    readonly reason: string
  }[]
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
  // REQ-MCP-83: a job change before 55 decides whether the Rule of 55 still
  // covers the old 401(k).
  if (
    profile.jobChange !== undefined ||
    (profile.currentAge < 55 &&
      profile.targetRetirementAge >= 55 &&
      profile.targetRetirementAge < 60)
  )
    checks.push({
      who: 'New employer plan administrator',
      what: 'Before any job change, confirm the new 401(k) accepts roll-ins of the old 401(k) and IRAs, and roll them in before you leave the new job',
      why: 'the Rule of 55 covers only the plan of the employer you leave at 55 or later; money left behind earlier or moved to an IRA waits until 59½ or pays the 10% penalty',
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
  const policy = proposePlanPolicy(portfolio, profile, asOfDate, options)
  // REQ-MCP-77: with autoApplyRules the rules are the system's working
  // settings, so the review stands on the proposed ones.
  const auto = profile.goals?.autoApplyRules === true
  const proposedSafeLadder = policy.findings.some(
    f => f.rule === 'safeLadder' && f.status !== 'keep'
  )
    ? policy.safeLadderTest.proposed
    : null
  const glideFinding = policy.findings.find(f => f.rule === 'glidePath')
  const proposedGlide =
    glideFinding !== undefined && glideFinding.status !== 'keep'
      ? policy.glideTest.proposed
      : null
  const reviewed: UserProfile = auto
    ? {
        ...profile,
        planRules: policy.proposedRules,
        ...(proposedSafeLadder === null
          ? {}
          : { safeLadder: proposedSafeLadder }),
        ...(glideFinding === undefined || glideFinding.status === 'keep'
          ? {}
          : {
              glidePath:
                proposedGlide === null ? undefined : [...proposedGlide],
            }),
      }
    : profile
  const verdict = planVerdict(portfolio, reviewed, asOfDate, options)
  const ranking = rankLevers(portfolio, reviewed, options)
  const orders = exploreWithdrawalOrders(
    portfolio,
    reviewed,
    undefined,
    options
  )
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
  // REQ-MCP-84: the engine's law figures against the law on asOfDate.
  const lawMessage = lawTablesMessage(asOfDate)
  if (lawMessage !== undefined)
    dataToRefresh.push(lawMessage[0].toUpperCase() + lawMessage.slice(1))

  const helping = ranking.levers.filter(
    l => (l.yearsEarlier ?? 0) > 0 || l.successChange > 0.005
  )
  if (profile.marketData === undefined)
    dataToRefresh.push(
      "No market data: search today's Treasury, TIPS and CD yields and the firms' stock forecasts and save them with save_market_data, so the forecast returns and the ladder test follow current markets"
    )
  else {
    const marketAge = marketDataAgeDays(profile.marketData, asOfDate)
    if (marketAge > MARKET_DATA_STALE_DAYS)
      dataToRefresh.push(
        `Market data is ${marketAge} days old (${profile.marketData.asOfDate}): refresh it with save_market_data`
      )
  }
  const ownerDecisions: string[] = []
  // REQ-MCP-81: stresses the base case leaves out.
  const stressTests: PlanReview['stressTests'][number][] = []
  if (
    (reviewed.preMedicareHealthcare ?? 0) > 0 &&
    reviewed.healthcareRealGrowth === undefined
  ) {
    const stressed = projectRetirement(
      portfolio,
      { ...reviewed, healthcareRealGrowth: REVIEW_DEFAULTS.healthcareStress },
      options
    ).monteCarlo.successRate
    stressTests.push({
      name: `Health cover rises ${REVIEW_DEFAULTS.healthcareStress * 100} points a year faster than prices`,
      successRate: stressed,
      change:
        Math.round((stressed - verdict.measures.successRate) * 1000) / 1000,
    })
  }

  // REQ-MCP-82: correlation, care, job loss and currency stresses.
  const stress = (name: string, plan: UserProfile) => {
    const rate = projectRetirement(portfolio, plan, options).monteCarlo
      .successRate
    stressTests.push({
      name,
      successRate: rate,
      change: Math.round((rate - verdict.measures.successRate) * 1000) / 1000,
    })
  }
  if (reviewed.marketAssumptions?.stockBondCorrelation === undefined)
    stress(
      `Stocks and bonds fall together (correlation ${REVIEW_DEFAULTS.correlationStress}, as in 2022)`,
      {
        ...reviewed,
        marketAssumptions: {
          ...reviewed.marketAssumptions,
          stockBondCorrelation: REVIEW_DEFAULTS.correlationStress,
        },
      }
    )
  if (reviewed.longTermCare === undefined) {
    const care = REVIEW_DEFAULTS.careStress
    stress(
      `Care need: $${care.annualCost.toLocaleString('en-US')} a year (median assisted living) for ${care.years} years from ${care.startAge}`,
      { ...reviewed, longTermCare: care }
    )
  }
  const gap = REVIEW_DEFAULTS.jobGapStress
  if (
    reviewed.incomeGap === undefined &&
    reviewed.currentAge < gap.startAge &&
    reviewed.targetRetirementAge > gap.startAge + gap.months / 12
  )
    stress(`A year out of work from ${gap.startAge}, no severance`, {
      ...reviewed,
      incomeGap: { ...gap },
    })
  const changeAge = REVIEW_DEFAULTS.jobChangeStressAge
  if (
    reviewed.jobChange === undefined &&
    reviewed.currentAge < changeAge &&
    reviewed.targetRetirementAge > changeAge
  ) {
    if (reviewed.targetRetirementAge < 60) {
      stress(
        `Change jobs at ${changeAge} and roll the old 401(k) into the new plan`,
        { ...reviewed, jobChange: { age: changeAge, oldPlan: 'rollIn' } }
      )
      stress(
        `Change jobs at ${changeAge} and move the old 401(k) to an IRA (loses the Rule of 55 on it)`,
        { ...reviewed, jobChange: { age: changeAge, oldPlan: 'ira' } }
      )
    } else
      stress(
        `Change jobs at ${changeAge} (retiring at ${reviewed.targetRetirementAge}, past 59½, the Rule of 55 does not matter; leaving starts any deferred-comp payout)`,
        { ...reviewed, jobChange: { age: changeAge, oldPlan: 'rollIn' } }
      )
  }
  if ((reviewed.lumpSums ?? []).length > 0)
    stress(
      `Lump sums worth ${REVIEW_DEFAULTS.lumpSumStress * 100}% less (${(reviewed.lumpSums ?? []).map(l => l.name).join(', ')}; e.g. the currency falls)`,
      {
        ...reviewed,
        lumpSums: (reviewed.lumpSums ?? []).map(l => ({
          ...l,
          amount: l.amount * (1 - REVIEW_DEFAULTS.lumpSumStress),
        })),
      }
    )

  // REQ-MCP-79: debt against safe yields.
  const safeYield =
    profile.marketData?.treasury10y ?? MONTE_CARLO_DEFAULTS.BOND_MEAN
  const p2 = (v: number) => `${(v * 100).toFixed(2)}%`
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`
  const debtRows: PlanReview['debt'][number][] = []
  const cardDebt = profile.consumerDebt ?? 0
  if (cardDebt > 0) {
    const rate = profile.consumerDebtRate
    if (rate === undefined) {
      debtRows.push({
        name: 'Card and loan debt',
        balance: cardDebt,
        rate: null,
        safeYield,
        verdict: 'rate needed',
        reason: `add consumerDebtRate (the APR) so the review can rank paying off ${money(cardDebt)} against investing`,
      })
      dataToRefresh.push(
        `Card and loan APR missing: save consumerDebtRate so paying off ${money(cardDebt)} can be ranked against investing`
      )
    } else {
      const payFirst = rate > safeYield
      debtRows.push({
        name: 'Card and loan debt',
        balance: cardDebt,
        rate,
        safeYield,
        verdict: payFirst ? 'pay off first' : 'keep',
        reason: payFirst
          ? `paying it off earns ${p2(rate)} guaranteed and tax-free, more than safe money pays (${p2(safeYield)}): pay it before buying TIPS, CDs or stocks`
          : `it costs ${p2(rate)}, less than safe money pays (${p2(safeYield)})`,
      })
    }
  }
  const mortgage = profile.mortgage
  if (
    mortgage !== undefined &&
    mortgage.balance > 0 &&
    mortgage.rate !== undefined
  ) {
    const prepay = mortgage.rate > safeYield + 0.005
    debtRows.push({
      name: 'Mortgage',
      balance: mortgage.balance,
      rate: mortgage.rate,
      safeYield,
      verdict: prepay ? 'pay off first' : 'keep',
      reason: prepay
        ? `extra payments earn ${p2(mortgage.rate)} guaranteed, more than safe money pays (${p2(safeYield)}): consider them before buying bonds`
        : `at ${p2(mortgage.rate)} it costs less than safe money pays (${p2(safeYield)}): keep it and invest spare cash instead of paying it down early`,
    })
  }
  const debtActions = debtRows
    .filter(d => d.verdict === 'pay off first')
    .map(
      d =>
        `${d.name} (${money(d.balance)} at ${p2(d.rate as number)}): ${d.reason}`
    )

  // REQ-MCP-86: a standby reverse mortgage line at the earliest age, when
  // the home is kept and the profile has none.
  let reverseMortgageTest: PlanReview['reverseMortgageTest'] = null
  if (
    reviewed.reverseMortgage === undefined &&
    reviewed.homeSale === undefined &&
    reviewed.home !== undefined
  ) {
    const openAge = Math.max(
      earliestReverseMortgageAge(reviewed),
      reviewed.targetRetirementAge
    )
    const withLine = { ...reviewed, reverseMortgage: { openAge } }
    const plan = reverseMortgagePlan(withLine, portfolio.asOfDate)
    if (plan !== undefined && plan.opens) {
      const rate = projectRetirement(portfolio, withLine, options).monteCarlo
        .successRate
      reverseMortgageTest = {
        openAge: plan.openAge,
        line: Math.round(plan.line),
        mortgagePayoff: Math.round(plan.mortgagePayoff),
        successRate: rate,
        change: Math.round((rate - verdict.measures.successRate) * 1000) / 1000,
      }
    }
  }
  const reverseMortgageAdvice =
    reverseMortgageTest !== null && reverseMortgageTest.change >= 0.02
      ? [
          `A reverse mortgage line opened at ${reverseMortgageTest.openAge} (pays off the mortgage, leaves about ${money(reverseMortgageTest.line)} as a standby, today's dollars) takes the chance the money lasts to ${(reverseMortgageTest.successRate * 100).toFixed(1)}% (${reverseMortgageTest.change > 0 ? '+' : ''}${(reverseMortgageTest.change * 100).toFixed(1)} pts); it costs about 3% of the home up front and the loan grows, so the heirs get less of the home: get a HUD-approved counselor's quote before deciding`,
        ]
      : []

  // REQ-MCP-85: where stocks and bonds sit, on the newest snapshot.
  const location = assetLocation(portfolio, profile)

  // REQ-MCP-78: the alternatives share is advice to act on, not a saved setting.
  const advisory = new Set(['altShare', 'incomeAnnuity'])
  const changedFindings = policy.findings.filter(
    f => (f.status === 'change' || f.status === 'add') && !advisory.has(f.rule)
  )
  const advice = policy.findings
    .filter(
      f => advisory.has(f.rule) && (f.status === 'change' || f.status === 'add')
    )
    .map(f => f.reason)
  if (auto && changedFindings.length > 0)
    dataToRefresh.unshift(
      `The engine updated ${changedFindings.length} working ${changedFindings.length === 1 ? 'setting' : 'settings'} (${changedFindings.map(f => f.rule).join(', ')}); this review already uses them: save rules.proposedRules${proposedSafeLadder === null ? '' : ', rules.safeLadder'}${proposedGlide === null ? '' : ', rules.glidePath'} with update_profile`
    )
  if (!auto && policy.changes > 0)
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
      mode: auto ? 'auto' : 'approve',
      changes: policy.changes,
      changed: policy.findings
        .filter(f => f.status === 'change' || f.status === 'add')
        .map(f => f.rule),
      needsInput: policy.findings
        .filter(f => f.status === 'needs_input')
        .map(f => f.rule),
      findings: changedFindings,
      proposedRules: policy.proposedRules,
      safeLadder: proposedSafeLadder,
      glidePath: proposedGlide,
    },
    market: {
      comparison: policy.market,
      safeLadderRows: policy.safeLadderTest.rows,
      safeLadderBasis: policy.safeLadderTest.basis,
    },
    actions: [
      ...debtActions,
      ...verdict.actions,
      ...advice,
      ...reverseMortgageAdvice,
      ...location.swaps.map(sw => `Asset location: ${sw.reason}`),
    ],
    dataToRefresh,
    ownerDecisions,
    humanChecks: humanChecksFor(portfolio, profile),
    withdrawalOrder: {
      current: orders.current,
      best: orders.best,
      headline: orders.headline,
    },
    stressTests,
    reverseMortgageTest,
    assetLocation: location,
    debt: debtRows,
    liquidity: {
      outsideCash: outsideCash ?? null,
      consumerDebt: debt ?? null,
      monthsOfSpending: months,
    },
    nextReviewDate: isoOf(nextReview),
  }
}
