import { describe, it, expect } from 'vitest'
import { mapPlaidToPortfolio as mapPlaidToPortfolioImpl } from '../plaid-mapper'
import type { PlaidAccount, PlaidHolding, PlaidSecurity } from '../plaid-mapper'

function makePlaidAccount(overrides: Partial<PlaidAccount> = {}): PlaidAccount {
  return {
    account_id: 'acct-1',
    name: 'My Brokerage',
    type: 'investment',
    subtype: 'brokerage',
    balances: { current: 5000, available: 5000 },
    ...overrides,
  }
}

function makePlaidSecurity(
  overrides: Partial<PlaidSecurity> = {}
): PlaidSecurity {
  return {
    security_id: 'sec-1',
    ticker_symbol: 'VTI',
    name: 'Vanguard Total Stock Market',
    type: 'etf',
    close_price: 250,
    ...overrides,
  }
}

function makePlaidHolding(overrides: Partial<PlaidHolding> = {}): PlaidHolding {
  return {
    account_id: 'acct-1',
    security_id: 'sec-1',
    quantity: 100,
    cost_basis: 20000,
    institution_value: 25000,
    ...overrides,
  }
}

function mapPlaidToPortfolio(
  accounts: PlaidAccount[],
  holdings: PlaidHolding[],
  securities: PlaidSecurity[],
  portfolioName = 'Imported Portfolio'
) {
  return mapPlaidToPortfolioImpl(accounts, holdings, securities, {
    portfolioName,
    asOfDate: '2026-01-31',
  })
}

describe('mapPlaidToPortfolio', () => {
  it('maps a simple brokerage account with one holding', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity()]
    )

    expect(result.accountsImported).toBe(1)
    expect(result.holdingsImported).toBe(1)
    expect(result.warnings).toHaveLength(0)

    const account = result.portfolio.accounts[0]
    expect(account.accountType).toBe('brokerage')
    expect(account.cashBalance).toBe(5000)
    expect(account.holdings).toHaveLength(1)
    expect(account.holdings[0].symbol).toBe('VTI')
    expect(account.holdings[0].currentValue).toBe(25000)
    expect(account.holdings[0].costBasis).toBe(20000)
    expect(account.holdings[0].assetClass).toBe('us_equity')
  })

  it('maps IRA account type correctly', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ subtype: 'ira' })],
      [makePlaidHolding()],
      [makePlaidSecurity()]
    )
    expect(result.portfolio.accounts[0].accountType).toBe('traditional_ira')
  })

  it('maps Roth account type correctly', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ subtype: 'roth' })],
      [makePlaidHolding()],
      [makePlaidSecurity()]
    )
    expect(result.portfolio.accounts[0].accountType).toBe('roth_ira')
  })

  it('maps 401k account type correctly', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ subtype: '401k' })],
      [makePlaidHolding()],
      [makePlaidSecurity()]
    )
    expect(result.portfolio.accounts[0].accountType).toBe('401k')
  })

  it('maps bond securities to us_bond asset class', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity({ type: 'bond', ticker_symbol: 'BND' })]
    )
    expect(result.portfolio.accounts[0].holdings[0].assetClass).toBe('us_bond')
  })

  it('folds cash-like holdings into cashBalance', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ balances: { current: 1000, available: 1000 } })],
      [makePlaidHolding({ security_id: 'sec-cash', institution_value: 3000 })],
      [makePlaidSecurity({ security_id: 'sec-cash', type: 'cash' })]
    )
    // Original cashBalance 1000 + cash holding 3000 = 4000
    expect(result.portfolio.accounts[0].cashBalance).toBe(4000)
    expect(result.portfolio.accounts[0].holdings).toHaveLength(0)
  })

  it('handles multiple accounts and holdings', () => {
    const result = mapPlaidToPortfolio(
      [
        makePlaidAccount({ account_id: 'acct-1', name: 'Brokerage' }),
        makePlaidAccount({
          account_id: 'acct-2',
          name: 'IRA',
          subtype: 'ira',
        }),
      ],
      [
        makePlaidHolding({ account_id: 'acct-1', security_id: 'sec-1' }),
        makePlaidHolding({ account_id: 'acct-2', security_id: 'sec-2' }),
      ],
      [
        makePlaidSecurity({ security_id: 'sec-1', ticker_symbol: 'VTI' }),
        makePlaidSecurity({ security_id: 'sec-2', ticker_symbol: 'VXUS' }),
      ]
    )
    expect(result.accountsImported).toBe(2)
    expect(result.holdingsImported).toBe(2)
  })

  it('warns on unknown account references', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ account_id: 'acct-1' })],
      [makePlaidHolding({ account_id: 'acct-unknown' })],
      [makePlaidSecurity()]
    )
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('unknown account')
  })

  it('warns on unknown security references', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount()],
      [makePlaidHolding({ security_id: 'sec-unknown' })],
      [makePlaidSecurity()]
    )
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('not found')
  })

  it('defaults cost basis to current value when null', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount()],
      [makePlaidHolding({ cost_basis: null, institution_value: 15000 })],
      [makePlaidSecurity()]
    )
    expect(result.portfolio.accounts[0].holdings[0].costBasis).toBe(15000)
  })

  it('handles empty inputs', () => {
    const result = mapPlaidToPortfolio([], [], [])
    expect(result.accountsImported).toBe(0)
    expect(result.holdingsImported).toBe(0)
    expect(result.portfolio.accounts).toHaveLength(0)
  })

  it('falls back to type-level mapping when subtype is unknown', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ type: 'investment', subtype: 'unknown_sub' })],
      [makePlaidHolding()],
      [makePlaidSecurity()]
    )
    expect(result.portfolio.accounts[0].accountType).toBe('brokerage')
  })

  it('falls back to brokerage when both type and subtype are unrecognized', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ type: 'other', subtype: 'weird' })],
      [makePlaidHolding()],
      [makePlaidSecurity()]
    )
    expect(result.portfolio.accounts[0].accountType).toBe('brokerage')
  })

  it('maps unknown security type to "other" asset class', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity({ type: 'structured_note' })]
    )
    expect(result.portfolio.accounts[0].holdings[0].assetClass).toBe('other')
  })

  it('maps null security type to "other" asset class', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity({ type: null })]
    )
    expect(result.portfolio.accounts[0].holdings[0].assetClass).toBe('other')
  })

  it('uses custom portfolio name', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      'My Custom Name'
    )
    expect(result.portfolio.name).toBe('My Custom Name')
  })

  it('uses an explicit as-of date and content-derived portfolio identity', () => {
    const options = { portfolioName: 'Imported', asOfDate: '2026-02-01' }
    const first = mapPlaidToPortfolioImpl(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      options
    )
    const second = mapPlaidToPortfolioImpl(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      options
    )

    expect(first.portfolio.asOfDate).toBe('2026-02-01')
    expect(first.portfolio.id).toBe(second.portfolio.id)
    expect(first.portfolio.id).toMatch(/^plaid-[0-9a-f]{32}$/)

    const nextSnapshot = mapPlaidToPortfolioImpl(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      { ...options, asOfDate: '2026-02-02' }
    )
    expect(nextSnapshot.portfolio.id).not.toBe(first.portfolio.id)
  })

  it('canonicalizes nested balance fields before hashing', () => {
    const normal = mapPlaidToPortfolioImpl(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      { asOfDate: '2026-02-01' }
    )
    const reversedBalanceKeys = mapPlaidToPortfolioImpl(
      [
        makePlaidAccount({
          balances: { available: 5000, current: 5000 },
        }),
      ],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      { asOfDate: '2026-02-01' }
    )

    expect(reversedBalanceKeys.portfolio.id).toBe(normal.portfolio.id)
  })

  it('retains additional balance metadata in the fingerprint', () => {
    const normal = mapPlaidToPortfolioImpl(
      [makePlaidAccount()],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      { asOfDate: '2026-02-01' }
    )
    const changedMetadata = mapPlaidToPortfolioImpl(
      [
        makePlaidAccount({
          balances: {
            current: 5000,
            available: 5000,
            iso_currency_code: 'EUR',
          },
        }),
      ],
      [makePlaidHolding()],
      [makePlaidSecurity()],
      { asOfDate: '2026-02-01' }
    )

    expect(changedMetadata.portfolio.id).not.toBe(normal.portfolio.id)
  })

  it('rejects unsupported balance metadata instead of collapsing it', () => {
    expect(() =>
      mapPlaidToPortfolioImpl(
        [
          makePlaidAccount({
            balances: {
              current: 5000,
              available: 5000,
              observed_at: new Date('2026-02-01'),
            },
          }),
        ],
        [makePlaidHolding()],
        [makePlaidSecurity()],
        { asOfDate: '2026-02-01' }
      )
    ).toThrow('JSON-compatible plain objects')
  })

  it('uses available balance when current is null', () => {
    const result = mapPlaidToPortfolio(
      [makePlaidAccount({ balances: { current: null, available: 3000 } })],
      [makePlaidHolding()],
      [makePlaidSecurity()]
    )
    expect(result.portfolio.accounts[0].cashBalance).toBe(3000)
  })
})
