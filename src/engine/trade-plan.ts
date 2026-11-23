import type {
  Portfolio,
  UserProfile,
  Trade,
  TradePlan,
  Holding,
  Account,
  AccountType,
} from './types'

interface TradePlanConfig {
  targetCashPosition: number
  maxTrades: number
  tradeIncrement: number
  taxRate?: number
}

const DEFAULT_CONFIG: TradePlanConfig = {
  targetCashPosition: 0,
  maxTrades: 10,
  tradeIncrement: 5000,
}

const ACCOUNT_TAX_PRIORITY: Record<AccountType, number> = {
  brokerage: 1,
  '401k': 2,
  '403b': 2,
  '457b': 2,
  nqdc: 2,
  traditional_ira: 3,
  rollover_ira: 3,
  roth_401k: 4,
  roth_ira: 5,
  hsa: 6,
}

function isEquityClass(assetClass: string): boolean {
  return (
    assetClass === 'us_equity' ||
    assetClass === 'intl_equity' ||
    assetClass === 'emerging_equity'
  )
}

function isTaxAdvantaged(accountType: AccountType): boolean {
  return accountType !== 'brokerage'
}

function estimateGainPercent(holding: Holding): number {
  if (holding.costBasis === 0) return 0
  return (holding.currentValue - holding.costBasis) / holding.costBasis
}

interface SellCandidate {
  holding: Holding
  account: Account
  priority: number
  estimatedTaxRate: number
}

function buildSellCandidates(
  portfolio: Portfolio,
  taxRate: number
): SellCandidate[] {
  const candidates: SellCandidate[] = []

  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      if (!isEquityClass(holding.assetClass)) continue
      if (holding.currentValue <= 0) continue

      const accountPriority = ACCOUNT_TAX_PRIORITY[account.accountType]
      const gainPct = estimateGainPercent(holding)
      const effectiveTaxRate = isTaxAdvantaged(account.accountType)
        ? 0
        : taxRate

      // Lower priority number = sell first
      // Sell from taxable accounts first (lower ACCOUNT_TAX_PRIORITY)
      // Within taxable: sell lowest-gain holdings first (tax-loss harvesting)
      // Within tax-advantaged: sell largest positions first (rebalancing)
      let priority: number
      if (!isTaxAdvantaged(account.accountType)) {
        priority = accountPriority * 100 + (gainPct < 0 ? -50 : gainPct * 10)
      } else {
        priority = accountPriority * 100 - holding.currentValue / 10000
      }

      candidates.push({
        holding,
        account,
        priority,
        estimatedTaxRate: effectiveTaxRate,
      })
    }
  }

  candidates.sort((a, b) => a.priority - b.priority)
  return candidates
}

function computeCurrentCash(portfolio: Portfolio): number {
  let cash = 0
  for (const account of portfolio.accounts) {
    cash += account.cashBalance
    for (const cd of account.cds) {
      cash += cd.principal
    }
    for (const holding of account.holdings) {
      if (
        holding.assetClass === 'cash' ||
        holding.assetClass === 'money_market'
      ) {
        cash += holding.currentValue
      }
    }
  }
  return cash
}

function generateRationale(candidate: SellCandidate): string {
  const gain = candidate.holding.currentValue - candidate.holding.costBasis
  const gainLabel = gain >= 0 ? 'gain' : 'loss'
  const taxNote = isTaxAdvantaged(candidate.account.accountType)
    ? 'tax-advantaged (no immediate tax impact)'
    : `taxable account (estimated ${(candidate.estimatedTaxRate * 100).toFixed(0)}% rate)`

  return `Sell ${candidate.holding.symbol} from ${candidate.account.name}: $${Math.abs(gain).toFixed(0)} unrealized ${gainLabel}, ${taxNote}.`
}

function buildMinimalSellCandidates(
  portfolio: Portfolio,
  taxRate: number
): SellCandidate[] {
  const candidates: SellCandidate[] = []

  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      if (!isEquityClass(holding.assetClass)) continue
      if (holding.currentValue <= 0) continue

      const accountPriority = ACCOUNT_TAX_PRIORITY[account.accountType]
      const effectiveTaxRate = isTaxAdvantaged(account.accountType)
        ? 0
        : taxRate

      // Minimal-trade: sort by value descending within each account priority tier
      // This way we pick the fewest large positions first
      const priority = accountPriority * 1000000 - holding.currentValue

      candidates.push({
        holding,
        account,
        priority,
        estimatedTaxRate: effectiveTaxRate,
      })
    }
  }

  candidates.sort((a, b) => a.priority - b.priority)
  return candidates
}

/**
 * REQ-MCP-53: the accounts a trade plan may sell from: all but the account
 * types the owner's planRules protect (such as a joint taxable account).
 */
function sellable(portfolio: Portfolio, profile: UserProfile): Portfolio {
  const protectedTypes = new Set(profile.planRules?.protectedAccountTypes ?? [])
  if (protectedTypes.size === 0) return portfolio
  return {
    ...portfolio,
    accounts: portfolio.accounts.filter(
      account => !protectedTypes.has(account.accountType)
    ),
  }
}

export function generateMinimalTradePlan(
  portfolio: Portfolio,
  profile: UserProfile,
  config?: Partial<TradePlanConfig>
): TradePlan {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  if (cfg.targetCashPosition === 0) {
    cfg.targetCashPosition = profile.annualExpenses * 2
  }

  const taxRate = profile.federalTaxBracket ?? 0.22
  const currentCash = computeCurrentCash(portfolio)
  const cashNeeded = Math.max(0, cfg.targetCashPosition - currentCash)

  if (cashNeeded === 0) {
    return {
      trades: [],
      totalProceeds: 0,
      totalTaxImpact: 0,
      targetCashPosition: cfg.targetCashPosition,
    }
  }

  const candidates = buildMinimalSellCandidates(
    sellable(portfolio, profile),
    taxRate
  )
  const trades: Trade[] = []
  let remainingNeeded = cashNeeded
  let totalProceeds = 0
  let totalTaxImpact = 0
  let tradeCount = 0

  for (const candidate of candidates) {
    if (remainingNeeded <= 0 || tradeCount >= cfg.maxTrades) break

    const available = candidate.holding.currentValue
    const rawSellAmount = Math.min(available, remainingNeeded)
    const sellAmount =
      Math.ceil(rawSellAmount / cfg.tradeIncrement) * cfg.tradeIncrement
    const clampedSellAmount = Math.min(sellAmount, available)

    const sellShares =
      candidate.holding.shares > 0
        ? (clampedSellAmount / available) * candidate.holding.shares
        : 0
    const gainFraction = clampedSellAmount / available
    const gain =
      (candidate.holding.currentValue - candidate.holding.costBasis) *
      gainFraction
    const taxImpact = gain > 0 ? gain * candidate.estimatedTaxRate : 0

    trades.push({
      holdingId: candidate.holding.id,
      accountId: candidate.account.id,
      action: 'sell',
      shares: Math.round(sellShares * 100) / 100,
      estimatedValue: Math.round(clampedSellAmount * 100) / 100,
      estimatedTaxImpact: Math.round(taxImpact * 100) / 100,
      priority: tradeCount + 1,
      rationale: generateRationale(candidate),
    })

    totalProceeds += clampedSellAmount
    totalTaxImpact += taxImpact
    remainingNeeded -= clampedSellAmount
    tradeCount++
  }

  return {
    trades,
    totalProceeds: Math.round(totalProceeds * 100) / 100,
    totalTaxImpact: Math.round(totalTaxImpact * 100) / 100,
    targetCashPosition: cfg.targetCashPosition,
  }
}

export function generateTradePlan(
  portfolio: Portfolio,
  profile: UserProfile,
  config?: Partial<TradePlanConfig>
): TradePlan {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  if (cfg.targetCashPosition === 0) {
    cfg.targetCashPosition = profile.annualExpenses * 2
  }

  const taxRate = profile.federalTaxBracket ?? 0.22

  const currentCash = computeCurrentCash(portfolio)
  const cashNeeded = Math.max(0, cfg.targetCashPosition - currentCash)

  if (cashNeeded === 0) {
    return {
      trades: [],
      totalProceeds: 0,
      totalTaxImpact: 0,
      targetCashPosition: cfg.targetCashPosition,
    }
  }

  const candidates = buildSellCandidates(sellable(portfolio, profile), taxRate)
  const trades: Trade[] = []
  let remainingNeeded = cashNeeded
  let totalProceeds = 0
  let totalTaxImpact = 0
  let tradeCount = 0

  for (const candidate of candidates) {
    if (remainingNeeded <= 0 || tradeCount >= cfg.maxTrades) break

    const available = candidate.holding.currentValue
    const sellAmount = Math.min(
      available,
      Math.ceil(remainingNeeded / cfg.tradeIncrement) * cfg.tradeIncrement
    )
    const sellShares =
      candidate.holding.shares > 0
        ? (sellAmount / available) * candidate.holding.shares
        : 0
    const gainFraction = sellAmount / available
    const gain =
      (candidate.holding.currentValue - candidate.holding.costBasis) *
      gainFraction
    const taxImpact = gain > 0 ? gain * candidate.estimatedTaxRate : 0

    trades.push({
      holdingId: candidate.holding.id,
      accountId: candidate.account.id,
      action: 'sell',
      shares: Math.round(sellShares * 100) / 100,
      estimatedValue: Math.round(sellAmount * 100) / 100,
      estimatedTaxImpact: Math.round(taxImpact * 100) / 100,
      priority: tradeCount + 1,
      rationale: generateRationale(candidate),
    })

    totalProceeds += sellAmount
    totalTaxImpact += taxImpact
    remainingNeeded -= sellAmount
    tradeCount++
  }

  return {
    trades,
    totalProceeds: Math.round(totalProceeds * 100) / 100,
    totalTaxImpact: Math.round(totalTaxImpact * 100) / 100,
    targetCashPosition: cfg.targetCashPosition,
  }
}
