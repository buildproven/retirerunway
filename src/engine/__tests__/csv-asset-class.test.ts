// BUI-1939 (FR-13): the CSV import classifies developed-market equity and
// high-yield bond funds, and names a holding it cannot classify.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePortfolioCSV } from '../csv-parser'
import type { Holding } from '../types'

const fixtureDir = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'skills',
  'retire-runway',
  'fixtures',
  'csv'
)

function fixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf8')
}

function holdings(csv: string): Holding[] {
  return parsePortfolioCSV(csv).accounts.flatMap(a => a.holdings)
}

function bySymbol(csv: string, symbol: string): Holding {
  const holding = holdings(csv).find(h => h.symbol === symbol)
  if (!holding) throw new Error(`no ${symbol} holding`)
  return holding
}

function row(symbol: string, name: string): string {
  return `Account,Symbol,Name,Shares,Price,Value,CostBasis\nTaxable,${symbol},${name},10,100,1000,900\n`
}

describe('FR-13 BUI-1939 developed-market and high-yield funds', () => {
  const csv = fixture('fidelity-classes.csv')

  it('FR-13 reads VEA (developed markets) as intl_equity', () => {
    expect(bySymbol(csv, 'VEA').assetClass).toBe('intl_equity')
  })

  it('FR-13 reads IEFA as intl_equity', () => {
    expect(bySymbol(csv, 'IEFA').assetClass).toBe('intl_equity')
  })

  it('FR-13 reads PHYQX (high yield) as us_bond', () => {
    expect(bySymbol(csv, 'PHYQX').assetClass).toBe('us_bond')
  })

  it('FR-13 reads VTMGX by symbol as intl_equity', () => {
    expect(holdings(row('VTMGX', 'VANGUARD ADMIRAL'))[0].assetClass).toBe(
      'intl_equity'
    )
  })

  it('FR-13 reads a fund named "developed" by name as intl_equity', () => {
    expect(
      holdings(row('ZZDEV', 'Acme Developed World Fund'))[0].assetClass
    ).toBe('intl_equity')
  })

  it('FR-13 reads a hyphenated "high-yield" fund as us_bond', () => {
    expect(holdings(row('ZZHY', 'Acme High-Yield Fund'))[0].assetClass).toBe(
      'us_bond'
    )
  })

  it('FR-13 reads an international high-yield fund as intl_bond', () => {
    expect(
      holdings(row('ZZIHY', 'Acme International High Yield Fund'))[0].assetClass
    ).toBe('intl_bond')
  })

  it('FR-13 reads a developed-markets bond fund as intl_bond', () => {
    expect(
      holdings(row('ZZDB', 'Acme Developed Markets Bond Fund'))[0].assetClass
    ).toBe('intl_bond')
  })

  it('FR-13 keeps a high dividend yield fund as us_equity', () => {
    const result = parsePortfolioCSV(
      row('ZZHDY', 'Acme High Dividend Yield Fund')
    )
    expect(result.accounts[0].holdings[0].assetClass).toBe('us_equity')
    expect(result.warnings).toEqual([])
  })
})

describe('FR-13 BUI-1939 unclassified holdings are named', () => {
  it('FR-13 warns with the name of a fund that falls to the us_equity default', () => {
    const result = parsePortfolioCSV(fixture('fidelity-classes.csv'))
    const mystery = result.accounts
      .flatMap(a => a.holdings)
      .find(h => h.symbol === 'ZZMYX')
    expect(mystery?.assetClass).toBe('us_equity')
    const named = result.warnings.filter(w => w.includes('ZZMYX'))
    expect(named).toHaveLength(1)
    expect(named[0]).toContain('ACME MYSTERY OPPORTUNITIES')
    expect(named[0]).toContain('us_equity')
  })

  it('FR-13 does not warn for VOO, VEA, IEFA, or PHYQX', () => {
    const { warnings } = parsePortfolioCSV(fixture('fidelity-classes.csv'))
    for (const symbol of ['VOO', 'VEA', 'IEFA', 'PHYQX']) {
      expect(warnings.some(w => w.includes(symbol))).toBe(false)
    }
  })

  it.each([
    ['VOO', 'VANGUARD S&P 500 ETF'],
    ['VTI', 'VANGUARD ETF'],
    ['VYM', 'VANGUARD ETF'],
    ['VBR', 'VANGUARD ETF'],
    ['VGT', 'VANGUARD ETF'],
    ['ZZ1', 'Acme Total Stock Market'],
    ['ZZ2', 'Acme Small-Cap Index'],
    ['ZZ3', 'Acme Dividend Growth'],
  ])('FR-13 does not warn for US equity %s %s', (symbol, name) => {
    const result = parsePortfolioCSV(row(symbol, name))
    expect(result.accounts[0].holdings[0].assetClass).toBe('us_equity')
    expect(result.warnings).toEqual([])
  })

  it('FR-13 does not warn for the existing broker fixtures', () => {
    for (const name of [
      'fidelity-sample.csv',
      'fidelity-2026.csv',
      'schwab-sample.csv',
      'vanguard-sample.csv',
      'generic-sample.csv',
      'account-numbers.csv',
    ]) {
      const { warnings } = parsePortfolioCSV(fixture(name))
      expect(
        warnings.filter(w => w.includes('us_equity')),
        name
      ).toEqual([])
    }
  })
})
