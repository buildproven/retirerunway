// Asset classes beyond stocks and bonds (REQ-MCP-78, ADR-014). Holdings fall
// into three sleeves: stocks (US, international, emerging, REITs), the safe
// sleeve (bonds, TIPS, CDs, cash, money market) and alternatives (gold and
// other commodities, crypto, other). Alternatives get their own return and
// volatility in the projection instead of being counted as bonds. Saved
// firm forecasts by asset class (marketData.assetForecasts) set each
// sleeve's 10-year mean from the classes the owner holds, and are compared
// with the TIPS real yield. Deterministic: inputs only.
import type {
  AssetClass,
  AssetForecast,
  Holding,
  MarketData,
  Portfolio,
} from './types'

export type Sleeve = 'equity' | 'safe' | 'alt'

/** Which sleeve each asset class is modelled in. */
export function sleeveOf(assetClass: AssetClass): Sleeve {
  switch (assetClass) {
    case 'us_equity':
    case 'intl_equity':
    case 'emerging_equity':
    case 'reit':
      return 'equity'
    case 'commodity':
    case 'crypto':
    case 'other':
      return 'alt'
    default:
      return 'safe'
  }
}

/**
 * Long-run alternatives sleeve: about 1% a year above the engine's 3%
 * inflation (studies of gold's long-run real return mostly land between 0%
 * and 1%), with gold-like volatility, drawn independently of stocks and
 * bonds.
 */
export const ALT_DEFAULTS = {
  mean: 0.04,
  stdDev: 0.16,
} as const

/** Typical annual volatility by asset class, for the reward-per-risk comparison. */
export const ASSET_VOLATILITY: Readonly<Record<AssetClass, number>> = {
  us_equity: 0.16,
  intl_equity: 0.17,
  emerging_equity: 0.21,
  reit: 0.2,
  us_bond: 0.06,
  intl_bond: 0.07,
  tips: 0.06,
  money_market: 0.01,
  cd: 0.01,
  cash: 0.01,
  commodity: 0.16,
  crypto: 0.6,
  other: 0.16,
}

/** Value-weighted shares of the stock and alternatives sleeves. */
export function sleeveShares(portfolio: Portfolio): {
  equity: number
  alt: number
} {
  let total = 0
  let equity = 0
  let alt = 0
  for (const account of portfolio.accounts) {
    total += account.cashBalance
    for (const cd of account.cds) total += cd.principal
    for (const holding of account.holdings) {
      total += holding.currentValue
      const sleeve = sleeveOf(holding.assetClass)
      if (sleeve === 'equity') equity += holding.currentValue
      else if (sleeve === 'alt') alt += holding.currentValue
    }
  }
  if (total <= 0) return { equity: 0, alt: 0 }
  return { equity: equity / total, alt: alt / total }
}

/** The average saved forecast for one asset class, or undefined. */
export function forecastFor(
  data: MarketData | undefined,
  assetClass: AssetClass
): number | undefined {
  const rows = (data?.assetForecasts ?? []).filter(
    f => f.assetClass === assetClass
  )
  if (rows.length === 0) return undefined
  return rows.reduce((sum, f) => sum + f.mean, 0) / rows.length
}

function holdingsOf(portfolio: Portfolio): Holding[] {
  return portfolio.accounts.flatMap(account => account.holdings)
}

/**
 * The 10-year mean for one sleeve from the classes the owner holds in it:
 * each class at its saved forecast, a class without one at `fallback`.
 * Undefined when the sleeve is empty or no held class has a forecast.
 */
export function sleeveForecast(
  portfolio: Portfolio,
  data: MarketData | undefined,
  sleeve: Sleeve,
  fallback: number
): number | undefined {
  let value = 0
  let weighted = 0
  let anyForecast = false
  for (const holding of holdingsOf(portfolio)) {
    if (sleeveOf(holding.assetClass) !== sleeve || holding.currentValue <= 0)
      continue
    const f = forecastFor(data, holding.assetClass)
    if (f !== undefined) anyForecast = true
    value += holding.currentValue
    weighted += holding.currentValue * (f ?? fallback)
  }
  if (value <= 0 || !anyForecast) return undefined
  return weighted / value
}

export interface AssetComparisonRow {
  readonly name: string
  readonly assetClass: AssetClass
  /** Average of the saved forecasts for this name (nominal, a year). */
  readonly forecast: number
  /** Forecast less breakeven inflation. */
  readonly realForecast: number
  /** Real forecast less the TIPS real yield. */
  readonly premiumOverTips: number
  readonly volatility: number
  /** Premium over TIPS per unit of volatility. */
  readonly rewardPerRisk: number
  readonly verdict: 'below TIPS' | 'thin' | 'fair' | 'strong'
  readonly sources: readonly string[]
}

/** Reward per unit of risk below which the premium is called thin. */
export const THIN_REWARD = 0.1
/** Reward per unit of risk at or above which it is called strong. */
export const STRONG_REWARD = 0.25

/**
 * Each saved asset forecast against TIPS (REQ-MCP-78): real return, premium
 * over the TIPS real yield, and that premium per unit of volatility, best
 * first. Empty without the TIPS and Treasury yields.
 */
export function compareAssets(
  data: MarketData | undefined
): AssetComparisonRow[] {
  if (
    data === undefined ||
    data.tipsReal10y === undefined ||
    data.treasury10y === undefined
  )
    return []
  const tips = data.tipsReal10y
  const breakeven = data.treasury10y - tips
  const byName = new Map<string, AssetForecast[]>()
  for (const f of data.assetForecasts ?? [])
    byName.set(f.name, [...(byName.get(f.name) ?? []), f])
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000
  const rows: AssetComparisonRow[] = []
  for (const [name, list] of byName) {
    const first = list[0] as AssetForecast
    const forecast = list.reduce((sum, f) => sum + f.mean, 0) / list.length
    const realForecast = forecast - breakeven
    const premium = realForecast - tips
    const volatility = first.volatility ?? ASSET_VOLATILITY[first.assetClass]
    const reward = volatility > 0 ? premium / volatility : 0
    rows.push({
      name,
      assetClass: first.assetClass,
      forecast: r4(forecast),
      realForecast: r4(realForecast),
      premiumOverTips: r4(premium),
      volatility,
      rewardPerRisk: Math.round(reward * 100) / 100,
      verdict:
        premium < 0
          ? 'below TIPS'
          : reward < THIN_REWARD
            ? 'thin'
            : reward < STRONG_REWARD
              ? 'fair'
              : 'strong',
      sources: list.map(f => `${f.source} (${f.asOf})`),
    })
  }
  return rows.sort(
    (a, b) => b.rewardPerRisk - a.rewardPerRisk || a.name.localeCompare(b.name)
  )
}

/**
 * The portfolio with its alternatives sleeve rescaled to `share` of the
 * total, the difference taken from or added to the safe sleeve (cash, CDs
 * and bond-like holdings, in proportion) account by account. Stocks are
 * untouched. Used to test an alternatives share.
 */
export function withAltShare(portfolio: Portfolio, share: number): Portfolio {
  const total = portfolio.accounts.reduce(
    (sum, a) =>
      sum +
      a.cashBalance +
      a.cds.reduce((s, cd) => s + cd.principal, 0) +
      a.holdings.reduce((s, h) => s + h.currentValue, 0),
    0
  )
  const current = sleeveShares(portfolio).alt * total
  const target = Math.max(0, Math.min(1, share)) * total
  if (current <= 0 && target > 0) return portfolio
  const altScale = current > 0 ? target / current : 0
  const freed = current - target
  const safeTotal = portfolio.accounts.reduce(
    (sum, a) =>
      sum +
      a.cashBalance +
      a.cds.reduce((s, cd) => s + cd.principal, 0) +
      a.holdings
        .filter(h => sleeveOf(h.assetClass) === 'safe')
        .reduce((s, h) => s + h.currentValue, 0),
    0
  )
  if (freed < 0 && safeTotal + freed < 0) return portfolio
  const safeScale = safeTotal > 0 ? (safeTotal + freed) / safeTotal : 1
  const scale = <
    T extends { currentValue: number; shares: number; costBasis: number },
  >(
    h: T,
    k: number
  ): T => ({
    ...h,
    currentValue: h.currentValue * k,
    shares: h.shares * k,
    costBasis: h.costBasis * k,
  })
  return {
    ...portfolio,
    accounts: portfolio.accounts.map(account => {
      const altInAccount = account.holdings
        .filter(h => sleeveOf(h.assetClass) === 'alt')
        .reduce((s, h) => s + h.currentValue, 0)
      const released = altInAccount * (1 - altScale)
      // Freed money lands as cash in the same account; a top-up is drawn
      // from the safe sleeve in proportion.
      const keepSafe = freed >= 0 ? 1 : safeScale
      return {
        ...account,
        cashBalance:
          account.cashBalance * keepSafe + (freed >= 0 ? released : 0),
        cds: account.cds.map(cd => ({
          ...cd,
          principal: cd.principal * keepSafe,
        })),
        holdings: account.holdings.map(h => {
          const sleeve = sleeveOf(h.assetClass)
          if (sleeve === 'alt') return scale(h, altScale)
          if (sleeve === 'safe' && freed < 0) return scale(h, keepSafe)
          return h
        }),
      }
    }),
  }
}
