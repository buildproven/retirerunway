import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parsePortfolioCSV } from '../csv-parser'

// A Schwab positions export starts with a "Positions for account … as of …"
// title line and a blank line before the real header row.
const SCHWAB_TITLE_CSV = readFileSync(
  resolve(__dirname, 'fixtures/schwab-title-line.csv'),
  'utf8'
)

describe('FR-13 portfolio import: preamble lines before the header row', () => {
  it('FR-13 detects a Schwab export that starts with its title line', () => {
    const result = parsePortfolioCSV(SCHWAB_TITLE_CSV)
    expect(result.format).toBe('schwab')
  })

  it('FR-13 reads every Schwab holding below the title line', () => {
    const result = parsePortfolioCSV(SCHWAB_TITLE_CSV)
    expect(result.rowsImported).toBe(2)
    expect(result.rowsSkipped).toBe(0)
    expect(result.accounts).toHaveLength(1)
    const [account] = result.accounts
    expect(account.name).toBe('Individual ...123')
    expect(account.institution).toBe('Schwab')
    expect(account.holdings.map(h => h.symbol)).toEqual(['SCHB', 'SCHZ'])
    expect(account.holdings.map(h => h.currentValue)).toEqual([8400, 28200])
    expect(account.holdings[1].shares).toBe(1200)
    expect(account.holdings[1].costBasis).toBe(30000)
  })

  it('FR-13 parses the same holdings with and without the title lines', () => {
    const withoutTitle = SCHWAB_TITLE_CSV.split(/\r?\n/).slice(2).join('\n')
    expect(parsePortfolioCSV(SCHWAB_TITLE_CSV)).toEqual(
      parsePortfolioCSV(withoutTitle)
    )
  })

  it('FR-13 reads a CRLF export with a title line', () => {
    const crlf = SCHWAB_TITLE_CSV.replace(/\r?\n/g, '\r\n')
    const result = parsePortfolioCSV(crlf)
    expect(result.format).toBe('schwab')
    expect(result.rowsImported).toBe(2)
  })

  it('FR-13 finds an unknown header row below a one-cell title line', () => {
    const csv = `My portfolio export
ColumnA,ColumnB
one,two`
    const result = parsePortfolioCSV(csv)
    expect(result.format).toBe('generic')
    expect(result.rowsImported + result.rowsSkipped).toBe(1)
  })

  it('FR-13 skips a title line with an unclosed quote', () => {
    const csv = `"Positions as of today
Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,Apple,10,185.00,1850.00,1500.00`
    const result = parsePortfolioCSV(csv)
    expect(result.accounts[0].holdings[0].currentValue).toBe(1850)
  })

  it('FR-13 does not take an unquoted title line with a comma as the header', () => {
    const csv = `Positions for account Individual, as of 2026/11/06
Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,Apple,10,185.00,1850.00,1500.00`
    const result = parsePortfolioCSV(csv)
    expect(result.rowsImported).toBe(1)
    expect(result.accounts[0].holdings[0].symbol).toBe('AAPL')
  })

  it('FR-13 returns no rows when only a title line precedes the header', () => {
    const csv = `"Positions for account Individual ...123 as of 2026/11/06",""
Symbol,Quantity,Market Value`
    const result = parsePortfolioCSV(csv)
    expect(result.accounts).toEqual([])
    expect(result.warnings).toContain('No data rows found in CSV')
  })

  it('FR-13 still reads a file whose header is its first line', () => {
    const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,Apple,10,185.00,1850.00,1500.00`
    const result = parsePortfolioCSV(csv)
    expect(result.rowsImported).toBe(1)
    expect(result.accounts[0].name).toBe('Main')
  })
})
