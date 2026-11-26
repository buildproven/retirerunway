// The engine proposes the plan rules (REQ-MCP-64, ADR-009). From the profile
// and snapshot it tests stock shares with the projection, sizes a ladder that
// funds the first retirement years, times the cash buffer, schedules the
// sales the proposed share needs, and checks the owner's current rules
// against all of it. Pure and deterministic: same inputs and seed, same
// proposal. Nothing is saved; the owner approves each change.
import { calculatePortfolioValue } from './portfolio-math'
import { checkPlan } from './plan-check'
import {
  compareAssets,
  sleeveShares,
  withAltShare,
  type AssetComparisonRow,
} from './asset-classes'
import { glideShareAt, projectRetirement } from './retirement-projection'
import {
  chooseInstrument,
  ladderCost,
  tipsGapRungs,
  withoutLadderCost,
} from './safe-ladder'
import type {
  Account,
  AccountType,
  CdLadderRule,
  GlidePoint,
  Holding,
  IncomeAnnuity,
  MarketData,
  PlanRules,
  Portfolio,
  SafeLadder,
  SafeLadderRung,
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
  /** Bond tent (REQ-MCP-71): stocks this much lower at retirement, back up after tentYears. */
  tentDip: 0.15,
  tentYears: 10,
  /** Rising glide path: this much lower at retirement, this much above target after risingYears. */
  risingDip: 0.2,
  risingTop: 0.1,
  risingYears: 15,
  minShare: 0.2,
  maxShare: 0.9,
  unit: 1_000,
  socialSecurityAge: 67,
  /** Safe-ladder test (REQ-MCP-76): bridge years covered, before the full bridge. */
  ladderCoverYears: [3, 5] as readonly number[],
  /** A CD quote counts for a rung within this many years of its term. */
  cdTermSlack: 1,
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

export interface GlideTestRow {
  readonly name: string
  /** Empty for a constant share. */
  readonly points: readonly GlidePoint[]
  readonly successRate: number
  readonly forecastSuccessRate: number
  readonly worse: number
}

export interface SafeLadderTestRow {
  readonly name: string
  /** Ages the rungs pay. */
  readonly firstAge: number
  readonly lastAge: number
  /** Cost today, taken from the ladder account. */
  readonly cost: number
  /** Stock share of what is left after the ladder. */
  readonly equityShareOfRest: number
  /** Stock share of the whole portfolio, ladder counted as bonds. */
  readonly equityShareOverall: number
  readonly successRate: number
  readonly forecastSuccessRate: number
  readonly worse: number
}

/** Safe yields against expected stock returns (REQ-MCP-75), from saved market data. */
export interface MarketComparison {
  readonly asOfDate: string
  readonly tipsReal10y: number | null
  readonly treasury10y: number | null
  /** Treasury less TIPS: the inflation the market expects. */
  readonly breakevenInflation: number | null
  readonly bestCd: { readonly termYears: number; readonly rate: number } | null
  /** Average of the saved 10-year stock forecasts (nominal). */
  readonly stockForecast: number | null
  /** stockForecast less breakeven inflation. */
  readonly stockRealForecast: number | null
  /** stockRealForecast less the TIPS real yield: what stocks are expected to pay for their risk. */
  readonly equityPremiumOverTips: number | null
  readonly headline: string
  /** REQ-MCP-78: each saved asset-class forecast against TIPS, best reward per risk first. */
  readonly assets: readonly AssetComparisonRow[]
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
  /** Constant share vs glide paths (REQ-MCP-71), same seed. */
  readonly glideTest: {
    readonly rows: readonly GlideTestRow[]
    /** The path to save as profile glidePath; null keeps a constant share. */
    readonly proposed: readonly GlidePoint[] | null
    readonly basis: string
  }
  /**
   * REQ-MCP-78: the alternatives sleeve (gold, commodities, crypto) held at
   * none, today's share, 5% and 10%, the difference from or to the safe
   * sleeve, on the owner's plan and seed. Advisory: `proposed` is the share
   * to hold, or null to keep today's.
   */
  readonly altTest: {
    readonly currentShare: number
    readonly rows: readonly {
      readonly share: number
      readonly successRate: number
      readonly forecastSuccessRate: number
      readonly worse: number
    }[]
    readonly proposed: number | null
    readonly basis: string
  }
  /**
   * REQ-MCP-80: a lifetime income annuity bought at Social Security age with
   * none, 25% or 50% of the expected balance then, at the saved quote for
   * that age. Advisory: `proposed` is the annuity to consider, or null.
   */
  readonly annuityTest: {
    readonly purchaseAge: number
    readonly payoutRate: number | null
    readonly rows: readonly {
      readonly share: number
      readonly premium: number
      readonly successRate: number
      readonly forecastSuccessRate: number
      readonly worse: number
    }[]
    readonly proposed: IncomeAnnuity | null
    readonly basis: string
  }
  readonly ladder: PolicyLadder | null
  /** Market data behind the forecast returns and the safe ladder; null when none is saved. */
  readonly market: MarketComparison | null
  /** Held-to-maturity ladder for the bridge vs none (REQ-MCP-76). */
  readonly safeLadderTest: {
    readonly rows: readonly SafeLadderTestRow[]
    /** The ladder to save as profile safeLadder; null keeps none. */
    readonly proposed: SafeLadder | null
    readonly basis: string
  }
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

function saleKey(s: ScheduledSale): string {
  return `${s.id}|${s.dueDate}|${s.symbol}|${s.amount}|${s.accountType}`
}

/** True when two runs of sales hold the same sales, in any order. */
function sameSales(
  a: readonly ScheduledSale[],
  b: readonly ScheduledSale[]
): boolean {
  if (a.length === 0 || a.length !== b.length) return false
  const keys = new Set(a.map(saleKey))
  return b.every(s => keys.has(saleKey(s)))
}

function sameLadder(a: CdLadderRule, b: CdLadderRule): boolean {
  return (
    a.accountType === b.accountType &&
    a.firstYear === b.firstYear &&
    a.lastYear === b.lastYear
  )
}

/** The largest account type a ladder can sit in (not taxable, not NQDC). */
function largestLadderType(portfolio: Portfolio): AccountType | undefined {
  const valueByType = new Map<AccountType, number>()
  for (const account of portfolio.accounts) {
    if (account.accountType === 'brokerage' || account.accountType === 'nqdc')
      continue
    valueByType.set(
      account.accountType,
      (valueByType.get(account.accountType) ?? 0) + accountTotal(account).value
    )
  }
  return [...valueByType.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** Safe yields against the stock forecasts (REQ-MCP-75). */
export function compareMarket(
  data: MarketData | undefined
): MarketComparison | null {
  if (data === undefined) return null
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000
  const tips = data.tipsReal10y ?? null
  const treasury = data.treasury10y ?? null
  const breakeven =
    tips !== null && treasury !== null ? r4(treasury - tips) : null
  const cds = [...(data.cdYields ?? [])].sort(
    (a, b) => b.rate - a.rate || a.termYears - b.termYears
  )
  const bestCd = cds[0] ?? null
  const forecasts = data.stockForecasts ?? []
  const stock =
    forecasts.length > 0
      ? r4(forecasts.reduce((sum, f) => sum + f.mean, 0) / forecasts.length)
      : null
  const stockReal =
    stock !== null && breakeven !== null ? r4(stock - breakeven) : null
  const premium =
    stockReal !== null && tips !== null ? r4(stockReal - tips) : null
  const p2 = (v: number) => `${(v * 100).toFixed(2)}%`
  const headline =
    premium === null
      ? `market data of ${data.asOfDate}: add the 10-year Treasury and TIPS yields and the firms' stock forecasts to compare safe yields with stocks`
      : premium < 0.01
        ? `stocks are expected to pay only ${p2(premium)} a year more than TIPS (${p2(stockReal as number)} vs ${p2(tips as number)} after inflation, ${data.asOfDate}): risk-free money is unusually well paid, so lock in the years you cannot afford to lose`
        : premium < 0.025
          ? `stocks are expected to pay ${p2(premium)} a year more than TIPS after inflation (${data.asOfDate}): a thin reward for their risk over the bridge years`
          : `stocks are expected to pay ${p2(premium)} a year more than TIPS after inflation (${data.asOfDate}): a normal reward for their risk`
  return {
    asOfDate: data.asOfDate,
    tipsReal10y: tips,
    treasury10y: treasury,
    breakevenInflation: breakeven,
    bestCd:
      bestCd === null
        ? null
        : { termYears: bestCd.termYears, rate: bestCd.rate },
    stockForecast: stock,
    stockRealForecast: stockReal,
    equityPremiumOverTips: premium,
    headline,
    assets: compareAssets(data),
  }
}

interface LadderTestResult {
  readonly rows: SafeLadderTestRow[]
  readonly ladders: SafeLadder[]
  readonly basis: string
  readonly notes: string[]
}

/**
 * Held-to-maturity ladders for the first 3 and 5 bridge years and the whole
 * bridge (retirement to the year before Social Security), each bought now
 * at the saved yields, against the same seed: for each, the stock share of
 * what is left that scores best on the worse of long-run and forecast
 * returns (REQ-MCP-76).
 */
function testSafeLadders(args: {
  readonly portfolio: Portfolio
  readonly profile: UserProfile
  readonly run: { seed?: number; paths?: number }
  readonly candidates: readonly number[]
  readonly socialSecurityAge: number
  readonly ladderType: AccountType | undefined
}): LadderTestResult {
  const { portfolio, profile, run, candidates, socialSecurityAge } = args
  const data = profile.marketData
  const none = (basis: string): LadderTestResult => ({
    rows: [],
    ladders: [],
    basis,
    notes: [],
  })
  if (
    data === undefined ||
    (data.tipsReal10y === undefined && (data.cdYields ?? []).length === 0)
  )
    return none(
      'no market data saved: save_market_data with TIPS and CD yields to test a safe ladder'
    )
  if (args.ladderType === undefined)
    return none('no retirement account to hold a ladder')
  const ladderType = args.ladderType
  const firstAge = Math.max(profile.targetRetirementAge, profile.currentAge + 1)
  const lastAge = socialSecurityAge - 1
  if (lastAge < firstAge) return none('no bridge years before Social Security')
  const expected = projectRetirement(portfolio, profile, run).expectedPath.years
  const needAt = (age: number) => {
    const row = expected.find(y => y.age === age)
    return row === undefined
      ? 0
      : Math.max(0, row.withdrawals.total - row.withdrawals.nqdc)
  }
  const breakeven =
    data.treasury10y !== undefined && data.tipsReal10y !== undefined
      ? data.treasury10y - data.tipsReal10y
      : 0.03
  const fullYears = lastAge - firstAge + 1
  const covers = [
    ...new Set([
      ...POLICY_DEFAULTS.ladderCoverYears.filter(y => y < fullYears),
      fullYears,
    ]),
  ]
  const total = calculatePortfolioValue(portfolio)
  const forecastProfileOf = (p: UserProfile): UserProfile => ({
    ...p,
    marketAssumptions: { ...p.marketAssumptions, preset: 'forecast' },
  })
  const rows: SafeLadderTestRow[] = []
  const ladders: SafeLadder[] = []
  const notes: string[] = []
  for (const cover of covers) {
    const ages = Array.from({ length: cover }, (_, i) => firstAge + i)
    const choices = ages.map(age =>
      chooseInstrument(
        data,
        age - profile.currentAge,
        POLICY_DEFAULTS.cdTermSlack
      )
    )
    const instrument: SafeLadder['instrument'] =
      data.tipsReal10y !== undefined &&
      choices.some(c => c === undefined || c.instrument === 'tips')
        ? 'tips'
        : 'cd'
    const rungs: SafeLadderRung[] = []
    for (const [i, age] of ages.entries()) {
      const need = needAt(age)
      if (need <= 0) continue
      const term = age - profile.currentAge
      if (instrument === 'tips') {
        rungs.push({
          age,
          amount: round2(need),
          yield: data.tipsReal10y as number,
        })
      } else {
        const rate = choices[i]?.realYield
        if (rate === undefined) continue
        rungs.push({
          age,
          amount: round2(need * Math.pow(1 + breakeven, term)),
          yield: rate + breakeven,
        })
      }
    }
    if (rungs.length === 0) continue
    const ladder: SafeLadder = { instrument, accountType: ladderType, rungs }
    const withLadder: UserProfile = { ...profile, safeLadder: ladder }
    const {
      portfolio: rest,
      cost,
      shortfall,
    } = withoutLadderCost(portfolio, withLadder)
    if (shortfall > 1) {
      notes.push(
        `a ${cover}-year ladder costs ${dollars(cost)}, more than the ${ladderType} accounts hold: not tested`
      )
      continue
    }
    // The projection takes the cost out again: hand it back as cash in
    // front, so the rebalanced rest keeps the tested share.
    const scored = candidates.map(share => {
      const rebalanced = withEquityShare(rest, share)
      const test: Portfolio = {
        ...rebalanced,
        accounts: [
          {
            id: 'safe-ladder-cost',
            name: 'Safe ladder (cost)',
            institution: 'test',
            accountType: ladderType,
            holdings: [],
            cds: [],
            cashBalance: cost,
          },
          ...rebalanced.accounts,
        ],
      }
      const successRate = projectRetirement(test, withLadder, run).monteCarlo
        .successRate
      const forecastSuccessRate = projectRetirement(
        test,
        forecastProfileOf(withLadder),
        run
      ).monteCarlo.successRate
      return {
        share,
        successRate,
        forecastSuccessRate,
        worse: Math.min(successRate, forecastSuccessRate),
      }
    })
    const top = Math.max(...scored.map(r => r.worse))
    const pick = scored.find(
      r => r.worse >= top - POLICY_DEFAULTS.tieTolerance
    ) as (typeof scored)[number]
    const rungAges = rungs.map(r => r.age)
    rows.push({
      name: `${rungs.length}-year ${instrument === 'tips' ? 'TIPS' : 'CD'} ladder`,
      firstAge: Math.min(...rungAges),
      lastAge: Math.max(...rungAges),
      cost: Math.round(cost),
      equityShareOfRest: pick.share,
      equityShareOverall:
        total > 0 ? round2((pick.share * (total - cost)) / total) : 0,
      successRate: pick.successRate,
      forecastSuccessRate: pick.forecastSuccessRate,
      worse: pick.worse,
    })
    ladders.push(ladder)
  }
  return {
    rows,
    ladders,
    basis:
      rows.length === 0
        ? 'no ladder could be tested'
        : `each ladder bought now at the ${data.asOfDate} yields, the rest at the stock share that scores best on the worse of long-run and forecast returns`,
    notes,
  }
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

  // 1. Stock share: run the plan at each candidate, long-run and forecast,
  // with no ladder (the safe-ladder test below adds one).
  const bare: UserProfile = { ...profile, safeLadder: undefined }
  const forecastProfile: UserProfile = {
    ...bare,
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
    const successRate = projectRetirement(test, bare, run).monteCarlo
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
  let proposedShare = chosen.equityShare
  let basis = `highest worse-of-two success rate (long-run and 10-year forecast returns): ${pct(chosen.worse)} at ${pct(proposedShare)} stocks; the lowest share within ${POLICY_DEFAULTS.tieTolerance * 100} point of the best wins`

  // 1a. Safe ladder (REQ-MCP-76): lock the bridge years at today's yields,
  // and hold stocks only in what is left, vs no ladder. Same seed.
  const market = compareMarket(profile.marketData)
  if (market !== null) notes.push(`market: ${market.headline}`)
  const ladderTest = testSafeLadders({
    portfolio,
    profile: bare,
    run,
    candidates,
    socialSecurityAge,
    ladderType: current?.cdLadder?.accountType ?? largestLadderType(portfolio),
  })
  notes.push(...ladderTest.notes)
  const bestLadderIndex = ladderTest.rows.reduce(
    (best, row, i) =>
      best === -1 ||
      row.worse > (ladderTest.rows[best] as SafeLadderTestRow).worse
        ? i
        : best,
    -1
  )
  const bestLadderRow =
    bestLadderIndex === -1 ? undefined : ladderTest.rows[bestLadderIndex]
  const ladderWins =
    bestLadderRow !== undefined &&
    bestLadderRow.worse > chosen.worse + POLICY_DEFAULTS.tieTolerance
  const proposedSafeLadder =
    ladderWins && bestLadderIndex !== -1
      ? (ladderTest.ladders[bestLadderIndex] as SafeLadder)
      : null
  const ladderBasis =
    bestLadderRow === undefined
      ? ladderTest.basis
      : ladderWins
        ? `${bestLadderRow.name} (ages ${bestLadderRow.firstAge}-${bestLadderRow.lastAge}, ${dollars(bestLadderRow.cost)} today) with ${pct(bestLadderRow.equityShareOfRest)} stocks in the rest scores ${pct(bestLadderRow.worse)} on the worse of long-run and forecast returns vs ${pct(chosen.worse)} with no ladder; ${ladderTest.basis}`
        : `no ladder beats ${pct(chosen.worse)} with no ladder by more than ${POLICY_DEFAULTS.tieTolerance * 100} point (best: ${bestLadderRow.name}, ${pct(bestLadderRow.worse)}); ${ladderTest.basis}`
  if (ladderWins && bestLadderRow !== undefined) {
    proposedShare = bestLadderRow.equityShareOverall
    basis = `with the bridge locked in (${bestLadderRow.name}, counted as bonds), ${pct(bestLadderRow.equityShareOfRest)} stocks in the rest is ${pct(proposedShare)} of the whole portfolio: ${pct(bestLadderRow.worse)} on the worse of long-run and forecast returns vs ${pct(chosen.worse)} at the best share with no ladder`
  }
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

  // 1b. Glide path (REQ-MCP-71): does a share that changes with age beat
  // the constant target? Same seed, long-run and forecast returns.
  const clamp = (v: number) =>
    round2(
      Math.min(POLICY_DEFAULTS.maxShare, Math.max(POLICY_DEFAULTS.minShare, v))
    )
  const from = profile.currentAge
  const retire = Math.max(retirementAge, from + 1)
  const glideCandidates: { name: string; points: GlidePoint[] }[] = [
    {
      name: 'Bond tent',
      points: [
        { age: from, equityShare: clamp(targetShare) },
        {
          age: retire,
          equityShare: clamp(targetShare - POLICY_DEFAULTS.tentDip),
        },
        {
          age: retire + POLICY_DEFAULTS.tentYears,
          equityShare: clamp(targetShare),
        },
      ],
    },
    {
      name: 'Rising after retirement',
      points: [
        { age: from, equityShare: clamp(targetShare) },
        {
          age: retire,
          equityShare: clamp(targetShare - POLICY_DEFAULTS.risingDip),
        },
        {
          age: retire + POLICY_DEFAULTS.risingYears,
          equityShare: clamp(targetShare + POLICY_DEFAULTS.risingTop),
        },
      ],
    },
  ]
  if (profile.glidePath !== undefined && profile.glidePath.length > 0)
    glideCandidates.unshift({
      name: 'Your glide path',
      points: [...profile.glidePath],
    })
  const constantTest = withEquityShare(portfolio, targetShare)
  const noGlide: UserProfile = { ...profile, glidePath: undefined }
  const scoreGlide = (points: GlidePoint[]) => {
    const withPath: UserProfile = { ...profile, glidePath: points }
    const longRun = projectRetirement(portfolio, withPath, run).monteCarlo
      .successRate
    const forecast = projectRetirement(
      portfolio,
      { ...withPath, marketAssumptions: forecastProfile.marketAssumptions },
      run
    ).monteCarlo.successRate
    return {
      successRate: longRun,
      forecastSuccessRate: forecast,
      worse: Math.min(longRun, forecast),
    }
  }
  // REQ-MCP-76: with a winning safe ladder the stock share is the ladder's;
  // a glide path on the whole portfolio would ignore the ladder, so skip it.
  const skipGlide = ladderWins
  const constantRow: GlideTestRow | null = skipGlide
    ? null
    : (() => {
        const longRun = projectRetirement(constantTest, noGlide, run).monteCarlo
          .successRate
        const forecast = projectRetirement(
          constantTest,
          { ...noGlide, marketAssumptions: forecastProfile.marketAssumptions },
          run
        ).monteCarlo.successRate
        return {
          name: `Constant ${pct(targetShare)}`,
          points: [],
          successRate: longRun,
          forecastSuccessRate: forecast,
          worse: Math.min(longRun, forecast),
        }
      })()
  const glideRows: GlideTestRow[] =
    constantRow === null
      ? []
      : [
          constantRow,
          ...glideCandidates.map(c => ({
            name: c.name,
            points: c.points,
            ...scoreGlide(c.points),
          })),
        ]
  const bestGlide = glideRows
    .slice(1)
    .reduce<
      GlideTestRow | undefined
    >((a, b) => (a === undefined || b.worse > a.worse ? b : a), undefined)
  const glideWins =
    constantRow !== null &&
    bestGlide !== undefined &&
    bestGlide.worse > constantRow.worse + POLICY_DEFAULTS.tieTolerance
  const proposedGlide =
    glideWins && bestGlide !== undefined ? bestGlide.points : null
  const glideBasis =
    constantRow === null
      ? 'not tested: the safe ladder locks in the bridge years and sets the stock share'
      : glideWins && bestGlide !== undefined
        ? `${bestGlide.name} scores ${pct(bestGlide.worse)} on the worse of long-run and forecast returns vs ${pct(constantRow.worse)} for a constant ${pct(targetShare)}`
        : `no glide path tested beats a constant ${pct(targetShare)} (${pct(constantRow.worse)}) by more than ${POLICY_DEFAULTS.tieTolerance * 100} point`
  const hasGlide =
    profile.glidePath !== undefined && profile.glidePath.length > 0
  if (proposedGlide !== null) {
    const same = hasGlide && bestGlide?.name === 'Your glide path'
    findings.push({
      rule: 'glidePath',
      status: same ? 'keep' : hasGlide ? 'change' : 'add',
      ...(hasGlide ? { current: profile.glidePath } : {}),
      proposed: proposedGlide,
      reason: `${glideBasis}; saved on the profile (glidePath), and the target each year is the path's share at your age (${pct(glideShareAt(proposedGlide, from, targetShare))} now)`,
    })
  } else if (hasGlide && !skipGlide) {
    findings.push({
      rule: 'glidePath',
      status: 'change',
      current: profile.glidePath,
      proposed: null,
      reason: `${glideBasis}; remove the glide path and hold the target`,
    })
  }

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
  const largestType = largestLadderType(portfolio)
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
  // REQ-MCP-76: a winning safe ladder sets the ladder rule's years and total.
  const safeRule: CdLadderRule | undefined =
    proposedSafeLadder === null
      ? undefined
      : (() => {
          const ages = proposedSafeLadder.rungs.map(r => r.age)
          const yearOf = (age: number) => asOfYear + (age - profile.currentAge)
          return {
            accountType: proposedSafeLadder.accountType,
            ...(current?.cdLadder?.accountName === undefined
              ? {}
              : { accountName: current.cdLadder.accountName }),
            firstYear: yearOf(Math.min(...ages)),
            lastYear: yearOf(Math.max(...ages)),
            total: unitDown(ladderCost(proposedSafeLadder, profile.currentAge)),
          }
        })()
  const proposedLadder: CdLadderRule | undefined =
    safeRule !== undefined
      ? safeRule
      : ladder === null
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
  if (safeRule !== undefined && proposedSafeLadder !== null) {
    const ladderRule = current?.cdLadder
    const same = ladderRule !== undefined && sameLadder(ladderRule, safeRule)
    const kind = proposedSafeLadder.instrument === 'tips' ? 'TIPS' : 'CD'
    findings.push({
      rule: 'cdLadder',
      status: ladderRule === undefined ? 'add' : same ? 'keep' : 'change',
      ...(ladderRule === undefined ? {} : { current: ladderRule }),
      ...(same ? {} : { proposed: safeRule }),
      reason: `buy a ${kind} ladder ${safeRule.firstYear}–${safeRule.lastYear} for ${dollars(safeRule.total ?? 0)} now, one rung a year sized to that year's withdrawals and held to maturity: ${ladderBasis}`,
    })
  } else if (ladder !== null) {
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

  if (proposedSafeLadder !== null) {
    // REQ-MCP-87: rungs in TIPS gap years wait for their January auction.
    const gapAges = new Set(
      tipsGapRungs(proposedSafeLadder, profile, asOfDate).map(r => r.age)
    )
    const far = proposedSafeLadder.rungs.filter(
      r =>
        r.age - profile.currentAge > POLICY_DEFAULTS.maxTermYears &&
        !gapAges.has(Math.floor(r.age))
    )
    if (far.length > 0)
      notes.push(
        `ladder rungs for ages ${far.map(r => r.age).join(', ')} are more than ${POLICY_DEFAULTS.maxTermYears} years out: buy those TIPS on the secondary market, or hold their share in short Treasuries and buy them later`
      )
  }

  // 3b. The safe ladder itself (REQ-MCP-76), saved as profile safeLadder.
  const savedLadder = profile.safeLadder
  const sameSafeLadder =
    savedLadder !== undefined &&
    proposedSafeLadder !== null &&
    JSON.stringify(savedLadder) === JSON.stringify(proposedSafeLadder)
  if (proposedSafeLadder !== null && sameSafeLadder) {
    findings.push({
      rule: 'safeLadder',
      status: 'keep',
      current: savedLadder,
      reason: ladderBasis,
    })
  } else if (proposedSafeLadder !== null) {
    findings.push({
      rule: 'safeLadder',
      status: savedLadder === undefined ? 'add' : 'change',
      ...(savedLadder === undefined ? {} : { current: savedLadder }),
      proposed: proposedSafeLadder,
      reason: `${ladderBasis}; saved on the profile (safeLadder) so every projection counts the locked-in years`,
    })
  } else if (savedLadder !== undefined && bestLadderRow !== undefined) {
    findings.push({
      rule: 'safeLadder',
      status: 'keep',
      current: savedLadder,
      reason: ladderBasis,
    })
  }

  // 3c. Alternatives sleeve (REQ-MCP-78): none, today's, 5%, 10%.
  const altNow = Math.round(sleeveShares(portfolio).alt * 1000) / 1000
  const altRows: {
    share: number
    successRate: number
    forecastSuccessRate: number
    worse: number
  }[] = []
  let altProposed: number | null = null
  let altBasis: string
  if (altNow <= 0) {
    altBasis =
      'no gold, commodities or crypto held: adding them is not tested (compare them with TIPS in market.assets)'
  } else {
    const shares = [...new Set([0, altNow, 0.05, 0.1])].sort((a, b) => a - b)
    const forecastPlan: UserProfile = {
      ...profile,
      marketAssumptions: { ...profile.marketAssumptions, preset: 'forecast' },
    }
    for (const share of shares) {
      const test = withAltShare(portfolio, share)
      const successRate = projectRetirement(test, profile, run).monteCarlo
        .successRate
      const forecastSuccessRate = projectRetirement(test, forecastPlan, run)
        .monteCarlo.successRate
      altRows.push({
        share,
        successRate,
        forecastSuccessRate,
        worse: Math.min(successRate, forecastSuccessRate),
      })
    }
    const nowRow = altRows.find(
      r => r.share === altNow
    ) as (typeof altRows)[number]
    const top = Math.max(...altRows.map(r => r.worse))
    const best = altRows.find(
      r => r.worse >= top - POLICY_DEFAULTS.tieTolerance
    ) as (typeof altRows)[number]
    if (best.worse > nowRow.worse + POLICY_DEFAULTS.tieTolerance) {
      altProposed = best.share
      altBasis = `${pct(best.share)} in gold and other alternatives scores ${pct(best.worse)} on the worse of long-run and forecast returns vs ${pct(nowRow.worse)} at today's ${pct(altNow)}; the difference comes from or goes to cash and bonds`
      findings.push({
        rule: 'altShare',
        status: 'change',
        current: altNow,
        proposed: best.share,
        reason: `${altBasis}. ${best.share < altNow ? 'Trim' : 'Add to'} the holding to about ${pct(best.share)} of the portfolio`,
      })
    } else
      altBasis = `today's ${pct(altNow)} in gold and other alternatives is within ${POLICY_DEFAULTS.tieTolerance * 100} point of the best share tested (${pct(nowRow.worse)} on the worse of long-run and forecast returns): keep it`
  }

  // 3d. Income annuity at Social Security age (REQ-MCP-80).
  const annuityAge = Math.max(socialSecurityAge, profile.targetRetirementAge)
  const quotes = profile.marketData?.annuityQuotes ?? []
  const wantJoint = profile.spouse !== undefined
  const quote = [...quotes]
    .filter(
      q => q.joint === wantJoint || quotes.every(o => o.joint !== wantJoint)
    )
    .sort(
      (a, b) =>
        Math.abs(a.age - annuityAge) - Math.abs(b.age - annuityAge) ||
        a.age - b.age
    )[0]
  const annuityRows: {
    share: number
    premium: number
    successRate: number
    forecastSuccessRate: number
    worse: number
  }[] = []
  let annuityProposed: IncomeAnnuity | null = null
  let annuityBasis: string
  const annuityType = largestLadderType(portfolio)
  if (profile.incomeAnnuity !== undefined) {
    annuityBasis = 'an income annuity is already in the plan: not re-tested'
  } else if (quote === undefined) {
    annuityBasis =
      'no annuity quotes saved: add annuityQuotes (SPIA payout rates by age, joint for a couple) with save_market_data to test an income annuity'
  } else if (annuityType === undefined) {
    annuityBasis = 'no retirement account to buy an annuity from'
  } else {
    const balanceAt = projectRetirement(
      portfolio,
      profile,
      run
    ).expectedPath.years.find(y => y.age === annuityAge - 1)?.endBalances.total
    const base = Math.max(0, balanceAt ?? 0)
    const forecastPlan = (p: UserProfile): UserProfile => ({
      ...p,
      marketAssumptions: { ...p.marketAssumptions, preset: 'forecast' },
    })
    for (const share of [0, 0.25, 0.5]) {
      const premium = unitDown(base * share)
      const plan: UserProfile =
        premium <= 0
          ? profile
          : {
              ...profile,
              incomeAnnuity: {
                purchaseAge: annuityAge,
                premium,
                payoutRate: quote.payoutRate,
                accountType: annuityType,
                joint: quote.joint,
              },
            }
      const successRate = projectRetirement(portfolio, plan, run).monteCarlo
        .successRate
      const forecastSuccessRate = projectRetirement(
        portfolio,
        forecastPlan(plan),
        run
      ).monteCarlo.successRate
      annuityRows.push({
        share,
        premium,
        successRate,
        forecastSuccessRate,
        worse: Math.min(successRate, forecastSuccessRate),
      })
    }
    const none = annuityRows[0] as (typeof annuityRows)[number]
    const top = annuityRows.reduce((a, b) => (b.worse > a.worse ? b : a))
    const quoteText = `${(quote.payoutRate * 100).toFixed(1)}% ${quote.joint ? 'joint' : 'single'}-life payout at ${quote.age} (${quote.source}, ${quote.asOf})`
    if (
      top.share > 0 &&
      top.worse > none.worse + POLICY_DEFAULTS.tieTolerance
    ) {
      annuityProposed = {
        purchaseAge: annuityAge,
        premium: top.premium,
        payoutRate: quote.payoutRate,
        accountType: annuityType,
        joint: quote.joint,
      }
      annuityBasis = `buying a lifetime annuity at ${annuityAge} with ${pct(top.share)} of the expected balance then (${dollars(top.premium)} today) at a ${quoteText} scores ${pct(top.worse)} on the worse of long-run and forecast returns vs ${pct(none.worse)} with none; the payout is fixed in dollars, and the rate is today's quote: get real quotes before buying`
      findings.push({
        rule: 'incomeAnnuity',
        status: 'add',
        proposed: annuityProposed,
        reason: annuityBasis,
      })
    } else
      annuityBasis = `an annuity at ${annuityAge} (${quoteText}) does not beat none by more than ${POLICY_DEFAULTS.tieTolerance * 100} point (${pct(top.worse)} best vs ${pct(none.worse)})`
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
    // Sales the engine proposed before and are not done yet are worked out
    // again from today's figures, so each review replaces them instead of
    // adding to them. The owner's own sales stay.
    sellSchedule: (current?.sellSchedule ?? []).filter(
      s => !(s.id.startsWith('policy-') && s.done !== true)
    ),
  }
  const earlierPolicySales = (current?.sellSchedule ?? []).filter(
    s => s.id.startsWith('policy-') && s.done !== true
  )
  const check = checkPlan(portfolio, profile, baseRules, asOfDate)
  let sellSchedule: ScheduledSale[] = [...(baseRules.sellSchedule ?? [])]
  const rebalance = check.recommendations.find(r => r.kind === 'rebalance_sell')
  // One run of monthly sales per holding the rebalance sells from.
  const bySymbol = new Map<
    string,
    { amount: number; accountType: AccountType; accountName: string }
  >()
  for (const t of rebalance?.trades ?? []) {
    const prev = bySymbol.get(t.symbol)
    bySymbol.set(t.symbol, {
      amount: (prev?.amount ?? 0) + t.amount,
      accountType: t.accountType,
      accountName: t.accountName,
    })
  }
  const saleLines = [...bySymbol.entries()]
    .map(([symbol, v]) => ({ symbol, ...v, amount: unitDown(v.amount) }))
    .filter(v => v.amount >= POLICY_DEFAULTS.unit)
  if (rebalance !== undefined && saleLines.length > 0) {
    const added: ScheduledSale[] = []
    for (const line of saleLines) {
      const chunks =
        line.amount >= POLICY_DEFAULTS.saleChunks * POLICY_DEFAULTS.unit
          ? POLICY_DEFAULTS.saleChunks
          : 1
      const each = unitDown(line.amount / chunks)
      nextFifteenths(asOfDate, chunks).forEach((dueDate, i) =>
        added.push({
          id: `policy-${line.symbol.toLowerCase()}-${dueDate}`,
          dueDate,
          symbol: line.symbol,
          amount: i === chunks - 1 ? line.amount - each * (chunks - 1) : each,
          accountType: line.accountType,
        })
      )
    }
    sellSchedule = [...sellSchedule, ...added]
    const total = saleLines.reduce((sum, l) => sum + l.amount, 0)
    // The same sales worked out again are kept, not reported as a change.
    const unchanged = sameSales(earlierPolicySales, added)
    findings.push({
      rule: 'sellSchedule',
      status: unchanged
        ? 'keep'
        : earlierPolicySales.length > 0
          ? 'change'
          : 'add',
      ...(earlierPolicySales.length > 0 ? { current: earlierPolicySales } : {}),
      proposed: added,
      reason: `stocks stay above ${pct(targetShare)} ± ${pct(driftBand)} after your own scheduled sales: sell ${dollars(total)} more (${saleLines.map(l => `${dollars(l.amount)} ${l.symbol} in ${l.accountName}`).join(', ')}), in monthly sales${earlierPolicySales.length > 0 ? '; this replaces the sales the engine proposed before' : ''}`,
    })
  } else {
    // Scheduled sales that would take stocks well below the proposed share.
    const undone = (baseRules.sellSchedule ?? []).filter(s => s.done !== true)
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
    } else if (earlierPolicySales.length > 0) {
      findings.push({
        rule: 'sellSchedule',
        status: 'change',
        current: earlierPolicySales,
        proposed: undone,
        reason: `the sales the engine proposed before are no longer needed: stocks are within ${pct(driftBand)} of ${pct(targetShare)} without them`,
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

  // REQ-MCP-87: a dated task for each TIPS gap-year rung, at the January
  // auction that creates it. Existing tasks with the same id are kept.
  const gapRungs = tipsGapRungs(
    proposedSafeLadder ?? profile.safeLadder,
    profile,
    asOfDate
  )
  const existingTasks = baseRules.tasks ?? []
  const gapTasks = gapRungs
    .filter(r => !existingTasks.some(t => t.id === `tips-gap-${r.year}`))
    .map(r => ({
      id: `tips-gap-${r.year}`,
      dueDate: `${r.auctionYear}-01-15`,
      action: `Buy about ${dollars(Math.round(r.cost / 1000) * 1000)} (today's dollars) of the new 10-year TIPS maturing in January ${r.year} at the January ${r.auctionYear} auction, for the age-${r.age} ladder rung; no TIPS mature in ${r.year} before then, so hold it in short Treasuries until the auction`,
    }))
  if (gapTasks.length > 0)
    notes.push(
      `no TIPS mature in ${gapRungs.map(r => r.year).join(', ')} yet (ladder ages ${gapRungs.map(r => r.age).join(', ')}): each is bought at the January 10-year TIPS auction ten years earlier (${gapRungs.map(r => `${r.auctionYear} for ${r.year}`).join(', ')}), added as dated tasks; the alternative is to buy extra July 2036 and February 2040 TIPS now (the bracket method)`
    )
  const proposedRules: PlanRules = {
    ...baseRules,
    sellSchedule,
    ...(gapTasks.length > 0 ? { tasks: [...existingTasks, ...gapTasks] } : {}),
  }
  if (sellSchedule.length === 0)
    delete (proposedRules as { sellSchedule?: unknown }).sellSchedule
  if (gapTasks.length > 0)
    findings.push({
      rule: 'tasks',
      status: 'add',
      proposed: gapTasks,
      reason: `no TIPS mature in ${gapTasks.map(t => t.id.slice(-4)).join(', ')} yet: buy each at its January 10-year TIPS auction`,
    })
  return {
    asOfDate,
    snapshotDate: portfolio.asOfDate,
    retirementAge,
    retirementYear,
    yearsToRetirement,
    socialSecurityAge,
    currentEquityShare: Math.round(actualShare * 10_000) / 10_000,
    equityTest: { rows, proposed: proposedShare, basis },
    glideTest: { rows: glideRows, proposed: proposedGlide, basis: glideBasis },
    annuityTest: {
      purchaseAge: annuityAge,
      payoutRate: quote?.payoutRate ?? null,
      rows: annuityRows,
      proposed: annuityProposed,
      basis: annuityBasis,
    },
    altTest: {
      currentShare: altNow,
      rows: altRows,
      proposed: altProposed,
      basis: altBasis,
    },
    ladder,
    market,
    safeLadderTest: {
      rows: ladderTest.rows,
      proposed: proposedSafeLadder,
      basis: ladderBasis,
    },
    findings,
    changes: findings.filter(f => f.status === 'change' || f.status === 'add')
      .length,
    proposedRules,
    notes,
  }
}
