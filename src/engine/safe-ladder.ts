// Held-to-maturity TIPS or CD ladder (REQ-MCP-76, ADR-013). A ladder bought
// today pays a known amount in each bridge year with no market risk: TIPS
// rungs in today's dollars (their principal follows inflation), CD rungs
// fixed in dollars. The projection takes the ladder's cost out of the
// account that holds it and pays each rung as income in its year.
// Deterministic: inputs only.
import type {
  AccountType,
  Holding,
  MarketData,
  Portfolio,
  SafeLadder,
  SafeLadderRung,
  UserProfile,
} from './types'

/** Accounts whose payouts are taxed as ordinary income. */
const PRE_TAX: readonly AccountType[] = [
  '401k',
  '403b',
  '457b',
  'traditional_ira',
  'rollover_ira',
  'nqdc',
]

/** Years from today until the rung pays (at least 0). */
function yearsUntil(rung: SafeLadderRung, currentAge: number): number {
  return Math.max(0, rung.age - currentAge)
}

/**
 * REQ-MCP-87: TIPS gap years. No TIPS were issued to mature 2037-2039 (the
 * Treasury stopped 20-year TIPS in 2009 and paused 30-year TIPS 2001-2010),
 * so a ladder cannot hold those years until the January 10-year auctions
 * create them: Jan 2027 for 2037, Jan 2028 for 2038, Jan 2029 for 2039.
 * The first TIPS after the gap matures in February 2040.
 */
export const TIPS_AFTER_GAP_YEAR = 2040
/** The January 10-year TIPS auction is held around the 20th. */
const TEN_YEAR_AUCTION_DAY = '01-25'

/** The latest year a TIPS matures in among those issued by asOfDate (below the gap). */
export function lastTipsMaturityBelowGap(asOfDate: string): number {
  const year = Number(asOfDate.slice(0, 4))
  return year + (asOfDate.slice(5, 10) >= TEN_YEAR_AUCTION_DAY ? 10 : 9)
}

/** Years with no TIPS to buy on asOfDate. */
export function tipsGapYears(asOfDate: string): number[] {
  const years: number[] = []
  for (
    let y = lastTipsMaturityBelowGap(asOfDate) + 1;
    y < TIPS_AFTER_GAP_YEAR;
    y++
  )
    years.push(y)
  return years
}

export interface TipsGapRung {
  readonly year: number
  readonly age: number
  /** Today's cost of the rung, as the ladder prices it. */
  readonly cost: number
  /** The January 10-year auction that issues a TIPS maturing that year. */
  readonly auctionYear: number
}

/** REQ-MCP-87: the ladder's rungs that fall in gap years. */
export function tipsGapRungs(
  ladder: SafeLadder | undefined,
  profile: UserProfile,
  asOfDate: string
): TipsGapRung[] {
  if (ladder === undefined || ladder.instrument !== 'tips') return []
  const gap = new Set(tipsGapYears(asOfDate))
  const asOfYear = Number(asOfDate.slice(0, 4))
  return ladder.rungs
    .map(rung => {
      const year = asOfYear + (Math.floor(rung.age) - profile.currentAge)
      return {
        year,
        age: Math.floor(rung.age),
        cost: rungCost(rung, profile.currentAge),
        auctionYear: year - 10,
      }
    })
    .filter(r => gap.has(r.year))
}

/**
 * What one rung costs today: its payout discounted at its yield. The
 * projection pays rungs from currentAge + 1, so a rung at the current age or
 * earlier (already paid, or paying this year from money held now) costs
 * nothing; charging it would take money out that no year pays back.
 */
export function rungCost(rung: SafeLadderRung, currentAge: number): number {
  if (Math.floor(rung.age) <= currentAge) return 0
  return rung.amount / Math.pow(1 + rung.yield, yearsUntil(rung, currentAge))
}

/** What the whole ladder costs today. */
export function ladderCost(ladder: SafeLadder, currentAge: number): number {
  return ladder.rungs.reduce((sum, r) => sum + rungCost(r, currentAge), 0)
}

function isEquity(holding: Holding): boolean {
  return (
    holding.assetClass === 'us_equity' ||
    holding.assetClass === 'intl_equity' ||
    holding.assetClass === 'emerging_equity'
  )
}

function scaleHolding(holding: Holding, keep: number): Holding {
  return {
    ...holding,
    shares: holding.shares * keep,
    costBasis: holding.costBasis * keep,
    currentValue: holding.currentValue * keep,
  }
}

/**
 * The portfolio with the ladder's cost taken out of the accounts of its
 * account type: cash, CDs and bonds first, then stocks. `shortfall` is the
 * cost those accounts could not cover.
 */
export function withoutLadderCost(
  portfolio: Portfolio,
  profile: UserProfile
): { portfolio: Portfolio; cost: number; shortfall: number } {
  const ladder = profile.safeLadder
  if (ladder === undefined || ladder.rungs.length === 0)
    return { portfolio, cost: 0, shortfall: 0 }
  const cost = ladderCost(ladder, profile.currentAge)
  let remaining = cost
  const take = (available: number): number => {
    const used = Math.min(Math.max(0, available), remaining)
    remaining -= used
    return used
  }
  const pass = (accounts: Portfolio['accounts'], stocks: boolean) =>
    accounts.map(account => {
      if (account.accountType !== ladder.accountType || remaining <= 0)
        return account
      const cashBalance = stocks
        ? account.cashBalance
        : account.cashBalance - take(account.cashBalance)
      const cds = stocks
        ? account.cds
        : account.cds.map(cd => ({
            ...cd,
            principal: cd.principal - take(cd.principal),
          }))
      const holdings = account.holdings.map(holding => {
        if (isEquity(holding) !== stocks || holding.currentValue <= 0)
          return holding
        const used = take(holding.currentValue)
        return scaleHolding(holding, 1 - used / holding.currentValue)
      })
      return { ...account, cashBalance, cds, holdings }
    })
  const afterSafe = pass(portfolio.accounts, false)
  const afterAll = pass(afterSafe, true)
  return {
    portfolio: { ...portfolio, accounts: afterAll },
    cost,
    shortfall: remaining,
  }
}

/**
 * The ladder's payout at `age`, nominal: TIPS rungs grow with the path's
 * cumulative inflation, CD rungs are fixed. `taxed` is the part from a
 * pre-tax account (ordinary income, like a pension); the rest is untaxed.
 */
export function safeLadderIncomeAt(
  profile: UserProfile,
  age: number,
  inflation: number
): { taxed: number; untaxed: number } {
  const ladder = profile.safeLadder
  if (ladder === undefined) return { taxed: 0, untaxed: 0 }
  let payout = 0
  for (const rung of ladder.rungs)
    if (Math.floor(rung.age) === age)
      payout +=
        ladder.instrument === 'tips' ? rung.amount * inflation : rung.amount
  return PRE_TAX.includes(ladder.accountType)
    ? { taxed: payout, untaxed: 0 }
    : { taxed: 0, untaxed: payout }
}

/**
 * The CD yield for a rung `termYears` out: the quote whose term is closest,
 * within `slack` years (a shorter term wins a tie); undefined when none is
 * that close, since rolling a short CD over leaves the rate to chance.
 */
export function cdYieldFor(
  data: MarketData,
  termYears: number,
  slack = 1
): number | undefined {
  let best: { gap: number; term: number; rate: number } | undefined
  for (const q of data.cdYields ?? []) {
    const gap = Math.abs(q.termYears - termYears)
    if (gap > slack) continue
    if (
      best === undefined ||
      gap < best.gap ||
      (gap === best.gap && q.termYears < best.term)
    )
      best = { gap, term: q.termYears, rate: q.rate }
  }
  return best?.rate
}

export interface InstrumentChoice {
  readonly instrument: 'tips' | 'cd'
  /** The real yield of the choice (CD: its yield less breakeven inflation). */
  readonly realYield: number
  readonly reason: string
}

/**
 * TIPS or CD for a rung `termYears` out: the higher expected real yield,
 * the CD's real yield being its yield less breakeven inflation. A tie goes
 * to TIPS, which also protect against inflation above the breakeven.
 */
export function chooseInstrument(
  data: MarketData,
  termYears: number,
  slack = 1
): InstrumentChoice | undefined {
  const tips = data.tipsReal10y
  const cd = cdYieldFor(data, termYears, slack)
  if (tips === undefined && cd === undefined) return undefined
  if (tips === undefined) {
    if (cd === undefined) return undefined
    return {
      instrument: 'cd',
      realYield: cd - 0.03,
      reason: 'no TIPS yield saved',
    }
  }
  // Without a saved 10-year Treasury yield, assume 3% breakeven inflation,
  // the same default testSafeLadders uses to price the rungs.
  const breakeven =
    data.treasury10y !== undefined ? data.treasury10y - tips : 0.03
  if (cd === undefined || cd - breakeven <= tips)
    return {
      instrument: 'tips',
      realYield: tips,
      reason:
        cd === undefined
          ? `TIPS ${(tips * 100).toFixed(2)}% real; no CD quote for this term`
          : `TIPS ${(tips * 100).toFixed(2)}% real beats the CD's ${(cd * 100).toFixed(2)}% less ${(breakeven * 100).toFixed(2)}% breakeven inflation, and protects against higher inflation`,
    }
  return {
    instrument: 'cd',
    realYield: cd - breakeven,
    reason: `CD ${(cd * 100).toFixed(2)}% less ${(breakeven * 100).toFixed(2)}% breakeven inflation beats TIPS ${(tips * 100).toFixed(2)}% real, but loses if inflation runs above the breakeven`,
  }
}
