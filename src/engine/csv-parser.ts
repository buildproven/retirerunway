import type {
  Account,
  Holding,
  AssetClass,
  BrokerageFormat,
  ImportResult,
  AccountType,
} from './types'
import { stableId } from './stable-id'

interface RawRow {
  [key: string]: string
}

// Column names that mark a line as the header row of a positions export.
const KNOWN_HEADER_CELLS = new Set([
  'symbol',
  'ticker',
  'description',
  'investment name',
  'quantity',
  'shares',
  'market value',
  'current value',
  'total value',
])

function headerCells(line: string): string[] | undefined {
  try {
    return splitCSVLine(line).map(h => h.trim())
  } catch {
    // A preamble line can hold an unmatched quote; it is not the header.
    return undefined
  }
}

// Some exports open with metadata before the header row: Schwab writes a
// "Positions for account ... as of ..." title line and a blank line. The
// header is the first line that names a known column; failing that, the first
// line with two or more non-empty cells; failing that, the first line.
function findHeaderIndex(lines: string[]): number {
  const cells = lines.map(headerCells)
  const known = cells.findIndex(
    c => c !== undefined && c.some(h => KNOWN_HEADER_CELLS.has(h.toLowerCase()))
  )
  if (known !== -1) return known
  const multiCell = cells.findIndex(
    c => c !== undefined && c.filter(h => h !== '').length >= 2
  )
  return multiCell === -1 ? 0 : multiCell
}

function parseCSV(text: string): RawRow[] {
  try {
    // Fidelity exports start with a UTF-8 byte-order mark, which would
    // otherwise become part of the first header name.
    const lines = text
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/)
    if (lines.length < 2) return []

    const headerIndex = findHeaderIndex(lines)
    const headerLine = lines[headerIndex]
    if (!headerLine) {
      throw new Error('CSV file is empty or invalid')
    }

    const headers = splitCSVLine(headerLine).map(h => h.trim())
    if (headers.length === 0) {
      throw new Error('No headers found in CSV')
    }

    const rows: RawRow[] = []

    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      try {
        const values = splitCSVLine(line)
        const row: RawRow = {}
        for (let j = 0; j < headers.length; j++) {
          row[headers[j]] = (values[j] ?? '').trim()
        }
        rows.push(row)
      } catch (lineError) {
        // Skip malformed lines but continue parsing
        console.warn(`Skipping malformed line ${i + 1}:`, lineError)
        continue
      }
    }

    return rows
  } catch (error) {
    console.error('CSV parsing error:', error)
    throw new Error(
      error instanceof Error ? error.message : 'Failed to parse CSV file'
    )
  }
}

function splitCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }

  // Check for unclosed quotes
  if (inQuotes) {
    throw new Error('Unclosed quote in CSV line')
  }

  result.push(current)
  return result
}

function cleanNumber(val: string): number {
  if (!val) return 0
  const cleaned = val.replace(/[$,%]/g, '').replace(/[()]/g, '-').trim()
  const num = parseFloat(cleaned)
  return isNaN(num) ? 0 : num
}

function detectFormat(headers: string[]): BrokerageFormat {
  const headerSet = new Set(headers.map(h => h.toLowerCase()))

  if (
    headerSet.has('account name/number') ||
    headerSet.has('last price change')
  ) {
    return 'fidelity'
  }

  if (
    headerSet.has('symbol') &&
    headerSet.has('quantity') &&
    headerSet.has('market value')
  ) {
    if (
      headerSet.has('reinvest dividends?') ||
      headerSet.has('reinvest capital gains?')
    ) {
      return 'schwab'
    }
  }

  if (
    headerSet.has('investment name') &&
    headerSet.has('fund account number')
  ) {
    return 'vanguard'
  }

  return 'generic'
}

// Names and symbols that mark a holding as US equity. A holding that matches
// no rule still reads as us_equity, but with a warning naming it, so an
// unknown fund is visible instead of silently US equity.
/** A coupon then a maturity date, as an individual bond, note or CD is named. */
export const INDIVIDUAL_SECURITY = /\d+(\.\d+)?%\s+\d{1,2}\/\d{1,2}\/\d{4}/

const US_EQUITY_NAMES = [
  's&p 500',
  '500 index',
  'total stock',
  'total market',
  'broad market',
  'extended market',
  'small-cap',
  'small cap',
  'mid-cap',
  'mid cap',
  'large-cap',
  'large cap',
  'dividend',
  'nasdaq',
  'russell',
  'dow jones',
  'us stock',
  'u.s. stock',
]
const US_EQUITY_SYMBOLS = [
  'VOO',
  'VTI',
  'VYM',
  'VBR',
  'VGT',
  'VUG',
  'VTV',
  'SPY',
  'IVV',
  'ITOT',
  'SCHB',
  'SCHD',
  'SCHX',
  'QQQ',
  'VFIAX',
  'VTSAX',
  'FXAIX',
  'FSKAX',
  'SWPPX',
  'SWTSX',
]

/**
 * The asset class the name and symbol of a holding match, or undefined when
 * no rule matches (the caller decides the default). Saved snapshots are
 * re-classified with these rules when read (src/mcp/user-store.ts).
 */
export function matchAssetClass(
  symbol: string,
  name: string
): AssetClass | undefined {
  const nameLower = name.toLowerCase()
  const symUpper = symbol.toUpperCase()
  const international =
    nameLower.includes('international') ||
    nameLower.includes('intl') ||
    nameLower.includes('developed')

  if (['SPAXX', 'FDRXX', 'VMFXX', 'SWVXX'].includes(symUpper))
    return 'money_market'
  if (symUpper === 'CASH' || nameLower.includes('cash')) return 'cash'

  // A brokered CD: "… CD 4.80000% 11/29/2027 …" or "… 12/02/2030 CD".
  if (/\bcd\b/.test(nameLower) || nameLower.includes('certificate')) return 'cd'

  if (nameLower.includes('reit') || nameLower.includes('real estate'))
    return 'reit'
  if (nameLower.includes('commodity') || nameLower.includes('gold'))
    return 'commodity'
  if (nameLower.includes('crypto') || nameLower.includes('bitcoin'))
    return 'crypto'

  if (
    nameLower.includes('bond') ||
    nameLower.includes('fixed income') ||
    /high[\s-]yield/.test(nameLower)
  )
    return international ? 'intl_bond' : 'us_bond'

  if (nameLower.includes('tips') || nameLower.includes('inflation protected'))
    return 'tips'

  // An individual Treasury or other note with a coupon and a maturity date
  // ("UNITED STATES TREAS NTS 4.25000% 11/30/2027"): fixed income, never stock.
  if (
    /\btreas(ury)?\b|\bt-?bills?\b/.test(nameLower) ||
    INDIVIDUAL_SECURITY.test(nameLower)
  )
    return 'us_bond'

  if (
    nameLower.includes('emerging') ||
    nameLower.includes('em ') ||
    ['VWO', 'IEMG', 'EEM'].includes(symUpper)
  )
    return 'emerging_equity'

  if (
    international ||
    nameLower.includes('foreign') ||
    ['VXUS', 'IXUS', 'EFA', 'VTIAX', 'VEA', 'IEFA', 'VTMGX'].includes(symUpper)
  )
    return 'intl_equity'

  if (['BND', 'AGG', 'VBTLX', 'VBMFX', 'TLT', 'IEF'].includes(symUpper))
    return 'us_bond'

  if (
    US_EQUITY_NAMES.some(term => nameLower.includes(term)) ||
    US_EQUITY_SYMBOLS.includes(symUpper)
  )
    return 'us_equity'

  return undefined
}

/**
 * The account type the account name matches, or undefined when no rule
 * matches (the caller decides the default). Saved snapshots re-derive a
 * `brokerage` account's type with these rules when read
 * (src/mcp/user-store.ts). A government 457(b) plan is also called a
 * deferred compensation plan, so a name naming 457(b) stays `457b`.
 */
export function matchAccountType(accountName: string): AccountType | undefined {
  const lower = accountName.toLowerCase()
  const is457b = lower.includes('457b') || lower.includes('457(b)')
  if (
    !is457b &&
    (lower.includes('deferred compensation') || /\bnqdc\b/.test(lower))
  )
    return 'nqdc'
  if (lower.includes('roth ira')) return 'roth_ira'
  if (lower.includes('roth 401')) return 'roth_401k'
  if (lower.includes('rollover')) return 'rollover_ira'
  if (lower.includes('traditional ira') || lower.includes('trad ira'))
    return 'traditional_ira'
  if (lower.includes('401k') || lower.includes('401(k)')) return '401k'
  if (lower.includes('403b') || lower.includes('403(b)')) return '403b'
  if (is457b) return '457b'
  if (lower.includes('hsa')) return 'hsa'
  if (lower.includes('ira')) return 'traditional_ira'
  // A Fidelity BrokerageLink is a self-directed window inside a workplace
  // plan, not a taxable account. Its own name rarely says which plan, so it
  // is a 401(k) unless the parser finds the parent plan (brokerageLinkType).
  if (isBrokerageLinkName(accountName)) return '401k'
  return undefined
}

/** True when the account name names a Fidelity BrokerageLink window. */
export function isBrokerageLinkName(accountName: string): boolean {
  return /brokerage\s?link/i.test(accountName)
}

function guessAccountType(accountName: string): AccountType {
  return matchAccountType(accountName) ?? 'brokerage'
}

const FIDELITY_FIELDS: FieldMapping = {
  account: 'Account',
  symbol: 'Symbol',
  name: 'Description',
  shares: 'Quantity',
  price: 'Last Price',
  value: 'Current Value',
  costBasis: 'Cost Basis Total',
}

// Fidelity marks its core money-market position with trailing asterisks
// (`SPAXX**`) and an uninvested cash line with `**` alone.
function normalizeSymbol(symbol: string): string {
  return symbol.replace(/\*+$/, '')
}

// A Fidelity 401(k) lists its BrokerageLink window as one row with no symbol
// and the description BROKERAGELINK, and the same export lists the window's
// holdings again under its own BrokerageLink account. Counting both would
// double that money, so the summary row is skipped when the account is there.
function isBrokerageLinkSummary(
  symbol: string,
  name: string,
  hasBrokerageLinkAccount: boolean
): boolean {
  return (
    hasBrokerageLinkAccount &&
    symbol === '' &&
    name.trim().toUpperCase() === 'BROKERAGELINK'
  )
}

interface FieldMapping {
  account: string
  /** A separate account-number column, when the export has one. */
  accountNumber?: string
  symbol: string
  name: string
  shares: string
  price: string
  value: string
  costBasis: string
}

// Brokerages change header case between export versions (Fidelity moved from
// "Current Value" to "Current value" in 2026), so a mapped column is matched
// without regard to case and resolved to the header the file actually uses.
function resolveHeaders(
  mapping: FieldMapping,
  headers: string[]
): FieldMapping {
  const byLower = new Map(headers.map(h => [h.toLowerCase(), h]))
  const resolve = (name: string): string =>
    byLower.get(name.toLowerCase()) ?? name
  return {
    account: resolve(mapping.account),
    ...(mapping.accountNumber === undefined
      ? {}
      : { accountNumber: resolve(mapping.accountNumber) }),
    symbol: resolve(mapping.symbol),
    name: resolve(mapping.name),
    shares: resolve(mapping.shares),
    price: resolve(mapping.price),
    value: resolve(mapping.value),
    costBasis: resolve(mapping.costBasis),
  }
}

function getFieldMapping(
  format: BrokerageFormat,
  headers: string[]
): FieldMapping {
  return resolveHeaders(baseFieldMapping(format, headers), headers)
}

function baseFieldMapping(
  format: BrokerageFormat,
  headers: string[]
): FieldMapping {
  const headerSet = new Set(headers.map(h => h.toLowerCase()))

  switch (format) {
    case 'fidelity':
      if (headerSet.has('account name/number')) {
        return { ...FIDELITY_FIELDS, account: 'Account Name/Number' }
      }
      if (headerSet.has('account name') && headerSet.has('account number')) {
        return {
          ...FIDELITY_FIELDS,
          account: 'Account Name',
          accountNumber: 'Account Number',
        }
      }
      return FIDELITY_FIELDS
    case 'schwab':
      return {
        account: 'Account',
        symbol: 'Symbol',
        name: 'Description',
        shares: 'Quantity',
        price: 'Price',
        value: 'Market Value',
        costBasis: 'Cost Basis',
      }
    case 'vanguard':
      return {
        account: 'Fund Account Number',
        symbol: 'Symbol',
        name: 'Investment Name',
        shares: 'Shares',
        price: 'Share Price',
        value: 'Total Value',
        costBasis: 'Cost Basis',
      }
    default:
      return {
        account: findHeader(headers, ['account', 'acct']) ?? 'Account',
        symbol: findHeader(headers, ['symbol', 'ticker']) ?? 'Symbol',
        name:
          findHeader(headers, ['description', 'name', 'investment']) ??
          'Description',
        shares:
          findHeader(headers, ['quantity', 'shares', 'qty']) ?? 'Quantity',
        price: findHeader(headers, ['price', 'last price']) ?? 'Price',
        value:
          findHeader(headers, [
            'value',
            'market value',
            'current value',
            'total value',
          ]) ?? 'Value',
        costBasis: findHeader(headers, ['cost basis', 'cost']) ?? 'Cost Basis',
      }
  }
}

function findHeader(
  headers: string[],
  candidates: string[]
): string | undefined {
  for (const candidate of candidates) {
    const match = headers.find(h => h.toLowerCase().includes(candidate))
    if (match) return match
  }
  return undefined
}

export function parsePortfolioCSV(csvText: string): ImportResult {
  try {
    // Validate input
    if (!csvText || csvText.trim().length === 0) {
      return {
        accounts: [],
        format: 'generic',
        warnings: ['CSV file is empty'],
        rowsImported: 0,
        rowsSkipped: 0,
      }
    }

    const rows = parseCSV(csvText)
    if (rows.length === 0) {
      return {
        accounts: [],
        format: 'generic',
        warnings: ['No data rows found in CSV'],
        rowsImported: 0,
        rowsSkipped: 0,
      }
    }

    const headers = Object.keys(rows[0])
    const format = detectFormat(headers)
    const fields = getFieldMapping(format, headers)
    const warnings: string[] = []
    let rowsSkipped = 0

    const hasBrokerageLinkAccount = rows.some(
      row =>
        (row[fields.account] ?? '').trim().toUpperCase() === 'BROKERAGELINK'
    )
    // The plan whose BROKERAGELINK summary row points at the window gives the
    // window its type: a 403(b) or 457(b) window is not a 401(k).
    const brokerageLinkParent = rows.find(
      row =>
        normalizeSymbol(row[fields.symbol] || '') === '' &&
        (row[fields.name] || '').trim().toUpperCase() === 'BROKERAGELINK'
    )?.[fields.account]
    const brokerageLinkType =
      brokerageLinkParent === undefined
        ? undefined
        : matchAccountType(brokerageLinkParent)
    const accountTypeFor = (accountName: string): AccountType =>
      isBrokerageLinkName(accountName) && brokerageLinkType !== undefined
        ? brokerageLinkType
        : guessAccountType(accountName)

    const accountMap = new Map<
      string,
      {
        name: string
        holdings: Holding[]
        cashBalance: number
        accountType: AccountType
      }
    >()

    for (const row of rows) {
      const accountName = row[fields.account] || 'Default Account'
      // Two accounts can share a name (two "Individual" accounts), so a
      // separate account-number column keeps them apart.
      const accountKey =
        fields.accountNumber === undefined
          ? accountName
          : `${accountName}|${row[fields.accountNumber] ?? ''}`
      const rawSymbol = row[fields.symbol] || ''
      const symbol = normalizeSymbol(rawSymbol)
      const name = row[fields.name] || ''

      if (isBrokerageLinkSummary(symbol, name, hasBrokerageLinkAccount)) {
        warnings.push(
          `Skipped ${name} row in ${accountName}: its holdings are listed under the BrokerageLink account`
        )
        rowsSkipped++
        continue
      }
      const shares = cleanNumber(row[fields.shares])
      const price = cleanNumber(row[fields.price])
      const value = cleanNumber(row[fields.value])
      const costBasis = cleanNumber(row[fields.costBasis])

      if (!rawSymbol && !name) {
        rowsSkipped++
        continue
      }

      if (symbol.toUpperCase() === 'CASH' || symbol === '--' || symbol === '') {
        if (value > 0) {
          const existing = accountMap.get(accountKey)
          if (existing) {
            existing.cashBalance += value
          } else {
            accountMap.set(accountKey, {
              name: accountName,
              holdings: [],
              cashBalance: value,
              accountType: accountTypeFor(accountName),
            })
          }
          continue
        }
        if (!symbol && !shares) {
          rowsSkipped++
          continue
        }
      }

      const currentValue = value || shares * price
      if (currentValue === 0 && shares === 0) {
        warnings.push(`Skipped ${symbol || name}: zero value and zero shares`)
        rowsSkipped++
        continue
      }

      const matched = matchAssetClass(symbol, name)
      if (matched === undefined) {
        warnings.push(
          `Classified ${[symbol, name].filter(Boolean).join(' ')} in ${accountName} as us_equity: no asset-class rule matches it`
        )
      }
      const holding: Holding = {
        id: 'h-' + stableId(`${accountKey}|${symbol}|${name}|${shares}`),
        symbol: symbol || 'UNKNOWN',
        name: name || symbol,
        assetClass: matched ?? 'us_equity',
        shares,
        costBasis: costBasis || currentValue,
        currentPrice: price || (shares > 0 ? currentValue / shares : 0),
        currentValue,
      }

      if (!accountMap.has(accountKey)) {
        accountMap.set(accountKey, {
          name: accountName,
          holdings: [],
          cashBalance: 0,
          accountType: accountTypeFor(accountName),
        })
      }
      accountMap.get(accountKey)!.holdings.push(holding)
    }

    // A missing value column reads every position as $0, so it is named.
    const headerSet = new Set(headers)
    if (
      accountMap.size > 0 &&
      !headerSet.has(fields.value) &&
      !headerSet.has(fields.price)
    ) {
      warnings.push(
        `No "${fields.value}" or "${fields.price}" column found: positions have no value`
      )
    }

    const accounts: Account[] = []
    for (const [key, data] of accountMap) {
      accounts.push({
        id: 'a-' + stableId(`${key}|${format}`),
        name: data.name,
        institution:
          format === 'generic'
            ? 'Unknown'
            : format.charAt(0).toUpperCase() + format.slice(1),
        accountType: data.accountType,
        holdings: data.holdings,
        cds: [],
        cashBalance: data.cashBalance,
      })
    }

    return {
      accounts,
      format,
      warnings,
      rowsImported: rows.length - rowsSkipped,
      rowsSkipped,
    }
  } catch (error) {
    // Return error state with user-friendly message
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown parsing error'
    console.error('Portfolio CSV parsing error:', error)

    return {
      accounts: [],
      format: 'generic',
      warnings: [`Failed to parse CSV: ${errorMessage}`],
      rowsImported: 0,
      rowsSkipped: 0,
    }
  }
}
