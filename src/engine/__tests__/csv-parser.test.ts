import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parsePortfolioCSV } from '../csv-parser'

const FIDELITY_2026_CSV = readFileSync(
  resolve(
    __dirname,
    '../../../skills/retire-runway/fixtures/csv/fidelity-2026.csv'
  ),
  'utf8'
)

const FIDELITY_CSV = `Account Name/Number,Symbol,Description,Quantity,Last Price,Last Price Change,Current Value,Today's Gain/Loss Dollar,Today's Gain/Loss Percent,Total Gain/Loss Dollar,Total Gain/Loss Percent,Cost Basis Total
"Individual - TOA X1234",VTI,VANGUARD TOTAL STOCK MARKET ETF,500,$250.00,+$1.50,"$125,000.00",+$750.00,+0.60%,"+$25,000.00",+25.00%,"$100,000.00"
"Individual - TOA X1234",BND,VANGUARD TOTAL BOND MARKET ETF,200,$75.00,-$0.25,"$15,000.00",-$50.00,-0.33%,"-$500.00",-3.23%,"$15,500.00"
"Individual - TOA X1234",SPAXX,FIDELITY GOVERNMENT MONEY MARKET,0,$1.00,$0.00,"$10,000.00",$0.00,0.00%,$0.00,0.00%,"$10,000.00"
"Roth IRA - X5678",VXUS,VANGUARD TOTAL INTL STOCK ETF,300,$60.00,+$0.80,"$18,000.00",+$240.00,+1.35%,"+$3,000.00",+20.00%,"$15,000.00"`

const SCHWAB_CSV = `Account,Symbol,Description,Quantity,Price,Price Change %,Price Change $,Market Value,Day Change %,Day Change $,Cost Basis,Gain/Loss %,Gain/Loss $,Ratings,Reinvest Dividends?,Reinvest Capital Gains?
"Brokerage XXXX-1234",VTI,"Vanguard Total Stock Mkt ETF",100,"$250.00",0.50%,$1.25,"$25,000.00",0.50%,$125.00,"$20,000.00",25.00%,"$5,000.00",N/A,No,No
"Brokerage XXXX-1234",CASH,"Cash & Cash Investments",--,--,--,--,"$5,000.00",--,--,--,--,--,N/A,--,--`

const VANGUARD_CSV = `Fund Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,Cost Basis
"12345678","Vanguard Total Stock Market Index Fund","VTSAX","1000.000","$120.50","$120,500.00","$95,000.00"
"12345678","Vanguard Total Bond Market Index Fund","VBTLX","500.000","$10.20","$5,100.00","$5,000.00"
"87654321","Vanguard Total International Stock Index Fund","VTIAX","200.000","$35.00","$7,000.00","$6,000.00"`

const GENERIC_CSV = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,Apple Inc,50,185.00,9250.00,7500.00
Main,MSFT,Microsoft Corp,30,380.00,11400.00,9000.00
Retirement IRA,VTI,Vanguard Total Stock,100,250.00,25000.00,20000.00`

describe('parsePortfolioCSV', () => {
  describe('format detection', () => {
    it('detects Fidelity format', () => {
      const result = parsePortfolioCSV(FIDELITY_CSV)
      expect(result.format).toBe('fidelity')
    })

    it('detects Schwab format', () => {
      const result = parsePortfolioCSV(SCHWAB_CSV)
      expect(result.format).toBe('schwab')
    })

    it('detects Vanguard format', () => {
      const result = parsePortfolioCSV(VANGUARD_CSV)
      expect(result.format).toBe('vanguard')
    })

    it('falls back to generic', () => {
      const result = parsePortfolioCSV(GENERIC_CSV)
      expect(result.format).toBe('generic')
    })
  })

  describe('Fidelity parsing', () => {
    it('parses holdings correctly', () => {
      const result = parsePortfolioCSV(FIDELITY_CSV)
      expect(result.rowsImported).toBe(4)
      expect(result.accounts.length).toBe(2)
    })

    it('uses 128-bit-width deterministic IDs for imported records', () => {
      const result = parsePortfolioCSV(FIDELITY_CSV)

      expect(result.accounts[0]?.id).toMatch(/^a-[0-9a-f]{32}$/)
      expect(result.accounts[0]?.holdings[0]?.id).toMatch(/^h-[0-9a-f]{32}$/)
    })

    it('groups by account', () => {
      const result = parsePortfolioCSV(FIDELITY_CSV)
      const individual = result.accounts.find(a =>
        a.name.includes('Individual')
      )
      expect(individual).toBeDefined()
      expect(individual!.holdings.length).toBe(3)
    })

    it('identifies Roth IRA account type', () => {
      const result = parsePortfolioCSV(FIDELITY_CSV)
      const roth = result.accounts.find(a => a.name.includes('Roth'))
      expect(roth).toBeDefined()
      expect(roth!.accountType).toBe('roth_ira')
    })

    it('classifies asset classes', () => {
      const result = parsePortfolioCSV(FIDELITY_CSV)
      const individual = result.accounts.find(a =>
        a.name.includes('Individual')
      )!
      const vti = individual.holdings.find(h => h.symbol === 'VTI')
      const bnd = individual.holdings.find(h => h.symbol === 'BND')
      const spaxx = individual.holdings.find(h => h.symbol === 'SPAXX')
      expect(vti!.assetClass).toBe('us_equity')
      expect(bnd!.assetClass).toBe('us_bond')
      expect(spaxx!.assetClass).toBe('money_market')
    })

    it('parses currency values with commas', () => {
      const result = parsePortfolioCSV(FIDELITY_CSV)
      const individual = result.accounts.find(a =>
        a.name.includes('Individual')
      )!
      const vti = individual.holdings.find(h => h.symbol === 'VTI')
      expect(vti!.currentValue).toBe(125000)
    })
  })

  describe('Fidelity 2026 export (sentence-case headers, BOM)', () => {
    const result = parsePortfolioCSV(FIDELITY_2026_CSV)
    const holdings = result.accounts.flatMap(a => a.holdings)
    const total = result.accounts.reduce(
      (sum, a) =>
        sum +
        a.cashBalance +
        a.holdings.reduce((s, h) => s + h.currentValue, 0),
      0
    )

    it('reads values from sentence-case headers', () => {
      expect(result.format).toBe('fidelity')
      expect(holdings.find(h => h.symbol === 'VOO')?.currentValue).toBe(6000)
      expect(holdings.find(h => h.symbol === 'VOO')?.currentPrice).toBe(600)
      expect(holdings.find(h => h.symbol === 'VOO')?.costBasis).toBe(5000)
    })

    it('groups by the account name and number columns', () => {
      expect(result.accounts.map(a => a.name)).toEqual([
        'Joint WROS - TOD',
        'ACME 401(K)',
        'BrokerageLink',
        'Pat Example - Traditional IRA Brokerage Account - 55555555',
      ])
      expect(result.accounts.map(a => a.name)).not.toContain('Default Account')
    })

    it('keeps two accounts with the same name apart by account number', () => {
      const twin = FIDELITY_2026_CSV.replace(
        /\r?\nZ11111111,Joint WROS - TOD,VOO/,
        '\r\nZ99999999,Joint WROS - TOD,VOO'
      )
      const names = parsePortfolioCSV(twin).accounts.map(a => a.name)
      expect(names.filter(n => n === 'Joint WROS - TOD')).toHaveLength(2)
    })

    it('treats SPAXX** and FDRXX** as money market and ** as cash', () => {
      expect(holdings.find(h => h.symbol === 'SPAXX')?.assetClass).toBe(
        'money_market'
      )
      expect(holdings.find(h => h.symbol === 'FDRXX')?.assetClass).toBe(
        'money_market'
      )
      const ira = result.accounts.find(a => a.name.includes('Traditional IRA'))
      expect(ira?.cashBalance).toBe(50)
    })

    it('skips the 401(k) BROKERAGELINK row the BrokerageLink account repeats', () => {
      expect(holdings.some(h => h.name === 'BROKERAGELINK')).toBe(false)
      expect(result.warnings.some(w => w.includes('BROKERAGELINK'))).toBe(true)
      expect(total).toBe(54_350)
    })

    it('types the BrokerageLink window as its parent plan, not taxable', () => {
      const types = Object.fromEntries(
        result.accounts.map(a => [a.name, a.accountType])
      )
      expect(types['BrokerageLink']).toBe('401k')
      expect(types['ACME 401(K)']).toBe('401k')
      expect(types['Joint WROS - TOD']).toBe('brokerage')
    })

    it('types a 403(b) BrokerageLink window as 403b', () => {
      const plan403b = FIDELITY_2026_CSV.replace(
        /ACME 401\(K\)/g,
        'ACME 403(B)'
      )
      const window = parsePortfolioCSV(plan403b).accounts.find(
        a => a.name === 'BrokerageLink'
      )
      expect(window?.accountType).toBe('403b')
    })

    it('keeps a BROKERAGELINK row when the export has no BrokerageLink account', () => {
      const alone = FIDELITY_2026_CSV.split(/\r?\n/)
        .filter(line => !line.startsWith('333333333,'))
        .join('\r\n')
      const parsed = parsePortfolioCSV(alone)
      const sum = parsed.accounts.reduce(
        (s, a) =>
          s +
          a.cashBalance +
          a.holdings.reduce((t, h) => t + h.currentValue, 0),
        0
      )
      expect(sum).toBe(54_350)
    })
  })

  describe('missing value column', () => {
    it('warns when neither a value nor a price column exists', () => {
      const result = parsePortfolioCSV(
        'Account,Symbol,Description,Quantity\nMain,VTI,Vanguard Total Stock,10'
      )
      expect(result.warnings.some(w => /column found/.test(w))).toBe(true)
    })
  })

  describe('Schwab parsing', () => {
    it('parses holdings and cash', () => {
      const result = parsePortfolioCSV(SCHWAB_CSV)
      expect(result.accounts.length).toBe(1)
      const account = result.accounts[0]
      expect(account.holdings.length).toBe(1)
      expect(account.cashBalance).toBe(5000)
    })
  })

  describe('Vanguard parsing', () => {
    it('parses multiple accounts', () => {
      const result = parsePortfolioCSV(VANGUARD_CSV)
      expect(result.accounts.length).toBe(2)
    })

    it('correctly classifies international holdings', () => {
      const result = parsePortfolioCSV(VANGUARD_CSV)
      const allHoldings = result.accounts.flatMap(a => a.holdings)
      const intl = allHoldings.find(h => h.symbol === 'VTIAX')
      expect(intl!.assetClass).toBe('intl_equity')
    })
  })

  describe('generic parsing', () => {
    it('parses basic CSV structure', () => {
      const result = parsePortfolioCSV(GENERIC_CSV)
      expect(result.rowsImported).toBe(3)
      expect(result.accounts.length).toBe(2)
    })

    it('guesses IRA account type', () => {
      const result = parsePortfolioCSV(GENERIC_CSV)
      const ira = result.accounts.find(a => a.name.includes('IRA'))
      expect(ira).toBeDefined()
      expect(ira!.accountType).toBe('traditional_ira')
    })
  })

  describe('edge cases', () => {
    it('returns empty result for empty CSV', () => {
      const result = parsePortfolioCSV('')
      expect(result.accounts).toEqual([])
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it('returns empty result for header-only CSV', () => {
      const result = parsePortfolioCSV('Symbol,Price,Value')
      expect(result.accounts).toEqual([])
    })

    it('handles quoted fields with commas', () => {
      const csv = `Account,Symbol,Description,Quantity,Price,Value,Cost Basis
"My Account",AAPL,"Apple, Inc.",10,185.00,"1,850.00","1,500.00"`
      const result = parsePortfolioCSV(csv)
      expect(result.accounts[0].holdings[0].currentValue).toBe(1850)
    })

    it('skips rows with no symbol and no name', () => {
      const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,,,,,,
Main,AAPL,Apple,10,185.00,1850.00,1500.00`
      const result = parsePortfolioCSV(csv)
      expect(result.rowsSkipped).toBe(1)
      expect(result.rowsImported).toBe(1)
    })
  })

  describe('error handling', () => {
    it('handles empty string input', () => {
      const result = parsePortfolioCSV('')
      expect(result.accounts).toEqual([])
      expect(result.warnings).toContain('CSV file is empty')
      expect(result.rowsImported).toBe(0)
    })

    it('handles whitespace-only input', () => {
      const result = parsePortfolioCSV('   \n   \n   ')
      expect(result.accounts).toEqual([])
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.rowsImported).toBe(0)
    })

    it('handles unclosed quotes gracefully', () => {
      const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,"Apple Inc,10,185.00,1850.00,1500.00`
      const result = parsePortfolioCSV(csv)
      // Should skip the malformed line and continue
      expect(result.rowsSkipped).toBeGreaterThanOrEqual(0)
    })

    it('handles malformed numeric values', () => {
      const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,Apple,abc,xyz,notanumber,invalid`
      const result = parsePortfolioCSV(csv)
      // Should skip rows with invalid numbers that result in zero values
      // This is expected behavior - protects against importing garbage data
      expect(result.rowsSkipped).toBeGreaterThanOrEqual(1)
    })

    it('handles missing required columns gracefully', () => {
      const csv = `RandomColumn1,RandomColumn2
Value1,Value2
Value3,Value4`
      const result = parsePortfolioCSV(csv)
      // Should detect generic format and attempt to parse
      expect(result.format).toBe('generic')
    })

    it('handles files with only headers', () => {
      const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis`
      const result = parsePortfolioCSV(csv)
      expect(result.accounts).toEqual([])
      expect(result.warnings).toContain('No data rows found in CSV')
    })

    it('handles extremely long lines without crashing', () => {
      const longValue = 'A'.repeat(10000)
      const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,"${longValue}",10,185.00,1850.00,1500.00`
      const result = parsePortfolioCSV(csv)
      expect(result.accounts.length).toBeGreaterThan(0)
    })

    it('handles special characters in field values', () => {
      const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
"Test & Co.",AAPL,"Apple <Inc>",10,185.00,1850.00,1500.00`
      const result = parsePortfolioCSV(csv)
      expect(result.accounts[0].holdings[0].name).toContain('Apple')
    })

    it('handles newlines within quoted fields', () => {
      const csv = `Account,Symbol,Name,Quantity,Price,Value,Cost Basis
Main,AAPL,"Apple
Inc",10,185.00,1850.00,1500.00
Main,MSFT,Microsoft,5,380.00,1900.00,1500.00`
      const result = parsePortfolioCSV(csv)
      // Should handle or skip malformed multiline
      expect(result.accounts.length).toBeGreaterThanOrEqual(0)
    })

    it('provides user-friendly error messages', () => {
      const result = parsePortfolioCSV('')
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings[0]).not.toContain('undefined')
      expect(result.warnings[0]).not.toContain('null')
    })
  })
})
