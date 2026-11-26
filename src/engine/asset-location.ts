/**
 * REQ-MCP-85: asset location. With the overall mix unchanged, interest is
 * cheapest to hold where it is not taxed each year (pre-tax accounts), and
 * expected growth is worth most where it is never taxed (Roth and HSA).
 * Swaps sell and buy inside each account, so nothing is withdrawn and
 * nothing is taxed. Deterministic; no market data is required.
 */
import { bucketOf } from './retirement-projection'
import type { AccountType, Holding, Portfolio, UserProfile } from './types'

type Place = 'taxable' | 'preTax' | 'taxFree'

const BOND_CLASSES: readonly Holding['assetClass'][] = [
  'us_bond',
  'intl_bond',
  'tips',
]
const STOCK_CLASSES: readonly Holding['assetClass'][] = [
  'us_equity',
  'intl_equity',
  'emerging_equity',
  'reit',
]

export const ASSET_LOCATION_DEFAULTS = {
  /** Swaps smaller than this are not worth the trades. */
  minSwap: 5_000,
  /** Bond yield used when no Treasury yield is saved. */
  fallbackYield: 0.04,
  /** Swaps are in whole thousands. */
  unit: 1_000,
} as const

function placeOf(accountType: AccountType): Place | null {
  switch (bucketOf(accountType)) {
    case 'taxable':
      return 'taxable'
    case 'employerPlan':
    case 'ira':
      return 'preTax'
    case 'roth':
      return 'taxFree'
    default:
      // Deferred comp is paid out on a schedule; it is not a place to swap.
      return null
  }
}

export interface LocationSwap {
  /** Sell this in `sellIn`, and the same amount the other way in `buyIn`. */
  readonly sellIn: Place
  readonly buyIn: Place
  readonly amount: number
  readonly reason: string
}

export interface AssetLocationResult {
  readonly byPlace: Record<
    Place,
    { readonly stocks: number; readonly bonds: number; readonly cash: number }
  >
  readonly swaps: readonly LocationSwap[]
  readonly headline: string
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`

export function assetLocation(
  portfolio: Portfolio,
  profile: UserProfile
): AssetLocationResult {
  const protectedTypes = new Set(profile.planRules?.protectedAccountTypes ?? [])
  const byPlace: Record<
    Place,
    { stocks: number; bonds: number; cash: number }
  > = {
    taxable: { stocks: 0, bonds: 0, cash: 0 },
    preTax: { stocks: 0, bonds: 0, cash: 0 },
    taxFree: { stocks: 0, bonds: 0, cash: 0 },
  }
  // Movable amounts leave out accounts the owner protected.
  const movable: Record<
    Place,
    { stocks: number; bonds: number; safe: number }
  > = {
    taxable: { stocks: 0, bonds: 0, safe: 0 },
    preTax: { stocks: 0, bonds: 0, safe: 0 },
    taxFree: { stocks: 0, bonds: 0, safe: 0 },
  }
  for (const account of portfolio.accounts) {
    const place = placeOf(account.accountType)
    if (place === null) continue
    const free = !protectedTypes.has(account.accountType)
    const cash =
      Math.max(0, account.cashBalance) +
      account.cds.reduce((s, cd) => s + Math.max(0, cd.principal), 0)
    byPlace[place].cash += cash
    if (free) movable[place].safe += cash
    for (const h of account.holdings) {
      const value = Math.max(0, h.currentValue)
      if (STOCK_CLASSES.includes(h.assetClass)) {
        byPlace[place].stocks += value
        if (free) movable[place].stocks += value
      } else if (BOND_CLASSES.includes(h.assetClass)) {
        byPlace[place].bonds += value
        if (free) {
          movable[place].bonds += value
          movable[place].safe += value
        }
      } else if (
        h.assetClass === 'money_market' ||
        h.assetClass === 'cash' ||
        h.assetClass === 'cd'
      ) {
        byPlace[place].cash += value
        if (free) movable[place].safe += value
      }
    }
  }

  const yieldNow =
    profile.marketData?.treasury10y ?? ASSET_LOCATION_DEFAULTS.fallbackYield
  const unit = ASSET_LOCATION_DEFAULTS.unit
  const floor = (n: number) => Math.floor(n / unit) * unit
  const swaps: LocationSwap[] = []
  let preTaxStocks = movable.preTax.stocks

  // 1. Bonds held in taxable (cash stays: it is the spending buffer).
  const taxableSwap = floor(Math.min(movable.taxable.bonds, preTaxStocks))
  if (taxableSwap >= ASSET_LOCATION_DEFAULTS.minSwap) {
    preTaxStocks -= taxableSwap
    swaps.push({
      sellIn: 'taxable',
      buyIn: 'preTax',
      amount: taxableSwap,
      reason: `sell ${money(taxableSwap)} of bonds in taxable and buy the same in stocks there; in the pre-tax accounts sell ${money(taxableSwap)} of stocks and buy bonds. The mix stays the same, and about ${money(taxableSwap * yieldNow)} a year of interest (at ${(yieldNow * 100).toFixed(2)}%) is no longer taxed each year; stock gains in taxable are taxed only when sold, at capital-gains rates`,
    })
  }
  // 2. Bonds and cash in Roth/HSA, where growth is never taxed.
  const rothSwap = floor(Math.min(movable.taxFree.safe, preTaxStocks))
  if (rothSwap >= ASSET_LOCATION_DEFAULTS.minSwap) {
    swaps.push({
      sellIn: 'taxFree',
      buyIn: 'preTax',
      amount: rothSwap,
      reason: `in the Roth/HSA sell ${money(rothSwap)} of bonds or cash and buy stocks; in the pre-tax accounts sell ${money(rothSwap)} of stocks and buy bonds. The mix stays the same, and the growth lands where it is never taxed`,
    })
  }
  const headline =
    swaps.length === 0
      ? 'Asset location is fine: no swap of $5,000 or more would put bonds where interest is not taxed or stocks where growth is tax-free'
      : `Asset location: ${swaps.map(s => `swap ${money(s.amount)} between ${s.sellIn === 'taxable' ? 'taxable' : 'Roth/HSA'} and pre-tax`).join('; ')}, with the overall mix unchanged`
  return { byPlace, swaps, headline }
}
