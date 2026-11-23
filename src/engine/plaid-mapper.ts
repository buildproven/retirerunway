// ---------------------------------------------------------------------------
// RetireRunway – Plaid Data Mapper
// Converts Plaid investment holdings to RetireRunway Portfolio format.
// All logic is deterministic — no AI.
// ---------------------------------------------------------------------------

import type {
  Account,
  AccountType,
  AssetClass,
  Holding,
  Portfolio,
} from './types'
import { stableId } from './stable-id'

// Plaid types (subset)
export interface PlaidAccount {
  account_id: string
  name: string
  type: string
  subtype: string | null
  balances: {
    current: number | null
    available: number | null
    [key: string]: unknown
  }
}

export interface PlaidHolding {
  account_id: string
  security_id: string
  quantity: number
  cost_basis: number | null
  institution_value: number | null
}

export interface PlaidSecurity {
  security_id: string
  ticker_symbol: string | null
  name: string | null
  type: string | null
  close_price: number | null
}

export interface PlaidImportResult {
  portfolio: Portfolio
  warnings: string[]
  accountsImported: number
  holdingsImported: number
}

export interface PlaidImportOptions {
  portfolioName?: string
  /** Explicit source date from the Plaid snapshot. */
  asOfDate: string
}

const PLAID_ACCOUNT_TYPE_MAP: Record<string, AccountType> = {
  brokerage: 'brokerage',
  investment: 'brokerage',
  '401k': '401k',
  '401a': '401k',
  '403b': '403b',
  '457b': '457b',
  ira: 'traditional_ira',
  roth: 'roth_ira',
  'roth 401k': 'roth_401k',
  hsa: 'hsa',
}

const PLAID_SECURITY_TYPE_MAP: Record<string, AssetClass> = {
  equity: 'us_equity',
  etf: 'us_equity',
  'mutual fund': 'us_equity',
  bond: 'us_bond',
  'fixed income': 'us_bond',
  cash: 'cash',
  'money market': 'money_market',
  cryptocurrency: 'crypto',
  derivative: 'other',
}

function compareFingerprintStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalizeForFingerprint(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Plaid fingerprint data must contain finite numbers')
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeForFingerprint)
  }

  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        'Plaid fingerprint data must contain JSON-compatible plain objects'
      )
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareFingerprintStrings(left, right))
        .map(([key, entry]) => [key, canonicalizeForFingerprint(entry)])
    )
  }

  throw new Error('Plaid fingerprint data must contain JSON-compatible values')
}

function mapAccountType(
  plaidType: string,
  plaidSubtype: string | null
): AccountType {
  const subLower = (plaidSubtype ?? '').toLowerCase()
  if (PLAID_ACCOUNT_TYPE_MAP[subLower]) {
    return PLAID_ACCOUNT_TYPE_MAP[subLower]
  }

  const typeLower = plaidType.toLowerCase()
  if (PLAID_ACCOUNT_TYPE_MAP[typeLower]) {
    return PLAID_ACCOUNT_TYPE_MAP[typeLower]
  }

  return 'brokerage'
}

function mapAssetClass(securityType: string | null): AssetClass {
  if (!securityType) return 'other'
  const lower = securityType.toLowerCase()
  return PLAID_SECURITY_TYPE_MAP[lower] ?? 'other'
}

export function mapPlaidToPortfolio(
  plaidAccounts: PlaidAccount[],
  plaidHoldings: PlaidHolding[],
  plaidSecurities: PlaidSecurity[],
  options: PlaidImportOptions
): PlaidImportResult {
  const portfolioName = options.portfolioName ?? 'Imported Portfolio'
  const { asOfDate } = options
  const warnings: string[] = []
  const securityMap = new Map<string, PlaidSecurity>()

  for (const sec of plaidSecurities) {
    securityMap.set(sec.security_id, sec)
  }

  const accountMap = new Map<string, Account>()

  for (const plaidAcct of plaidAccounts) {
    const accountType = mapAccountType(plaidAcct.type, plaidAcct.subtype)

    accountMap.set(plaidAcct.account_id, {
      id: plaidAcct.account_id,
      name: plaidAcct.name,
      institution: 'Plaid Import',
      accountType,
      holdings: [],
      cds: [],
      cashBalance:
        plaidAcct.balances.available ?? plaidAcct.balances.current ?? 0,
    })
  }

  let holdingsImported = 0

  for (const plaidHolding of plaidHoldings) {
    const account = accountMap.get(plaidHolding.account_id)
    if (!account) {
      warnings.push(
        `Holding for unknown account ${plaidHolding.account_id} skipped`
      )
      continue
    }

    const security = securityMap.get(plaidHolding.security_id)
    if (!security) {
      warnings.push(`Security ${plaidHolding.security_id} not found, skipped`)
      continue
    }

    const assetClass = mapAssetClass(security.type)

    // Cash-like holdings go to cashBalance instead
    if (assetClass === 'cash' || assetClass === 'money_market') {
      account.cashBalance += plaidHolding.institution_value ?? 0
      continue
    }

    const currentValue = plaidHolding.institution_value ?? 0
    const currentPrice = security.close_price ?? 0

    const holding: Holding = {
      id: `${plaidHolding.account_id}-${plaidHolding.security_id}`,
      symbol: security.ticker_symbol ?? 'UNKNOWN',
      name: security.name ?? 'Unknown Security',
      assetClass,
      shares: plaidHolding.quantity,
      costBasis: plaidHolding.cost_basis ?? currentValue,
      currentPrice,
      currentValue,
    }

    account.holdings.push(holding)
    holdingsImported++
  }

  const accounts = Array.from(accountMap.values())

  const fingerprint = JSON.stringify({
    accounts: plaidAccounts
      .map(account => ({
        account_id: account.account_id,
        name: account.name,
        type: account.type,
        subtype: account.subtype,
        balances: canonicalizeForFingerprint(account.balances),
      }))
      .sort((left, right) =>
        compareFingerprintStrings(left.account_id, right.account_id)
      ),
    holdings: plaidHoldings
      .map(holding => ({
        account_id: holding.account_id,
        security_id: holding.security_id,
        quantity: holding.quantity,
        cost_basis: holding.cost_basis,
        institution_value: holding.institution_value,
      }))
      .sort((left, right) =>
        compareFingerprintStrings(
          `${left.account_id}:${left.security_id}`,
          `${right.account_id}:${right.security_id}`
        )
      ),
    securities: plaidSecurities
      .map(security => ({
        security_id: security.security_id,
        ticker_symbol: security.ticker_symbol,
        name: security.name,
        type: security.type,
        close_price: security.close_price,
      }))
      .sort((left, right) =>
        compareFingerprintStrings(left.security_id, right.security_id)
      ),
    portfolioName,
    asOfDate,
  })

  const portfolio: Portfolio = {
    id: `plaid-${stableId(fingerprint)}`,
    name: portfolioName,
    accounts,
    asOfDate,
  }

  return {
    portfolio,
    warnings,
    accountsImported: accounts.length,
    holdingsImported,
  }
}
