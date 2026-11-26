// Stock-bond correlation, long-term care, job loss and lump-sum currency
// stresses (REQ-MCP-82). Invented household only.
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { reviewPlan } from '../plan-review'
import { projectRetirement } from '../retirement-projection'
import type { Holding, Portfolio, UserProfile } from '../types'

function holding(
  id: string,
  assetClass: Holding['assetClass'],
  value: number
): Holding {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    assetClass,
    shares: value / 100,
    costBasis: value,
    currentPrice: 100,
    currentValue: value,
  }
}

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    {
      id: 'window',
      name: 'window',
      institution: 'Broker',
      accountType: '401k',
      cashBalance: 0,
      cds: [],
      holdings: [
        holding('voo', 'us_equity', 500_000),
        holding('bnd', 'us_bond', 400_000),
      ],
    },
  ],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_500,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
  preMedicareHealthcare: 25_000,
  separationAge: 60,
  lumpSums: [{ name: 'Overseas pension', age: 60, amount: 150_000 }],
}

const run = { seed: 42, paths: 300 }

describe('REQ-MCP-82: stock-bond correlation', () => {
  it('REQ-MCP-82 leaves seeded results unchanged at zero and widens the spread when positive', () => {
    const base = projectRetirement(portfolio, profile, run)
    const zero = projectRetirement(
      portfolio,
      { ...profile, marketAssumptions: { stockBondCorrelation: 0 } },
      run
    )
    expect(zero.monteCarlo).toEqual(base.monteCarlo)

    const spreadAt60 = (rho: number) => {
      const row = projectRetirement(
        portfolio,
        { ...profile, marketAssumptions: { stockBondCorrelation: rho } },
        run
      ).monteCarlo.percentiles.find(r => r.age === 60)!
      return row.p90 - row.p10
    }
    // Same seed and the same mix: the more stocks and bonds move together,
    // the wider the range of balances at retirement.
    expect(spreadAt60(0.6)).toBeGreaterThan(spreadAt60(0))
    expect(spreadAt60(0)).toBeGreaterThan(spreadAt60(-0.4))
    // For a plan that usually works, losing diversification costs success.
    const sound = { ...profile, annualExpenses: 60_000 }
    const rate = (rho: number) =>
      projectRetirement(
        portfolio,
        { ...sound, marketAssumptions: { stockBondCorrelation: rho } },
        run
      ).monteCarlo.successRate
    expect(rate(0)).toBeGreaterThan(0.6)
    expect(rate(0.6)).toBeLessThanOrEqual(rate(0))
  })

  it('REQ-MCP-82 bounds the correlation in the schema', () => {
    const ok = userProfileSchema.safeParse({
      ...profile,
      marketAssumptions: { stockBondCorrelation: 0.5 },
    })
    expect(ok.success).toBe(true)
    const bad = userProfileSchema.safeParse({
      ...profile,
      marketAssumptions: { stockBondCorrelation: 1 },
    })
    expect(bad.success).toBe(false)
  })
})

describe('REQ-MCP-82: long-term care', () => {
  it('REQ-MCP-82 adds the care cost only in the care years', () => {
    const care = { startAge: 85, years: 3, annualCost: 74_400 }
    const at = (p: UserProfile, age: number) =>
      projectRetirement(portfolio, p, run).expectedPath.years.find(
        y => y.age === age
      )?.healthcare ?? 0
    const withCare = { ...profile, longTermCare: care }
    expect(at(withCare, 84)).toBeCloseTo(at(profile, 84), 6)
    expect(at(withCare, 88)).toBeCloseTo(at(profile, 88), 6)
    // The year rows are in today's dollars.
    expect(at(withCare, 86) - at(profile, 86)).toBeCloseTo(74_400, 0)
    expect(
      projectRetirement(portfolio, withCare, run).monteCarlo.successRate
    ).toBeLessThanOrEqual(
      projectRetirement(portfolio, profile, run).monteCarlo.successRate
    )
  })

  it('REQ-MCP-82 keeps the ACA credit to the health premium, not the care cost', () => {
    // A taxable-only household with a low MAGI, so the credit is large.
    const taxableOnly: Portfolio = {
      ...portfolio,
      accounts: [
        {
          ...portfolio.accounts[0],
          id: 'brokerage',
          name: 'brokerage',
          accountType: 'brokerage',
          holdings: [
            holding('vti', 'us_equity', 600_000),
            holding('bnd', 'us_bond', 300_000),
          ],
        },
      ],
    }
    const base: UserProfile = {
      ...profile,
      annualExpenses: 30_000,
      annualContributions: 0,
      preMedicareHealthcare: 20_000,
      acaPremiumTaxCredit: true,
      lumpSums: [],
    }
    const care = { startAge: 60, years: 3, annualCost: 60_000 }
    const row = (p: UserProfile, age: number) =>
      projectRetirement(taxableOnly, p, run).expectedPath.years.find(
        y => y.age === age
      )!
    const plain = row(base, 61)
    const withCare = row({ ...base, longTermCare: care }, 61)
    expect(plain.acaCredit).toBeGreaterThan(0)
    expect(withCare.healthcare - plain.healthcare).toBeCloseTo(60_000, 0)
    // Care adds no credit: it never exceeds the premium or the plain year's.
    expect(withCare.acaCredit).toBeLessThanOrEqual(20_000)
    expect(withCare.acaCredit).toBeLessThanOrEqual(plain.acaCredit)
  })

  it('REQ-MCP-82 rejects a fractional care start age', () => {
    const bad = userProfileSchema.safeParse({
      ...profile,
      longTermCare: { startAge: 85.5, years: 3, annualCost: 70_000 },
    })
    expect(bad.success).toBe(false)
  })
})

describe('REQ-MCP-82: the review runs the stresses', () => {
  it('REQ-MCP-82 stresses correlation, care, a job gap and lump sums, each no better than the plan', () => {
    const review = reviewPlan(
      portfolio,
      { ...profile, annualExpenses: 60_000 },
      '2026-11-24',
      run
    )
    const names = review.stressTests.map(t => t.name)
    expect(names.some(n => /^Stocks and bonds fall together/.test(n))).toBe(
      true
    )
    expect(names.some(n => /^Care need: \$74,400 a year/.test(n))).toBe(true)
    expect(names.some(n => /^A year out of work from 55/.test(n))).toBe(true)
    expect(names.some(n => /^Lump sums worth 20% less/.test(n))).toBe(true)
    for (const t of review.stressTests) {
      expect(t.change).toBeLessThanOrEqual(0)
      expect(t.successRate).toBeGreaterThanOrEqual(0)
      expect(t.successRate).toBeLessThanOrEqual(1)
    }
  })

  it('REQ-MCP-82 skips a stress the profile already models', () => {
    const review = reviewPlan(
      portfolio,
      {
        ...profile,
        marketAssumptions: { stockBondCorrelation: 0.3 },
        longTermCare: { startAge: 82, years: 4, annualCost: 90_000 },
        lumpSums: [],
      },
      '2026-11-24',
      run
    )
    const names = review.stressTests.map(t => t.name)
    expect(names.some(n => /^Stocks and bonds/.test(n))).toBe(false)
    expect(names.some(n => /^Care need/.test(n))).toBe(false)
    expect(names.some(n => /^Lump sums/.test(n))).toBe(false)
  })
})
