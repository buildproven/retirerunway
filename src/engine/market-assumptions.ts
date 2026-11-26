// Near-term market assumptions (REQ-MCP-51). The engine's long-run means
// (MONTE_CARLO_DEFAULTS: stocks 7%, bonds 4%, inflation 3%) can be replaced
// for the first years of a projection by the owner's own means or by the
// 10-year valuation-based forecasts below, then revert to the long-run
// means. Volatility is unchanged. Deterministic: committed numbers only.
import { MONTE_CARLO_DEFAULTS } from './config'
import type { MarketAssumptions, MarketData, UserProfile } from './types'

/**
 * The 10-year valuation-based forecast preset (retrieved 2026-11-21):
 * Vanguard's 2026 outlook (Vanguard Capital Markets Model, December 2025)
 * puts US equities at 4%-5% a year over the next five to ten years and
 * high-quality US bonds at about 4%; Morningstar's 2026 survey of firms'
 * forecasts has a 3.5%-5.5% median range for US equities. Midpoints used;
 * inflation stays at the engine's 3%.
 */
export const MARKET_FORECAST = {
  equityMean: 0.045,
  bondMean: 0.04,
  inflationMean: MONTE_CARLO_DEFAULTS.INFLATION_MEAN,
  years: 10,
  source:
    'Vanguard 2026 outlook (VCMM, Dec 2025): US equities 4%-5% a year for 5-10 years, high-quality US bonds about 4%; Morningstar 2026 survey of firms: US equities 3.5%-5.5%',
} as const

export const LONG_RUN = {
  equityMean: MONTE_CARLO_DEFAULTS.EQUITY_MEAN,
  bondMean: MONTE_CARLO_DEFAULTS.BOND_MEAN,
  inflationMean: MONTE_CARLO_DEFAULTS.INFLATION_MEAN,
} as const

export interface YearMeans {
  readonly equity: number
  readonly bond: number
  readonly inflation: number
}

export interface ResolvedMarketAssumptions {
  readonly nearTerm: YearMeans
  readonly years: number
  readonly longRun: YearMeans
  readonly source: string
}

/** Saved market data older than this many days is stale (REQ-MCP-75). */
export const MARKET_DATA_STALE_DAYS = 35

/**
 * The 10-year means saved market data implies (REQ-MCP-75): stocks at the
 * average of the firms' forecasts, bonds at the 10-year Treasury yield, and
 * inflation at the breakeven (Treasury less TIPS real yield). A figure the
 * data lacks falls back to MARKET_FORECAST. Deterministic: inputs only.
 */
export function marketDataMeans(data: MarketData): YearMeans & {
  readonly source: string
} {
  const forecasts = data.stockForecasts ?? []
  const equity =
    forecasts.length > 0
      ? forecasts.reduce((sum, f) => sum + f.mean, 0) / forecasts.length
      : MARKET_FORECAST.equityMean
  const bond = data.treasury10y ?? MARKET_FORECAST.bondMean
  const breakeven =
    data.treasury10y !== undefined && data.tipsReal10y !== undefined
      ? Math.min(0.1, Math.max(0, data.treasury10y - data.tipsReal10y))
      : MARKET_FORECAST.inflationMean
  const parts = [
    forecasts.length > 0
      ? `stocks: average of ${forecasts.map(f => `${f.source} ${(f.mean * 100).toFixed(1)}% (${f.asOf})`).join(', ')}`
      : 'stocks: committed forecast',
    data.treasury10y !== undefined
      ? `bonds: 10-year Treasury ${(data.treasury10y * 100).toFixed(2)}%`
      : 'bonds: committed forecast',
    data.treasury10y !== undefined && data.tipsReal10y !== undefined
      ? `inflation: breakeven ${(breakeven * 100).toFixed(2)}% (Treasury less TIPS ${(data.tipsReal10y * 100).toFixed(2)}%)`
      : 'inflation: engine default',
  ]
  return {
    equity,
    bond,
    inflation: breakeven,
    source: `market data of ${data.asOfDate} (${parts.join('; ')})`,
  }
}

/** Whole days from the market data's date to `asOfDate`. */
export function marketDataAgeDays(data: MarketData, asOfDate: string): number {
  const from = Date.parse(`${data.asOfDate}T00:00:00Z`)
  const to = Date.parse(`${asOfDate}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Infinity
  return Math.floor((to - from) / 86_400_000)
}

/** The near-term and long-run means a profile's marketAssumptions resolve to. */
export function resolveMarketAssumptions(
  assumptions: MarketAssumptions | undefined,
  marketData?: MarketData
): ResolvedMarketAssumptions {
  const longRun = {
    equity: LONG_RUN.equityMean,
    bond: LONG_RUN.bondMean,
    inflation: LONG_RUN.inflationMean,
  }
  if (assumptions === undefined) {
    return {
      nearTerm: longRun,
      years: 0,
      longRun,
      source: 'engine long-run means',
    }
  }
  const live =
    assumptions.preset === 'forecast' && marketData !== undefined
      ? marketDataMeans(marketData)
      : undefined
  const base =
    live !== undefined
      ? { equity: live.equity, bond: live.bond, inflation: live.inflation }
      : assumptions.preset === 'forecast'
        ? {
            equity: MARKET_FORECAST.equityMean,
            bond: MARKET_FORECAST.bondMean,
            inflation: MARKET_FORECAST.inflationMean,
          }
        : longRun
  const forecastSource = live?.source ?? MARKET_FORECAST.source
  const nearTerm = {
    equity: assumptions.equityMean ?? base.equity,
    bond: assumptions.bondMean ?? base.bond,
    inflation: assumptions.inflationMean ?? base.inflation,
  }
  const custom =
    assumptions.equityMean !== undefined ||
    assumptions.bondMean !== undefined ||
    assumptions.inflationMean !== undefined
  return {
    nearTerm,
    years: assumptions.years ?? MARKET_FORECAST.years,
    longRun,
    source:
      assumptions.preset === 'forecast'
        ? custom
          ? `${forecastSource}, with your overrides`
          : forecastSource
        : custom
          ? 'your own means'
          : 'engine long-run means',
  }
}

/** The means for the projection year at `yearIndex` (0 = the first year after today). */
export function meansForYear(
  profile: UserProfile,
  yearIndex: number
): YearMeans {
  const resolved = resolveMarketAssumptions(
    profile.marketAssumptions,
    profile.marketData
  )
  return yearIndex < resolved.years ? resolved.nearTerm : resolved.longRun
}

/**
 * REQ-MCP-78: the near-term sleeve means the owner's own holdings imply
 * under preset 'forecast' with saved asset forecasts: stocks from the
 * classes held (a class without a forecast at the preset's stock mean),
 * alternatives likewise. Owner overrides (equityMean) win. `years` is 0
 * when nothing applies.
 */
export function holdingsNearTerm(
  profile: UserProfile,
  sleeveMean: (
    sleeve: 'equity' | 'alt',
    fallback: number
  ) => number | undefined,
  altFallback: number
): { years: number; equity?: number; alt?: number } {
  const assumptions = profile.marketAssumptions
  if (
    assumptions?.preset !== 'forecast' ||
    profile.marketData === undefined ||
    (profile.marketData.assetForecasts ?? []).length === 0
  )
    return { years: 0 }
  const resolved = resolveMarketAssumptions(assumptions, profile.marketData)
  const equity =
    assumptions.equityMean === undefined
      ? sleeveMean('equity', resolved.nearTerm.equity)
      : undefined
  const alt = sleeveMean('alt', altFallback)
  return {
    years: resolved.years,
    ...(equity === undefined ? {} : { equity }),
    ...(alt === undefined ? {} : { alt }),
  }
}
