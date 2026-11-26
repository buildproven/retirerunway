// CD and Treasury ladder (REQ-MCP-63): splits the owner's ladder into one rung
// per maturity year, counts what each rung already holds (CDs, CD holdings with
// a maturity date in the name, iShares iBonds Treasury ETFs), and places the
// cash that is ready now in the earliest rungs that are short, in $1,000 units,
// at the best call-protected quote for each term. Deterministic: quotes and the
// as-of date are inputs; nothing here fetches rates or trades.
import { INDIVIDUAL_SECURITY } from './csv-parser'
import type {
  Account,
  AccountType,
  CdLadderRule,
  Portfolio,
  RateQuote,
} from './types'

/** FDIC insurance per bank, per ownership category. */
export const FDIC_LIMIT = 250_000
/** Brokered CDs and Treasuries are bought in $1,000 units. */
export const LADDER_UNIT = 1_000
/** A quote older than this many days is flagged to re-check before buying. */
export const QUOTE_STALE_DAYS = 7

/** iShares iBonds Dec 20xx Term Treasury ETFs and the year each matures. */
export const IBONDS_TREASURY_YEARS: Readonly<Record<string, number>> = {
  IBTF: 2025,
  IBTG: 2026,
  IBTH: 2027,
  IBTI: 2028,
  IBTJ: 2029,
  IBTK: 2030,
  IBTL: 2031,
  IBTM: 2032,
  IBTO: 2033,
  IBTP: 2034,
}

export class CdLadderError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
  }
}

export interface LadderHolding {
  readonly symbol: string
  readonly name: string
  readonly year: number
  readonly amount: number
}

export interface LadderQuote {
  readonly kind: 'cd' | 'treasury'
  readonly termYears: number
  readonly apy: number
  readonly source: string
  readonly quotedOn: string
  /** True when quotedOn is more than QUOTE_STALE_DAYS before the as-of date. */
  readonly stale: boolean
}

export interface LadderRung {
  readonly year: number
  /** Whole years from the as-of year to the rung (at least 1): the term to buy. */
  readonly termYears: number
  readonly target: number
  /** Already held for this year. */
  readonly existing: number
  readonly shortfall: number
  /** To buy now, in $1,000 units. */
  readonly buyNow: number
  /** The best call-protected CD or Treasury quote for the term, or null. */
  readonly quote: LadderQuote | null
  /** buyNow × quote APY: interest a year, paid out, not compounded. */
  readonly annualInterest: number
  readonly note?: string
}

export interface CdLadderPlan {
  readonly accountType: AccountType
  /** The one account the rungs are bought in, or null when the snapshot has none of the type. */
  readonly accountName: string | null
  readonly firstYear: number
  readonly lastYear: number
  readonly total: number
  readonly rungTarget: number
  /** Idle cash in the account type plus sale proceeds ready now. */
  readonly fundingNow: number
  /** Upcoming sale proceeds and holdings that mature into the ladder later. */
  readonly fundingLater: number
  readonly idleCash: number
  readonly heldInLadder: readonly LadderHolding[]
  /** Holdings that mature before firstYear; their payout funds later rungs. */
  readonly rollingIn: readonly LadderHolding[]
  /** CD holdings in the account type whose maturity year could not be read. */
  readonly unknownMaturity: readonly LadderHolding[]
  readonly rungs: readonly LadderRung[]
  readonly buyNowTotal: number
  /** Cash ready now that no rung needs (or under $1,000 per rung). */
  readonly unplaced: number
  readonly skippedCallableQuotes: number
  readonly notes: readonly string[]
}

export interface SaleProceeds {
  readonly accountName: string
  readonly amount: number
}

export interface LadderInputs {
  readonly asOfDate: string
  /** Sale proceeds landing now, by account (done after the snapshot, or due). */
  readonly saleProceedsNow: readonly SaleProceeds[]
  /** Upcoming scheduled sale proceeds, by account. */
  readonly saleProceedsLater: readonly SaleProceeds[]
  readonly quotes?: readonly RateQuote[]
  /**
   * REQ-MCP-76: each year's target, overriding the even split (a safe
   * ladder's rung costs). Years not in the map keep the even split.
   */
  readonly rungTargets?: ReadonlyMap<number, number>
  /** True for Treasury-backed rungs (TIPS): no per-bank FDIC split. */
  readonly noIssuerLimit?: boolean
}

const DAY_MS = 86_400_000

function dayNumber(isoDate: string, field: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (match === null) throw new CdLadderError(field, 'must be YYYY-MM-DD')
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Math.round(ms / DAY_MS)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** The maturity year in a CD's description: "… 4.8% 12/15/2027 …" or "2027-12-15". */
export function maturityYearFromName(name: string): number | undefined {
  const us = /\b\d{1,2}\/\d{1,2}\/(\d{4})\b/.exec(name)
  if (us !== null) return Number(us[1])
  const iso = /\b(\d{4})-\d{2}-\d{2}\b/.exec(name)
  if (iso !== null) return Number(iso[1])
  return undefined
}

export function validateLadder(rule: CdLadderRule): void {
  const field = 'planRules.cdLadder'
  for (const key of ['firstYear', 'lastYear'] as const) {
    const year = rule[key]
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      throw new CdLadderError(
        `${field}.${key}`,
        'must be a year from 2000 to 2100'
      )
  }
  if (rule.lastYear < rule.firstYear)
    throw new CdLadderError(`${field}.lastYear`, 'must not be before firstYear')
  if (rule.lastYear - rule.firstYear > 29)
    throw new CdLadderError(
      `${field}.lastYear`,
      'must be within 30 years of firstYear'
    )
  if (
    rule.total !== undefined &&
    !(Number.isFinite(rule.total) && rule.total >= 0)
  )
    throw new CdLadderError(`${field}.total`, 'must be 0 or more')
  if (
    rule.maxPerIssuer !== undefined &&
    !(Number.isFinite(rule.maxPerIssuer) && rule.maxPerIssuer >= LADDER_UNIT)
  )
    throw new CdLadderError(
      `${field}.maxPerIssuer`,
      `must be at least ${LADDER_UNIT}`
    )
}

function validateQuotes(quotes: readonly RateQuote[]): void {
  for (const [index, quote] of quotes.entries()) {
    const field = `rateQuotes.${index}`
    if (
      !Number.isInteger(quote.termYears) ||
      quote.termYears < 1 ||
      quote.termYears > 10
    )
      throw new CdLadderError(
        `${field}.termYears`,
        'must be a whole number from 1 to 10'
      )
    if (!Number.isFinite(quote.apy) || quote.apy < 0 || quote.apy > 0.2)
      throw new CdLadderError(
        `${field}.apy`,
        'must be a fraction from 0 to 0.2'
      )
    dayNumber(quote.quotedOn, `${field}.quotedOn`)
  }
}

/** The ladder plan on asOfDate, or null once every rung's year has passed. */
export function planCdLadder(
  portfolio: Portfolio,
  rule: CdLadderRule,
  inputs: LadderInputs
): CdLadderPlan | null {
  validateLadder(rule)
  const quotes = inputs.quotes ?? []
  validateQuotes(quotes)
  const today = dayNumber(inputs.asOfDate, 'asOfDate')
  const asOfYear = Number(inputs.asOfDate.slice(0, 4))
  const firstYear = Math.max(rule.firstYear, asOfYear)
  if (firstYear > rule.lastYear) return null
  const maxPerIssuer = rule.maxPerIssuer ?? FDIC_LIMIT

  const proceedsIn = (list: readonly SaleProceeds[], name: string) =>
    list
      .filter(p => p.accountName === name)
      .reduce((total, p) => total + Math.max(0, p.amount), 0)

  // The rungs live in one account: the one of the type (and name, when given)
  // that holds the most ladder money (idle cash, dated holdings, sale proceeds).
  const wanted = rule.accountName?.trim().toLowerCase()
  const candidates = portfolio.accounts.filter(
    account =>
      account.accountType === rule.accountType &&
      (wanted === undefined || account.name.toLowerCase().includes(wanted))
  )
  const scan = (account: Account) => {
    const held: LadderHolding[] = []
    const rolling: LadderHolding[] = []
    const unknown: LadderHolding[] = []
    let idle = Math.max(0, account.cashBalance)
    const place = (holding: LadderHolding) => {
      if (holding.year >= firstYear && holding.year <= rule.lastYear)
        held.push(holding)
      else if (holding.year >= asOfYear && holding.year < firstYear)
        rolling.push(holding)
    }
    for (const cd of account.cds) {
      const year = Number(cd.maturityDate.slice(0, 4))
      if (Number.isInteger(year) && cd.principal > 0)
        place({
          symbol: cd.id,
          name: cd.institution,
          year,
          amount: cd.principal,
        })
    }
    for (const holding of account.holdings) {
      if (holding.currentValue <= 0) continue
      const symbol = holding.symbol.toUpperCase()
      if (
        holding.assetClass === 'cash' ||
        holding.assetClass === 'money_market'
      ) {
        idle += holding.currentValue
        continue
      }
      const etfYear = IBONDS_TREASURY_YEARS[symbol]
      const individual =
        holding.assetClass === 'cd' || INDIVIDUAL_SECURITY.test(holding.name)
      const year =
        etfYear ?? (individual ? maturityYearFromName(holding.name) : undefined)
      const entry = (y: number): LadderHolding => ({
        symbol: holding.symbol,
        name: holding.name,
        year: y,
        amount: holding.currentValue,
      })
      if (year !== undefined) place(entry(year))
      else if (holding.assetClass === 'cd') unknown.push(entry(0))
    }
    const money =
      idle +
      [...held, ...rolling].reduce((t, h) => t + h.amount, 0) +
      proceedsIn(inputs.saleProceedsNow, account.name) +
      proceedsIn(inputs.saleProceedsLater, account.name)
    return { account, held, rolling, unknown, idle, money }
  }
  const scanned = candidates.map(scan)
  const chosen = scanned.reduce<(typeof scanned)[number] | undefined>(
    (best, next) =>
      best === undefined || next.money > best.money ? next : best,
    undefined
  )
  const heldInLadder = chosen?.held ?? []
  const rollingIn = chosen?.rolling ?? []
  const unknownMaturity = chosen?.unknown ?? []
  const idleCash = chosen?.idle ?? 0
  const accountName = chosen?.account.name ?? null

  const sum = (list: readonly LadderHolding[]) =>
    list.reduce((total, holding) => total + holding.amount, 0)
  const held = sum(heldInLadder)
  const rolling = sum(rollingIn)
  const saleNow =
    accountName === null ? 0 : proceedsIn(inputs.saleProceedsNow, accountName)
  const saleLater =
    accountName === null ? 0 : proceedsIn(inputs.saleProceedsLater, accountName)
  const fundingNow = idleCash + saleNow
  const fundingLater = saleLater + rolling
  const total = rule.total ?? held + fundingNow + fundingLater
  const rungCount = rule.lastYear - firstYear + 1
  const rungTarget = total / rungCount

  const staleOf = (quote: RateQuote) =>
    today - dayNumber(quote.quotedOn, 'quotedOn') > QUOTE_STALE_DAYS
  const usable = quotes.filter(
    q => q.kind === 'treasury' || q.callProtected !== false
  )
  const skippedCallableQuotes = quotes.length - usable.length
  const bestQuote = (termYears: number): LadderQuote | null => {
    const candidates = usable
      .filter(q => q.termYears === termYears)
      .sort(
        (a, b) =>
          b.apy - a.apy ||
          (a.kind === b.kind ? 0 : a.kind === 'treasury' ? -1 : 1) ||
          a.source.localeCompare(b.source)
      )
    const best = candidates[0]
    if (best === undefined) return null
    return {
      kind: best.kind,
      termYears: best.termYears,
      apy: best.apy,
      source: best.source,
      quotedOn: best.quotedOn,
      stale: staleOf(best),
    }
  }

  let left = fundingNow
  const rungs: LadderRung[] = []
  for (let year = firstYear; year <= rule.lastYear; year++) {
    const existing = sum(heldInLadder.filter(holding => holding.year === year))
    const target = inputs.rungTargets?.get(year) ?? rungTarget
    const shortfall = Math.max(0, target - existing)
    const buyNow =
      Math.floor(Math.min(shortfall, left) / LADDER_UNIT) * LADDER_UNIT
    left -= buyNow
    const termYears = Math.max(1, year - asOfYear)
    const quote = bestQuote(termYears)
    const note =
      inputs.noIssuerLimit !== true && buyNow > maxPerIssuer
        ? `split across ${Math.ceil(buyNow / maxPerIssuer)} banks: FDIC insures ${'$' + maxPerIssuer.toLocaleString('en-US')} per bank`
        : undefined
    rungs.push({
      year,
      termYears,
      target: round2(target),
      existing: round2(existing),
      shortfall: round2(shortfall),
      buyNow,
      quote,
      annualInterest: quote === null ? 0 : round2(buyNow * quote.apy),
      ...(note === undefined ? {} : { note }),
    })
  }

  const buyNowTotal = rungs.reduce((total, rung) => total + rung.buyNow, 0)
  const notes: string[] = []
  if (buyNowTotal > 0 && quotes.length === 0)
    notes.push(
      'no rate quotes: pass rateQuotes (current new-issue CD and Treasury yields by term) to choose each rung'
    )
  if (rungs.some(rung => rung.buyNow > 0 && rung.quote?.stale === true))
    notes.push(
      `some quotes are more than ${QUOTE_STALE_DAYS} days old: re-check the rates before buying`
    )
  if (skippedCallableQuotes > 0)
    notes.push(
      `${skippedCallableQuotes} callable CD quote${skippedCallableQuotes === 1 ? '' : 's'} skipped: a callable CD can be repaid early when rates fall`
    )
  if (unknownMaturity.length > 0)
    notes.push(
      `${unknownMaturity.length} CD holding${unknownMaturity.length === 1 ? '' : 's'} with no maturity date in the name: not counted in any rung`
    )
  if (rollingIn.length > 0)
    notes.push(
      `${rollingIn.map(h => `${h.symbol} (${h.year})`).join(', ')} mature before ${firstYear}: roll the payout into the next rungs`
    )

  return {
    accountType: rule.accountType,
    accountName,
    firstYear,
    lastYear: rule.lastYear,
    total: round2(total),
    rungTarget: round2(rungTarget),
    fundingNow: round2(fundingNow),
    fundingLater: round2(fundingLater),
    idleCash: round2(idleCash),
    heldInLadder,
    rollingIn,
    unknownMaturity,
    rungs,
    buyNowTotal,
    unplaced: round2(fundingNow - buyNowTotal),
    skippedCallableQuotes,
    notes,
  }
}
