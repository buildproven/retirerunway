// Medicare IRMAA (REQ-MCP-44): tiers at the CMS 2026 boundaries, the
// two-year lookback in the projection, one surcharge per person on Medicare.
import { describe, expect, it } from 'vitest'
import { IRMAA_2026, irmaaCeiling, irmaaFor } from '../irmaa'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import type { AccountType, Portfolio, UserProfile } from '../types'

function account(id: string, accountType: AccountType, value: number) {
  return {
    id,
    name: id,
    institution: 'Test',
    accountType,
    cds: [],
    cashBalance: 0,
    holdings: [
      {
        id: `${id}-bd`,
        symbol: 'BD',
        name: 'Bond',
        assetClass: 'us_bond' as const,
        shares: 1,
        costBasis: value,
        currentPrice: value,
        currentValue: value,
      },
    ],
  }
}

function portfolio(...accounts: ReturnType<typeof account>[]): Portfolio {
  return { id: 'p', name: 'Test', asOfDate: '2026-11-17', accounts }
}

const yearly = (b: number, d: number) => Math.round((b + d) * 12 * 100) / 100

describe('irmaaFor (CMS 2026 table)', () => {
  it('charges nothing at or below the first threshold', () => {
    expect(irmaaFor(218_000, 'married_filing_jointly')).toEqual({
      tier: 0,
      annualPerPerson: 0,
    })
    expect(irmaaFor(109_000, 'single').tier).toBe(0)
  })

  it('moves up a tier one dollar over each threshold', () => {
    expect(irmaaFor(218_001, 'married_filing_jointly')).toEqual({
      tier: 1,
      annualPerPerson: yearly(81.2, 14.5),
    })
    expect(irmaaFor(274_001, 'married_filing_jointly').tier).toBe(2)
    expect(irmaaFor(342_001, 'married_filing_jointly').tier).toBe(3)
    expect(irmaaFor(410_001, 'married_filing_jointly').tier).toBe(4)
    expect(irmaaFor(109_001, 'single').tier).toBe(1)
  })

  it('starts the top tier AT $750,000 joint / $500,000 single', () => {
    expect(irmaaFor(749_999, 'married_filing_jointly')).toEqual({
      tier: 4,
      annualPerPerson: yearly(446.3, 83.3),
    })
    expect(irmaaFor(750_000, 'married_filing_jointly')).toEqual({
      tier: 5,
      annualPerPerson: yearly(487, 91),
    })
    expect(irmaaFor(500_000, 'single').tier).toBe(5)
  })

  it('uses the individual thresholds for head of household', () => {
    expect(irmaaFor(150_000, 'head_of_household').tier).toBe(2)
    expect(irmaaFor(150_000, 'married_filing_jointly').tier).toBe(0)
  })

  it('gives the MAGI ceiling that keeps each tier', () => {
    expect(irmaaCeiling(0, 'married_filing_jointly')).toBe(218_000)
    expect(irmaaCeiling(1, 'single')).toBe(137_000)
    expect(irmaaCeiling(IRMAA_2026.tiers.length, 'single')).toBe(Infinity)
  })
})

describe('IRMAA in projectRetirement', () => {
  // Large pretax balance: RMDs and spending keep AGI well above $218,000.
  const rich = portfolio(account('k', '401k', 6_000_000))
  const richProfile: UserProfile = {
    currentAge: 62,
    targetRetirementAge: 62,
    annualExpenses: 240_000,
    socialSecurityAge: 67,
    socialSecurityMonthly: 4_000,
    filingStatus: 'married_filing_jointly',
    planningAge: 80,
  }

  const yearAt = (r: ReturnType<typeof projectRetirement>, age: number) => {
    const year = r.expectedPath.years.find(y => y.age === age)
    if (year === undefined) throw new Error(`no year ${age}`)
    return year
  }

  it('charges nothing before 65 and a surcharge from 65 when AGI is high', () => {
    const r = projectRetirement(rich, richProfile, { paths: 10 })
    expect(yearAt(r, 64).irmaa).toBe(0)
    const y65 = yearAt(r, 65)
    expect(y65.irmaaTier).toBeGreaterThan(0)
    // One person on Medicare (no spouse given): one tier's surcharge.
    const tier = IRMAA_2026.tiers.at(y65.irmaaTier - 1)
    expect(tier).toBeDefined()
    expect(y65.irmaa).toBe(
      Math.round(((tier?.partB ?? 0) + (tier?.partD ?? 0)) * 12)
    )
    expect(r.expectedPath.lifetimeIrmaa).toBe(
      r.expectedPath.years.reduce((sum, y) => sum + y.irmaa, 0)
    )
    expect(r.expectedPath.lifetimeIrmaa).toBeGreaterThan(0)
  })

  it('charges each spouse on Medicare', () => {
    const single = projectRetirement(rich, richProfile, { paths: 10 })
    const couple = projectRetirement(
      rich,
      {
        ...richProfile,
        spouse: { currentAge: 62, socialSecurityAge: 67 },
      },
      { paths: 10 }
    )
    const s = yearAt(single, 66)
    const c = yearAt(couple, 66)
    expect(c.irmaaTier).toBe(s.irmaaTier)
    expect(c.irmaa).toBeGreaterThanOrEqual(2 * s.irmaa - 1)
    expect(c.irmaa).toBeLessThanOrEqual(2 * s.irmaa + 1)
  })

  it('charges nothing when AGI stays under the first threshold', () => {
    const modest = projectRetirement(
      portfolio(account('k', '401k', 900_000)),
      { ...richProfile, annualExpenses: 60_000 },
      { paths: 10 }
    )
    expect(modest.expectedPath.lifetimeIrmaa).toBe(0)
    expect(modest.expectedPath.years.every(y => y.irmaaTier === 0)).toBe(true)
  })

  it('is paid from the portfolio: cash in covers spending, IRMAA and tax', () => {
    const r = projectRetirement(rich, richProfile, { paths: 10 })
    const y70 = yearAt(r, 70)
    expect(y70.irmaa).toBeGreaterThan(0)
    const cashIn = y70.withdrawals.total + y70.socialSecurity + y70.otherIncome
    const cashOut = y70.spending + y70.irmaa + y70.taxes.total
    expect(cashIn).toBeGreaterThanOrEqual(cashOut - 5)
  })

  it('skips a lookback year before retirement and says so', () => {
    const late: UserProfile = {
      ...richProfile,
      currentAge: 60,
      targetRetirementAge: 64,
    }
    const r = projectRetirement(rich, late, { paths: 10 })
    expect(yearAt(r, 65).irmaa).toBe(0) // lookback 63: still working
    expect(yearAt(r, 66).irmaaTier).toBeGreaterThan(0) // lookback 64: retired
    expect(projectionWarnings(rich, late).join('\n')).toMatch(
      /IRMAA is not modelled for Medicare years whose two-year lookback falls before retirement at 64/
    )
    expect(projectionWarnings(rich, richProfile).join('\n')).not.toMatch(
      /IRMAA is not modelled/
    )
  })

  it('is deterministic', () => {
    const a = projectRetirement(rich, richProfile, { paths: 50, seed: 7 })
    const b = projectRetirement(rich, richProfile, { paths: 50, seed: 7 })
    expect(a).toEqual(b)
  })
})
