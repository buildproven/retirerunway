// Asset location (REQ-MCP-85): bonds where interest is not taxed, stocks
// where growth is tax-free, with the overall mix unchanged.
import { describe, expect, it } from 'vitest'
import { assetLocation } from '../asset-location'
import { reviewPlan } from '../plan-review'
import type { Account, Holding, Portfolio, UserProfile } from '../types'

const holding = (
  id: string,
  assetClass: Holding['assetClass'],
  value: number
): Holding => ({
  id,
  symbol: id.toUpperCase(),
  name: id,
  assetClass,
  shares: value / 100,
  costBasis: value,
  currentPrice: 100,
  currentValue: value,
})

const account = (
  id: string,
  accountType: Account['accountType'],
  holdings: Holding[],
  cashBalance = 0
): Account => ({
  id,
  name: id,
  institution: 'Broker',
  accountType,
  holdings,
  cds: [],
  cashBalance,
})

const portfolio = (...accounts: Account[]): Portfolio => ({
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts,
})

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  marketData: { asOfDate: '2026-11-25', treasury10y: 0.05 },
}

describe('REQ-MCP-85: asset location', () => {
  const p = portfolio(
    account('tax', 'brokerage', [holding('bnd', 'us_bond', 80_300)], 20_000),
    account('k', '401k', [holding('voo', 'us_equity', 500_000)]),
    account('roth', 'roth_ira', [holding('bndr', 'us_bond', 40_000)])
  )

  it('REQ-MCP-85 swaps taxable bonds and Roth bonds against pre-tax stocks, in whole thousands', () => {
    const r = assetLocation(p, profile)
    expect(r.byPlace.taxable).toEqual({
      stocks: 0,
      bonds: 80_300,
      cash: 20_000,
    })
    expect(r.swaps.map(s => [s.sellIn, s.buyIn, s.amount])).toEqual([
      ['taxable', 'preTax', 80_000],
      ['taxFree', 'preTax', 40_000],
    ])
    // Interest moved out of taxable: $80,000 at 5% = $4,000 a year.
    expect(r.swaps[0].reason).toContain('$4,000 a year of interest')
    // Cash in taxable is the spending buffer: it is not swapped.
    expect(r.swaps[0].amount).toBeLessThan(80_300 + 20_000)
  })

  it('REQ-MCP-85 never swaps more than the pre-tax stocks and skips protected accounts', () => {
    const small = portfolio(
      account('tax', 'brokerage', [holding('bnd', 'us_bond', 80_000)]),
      account('k', '401k', [holding('voo', 'us_equity', 30_000)]),
      account('roth', 'roth_ira', [holding('bndr', 'us_bond', 40_000)])
    )
    const r = assetLocation(small, profile)
    const total = r.swaps.reduce((s, x) => s + x.amount, 0)
    expect(total).toBeLessThanOrEqual(30_000)
    const guarded = assetLocation(p, {
      ...profile,
      planRules: {
        targetEquityShare: 0.5,
        protectedAccountTypes: ['brokerage'],
      },
    })
    expect(guarded.swaps.some(s => s.sellIn === 'taxable')).toBe(false)
  })

  it('REQ-MCP-85 says location is fine when bonds already sit in pre-tax', () => {
    const fine = portfolio(
      account('k', '401k', [holding('bnd', 'us_bond', 300_000)]),
      account('roth', 'roth_ira', [holding('voo', 'us_equity', 100_000)])
    )
    const r = assetLocation(fine, profile)
    expect(r.swaps).toEqual([])
    expect(r.headline).toMatch(/^Asset location is fine/)
  })

  it('REQ-MCP-85 puts the swaps in the review actions', () => {
    const review = reviewPlan(p, profile, '2026-11-24', {
      seed: 42,
      paths: 100,
    })
    expect(review.assetLocation.swaps.length).toBe(2)
    expect(
      review.actions.filter(a => a.startsWith('Asset location:')).length
    ).toBe(2)
  })
})
