// One-off after-tax lump sums at an age (REQ-MCP-60).
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import type { Portfolio, UserProfile } from '../types'

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    {
      id: 'k',
      name: '401k',
      institution: 'Test',
      accountType: '401k',
      cds: [],
      cashBalance: 0,
      holdings: [
        {
          id: 'bd',
          symbol: 'BD',
          name: 'Bond',
          assetClass: 'us_bond',
          shares: 1,
          costBasis: 1_000_000,
          currentPrice: 1_000_000,
          currentValue: 1_000_000,
        },
      ],
    },
  ],
}

const base: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 90_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  planningAge: 95,
}

const withSuper: UserProfile = {
  ...base,
  lumpSums: [{ name: 'Foreign pension', age: 60, amount: 50_000 }],
}

const yearAt = (profile: UserProfile, age: number) => {
  const year = projectRetirement(portfolio, profile, {
    paths: 10,
  }).expectedPath.years.find(y => y.age === age)
  if (year === undefined) throw new Error(`no year ${age}`)
  return year
}

describe('REQ-MCP-60 lump sums', () => {
  it('adds nothing before the age and the whole amount at it, untaxed', () => {
    expect(yearAt(withSuper, 59).endBalances.taxable).toBe(
      yearAt(base, 59).endBalances.taxable
    )
    // The lump sum lands as basis, untaxed. Spending it first means less
    // pre-tax money comes out that year, so savings rise by the amount plus
    // at most the tax saved and a year's growth on the difference.
    const plain = yearAt(base, 60)
    const lumped = yearAt(withSuper, 60)
    const gained = lumped.endBalances.total - plain.endBalances.total
    expect(gained).toBeGreaterThanOrEqual(50_000 - 1)
    expect(gained).toBeLessThanOrEqual((50_000 + plain.taxes.total) * 1.1)
    expect(lumped.taxes.total).toBeLessThan(plain.taxes.total)
  })

  it('raises the success rate and names the sum in the warnings', () => {
    const lean = { ...base, annualExpenses: 75_000 }
    const without = projectRetirement(portfolio, lean, { paths: 200 })
    const withIt = projectRetirement(
      portfolio,
      { ...lean, lumpSums: withSuper.lumpSums },
      { paths: 200 }
    )
    expect(withIt.monteCarlo.successRate).toBeGreaterThan(
      without.monteCarlo.successRate
    )
    expect(projectionWarnings(portfolio, withSuper)).toContain(
      'lump sum "Foreign pension": $50,000 after tax in today\'s dollars arrives at 60 into taxable savings'
    )
    expect(
      projectionWarnings(portfolio, {
        ...base,
        lumpSums: [{ name: 'Past', age: 50, amount: 1 }],
      })
    ).toContain(
      'lump sum "Past" is ignored: age 50 is outside the projection (54 to 95)'
    )
  })

  it('warns only about the sums the projection adds, at a fractional age too', () => {
    const lumpAt = (age: number): UserProfile => ({
      ...base,
      lumpSums: [{ name: 'Inheritance', age, amount: 50_000 }],
    })
    const totals = (profile: UserProfile) =>
      projectRetirement(portfolio, profile, {
        paths: 10,
      }).expectedPath.years.map(y => y.endBalances.total)
    // 53.5 counts as 53, the current age, so no projection year adds it.
    expect(totals(lumpAt(53.5))).toEqual(totals(base))
    expect(projectionWarnings(portfolio, lumpAt(53.5))).toContain(
      'lump sum "Inheritance" is ignored: age 53.5 (counted as 53) is outside the projection (54 to 95)'
    )
    // 60.5 counts as 60 and is added there.
    expect(yearAt(lumpAt(60.5), 60).endBalances).toEqual(
      yearAt(lumpAt(60), 60).endBalances
    )
    expect(projectionWarnings(portfolio, lumpAt(60.5))).toContain(
      'lump sum "Inheritance": $50,000 after tax in today\'s dollars arrives at 60 into taxable savings'
    )
    // 95.5 counts as 95, the last projection year, so it is not ignored.
    expect(projectionWarnings(portfolio, lumpAt(95.5))).toContain(
      'lump sum "Inheritance": $50,000 after tax in today\'s dollars arrives at 95 into taxable savings'
    )
  })

  it('validates the profile field', () => {
    expect(userProfileSchema.safeParse(withSuper).success).toBe(true)
    expect(
      userProfileSchema.safeParse({
        ...base,
        lumpSums: [{ name: 'x', age: 60, amount: -1 }],
      }).success
    ).toBe(false)
  })
})
