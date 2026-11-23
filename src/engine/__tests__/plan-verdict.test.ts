// Plan verdict (REQ-MCP-56).
import { describe, expect, it } from 'vitest'
import { VERDICT_THRESHOLDS, planVerdict } from '../plan-verdict'
import type { Portfolio, UserProfile } from '../types'

function portfolioOf(value: number): Portfolio {
  return {
    id: 'p',
    name: 'Test',
    asOfDate: '2026-11-17',
    accounts: [
      {
        id: 'k',
        name: 'BrokerageLink',
        institution: 'Fidelity',
        accountType: '401k',
        cds: [],
        cashBalance: 0,
        holdings: [
          {
            id: 'v',
            symbol: 'VOO',
            name: 'VOO',
            assetClass: 'us_equity',
            shares: 1,
            costBasis: value * 0.6,
            currentPrice: value * 0.6,
            currentValue: value * 0.6,
          },
          {
            id: 'b',
            symbol: 'BND',
            name: 'BND',
            assetClass: 'us_bond',
            shares: 1,
            costBasis: value * 0.4,
            currentPrice: value * 0.4,
            currentValue: value * 0.4,
          },
        ],
      },
    ],
  }
}

const base: UserProfile = {
  currentAge: 59,
  targetRetirementAge: 60,
  annualExpenses: 40_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  planningAge: 90,
}

describe('REQ-MCP-56 plan verdict', () => {
  it('says GO for a well-funded plan, with no reasons', () => {
    const v = planVerdict(portfolioOf(2_000_000), base, '2026-11-21', {
      paths: 200,
    })
    expect(v.verdict).toBe('GO')
    expect(v.reasons).toEqual([])
    expect(v.measures.successRate).toBeGreaterThanOrEqual(
      VERDICT_THRESHOLDS.go.successRate
    )
    expect(v.headline).toMatch(/^GO: /)
    // No planRules: the verdict asks for them.
    expect(v.actions.some(a => a.startsWith('Save planRules'))).toBe(true)
  })

  it('says DELAY for an underfunded plan and leads with the reason and the spending action', () => {
    const v = planVerdict(
      portfolioOf(500_000),
      { ...base, annualExpenses: 90_000 },
      '2026-11-21',
      { paths: 200 }
    )
    expect(v.verdict).toBe('DELAY')
    expect(v.headline).toMatch(/^DELAY: chance the money lasts is/)
    expect(v.measures.forecastSuccessRate).toBeLessThanOrEqual(
      v.measures.successRate
    )
    expect(v.actions.some(a => a.startsWith('Plan spending at or below'))).toBe(
      true
    )
    expect(v.actions.length).toBeLessThanOrEqual(5)
  })

  it('puts the plan check first and is CAUTION when only the trades are behind', () => {
    const v = planVerdict(
      portfolioOf(2_000_000),
      {
        ...base,
        planRules: {
          targetEquityShare: 0.4,
          sellSchedule: [
            {
              id: 'chunk 1',
              dueDate: '2026-11-17',
              symbol: 'VOO',
              amount: 100_000,
            },
          ],
        },
      },
      '2026-11-21',
      { paths: 200 }
    )
    expect(v.measures.planStatus).toBe('action_needed')
    expect(v.verdict).toBe('CAUTION')
    expect(v.actions[0]).toMatch(/^Sell \$100,000 VOO in BrokerageLink/)
  })

  it('is deterministic', () => {
    const run = () =>
      planVerdict(portfolioOf(1_000_000), base, '2026-11-21', { paths: 100 })
    expect(run()).toEqual(run())
  })
})
