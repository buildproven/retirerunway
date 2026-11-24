// The engine proposes the plan rules (REQ-MCP-64, ADR-009). From the profile
// and snapshot it tests stock shares with the projection, sizes a ladder that
// funds the first retirement years, times the cash buffer, schedules the
// sales the proposed share needs, and checks the owner's current rules
// against all of it. Pure and deterministic: same inputs and seed, same
// proposal. Nothing is saved; the owner approves each change.
import { calculatePortfolioValue } from './portfolio-math'
import { checkPlan } from './plan-check'
import { projectRetirement } from './retirement-projection'
import type {
  Account,
  AccountType,
  CdLadderRule,
  Holding,
  PlanRules,
  Portfolio,
  ScheduledSale,
  UserProfile,
} from './types'

export const POLICY_DEFAULTS = {
  /** Stock shares the projection is run at. */
  equityCandidates: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8] as readonly number[],
  /** Within this many points of the best, the lower share wins. */
  tieTolerance: 0.01,
  /** A current target this far from the tested share is a change. */
  changeThreshold: 0.05,
  driftBand: 0.05,
  cashBufferYears: 1,
  /** The bond-tent window: at most this many rungs from retirement. */
  maxRungs: 5,
  /** New-issue CDs and Treasury notes go out to 10 years. */
  maxTermYears: 10,
  saleChunks: 3,
  unit: 1_000,
  socialSecurityAge: 67,
} as const

export type FindingStatus = 'keep' | 'change' | 'add' | 'needs_input'

export interface PolicyFinding {
  readonly rule: string
  readonly status: FindingStatus
  readonly current?: unknown
  readonly proposed?: unknown
  readonly reason: string
}

export interface EquityTestRow {
  readonly equityShare: number
  readonly successRate: number
  readonly forecastSuccessRate: number
  /** The worse of the two: the score the proposal ranks by. */
  readonly worse: number
}

export interface PolicyRung {
  readonly year: number
  readonly age: number
  /** Years from the as-of year: the term to buy. */
  readonly termYears: number
  /** Expected-path withdrawals that year, less deferred-compensation payouts, today's dollars. */
  readonly need: number
  /** The part of the need the ladder can fill. */
  readonly target: number
  /** True when the term is 10 years or less. */
  readonly buyableNow: boolean
  /** True when taking it out that year carries the 10% early-withdrawal penalty. */
  readonly penalty: boolean
}

export interface PolicyLadder {
  readonly accountType: AccountType
  readonly firstYear: number
  readonly lastYear: number
  readonly total: number
  readonly needTotal: number
  readonly rungs: readonly PolicyRung[]
}

export interface PolicyProposal {
  readonly asOfDate: string
  readonly snapshotDate: string
  readonly retirementAge: number
  readonly retirementYear: number
  readonly yearsToRetirement: number
  readonly socialSecurityAge: number
  readonly currentEquityShare: number
  readonly equityTest: {
    readonly rows: readonly EquityTestRow[]
    readonly proposed: number
    readonly basis: string
  }
  readonly ladder: PolicyLadder | null
  readonly findings: readonly PolicyFinding[]
  /** Findings that would change or add a rule. */
  readonly changes: number
  readonly proposedRules: PlanRules
  readonly notes: readonly string[]
}

const round2 = (value: number) => Math.round(value * 100) / 100
const pct = (value: number) => `${(value * 100).toFixed(1)}%`
const dollars = (value: number) =>
  `$${Math.round(value).toLocaleString('en-US')}`
const unitDown = (value: number) =>
  Math.floor(value / POLICY_DEFAULTS.unit) * POLICY_DEFAULTS.unit

function accountTotal(account: Account): {
  value: number
  basis: number
} {
  let value = Math.max(0, account.cashBalance)
  let basis = value
  for (const holding of account.holdings) {
    value += holding.currentValue
    basis += holding.costBasis
  }
  for (const cd of account.cds) {
    value += cd.principal
    basis += cd.principal
  }
  return { value, basis }
}

/**
 * The portfolio with every account rebalanced to `share` in stocks and the
 * rest in bonds, keeping each account's total and taxable basis, so the
 * projection tests the share and nothing else.
 */
export function withEquityShare(
  portfolio: Portfolio,
  share: number
): Portfolio {
  return {
    ...portfolio,
    accounts: portfolio.accounts.map(account => {
      const { value, basis } = accountTotal(account)
      if (value <= 0) return account
      const make = (
        suffix: string,
        assetClass: Holding['assetClass'],
        part: number
      ): Holding => ({
        id: `${account.id}-${suffix}`,
        symbol: suffix.toUpperCase(),
        name: `${suffix} (rebalanced for the test)`,
        assetClass,
        shares: value * part,
        costBasis: basis * part,
        currentPrice: 1,
        currentValue: value * part,
      })
      return {
        ...account,
        cashBalance: 0,
        cds: [],
        holdings: [
          make('stocks', 'us_equity', share),
          make('bonds', 'us_bond', 1 - share),
        ],
      }
    }),
  }
}

function isEquity(holding: Holding): boolean {
  return (
    holding.assetClass === 'us_equity' ||
    holding.assetClass === 'intl_equity' ||
    holding.assetClass === 'emerging_equity'
  )
}

function currentEquityShare(portfolio: Portfolio): number {
  const total = calculatePortfolioValue(portfolio)
  if (total <= 0) return 0
  let equity = 0
  for (const account of portfolio.accounts)
    for (const holding of account.holdings)
      if (isEquity(holding)) equity += holding.currentValue
  return equity / total
}

const EMPLOYER_PLANS: readonly AccountType[] = ['401k', '403b', 'roth_401k']

/** True when money taken out of `accountType` at `age` carries the 10% penalty. */
export function earlyPenaltyAt(
  accountType: AccountType,
  age: number,
  separationAge: number
): boolean {
  if (age >= 59.5) return false
  if (accountType === 'brokerage' || accountType === '457b') return false
  if (accountType === 'nqdc') return false
  // Rule of 55: leaving the employer in or after the year you turn 55.
  if (EMPLOYER_PLANS.includes(accountType))
    return !(separationAge >= 55 && age >= separationAge)
  return true
}

/** The 15th of each of the next `count` months after `asOfDate`. */
function nextFifteenths(asOfDate: string, count: number): string[] {
  const year = Number(asOfDate.slice(0, 4))
  let month = Number(asOfDate.slice(5, 7))
  const day = Number(asOfDate.slice(8, 10))
  if (day >= 15) month += 1
  const dates: string[] = []
  for (let i = 0; i < count; i++) {
    const m = month + i
    const y = year + Math.floor((m - 1) / 12)
    const mm = ((m - 1) % 12) + 1
    dates.push(`${y}-${String(mm).padStart(2, '0')}-15`)
  }
  return dates
}

function sameLadder(a: CdLadderRule, b: CdLadderRule): boolean {
  return (
    a.accountType === b.accountType &&
    a.firstYear === b.firstYear &&
    a.lastYear === b.lastYear
  )
}

export function proposePlanPolicy(
  portfolio: Portfolio,
  profile: UserProfile,
  asOfDate: string,
  options: { readonly seed?: number; readonly paths?: number } = {}
): PolicyProposal {
  const run = {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  }
  const current = profile.planRules
  const asOfYear = Number(asOfDate.slice(0, 4))
  const retirementAge = profile.targetRetirementAge
  const yearsToRetirement = Math.max(0, retirementAge - profile.currentAge)
  const retirementYear = asOfYear + yearsToRetirement
  const socialSecurityAge =
    profile.socialSecurityAge ?? POLICY_DEFAULTS.socialSecurityAge
  const separationAge = profile.separationAge ?? retirementAge
  const total = calculatePortfolioValue(portfolio)
  const actualShare = currentEquityShare(portfolio)
  const findings: PolicyFinding[] = []
  const notes: string[] = []

  // 1. Stock share: run the plan at each candidate, long-run and forecast.
  const forecastProfile: UserProfile = {
    ...profile,
    marketAssumptions: { ...profile.marketAssumptions, preset: 'forecast' },
  }
  const candidates = [
    ...new Set(
      [
        ...POLICY_DEFAULTS.equityCandidates,
        ...(current === undefined
          ? []
          : [Math.round(current.targetEquityShare * 100) / 100]),
      ].map(share => Math.round(share * 100) / 100)
    ),
  ].sort((a, b) => a - b)
  const rows: EquityTestRow[] = candidates.map(share => {
    const test = withEquityShare(portfolio, share)
    const successRate = projectRetirement(test, profile, run).monteCarlo
      .successRate
    const forecastSuccessRate = projectRetirement(test, forecastProfile, run)
      .monteCarlo.successRate
    return {
      equityShare: share,
      successRate,
      forecastSuccessRate,
      worse: Math.min(successRate, forecastSuccessRate),
    }
  })
  const best = Math.max(...rows.map(row => row.worse))
  const chosen = rows.find(
    row => row.worse >= best - POLICY_DEFAULTS.tieTolerance
  ) as EquityTestRow
  const proposedShare = chosen.equityShare
  const basis = `highest worse-of-two success rate (long-run and 10-year forecast returns): ${pct(chosen.worse)} at ${pct(proposedShare)} stocks; the lowest share within ${POLICY_DEFAULTS.tieTolerance * 100} point of the best wins`
  if (current === undefined) {
    findings.push({
      rule: 'targetEquityShare',
      status: 'add',
      proposed: proposedShare,
      reason: basis,
    })
  } else {
    const row = rows.find(
      r => r.equityShare === Math.round(current.targetEquityShare * 100) / 100
    )
    const gap = Math.abs(current.targetEquityShare - proposedShare)
    findings.push({
      rule: 'targetEquityShare',
      status: gap >= POLICY_DEFAULTS.changeThreshold ? 'change' : 'keep',
      current: current.targetEquityShare,
      proposed:
        gap >= POLICY_DEFAULTS.changeThreshold
          ? proposedShare
          : current.targetEquityShare,
      reason:
        gap >= POLICY_DEFAULTS.changeThreshold
          ? `${basis}; your ${pct(current.targetEquityShare)} scores ${row === undefined ? 'n/a' : pct(row.worse)}`
          : `your ${pct(current.targetEquityShare)} is within ${POLICY_DEFAULTS.changeThreshold * 100} points of the tested ${pct(proposedShare)}`,
    })
  }
  const targetShare =
    findings[0]?.status === 'keep' && current !== undefined
      ? current.targetEquityShare
      : proposedShare

  const driftBand = current?.driftBand ?? POLICY_DEFAULTS.driftBand
  if (current?.driftBand === undefined)
    findings.push({
      rule: 'driftBand',
      status: 'add',
      proposed: driftBand,
      reason:
        'rebalance only when stocks drift more than 5 points from the target',
    })

  // 2. Ladder: fund the first retirement years, up to the bonds the share leaves.
  const expected = projectRetirement(portfolio, profile, run).expectedPath.years
  const bridge = Math.max(
    1,
    socialSecurityAge - Math.max(retirementAge, profile.currentAge)
  )
  const rungCount = Math.min(POLICY_DEFAULTS.maxRungs, bridge)
  const firstYear = Math.max(retirementYear, asOfYear)
  const valueByType = new Map<AccountType, number>()
  for (const account of portfolio.accounts) {
    if (account.accountType === 'brokerage' || account.accountType === 'nqdc')
      continue
    valueByType.set(
      account.accountType,
      (valueByType.get(account.accountType) ?? 0) + accountTotal(account).value
    )
  }
  const largestType = [...valueByType.entries()].sort(
    (a, b) => b[1] - a[1]
  )[0]?.[0]
  const ladderType = current?.cdLadder?.accountType ?? largestType
  let ladder: PolicyLadder | null = null
  if (ladderType !== undefined) {
    let room = (1 - targetShare) * total
    const rungs: PolicyRung[] = []
    for (let i = 0; i < rungCount; i++) {
      const year = firstYear + i
      const age = profile.currentAge + (year - asOfYear)
      const row = expected.find(y => y.age === age)
      const need =
        row === undefined
          ? 0
          : Math.max(0, row.withdrawals.total - row.withdrawals.nqdc)
      const target = Math.max(0, Math.min(need, room))
      room -= target
      const termYears = Math.max(1, year - asOfYear)
      rungs.push({
        year,
        age,
        termYears,
        need: round2(need),
        target: round2(target),
        buyableNow: termYears <= POLICY_DEFAULTS.maxTermYears,
        penalty: earlyPenaltyAt(ladderType, age, separationAge),
      })
    }
    const needTotal = rungs.reduce((sum, r) => sum + r.need, 0)
    const ladderTotal = unitDown(rungs.reduce((sum, r) => sum + r.target, 0))
    if (ladderTotal > 0) {
      ladder = {
        accountType: ladderType,
        firstYear,
        lastYear: firstYear + rungCount - 1,
        total: ladderTotal,
        needTotal: round2(needTotal),
        rungs,
      }
    }
  }
  const proposedLadder: CdLadderRule | undefined =
    ladder === null
      ? current?.cdLadder
      : {
          accountType: ladder.accountType,
          ...(current?.cdLadder?.accountName === undefined
            ? {}
            : { accountName: current.cdLadder.accountName }),
          firstYear: ladder.firstYear,
          lastYear: ladder.lastYear,
          total: ladder.total,
        }
  if (ladder !== null) {
    const rangeText = `${ladder.firstYear}–${ladder.lastYear}`
    const why = `one rung a year from your retirement in ${retirementYear} through the bridge to Social Security at ${socialSecurityAge} (at most ${POLICY_DEFAULTS.maxRungs}), each sized to that year's expected withdrawals: ${dollars(ladder.needTotal)} needed, ${dollars(ladder.total)} fits in the bonds and cash a ${pct(targetShare)} stock share leaves`
    const ladderRule = current?.cdLadder
    if (ladderRule === undefined) {
      findings.push({
        rule: 'cdLadder',
        status: 'add',
        proposed: proposedLadder,
        reason: why,
      })
    } else if (
      proposedLadder !== undefined &&
      !sameLadder(ladderRule, proposedLadder)
    ) {
      const early =
        ladderRule.lastYear < retirementYear
          ? `your rungs mature ${ladderRule.firstYear}–${ladderRule.lastYear}, before you retire in ${retirementYear}, so they fund no spending and must be reinvested at maturity; `
          : ''
      findings.push({
        rule: 'cdLadder',
        status: 'change',
        current: ladderRule,
        proposed: proposedLadder,
        reason: `${early}proposed ${rangeText}: ${why}`,
      })
    } else {
      findings.push({
        rule: 'cdLadder',
        status: 'keep',
        current: ladderRule,
        reason: why,
      })
    }
    const penalised = ladder.rungs.filter(r => r.penalty)
    if (penalised.length > 0)
      notes.push(
        `rungs at age ${penalised.map(r => r.age).join(', ')} would carry the 10% early-withdrawal penalty from a ${ladder.accountType}: hold them in a taxable account, or leave work in or after the year you turn 55 (Rule of 55)`
      )
    const later = ladder.rungs.filter(r => !r.buyableNow)
    if (later.length > 0)
      notes.push(
        `rungs for ${later.map(r => r.year).join(', ')} are more than ${POLICY_DEFAULTS.maxTermYears} years out: hold their share in short bonds and buy them later`
      )
    const short = ladder.rungs.filter(r => r.target < r.need - 1)
    if (short.length > 0)
      notes.push(
        `the bonds a ${pct(targetShare)} stock share leaves do not fill ${short.map(r => r.year).join(', ')}: the rest of those years comes from selling stocks`
      )
    notes.push(
      "rungs are sized in today's dollars; a CD pays a fixed amount, so later rungs lose about 3% a year to inflation (a TIPS ladder avoids that)"
    )
  }

  // 3. Cash buffer: from one year before retirement.
  const bufferStartAge =
    current?.bufferStartAge ?? Math.max(18, retirementAge - 1)
  const minCashBufferYears =
    current?.minCashBufferYears ?? POLICY_DEFAULTS.cashBufferYears
  if (current?.bufferStartAge === undefined) {
    findings.push({
      rule: 'bufferStartAge',
      status: current === undefined ? 'add' : 'change',
      current: undefined,
      proposed: bufferStartAge,
      reason:
        profile.currentAge < bufferStartAge
          ? `${minCashBufferYears} year of retirement spending in liquid cash is needed from ${bufferStartAge}, a year before you retire; asking for it now ties up cash ${bufferStartAge - profile.currentAge} years early`
          : `hold ${minCashBufferYears} year of spending in liquid cash from now`,
    })
  }

  // 4. Protected accounts: taxable accounts with gains.
  const gains = portfolio.accounts.some(
    a =>
      a.accountType === 'brokerage' &&
      a.holdings.some(h => h.currentValue > h.costBasis + 0.005)
  )
  const protectedTypes: AccountType[] = [
    ...(current?.protectedAccountTypes ?? []),
  ]
  if (gains && !protectedTypes.includes('brokerage')) {
    protectedTypes.push('brokerage')
    findings.push({
      rule: 'protectedAccountTypes',
      status: current === undefined ? 'add' : 'change',
      current: current?.protectedAccountTypes,
      proposed: protectedTypes,
      reason:
        'your taxable account holds gains: rebalance inside tax-advantaged accounts, where a sale costs no tax',
    })
  }

  // 5. Sell schedule: what the proposed share needs beyond the current one.
  const baseRules: PlanRules = {
    ...(current ?? {}),
    targetEquityShare: targetShare,
    driftBand,
    minCashBufferYears,
    bufferStartAge,
    ...(protectedTypes.length > 0
      ? { protectedAccountTypes: protectedTypes }
      : {}),
    ...(proposedLadder === undefined ? {} : { cdLadder: proposedLadder }),
    sellSchedule: [...(current?.sellSchedule ?? [])],
  }
  const check = checkPlan(portfolio, profile, baseRules, asOfDate)
  let sellSchedule: ScheduledSale[] = [...(baseRules.sellSchedule ?? [])]
  const rebalance = check.recommendations.find(r => r.kind === 'rebalance_sell')
  const trade = rebalance?.trades[0]
  if (
    rebalance !== undefined &&
    trade !== undefined &&
    rebalance.amount >= POLICY_DEFAULTS.unit
  ) {
    const amount = unitDown(rebalance.amount)
    const chunks =
      amount >= POLICY_DEFAULTS.saleChunks * POLICY_DEFAULTS.unit
        ? POLICY_DEFAULTS.saleChunks
        : 1
    const each = unitDown(amount / chunks)
    const dates = nextFifteenths(asOfDate, chunks)
    const added: ScheduledSale[] = dates.map((dueDate, i) => ({
      id: `policy-${trade.symbol.toLowerCase()}-${dueDate}`,
      dueDate,
      symbol: trade.symbol,
      amount: i === chunks - 1 ? amount - each * (chunks - 1) : each,
      accountType: trade.accountType,
    }))
    sellSchedule = [...sellSchedule, ...added]
    findings.push({
      rule: 'sellSchedule',
      status: 'add',
      proposed: added,
      reason: `stocks stay above ${pct(targetShare)} ± ${pct(driftBand)} after your scheduled sales: sell ${dollars(amount)} more of ${trade.symbol} in ${trade.accountName}, in ${chunks} monthly ${chunks === 1 ? 'sale' : 'sales'}`,
    })
  } else {
    // Scheduled sales that would take stocks well below the proposed share.
    const undone = (current?.sellSchedule ?? []).filter(s => s.done !== true)
    const undoneTotal = undone.reduce((sum, s) => sum + s.amount, 0)
    const after = check.measures.equityValue - undoneTotal
    const overshoot = targetShare * check.measures.totalValue - after
    if (undone.length > 0 && overshoot > 0.02 * check.measures.totalValue) {
      let trim = unitDown(overshoot)
      const trimmed = [...sellSchedule]
      for (let i = trimmed.length - 1; i >= 0 && trim > 0; i--) {
        const sale = trimmed[i] as ScheduledSale
        if (sale.done === true) continue
        const cut = Math.min(trim, sale.amount)
        trim -= cut
        trimmed[i] = { ...sale, amount: sale.amount - cut }
      }
      sellSchedule = trimmed.filter(s => s.amount > 0)
      findings.push({
        rule: 'sellSchedule',
        status: 'change',
        current: undone,
        proposed: sellSchedule.filter(s => s.done !== true),
        reason: `your scheduled sales would take stocks to ${pct(after / check.measures.totalValue)}, below the ${pct(targetShare)} target: cut the last ${dollars(unitDown(overshoot))}`,
      })
    } else if (undone.length > 0) {
      findings.push({
        rule: 'sellSchedule',
        status: 'keep',
        current: undone,
        reason: `your scheduled sales bring stocks to within ${pct(driftBand)} of ${pct(targetShare)}`,
      })
    }
  }

  // 6. Inputs only the owner has.
  if (current?.outsideCash === undefined)
    findings.push({
      rule: 'outsideCash',
      status: 'needs_input',
      reason:
        'bank savings outside the snapshot: give the total so the cash buffer counts it',
    })

  const proposedRules: PlanRules = { ...baseRules, sellSchedule }
  if (sellSchedule.length === 0)
    delete (proposedRules as { sellSchedule?: unknown }).sellSchedule
  return {
    asOfDate,
    snapshotDate: portfolio.asOfDate,
    retirementAge,
    retirementYear,
    yearsToRetirement,
    socialSecurityAge,
    currentEquityShare: Math.round(actualShare * 10_000) / 10_000,
    equityTest: { rows, proposed: proposedShare, basis },
    ladder,
    findings,
    changes: findings.filter(f => f.status === 'change' || f.status === 'add')
      .length,
    proposedRules,
    notes,
  }
}
