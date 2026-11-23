// The v1 alerts and trade plan follow the owner's planRules (REQ-MCP-53).
import { describe, expect, it } from 'vitest'
import { generateAlerts } from '../alerts'
import { generateTradePlan } from '../trade-plan'
import type { Portfolio, UserProfile } from '../types'

// $1M, 80% stocks: taxable VOO $300K (gain), 401(k) VOO $500K and BND $200K.
const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    {
      id: 'joint',
      name: 'Joint',
      institution: 'Fidelity',
      accountType: 'brokerage',
      cds: [],
      cashBalance: 0,
      holdings: [
        {
          id: 'j1',
          symbol: 'VOO',
          name: 'VOO',
          assetClass: 'us_equity',
          shares: 500,
          costBasis: 150_000,
          currentPrice: 600,
          currentValue: 300_000,
        },
      ],
    },
    {
      id: 'k',
      name: 'BrokerageLink',
      institution: 'Fidelity',
      accountType: '401k',
      cds: [],
      cashBalance: 0,
      holdings: [
        {
          id: 'k1',
          symbol: 'VOO',
          name: 'VOO',
          assetClass: 'us_equity',
          shares: 833,
          costBasis: 300_000,
          currentPrice: 600,
          currentValue: 500_000,
        },
        {
          id: 'k2',
          symbol: 'BND',
          name: 'BND',
          assetClass: 'us_bond',
          shares: 2_700,
          costBasis: 200_000,
          currentPrice: 74,
          currentValue: 200_000,
        },
      ],
    },
  ],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 100_000,
}

describe('REQ-MCP-53 v1 tools follow planRules', () => {
  it('measures equity drift against the saved target and band', () => {
    const fixed = generateAlerts(
      portfolio,
      profile,
      undefined,
      '2026-11-20'
    ).find(a => a.id === 'drift-equity')
    expect(fixed?.threshold).toBe(0.6)
    const ruled = generateAlerts(
      portfolio,
      { ...profile, planRules: { targetEquityShare: 0.64, driftBand: 0.05 } },
      undefined,
      '2026-11-20'
    ).find(a => a.id === 'drift-equity')
    expect(ruled?.threshold).toBe(0.64)
    expect(ruled?.message).toContain('your 64% target')
    // 16 points over a 5-point band: more than twice the band.
    expect(ruled?.severity).toBe('critical')
    // Within the band: no drift alert.
    expect(
      generateAlerts(
        portfolio,
        { ...profile, planRules: { targetEquityShare: 0.78 } },
        undefined,
        '2026-11-20'
      ).some(a => a.id === 'drift-equity')
    ).toBe(false)
  })

  it('never sells from a protected account type', () => {
    const open = generateTradePlan(portfolio, profile)
    expect(open.trades.some(t => t.accountId === 'joint')).toBe(true)
    const ruled = generateTradePlan(portfolio, {
      ...profile,
      planRules: {
        targetEquityShare: 0.64,
        protectedAccountTypes: ['brokerage'],
      },
    })
    expect(ruled.trades.length).toBeGreaterThan(0)
    expect(ruled.trades.every(t => t.accountId === 'k')).toBe(true)
    expect(ruled.totalTaxImpact).toBe(0)
  })
})
