// Plan check (REQ-MCP-47): measures the newest snapshot against the owner's
// own rules (target stock share, drift band, cash buffer, sell schedule,
// accounts never to sell from) and returns ranked recommendations for the
// owner to review. Deterministic: the as-of date is an input, never the clock.
// Nothing here trades; the owner places every order.
import { CdLadderError, planCdLadder, type CdLadderPlan } from './cd-ladder'
import { baseExpensesAt, isLiquidAccount } from './portfolio-math'
import type {
  Account,
  AccountType,
  Holding,
  PlanRules,
  Portfolio,
  RateQuote,
  ScheduledSale,
  UserProfile,
} from './types'

export const PLAN_CHECK_DEFAULTS = {
  driftBand: 0.05,
  minCashBufferYears: 1,
  /** A snapshot older than this many days is flagged for a re-import. */
  staleSnapshotDays: 35,
  /** Tax rate on taxable-account gains when the profile has no federalTaxBracket (as trade_plan). */
  taxableGainRate: 0.22,
} as const

export type PlanStatus = 'on_plan' | 'on_schedule' | 'action_needed'

export type ScheduleStatus = 'done' | 'overdue' | 'due_today' | 'upcoming'

export interface ScheduleItem {
  readonly id: string
  readonly dueDate: string
  readonly symbol: string
  readonly amount: number
  readonly accountType?: AccountType
  readonly status: ScheduleStatus
  /** Days past dueDate; 0 when not overdue. */
  readonly daysOverdue: number
}

export interface TaskItem {
  readonly id: string
  readonly dueDate: string
  readonly action: string
  readonly status: ScheduleStatus
  /** Days past dueDate; 0 when not overdue. */
  readonly daysOverdue: number
}

/** Days ahead that an upcoming task is listed as due soon (REQ-MCP-61). */
export const TASK_DUE_SOON_DAYS = 7

export interface RecommendedTrade {
  readonly action: 'sell' | 'buy'
  readonly symbol: string
  readonly accountName: string
  readonly accountType: AccountType
  readonly amount: number
  readonly estimatedTax: number
}

export type RecommendationKind =
  | 'refresh_snapshot'
  | 'scheduled_sale'
  | 'task'
  | 'rebalance_sell'
  | 'rebalance_buy'
  | 'cash_buffer'
  | 'cd_ladder'

export interface Recommendation {
  readonly priority: number
  readonly kind: RecommendationKind
  /** One line the agent relays as written. */
  readonly action: string
  readonly amount: number
  readonly trades: readonly RecommendedTrade[]
  readonly reason: string
}

export interface PlanCheckMeasures {
  readonly totalValue: number
  readonly equityValue: number
  readonly equityShare: number
  readonly targetEquityShare: number
  readonly driftBand: number
  /** equityShare − targetEquityShare. */
  readonly drift: number
  /** Stock dollars above target (negative: below). */
  readonly excessEquity: number
  /** Liquid cash: taxable accounts plus planRules.outsideCash (REQ-MCP-62). */
  readonly cashBuffer: number
  /** Cash, CDs and buffer funds inside retirement accounts: not liquid, not in cashBuffer. */
  readonly retirementAccountCash: number
  /** Cash held outside the snapshot, from planRules.outsideCash. */
  readonly outsideCash: number
  readonly annualSpending: number
  readonly cashBufferYears: number
  readonly minCashBufferYears: number
  /** Stock share after the recommended trades. */
  readonly equityShareAfter: number
  readonly cashBufferYearsAfter: number
}

export interface PlanCheckResult {
  readonly asOfDate: string
  readonly snapshotDate: string
  readonly snapshotAgeDays: number
  readonly status: PlanStatus
  /** One line: the status and the top recommendation. */
  readonly headline: string
  readonly measures: PlanCheckMeasures
  readonly schedule: readonly ScheduleItem[]
  /** The owner's one-off tasks with their status (REQ-MCP-61). */
  readonly tasks: readonly TaskItem[]
  readonly nextScheduledSale: ScheduleItem | null
  readonly recommendations: readonly Recommendation[]
  /** The CD or Treasury ladder from planRules.cdLadder, or null (REQ-MCP-63). */
  readonly cdLadder: CdLadderPlan | null
  readonly rules: Required<
    Pick<PlanRules, 'targetEquityShare' | 'driftBand' | 'minCashBufferYears'>
  > & {
    readonly protectedAccountTypes: readonly AccountType[]
    readonly bufferSymbols: readonly string[]
  }
}

export class PlanCheckError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
  }
}

const DAY_MS = 86_400_000

function dayNumber(isoDate: string, field: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (match === null) throw new PlanCheckError(field, 'must be YYYY-MM-DD')
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const ms = Date.UTC(y, m - 1, d)
  const back = new Date(ms)
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== m - 1 ||
    back.getUTCDate() !== d
  ) {
    throw new PlanCheckError(field, 'is not a calendar date')
  }
  return Math.round(ms / DAY_MS)
}

function isEquity(holding: Holding): boolean {
  return (
    holding.assetClass === 'us_equity' ||
    holding.assetClass === 'intl_equity' ||
    holding.assetClass === 'emerging_equity'
  )
}

function isCashLike(
  holding: Holding,
  bufferSymbols: ReadonlySet<string>
): boolean {
  return (
    holding.assetClass === 'cash' ||
    holding.assetClass === 'money_market' ||
    holding.assetClass === 'cd' ||
    bufferSymbols.has(holding.symbol.toUpperCase())
  )
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function dollars(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

function validateRules(rules: PlanRules): void {
  const share = rules.targetEquityShare
  if (!Number.isFinite(share) || share < 0 || share > 1)
    throw new PlanCheckError(
      'planRules.targetEquityShare',
      'must be from 0 to 1'
    )
  const band = rules.driftBand
  if (band !== undefined && (!Number.isFinite(band) || band < 0 || band > 0.5))
    throw new PlanCheckError('planRules.driftBand', 'must be from 0 to 0.5')
  const years = rules.minCashBufferYears
  if (
    years !== undefined &&
    (!Number.isFinite(years) || years < 0 || years > 10)
  )
    throw new PlanCheckError(
      'planRules.minCashBufferYears',
      'must be from 0 to 10'
    )
  const ids = new Set<string>()
  for (const [index, sale] of (rules.sellSchedule ?? []).entries()) {
    const field = `planRules.sellSchedule.${index}`
    dayNumber(sale.dueDate, `${field}.dueDate`)
    if (!Number.isFinite(sale.amount) || sale.amount <= 0)
      throw new PlanCheckError(`${field}.amount`, 'must be above 0')
    if (ids.has(sale.id))
      throw new PlanCheckError(`${field}.id`, `"${sale.id}" is used twice`)
    ids.add(sale.id)
  }
  const taskIds = new Set<string>()
  for (const [index, task] of (rules.tasks ?? []).entries()) {
    const field = `planRules.tasks.${index}`
    dayNumber(task.dueDate, `${field}.dueDate`)
    if (task.action.trim() === '')
      throw new PlanCheckError(`${field}.action`, 'must not be empty')
    if (taskIds.has(task.id))
      throw new PlanCheckError(`${field}.id`, `"${task.id}" is used twice`)
    taskIds.add(task.id)
  }
}

interface Lot {
  readonly account: Account
  readonly holding: Holding
  remaining: number
}

/** The lots a sale may come from: unprotected accounts, tax-advantaged first, larger first. */
function saleLots(
  portfolio: Portfolio,
  protectedTypes: ReadonlySet<AccountType>,
  match: (account: Account, holding: Holding) => boolean
): Lot[] {
  const lots: Lot[] = []
  for (const account of portfolio.accounts) {
    if (protectedTypes.has(account.accountType)) continue
    for (const holding of account.holdings) {
      if (holding.currentValue > 0 && match(account, holding)) {
        lots.push({ account, holding, remaining: holding.currentValue })
      }
    }
  }
  const taxable = (lot: Lot) =>
    lot.account.accountType === 'brokerage' ? 1 : 0
  return lots.sort(
    (a, b) =>
      taxable(a) - taxable(b) ||
      b.remaining - a.remaining ||
      a.account.id.localeCompare(b.account.id) ||
      a.holding.id.localeCompare(b.holding.id)
  )
}

function takeFromLots(
  lots: Lot[],
  amount: number,
  gainRate: number
): { trades: RecommendedTrade[]; filled: number } {
  const trades: RecommendedTrade[] = []
  let left = amount
  for (const lot of lots) {
    if (left <= 0.005) break
    const take = Math.min(left, lot.remaining)
    if (take <= 0) continue
    lot.remaining -= take
    left -= take
    const gainShare =
      lot.holding.currentValue > 0
        ? Math.max(0, 1 - lot.holding.costBasis / lot.holding.currentValue)
        : 0
    trades.push({
      action: 'sell',
      symbol: lot.holding.symbol,
      accountName: lot.account.name,
      accountType: lot.account.accountType,
      amount: round2(take),
      estimatedTax:
        lot.account.accountType === 'brokerage'
          ? round2(take * gainShare * gainRate)
          : 0,
    })
  }
  return { trades, filled: round2(amount - Math.max(0, left)) }
}

function taxNote(trades: readonly RecommendedTrade[]): string {
  const tax = trades.reduce((sum, trade) => sum + trade.estimatedTax, 0)
  return tax > 0
    ? `estimated tax ${dollars(tax)}`
    : 'no tax (inside tax-advantaged accounts)'
}

function where(trades: readonly RecommendedTrade[]): string {
  const names = [...new Set(trades.map(trade => trade.accountName))]
  return names.join(' + ')
}

/**
 * Measures the portfolio against the owner's rules on asOfDate and returns
 * the status and recommendations, most urgent first.
 */
export function checkPlan(
  portfolio: Portfolio,
  profile: UserProfile,
  rules: PlanRules,
  asOfDate: string,
  rateQuotes: readonly RateQuote[] = []
): PlanCheckResult {
  validateRules(rules)
  const today = dayNumber(asOfDate, 'asOfDate')
  const snapshotDay = dayNumber(portfolio.asOfDate, 'portfolio.asOfDate')
  const snapshotAgeDays = today - snapshotDay
  if (snapshotAgeDays < 0)
    throw new PlanCheckError('asOfDate', 'is before the snapshot date')

  const driftBand = rules.driftBand ?? PLAN_CHECK_DEFAULTS.driftBand
  const minCashBufferYears =
    rules.minCashBufferYears ?? PLAN_CHECK_DEFAULTS.minCashBufferYears
  const protectedAccountTypes = [
    ...new Set(rules.protectedAccountTypes ?? []),
  ].sort()
  const protectedTypes = new Set<AccountType>(protectedAccountTypes)
  const bufferSymbols = [
    ...new Set((rules.bufferSymbols ?? []).map(symbol => symbol.toUpperCase())),
  ].sort()
  const bufferSet = new Set(bufferSymbols)
  const gainRate =
    profile.federalTaxBracket ?? PLAN_CHECK_DEFAULTS.taxableGainRate
  // One pool of sellable lots, shared by every sale below so a dollar is never sold twice.
  const pool = saleLots(portfolio, protectedTypes, () => true)

  let totalValue = 0
  let equityValue = 0
  // REQ-MCP-62: liquid cash (taxable accounts plus cash held outside the
  // snapshot) is the buffer; cash-like money in retirement accounts is
  // reported apart and never counts toward it.
  const outsideCash = Math.max(0, rules.outsideCash ?? 0)
  let liquidCash = 0
  let retirementAccountCash = 0
  for (const account of portfolio.accounts) {
    const liquid = isLiquidAccount(account.accountType)
    let cashLike = account.cashBalance
    totalValue += account.cashBalance
    for (const holding of account.holdings) {
      totalValue += holding.currentValue
      if (isEquity(holding)) equityValue += holding.currentValue
      else if (isCashLike(holding, bufferSet)) cashLike += holding.currentValue
    }
    for (const cd of account.cds) {
      totalValue += cd.principal
      cashLike += cd.principal
    }
    if (liquid) liquidCash += cashLike
    else retirementAccountCash += cashLike
  }
  // Sales marked done on or after the snapshot date have happened: take them
  // off the stock lots and count the proceeds as cash where they landed, so
  // nothing below sells or counts the same dollars twice.
  const doneProceeds: { accountName: string; amount: number }[] = []
  for (const sale of rules.sellSchedule ?? []) {
    if (sale.done !== true) continue
    if (dayNumber(sale.dueDate, 'dueDate') < snapshotDay) continue
    let left = sale.amount
    for (const lot of pool) {
      if (left <= 0.005) break
      if (!isEquity(lot.holding)) continue
      if (lot.holding.symbol.toUpperCase() !== sale.symbol.toUpperCase())
        continue
      if (
        sale.accountType !== undefined &&
        lot.account.accountType !== sale.accountType
      )
        continue
      const take = Math.min(left, lot.remaining)
      if (take <= 0) continue
      lot.remaining -= take
      left -= take
      equityValue -= take
      if (isLiquidAccount(lot.account.accountType)) liquidCash += take
      else retirementAccountCash += take
      doneProceeds.push({ accountName: lot.account.name, amount: take })
    }
  }
  const cashBuffer = liquidCash + outsideCash
  if (totalValue <= 0)
    throw new PlanCheckError('portfolio', 'has no value to measure')

  const target = rules.targetEquityShare
  const equityShare = equityValue / totalValue
  const drift = equityShare - target
  const excessEquity = equityValue - target * totalValue
  const annualSpending = baseExpensesAt(profile, profile.targetRetirementAge)
  const yearsOf = (cash: number) =>
    annualSpending > 0 ? cash / annualSpending : 0

  const schedule: ScheduleItem[] = [...(rules.sellSchedule ?? [])]
    .sort(
      (a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id)
    )
    .map((sale: ScheduledSale) => {
      const due = dayNumber(sale.dueDate, 'dueDate')
      const status: ScheduleStatus =
        sale.done === true
          ? 'done'
          : due < today
            ? 'overdue'
            : due === today
              ? 'due_today'
              : 'upcoming'
      return {
        id: sale.id,
        dueDate: sale.dueDate,
        symbol: sale.symbol.toUpperCase(),
        amount: sale.amount,
        ...(sale.accountType === undefined
          ? {}
          : { accountType: sale.accountType }),
        status,
        daysOverdue: status === 'overdue' ? today - due : 0,
      }
    })

  const tasks: TaskItem[] = [...(rules.tasks ?? [])]
    .sort(
      (a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id)
    )
    .map(task => {
      const due = dayNumber(task.dueDate, 'dueDate')
      const status: ScheduleStatus =
        task.done === true
          ? 'done'
          : due < today
            ? 'overdue'
            : due === today
              ? 'due_today'
              : 'upcoming'
      return {
        id: task.id,
        dueDate: task.dueDate,
        action: task.action.trim(),
        status,
        daysOverdue: status === 'overdue' ? today - due : 0,
      }
    })

  const recommendations: Omit<Recommendation, 'priority'>[] = []

  const doneAfterSnapshot = (rules.sellSchedule ?? []).some(
    sale =>
      sale.done === true && dayNumber(sale.dueDate, 'dueDate') >= snapshotDay
  )
  if (
    snapshotAgeDays > PLAN_CHECK_DEFAULTS.staleSnapshotDays ||
    doneAfterSnapshot
  ) {
    recommendations.push({
      kind: 'refresh_snapshot',
      action:
        'Re-import your positions (import_positions with save: true) before acting.',
      amount: 0,
      trades: [],
      reason: doneAfterSnapshot
        ? `the snapshot (${portfolio.asOfDate}) predates sales marked done, so the figures below still count them as stocks`
        : `the snapshot is ${snapshotAgeDays} days old (more than ${PLAN_CHECK_DEFAULTS.staleSnapshotDays})`,
    })
  }

  // Sales: the due and overdue chunks of the schedule, each capped at the
  // stock dollars still above target; without a schedule, the excess itself
  // once the share is outside the band.
  let remainingExcess = Math.max(0, excessEquity)
  let sold = 0
  // Sale proceeds that land in a liquid account (REQ-MCP-62).
  let soldLiquid = 0
  const liquidPart = (trades: readonly RecommendedTrade[]) =>
    trades
      .filter(trade => isLiquidAccount(trade.accountType))
      .reduce((sum, trade) => sum + trade.amount - trade.estimatedTax, 0)
  // Only stock holdings: a chunk is counted as stock sold.
  const stockLotsFor = (item: ScheduleItem): Lot[] =>
    pool.filter(
      lot =>
        isEquity(lot.holding) &&
        lot.holding.symbol.toUpperCase() === item.symbol &&
        (item.accountType === undefined ||
          lot.account.accountType === item.accountType)
    )
  const due = schedule.filter(
    item => item.status === 'overdue' || item.status === 'due_today'
  )
  for (const item of due) {
    const amount = Math.min(item.amount, remainingExcess)
    if (amount <= 0.005) {
      recommendations.push({
        kind: 'scheduled_sale',
        action: `Skip ${item.id}: stocks are already at or below your ${percent(target)} target.`,
        amount: 0,
        trades: [],
        reason: `stocks are ${percent(equityShare)} of the portfolio`,
      })
      continue
    }
    const { trades, filled } = takeFromLots(
      stockLotsFor(item),
      amount,
      gainRate
    )
    if (filled <= 0.005) {
      recommendations.push({
        kind: 'scheduled_sale',
        action: `${item.id}: no ${item.symbol} stock holding found in an account you allow sales from; check the schedule.`,
        amount: 0,
        trades: [],
        reason: `the snapshot has no ${item.symbol} stock holding${item.accountType === undefined ? '' : ` in a ${item.accountType} account`} outside your protected accounts`,
      })
      continue
    }
    remainingExcess -= filled
    sold += filled
    soldLiquid += liquidPart(trades)
    const late =
      item.status === 'overdue'
        ? `${item.daysOverdue} day${item.daysOverdue === 1 ? '' : 's'} overdue`
        : 'due today'
    recommendations.push({
      kind: 'scheduled_sale',
      action: `Sell ${dollars(filled)} ${item.symbol} in ${where(trades)}, into cash or your CD rungs (${item.id}, ${late}).`,
      amount: filled,
      trades,
      reason: `your schedule; stocks ${percent(equityShare)} vs ${percent(target)} target; ${taxNote(trades)}${filled < item.amount - 0.005 ? `; capped at the ${dollars(filled)} still above target` : ''}`,
    })
  }

  const upcoming = schedule.filter(item => item.status === 'upcoming')
  // What each upcoming chunk can still sell of the stock lots it names.
  const reserved = new Map<Lot, number>()
  const upcomingStock = upcoming.map(item => {
    let left = item.amount
    const byAccount: { accountName: string; amount: number }[] = []
    for (const lot of stockLotsFor(item)) {
      const free = lot.remaining - (reserved.get(lot) ?? 0)
      const take = Math.min(left, Math.max(0, free))
      reserved.set(lot, (reserved.get(lot) ?? 0) + take)
      left -= take
      if (take > 0)
        byAccount.push({ accountName: lot.account.name, amount: take })
    }
    return { item, amount: item.amount - left, byAccount }
  })
  const upcomingCovered = upcomingStock.filter(u => u.amount > 0.005)
  const upcomingTotal = upcomingCovered.reduce((sum, u) => sum + u.amount, 0)
  const shareAfterSales = (equityValue - sold) / totalValue
  // Still outside the band once every upcoming chunk is sold too: sell the rest now.
  const shareAfterSchedule = (equityValue - sold - upcomingTotal) / totalValue
  if (shareAfterSchedule > target + driftBand + 1e-9) {
    const amount = remainingExcess - upcomingTotal
    const lots = pool.filter(lot => isEquity(lot.holding))
    const { trades, filled } = takeFromLots(lots, amount, gainRate)
    if (filled > 0.005) {
      sold += filled
      soldLiquid += liquidPart(trades)
      recommendations.push({
        kind: 'rebalance_sell',
        action: `Sell ${dollars(filled)} of stocks (${[...new Set(trades.map(trade => trade.symbol))].join(', ')}) in ${where(trades)}, into cash or bonds.`,
        amount: filled,
        trades,
        reason: `stocks ${percent(shareAfterSales)} are outside your ${percent(target)} ± ${percent(driftBand)} band${upcomingCovered.length > 0 ? ' even after the scheduled sales' : ''}; ${taxNote(trades)}`,
      })
    }
  }

  if (equityShare < target - driftBand - 1e-9) {
    const amount = -excessEquity
    recommendations.push({
      kind: 'rebalance_buy',
      action: `Buy ${dollars(amount)} of stocks to get back to your ${percent(target)} target.`,
      amount: round2(amount),
      trades: [],
      reason: `stocks ${percent(equityShare)} are below your ${percent(target)} − ${percent(driftBand)} band`,
    })
  }

  const cashAfter = cashBuffer + soldLiquid
  if (yearsOf(cashAfter) < minCashBufferYears - 1e-9) {
    const short = minCashBufferYears * annualSpending - cashAfter
    const inRetirement =
      retirementAccountCash > 0.005
        ? `; ${dollars(retirementAccountCash)} more in cash, CDs and ladder funds inside retirement accounts does not count (taxed, and before 59½ penalised, when taken out)`
        : ''
    recommendations.push({
      kind: 'cash_buffer',
      action: `Build ${dollars(short)} of liquid cash outside retirement accounts (savings, money market or Treasuries in a taxable account).`,
      amount: round2(short),
      trades: [],
      reason: `${yearsOf(cashAfter).toFixed(1)} years of retirement spending (${dollars(annualSpending)}/yr) in liquid cash${outsideCash > 0 ? `, including ${dollars(outsideCash)} held outside the snapshot` : ''}${soldLiquid > 0 ? ' after the sales above' : ''}, vs your ${minCashBufferYears}-year minimum${inRetirement}`,
    })
  }

  // REQ-MCP-63: place cash that is ready now in the ladder's short rungs.
  let cdLadder: CdLadderPlan | null = null
  const ladderRule = rules.cdLadder
  if (ladderRule !== undefined) {
    const proceedsNow = [
      ...doneProceeds,
      ...recommendations
        .filter(
          rec => rec.kind === 'scheduled_sale' || rec.kind === 'rebalance_sell'
        )
        .flatMap(rec => rec.trades)
        .map(trade => ({
          accountName: trade.accountName,
          amount: trade.amount - trade.estimatedTax,
        })),
    ]
    const proceedsLater = upcomingCovered.flatMap(u => u.byAccount)
    try {
      cdLadder = planCdLadder(portfolio, ladderRule, {
        asOfDate,
        saleProceedsNow: proceedsNow,
        saleProceedsLater: proceedsLater,
        quotes: rateQuotes,
      })
    } catch (error) {
      if (error instanceof CdLadderError)
        throw new PlanCheckError(error.field, error.message)
      throw error
    }
    if (cdLadder !== null && cdLadder.buyNowTotal > 0) {
      const plan = cdLadder
      const buys = plan.rungs.filter(rung => rung.buyNow > 0)
      const accountName = plan.accountName ?? plan.accountType
      const label = (rung: (typeof buys)[number]) =>
        rung.quote === null
          ? `${rung.year} ${dollars(rung.buyNow)} (${rung.termYears}-yr, no quote)`
          : `${rung.year} ${dollars(rung.buyNow)} (${rung.termYears}-yr ${rung.quote.kind === 'cd' ? 'call-protected CD' : 'Treasury'} ${(rung.quote.apy * 100).toFixed(2)}%)`
      const sources = [
        ...new Set(
          buys.flatMap(rung =>
            rung.quote === null
              ? []
              : [`${rung.quote.source}, ${rung.quote.quotedOn}`]
          )
        ),
      ]
      recommendations.push({
        kind: 'cd_ladder',
        action: `Buy ${dollars(plan.buyNowTotal)} for your ${plan.firstYear}–${plan.lastYear} ladder in ${accountName}: ${buys.map(label).join('; ')}.`,
        amount: plan.buyNowTotal,
        trades: buys.map(rung => ({
          action: 'buy' as const,
          symbol: `${rung.quote?.kind === 'treasury' ? 'TREASURY' : 'CD'} ${rung.year}`,
          accountName,
          accountType: plan.accountType,
          amount: rung.buyNow,
          estimatedTax: 0,
        })),
        reason: `${dollars(plan.fundingNow)} ready in ${plan.accountType} (idle cash ${dollars(plan.idleCash)}${plan.fundingNow - plan.idleCash > 0.005 ? ` plus ${dollars(plan.fundingNow - plan.idleCash)} of sale proceeds` : ''}); each rung's target is ${dollars(plan.rungTarget)} of the ${dollars(plan.total)} ladder, earliest short rung first${sources.length > 0 ? `; quotes: ${sources.join('; ')}` : ''}${plan.notes.length > 0 ? `; ${plan.notes.join('; ')}` : ''}`,
      })
    }
  }

  // REQ-MCP-61: overdue and due tasks, then tasks due within a week.
  const dueTaskActions = new Set<string>()
  for (const task of tasks) {
    if (task.status === 'done') continue
    const daysAhead = dayNumber(task.dueDate, 'dueDate') - today
    if (task.status === 'upcoming' && daysAhead > TASK_DUE_SOON_DAYS) continue
    const when =
      task.status === 'overdue'
        ? `${task.daysOverdue} day${task.daysOverdue === 1 ? '' : 's'} overdue`
        : task.status === 'due_today'
          ? 'due today'
          : `due ${task.dueDate}`
    const action = `${task.action} (${task.id}, ${when}).`
    if (task.status !== 'upcoming') dueTaskActions.add(action)
    recommendations.push({
      kind: 'task',
      action,
      amount: 0,
      trades: [],
      reason: 'your task list',
    })
  }

  const order: Record<RecommendationKind, number> = {
    refresh_snapshot: 0,
    scheduled_sale: 1,
    task: 1,
    rebalance_sell: 2,
    rebalance_buy: 2,
    cd_ladder: 2,
    cash_buffer: 3,
  }
  const ranked = recommendations
    .map((rec, index) => ({ rec, index }))
    .sort((a, b) => order[a.rec.kind] - order[b.rec.kind] || a.index - b.index)
    .map(({ rec }, index) => ({ priority: index + 1, ...rec }))

  const isDueTask = (rec: Recommendation) =>
    rec.kind === 'task' && dueTaskActions.has(rec.action)
  const acting = ranked.some(
    rec => (rec.amount > 0 && rec.kind !== 'refresh_snapshot') || isDueTask(rec)
  )
  const status: PlanStatus = acting
    ? 'action_needed'
    : Math.abs(drift) > driftBand + 1e-9 && upcomingCovered.length > 0
      ? 'on_schedule'
      : 'on_plan'
  const nextScheduledSale = upcoming[0] ?? null
  const nextStockSale = upcomingCovered[0]?.item
  const top = ranked.find(rec => rec.amount > 0 || isDueTask(rec)) ?? ranked[0]
  const headline =
    status === 'action_needed' && top !== undefined
      ? `Action needed: ${top.action}`
      : status === 'on_schedule' && nextStockSale !== undefined
        ? `On schedule: next sale ${nextStockSale.id} (${dollars(nextStockSale.amount)} ${nextStockSale.symbol}) on ${nextStockSale.dueDate}.`
        : `On plan: stocks ${percent(equityShare)} vs ${percent(target)} target.`

  return {
    asOfDate,
    snapshotDate: portfolio.asOfDate,
    snapshotAgeDays,
    status,
    headline,
    measures: {
      totalValue: round2(totalValue),
      equityValue: round2(equityValue),
      equityShare,
      targetEquityShare: target,
      driftBand,
      drift,
      excessEquity: round2(excessEquity),
      cashBuffer: round2(cashBuffer),
      retirementAccountCash: round2(retirementAccountCash),
      outsideCash: round2(outsideCash),
      annualSpending,
      cashBufferYears: yearsOf(cashBuffer),
      minCashBufferYears,
      equityShareAfter: (equityValue - sold) / totalValue,
      cashBufferYearsAfter: yearsOf(cashAfter),
    },
    schedule,
    tasks,
    nextScheduledSale,
    recommendations: ranked,
    cdLadder,
    rules: {
      targetEquityShare: target,
      driftBand,
      minCashBufferYears,
      protectedAccountTypes,
      bufferSymbols,
    },
  }
}
