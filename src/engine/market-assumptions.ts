// Near-term market assumptions (REQ-MCP-51). The engine's long-run means
// (MONTE_CARLO_DEFAULTS: stocks 7%, bonds 4%, inflation 3%) can be replaced
// for the first years of a projection by the owner's own means or by the
// 10-year valuation-based forecasts below, then revert to the long-run
// means. Volatility is unchanged. Deterministic: committed numbers only.
import { MONTE_CARLO_DEFAULTS } from './config'
import type { MarketAssumptions, UserProfile } from './types'

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

/** The near-term and long-run means a profile's marketAssumptions resolve to. */
export function resolveMarketAssumptions(
  assumptions: MarketAssumptions | undefined
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
  const base =
    assumptions.preset === 'forecast'
      ? {
          equity: MARKET_FORECAST.equityMean,
          bond: MARKET_FORECAST.bondMean,
          inflation: MARKET_FORECAST.inflationMean,
        }
      : longRun
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
          ? `${MARKET_FORECAST.source}, with your overrides`
          : MARKET_FORECAST.source
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
  const resolved = resolveMarketAssumptions(profile.marketAssumptions)
  return yearIndex < resolved.years ? resolved.nearTerm : resolved.longRun
}
