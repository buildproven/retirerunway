// ---------------------------------------------------------------------------
// RetireRunway – balance sheet from an aggregator list (REQ-MCP-72)
//
// Reads the net-worth list an aggregator such as Empower shows (one account
// per line: name, then a dollar amount; section headings such as Cash or
// Credit Cards; an optional "last updated" date), sorts each line into cash,
// investments, credit cards, loans, mortgage, home and other, takes out
// money the owner earmarks (college, a tax bill), and returns the totals,
// checks (card debt against free cash, months of spending in free cash,
// stale accounts, the snapshot's age and size) and the profile changes to
// propose. Account numbers in names are masked. Pure and deterministic; no
// AI, nothing saved.
// ---------------------------------------------------------------------------

import type { UserProfile } from './types'

export type BalanceCategory =
  | 'cash'
  | 'investment'
  | 'creditCard'
  | 'loan'
  | 'mortgage'
  | 'home'
  | 'otherAsset'
  | 'otherLiability'

export interface BalanceLine {
  readonly name: string
  readonly category: BalanceCategory
  /** Positive for assets; debts are positive amounts owed. */
  readonly amount: number
  readonly lastUpdated?: string
  readonly earmarked?: number
  readonly purpose?: string
}

export interface Earmark {
  /** Part of the account name, case ignored. */
  readonly account: string
  readonly amount: number
  readonly purpose: string
}

export interface BalanceCheck {
  readonly id: string
  readonly message: string
}

export interface ProposedChange {
  readonly field: string
  readonly current: unknown
  readonly proposed: unknown
}

export interface BalanceSheet {
  readonly asOfDate: string
  readonly lines: readonly BalanceLine[]
  readonly totals: {
    readonly cash: number
    readonly earmarked: number
    readonly freeCash: number
    readonly investments: number
    readonly creditCards: number
    readonly loans: number
    readonly mortgage: number
    readonly home: number
    readonly otherAssets: number
    readonly otherLiabilities: number
    readonly netWorth: number
  }
  readonly checks: readonly BalanceCheck[]
  /** For save_profile once the owner agrees; nothing is saved here. */
  readonly proposedChanges: readonly ProposedChange[]
  /** Lines that had no amount and were not headings. */
  readonly skipped: readonly string[]
}

export class BalanceSheetError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
  }
}

export const BALANCE_DEFAULTS = {
  /** An account not refreshed for this many days is stale. */
  staleDays: 30,
  /** Investments this far from the newest snapshot mean re-import positions. */
  snapshotTolerance: 0.03,
  snapshotStaleDays: 14,
  /** Free cash under this many months of spending is thin. */
  minMonths: 3,
} as const

const HEADINGS: ReadonlyMap<string, BalanceCategory | null> = new Map([
  ['cash', 'cash'],
  ['banking', 'cash'],
  ['bank accounts', 'cash'],
  ['investment', 'investment'],
  ['investments', 'investment'],
  ['retirement', 'investment'],
  ['credit card', 'creditCard'],
  ['credit cards', 'creditCard'],
  ['credit', 'creditCard'],
  ['loan', 'loan'],
  ['loans', 'loan'],
  ['mortgage', 'mortgage'],
  ['mortgages', 'mortgage'],
  ['property', 'home'],
  ['real estate', 'home'],
  ['other asset', 'otherAsset'],
  ['other assets', 'otherAsset'],
  ['other liability', 'otherLiability'],
  ['other liabilities', 'otherLiability'],
  ['assets', null],
  ['liabilities', null],
  ['net worth', null],
  ['total', null],
])

const LIABILITY: ReadonlySet<BalanceCategory> = new Set([
  'creditCard',
  'loan',
  'mortgage',
  'otherLiability',
])

const KEYWORDS: readonly [RegExp, BalanceCategory][] = [
  [/\bmortgage\b|home loan/i, 'mortgage'],
  [/\bheloc\b|\bloan\b|auto finance/i, 'loan'],
  [
    /credit card|\bcard\b|\bvisa\b|mastercard|\bamex\b|american express|discover/i,
    'creditCard',
  ],
  [
    /checking|savings|\bhysa\b|money market|pocket money|\bbank\b|credit union|\bccu\b|treasury ?direct|\bi[ -]?bonds?\b/i,
    'cash',
  ],
  [
    /\b401\s?\(?k\)?|\bira\b|\broth\b|\b403\s?\(?b\)?|\b457\b|\bhsa\b|\bnqdc\b|deferred comp|brokerage|\bsuper(annuation)?\b|pension|stock plan|\bjoint\b|\bbrokerage\b/i,
    'investment',
  ],
  [/\bcash\b|\bcds?\b/i, 'cash'],
  [/\bhome\b|\bhouse\b|residence|real estate|zillow|redfin|property/i, 'home'],
]

// (paren)(minus)($)(minus)(number)(paren): "-$1,234.56", "$-1,234", "(1,234.56)".
const AMOUNT =
  /(?:^|\s)(\(?)\s*([-−–]?)\s*(\$?)\s*([-−–]?)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(\)?)\s*$/
const DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b/

const round2 = (n: number) => Math.round(n * 100) / 100
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/** Mask anything that looks like an account number (4+ digits in a row). */
export function maskAccountNumbers(name: string): string {
  return name
    .replace(/[x*•.#-]*\d{4,}/gi, '••••')
    .replace(/\s+/g, ' ')
    .trim()
}

function normaliseHeading(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000
  )
}

function parseDate(match: RegExpMatchArray): string {
  if (match[1] !== undefined) {
    const mm = match[1].padStart(2, '0')
    const dd = match[2].padStart(2, '0')
    return `${match[3]}-${mm}-${dd}`
  }
  return `${match[4]}-${match[5]}-${match[6]}`
}

function categorise(
  name: string,
  heading: BalanceCategory | null,
  negative: boolean
): BalanceCategory {
  // A specific heading decides; a generic one (other assets) lets the name decide.
  if (
    heading !== null &&
    heading !== 'otherAsset' &&
    heading !== 'otherLiability'
  )
    return heading
  for (const [pattern, category] of KEYWORDS) {
    if (pattern.test(name)) {
      // A "home" line that is negative is the loan against it.
      if (category === 'home' && negative) return 'mortgage'
      return category
    }
  }
  if (heading !== null) return heading
  return negative ? 'otherLiability' : 'otherAsset'
}

export function readBalanceSheet(
  text: string,
  asOfDate: string,
  earmarks: readonly Earmark[] = []
): BalanceSheet {
  const lines: BalanceLine[] = []
  const skipped: string[] = []
  let heading: BalanceCategory | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, ' ').trim()
    if (line === '') continue
    const dateMatch = line.match(DATE)
    const withoutDate = (dateMatch === null ? line : line.replace(DATE, ' '))
      .replace(/\b(last )?updated\b:?/gi, ' ')
      .trim()
    const found = withoutDate.match(AMOUNT)
    // A bare whole number with no $ or comma is part of a name (a 401).
    const amount =
      found !== null && (found[3] !== '' || /[,.]/.test(found[5]))
        ? found
        : null
    const name = (
      amount === null ? withoutDate : withoutDate.slice(0, amount.index)
    )
      .replace(/[:\-–—\s]+$/, '')
      .trim()
    const key = normaliseHeading(name)
    if (HEADINGS.has(key)) {
      // A heading, perhaps with its section total: the total is not counted.
      heading = HEADINGS.get(key) ?? null
      continue
    }
    if (amount === null || name === '') {
      skipped.push(maskAccountNumbers(line).slice(0, 80))
      continue
    }
    const value = Number(amount[5].replace(/,/g, ''))
    const negative =
      amount[2] !== '' ||
      amount[4] !== '' ||
      (amount[1] === '(' && amount[6] === ')')
    const category = categorise(name, heading, negative)
    lines.push({
      name: maskAccountNumbers(name),
      category,
      amount: round2(
        LIABILITY.has(category) ? Math.abs(value) : negative ? -value : value
      ),
      ...(dateMatch === null ? {} : { lastUpdated: parseDate(dateMatch) }),
    })
  }
  if (lines.length === 0)
    throw new BalanceSheetError(
      'text',
      'found no account lines: paste one account per line, its name then its balance'
    )

  // Earmarks: take the money out of free cash, account by account.
  const marked = new Map<number, { amount: number; purpose: string }>()
  for (const [i, earmark] of earmarks.entries()) {
    const needle = earmark.account.toLowerCase()
    const index = lines.findIndex(l => l.name.toLowerCase().includes(needle))
    if (index < 0)
      throw new BalanceSheetError(
        `earmarks[${i}].account`,
        `no account name contains "${earmark.account}"`
      )
    const prior = marked.get(index)?.amount ?? 0
    if (prior + earmark.amount > lines[index].amount + 0.005)
      throw new BalanceSheetError(
        `earmarks[${i}].amount`,
        `${usd(prior + earmark.amount)} earmarked is more than the ${usd(lines[index].amount)} in ${lines[index].name}`
      )
    marked.set(index, {
      amount: prior + earmark.amount,
      purpose:
        prior > 0
          ? `${marked.get(index)?.purpose}; ${earmark.purpose}`
          : earmark.purpose,
    })
  }
  const withMarks = lines.map((l, i) => {
    const m = marked.get(i)
    return m === undefined
      ? l
      : { ...l, earmarked: round2(m.amount), purpose: m.purpose }
  })

  const sum = (c: BalanceCategory) =>
    round2(
      withMarks.filter(l => l.category === c).reduce((a, l) => a + l.amount, 0)
    )
  const cash = sum('cash')
  const earmarked = round2(
    withMarks
      .filter(l => l.category === 'cash')
      .reduce((a, l) => a + (l.earmarked ?? 0), 0)
  )
  const investmentEarmarks = withMarks.some(
    l => l.category !== 'cash' && (l.earmarked ?? 0) > 0
  )
  const totals = {
    cash,
    earmarked,
    freeCash: round2(cash - earmarked),
    investments: sum('investment'),
    creditCards: sum('creditCard'),
    loans: sum('loan'),
    mortgage: sum('mortgage'),
    home: sum('home'),
    otherAssets: sum('otherAsset'),
    otherLiabilities: sum('otherLiability'),
    netWorth: 0,
  }
  totals.netWorth = round2(
    totals.cash +
      totals.investments +
      totals.home +
      totals.otherAssets -
      totals.creditCards -
      totals.loans -
      totals.mortgage -
      totals.otherLiabilities
  )
  const checks: BalanceCheck[] = []
  if (investmentEarmarks)
    checks.push({
      id: 'earmark-not-cash',
      message:
        'an earmark sits in a non-cash account: it is shown on the line but only cash earmarks come out of free cash',
    })
  for (const l of withMarks) {
    if (
      l.lastUpdated !== undefined &&
      daysBetween(l.lastUpdated, asOfDate) > BALANCE_DEFAULTS.staleDays
    )
      checks.push({
        id: 'stale-account',
        message: `${l.name} was last updated ${l.lastUpdated} (${daysBetween(l.lastUpdated, asOfDate)} days ago): refresh or reconnect it before trusting its balance`,
      })
  }
  return {
    asOfDate,
    lines: withMarks,
    totals,
    checks,
    proposedChanges: [],
    skipped,
  }
}

/**
 * Checks and proposed profile changes against the saved plan (REQ-MCP-72).
 */
export function compareWithPlan(
  sheet: BalanceSheet,
  profile: UserProfile | undefined,
  snapshot:
    | { readonly asOfDate: string; readonly totalValue: number }
    | undefined
): BalanceSheet {
  const checks: BalanceCheck[] = [...sheet.checks]
  const changes: ProposedChange[] = []
  const t = sheet.totals
  const consumerDebt = round2(t.creditCards + t.loans + t.otherLiabilities)
  if (consumerDebt > t.freeCash)
    checks.push({
      id: 'debt-over-free-cash',
      message: `card and loan debt ${usd(consumerDebt)} is more than free cash ${usd(t.freeCash)}${t.earmarked > 0 ? ` (after ${usd(t.earmarked)} earmarked)` : ''}`,
    })
  if (profile !== undefined && profile.annualExpenses > 0) {
    const months =
      Math.round((t.freeCash / (profile.annualExpenses / 12)) * 10) / 10
    if (months < BALANCE_DEFAULTS.minMonths)
      checks.push({
        id: 'thin-cash',
        message: `free cash covers ${months} months of spending (${usd(profile.annualExpenses / 12)}/mo); ${BALANCE_DEFAULTS.minMonths} to 6 months is the usual emergency fund`,
      })
  }
  if (snapshot !== undefined && snapshot.totalValue > 0 && t.investments > 0) {
    const gap = (t.investments - snapshot.totalValue) / snapshot.totalValue
    const age = daysBetween(snapshot.asOfDate, sheet.asOfDate)
    if (
      Math.abs(gap) > BALANCE_DEFAULTS.snapshotTolerance ||
      age > BALANCE_DEFAULTS.snapshotStaleDays
    )
      checks.push({
        id: 'snapshot-differs',
        message: `investments here are ${usd(t.investments)} vs ${usd(snapshot.totalValue)} in the ${snapshot.asOfDate} positions snapshot (${gap >= 0 ? '+' : ''}${Math.round(gap * 1000) / 10}%, ${age} days old): import a fresh positions CSV`,
      })
  }
  if (profile !== undefined) {
    const outside = profile.planRules?.outsideCash
    if (
      profile.planRules !== undefined &&
      Math.abs((outside ?? 0) - t.freeCash) >= 1
    )
      changes.push({
        field: 'planRules.outsideCash',
        current: outside ?? null,
        proposed: t.freeCash,
      })
    if (Math.abs((profile.consumerDebt ?? 0) - consumerDebt) >= 1)
      changes.push({
        field: 'consumerDebt',
        current: profile.consumerDebt ?? null,
        proposed: consumerDebt,
      })
    if (
      t.mortgage > 0 &&
      profile.mortgage !== undefined &&
      Math.abs(profile.mortgage.balance - t.mortgage) >= 1
    )
      changes.push({
        field: 'mortgage.balance',
        current: profile.mortgage.balance,
        proposed: t.mortgage,
      })
    if (
      t.mortgage > 0 &&
      profile.mortgage !== undefined &&
      profile.mortgage.asOfDate !== sheet.asOfDate &&
      Math.abs(profile.mortgage.balance - t.mortgage) >= 1
    )
      changes.push({
        field: 'mortgage.asOfDate',
        current: profile.mortgage.asOfDate,
        proposed: sheet.asOfDate,
      })
    if (
      t.home > 0 &&
      Math.abs((profile.home?.estimatedValue ?? 0) - t.home) >= 1
    )
      changes.push({
        field: 'home.estimatedValue',
        current: profile.home?.estimatedValue ?? null,
        proposed: t.home,
      })
  }
  return { ...sheet, checks, proposedChanges: changes }
}
