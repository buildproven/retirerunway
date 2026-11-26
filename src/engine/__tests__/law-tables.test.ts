// Law tables kept current (REQ-MCP-84): dated tables, staleness, 2027
// federal figures, the extra deduction at 65 and the senior deduction.
import { describe, expect, it } from 'vitest'
import { IRMAA_2027 } from '../irmaa'
import {
  LAW_SUNSETS,
  LAW_TABLES,
  expectedYear,
  lawTablesBehind,
  lawTablesMessage,
} from '../law-tables'
import { projectRetirement } from '../retirement-projection'
import {
  AGED_ADDITIONAL_DEDUCTION,
  FEDERAL_TAX_YEAR,
  calculateOrdinaryTax,
  getStandardDeduction,
  seniorDeduction,
} from '../tax-brackets'
import type { Account, Portfolio, UserProfile } from '../types'

describe('REQ-MCP-84: law tables and when they fall behind', () => {
  const federal = LAW_TABLES.find(t => t.id === 'federalTax')!

  it('REQ-MCP-84 dates each table and matches the engine figures', () => {
    expect(federal.year).toBe(FEDERAL_TAX_YEAR)
    expect(LAW_TABLES.find(t => t.id === 'irmaa')!.year).toBe(IRMAA_2027.year)
    for (const t of LAW_TABLES) {
      expect(t.source.length).toBeGreaterThan(5)
      expect(t.published.month).toBeGreaterThanOrEqual(1)
      expect(t.published.month).toBeLessThanOrEqual(12)
    }
    expect(LAW_SUNSETS.find(s => s.id === 'seniorDeduction')!.lastYear).toBe(
      2028
    )
  })

  it('REQ-MCP-84 expects next year’s tax tables after mid-November', () => {
    expect(expectedYear(federal, '2026-11-14')).toBe(2026)
    expect(expectedYear(federal, '2026-11-15')).toBe(2027)
    expect(expectedYear(federal, '2027-11-20')).toBe(2028)
    const poverty = LAW_TABLES.find(t => t.id === 'povertyLine')!
    expect(expectedYear(poverty, '2027-01-31')).toBe(2026)
    expect(expectedYear(poverty, '2027-02-15')).toBe(2027)
  })

  it('REQ-MCP-84 is current today and names each table once it falls behind', () => {
    expect(lawTablesBehind('2026-11-25')).toEqual([])
    expect(lawTablesMessage('2026-11-25')).toBeUndefined()
    const later = lawTablesBehind('2027-12-01').map(t => t.id)
    expect(later).toEqual(
      expect.arrayContaining([
        'federalTax',
        'irmaa',
        'acaApplicablePercentage',
        'povertyLine',
        'socialSecurityTrustees',
      ])
    )
    expect(lawTablesMessage('2027-12-01')).toMatch(
      /^the engine's law figures are behind: .*are for 2026/
    )
  })
})

describe('REQ-MCP-84: 2027 federal figures', () => {
  it('REQ-MCP-84 uses the 2027 brackets and standard deduction (Rev. Proc. 2026-35)', () => {
    expect(getStandardDeduction('married_filing_jointly')).toBe(33_200)
    expect(getStandardDeduction('single')).toBe(16_600)
    // MFJ: 10% of 25,600 + 12% of (104,050 - 25,600) = 2,560 + 9,414.
    expect(calculateOrdinaryTax(104_050, 'married_filing_jointly').total).toBe(
      11_974
    )
    expect(
      calculateOrdinaryTax(104_051, 'married_filing_jointly').marginalRate
    ).toBe(0.22)
    expect(AGED_ADDITIONAL_DEDUCTION.married_filing_jointly).toBe(1_700)
  })

  it('REQ-MCP-84 phases the senior deduction out and ends it after 2028', () => {
    expect(seniorDeduction(2027, 2, 100_000, 'married_filing_jointly')).toBe(
      12_000
    )
    // 6% of 50,000 over 150,000 = 3,000 off each person's 6,000.
    expect(seniorDeduction(2028, 2, 200_000, 'married_filing_jointly')).toBe(
      6_000
    )
    expect(seniorDeduction(2028, 1, 300_000, 'married_filing_jointly')).toBe(0)
    expect(seniorDeduction(2029, 2, 50_000, 'married_filing_jointly')).toBe(0)
    expect(seniorDeduction(2027, 0, 50_000, 'single')).toBe(0)
  })
})

describe('REQ-MCP-84: deductions at 65 in the projection', () => {
  const account = (
    accountType: Account['accountType'],
    value: number
  ): Account => ({
    id: accountType,
    name: accountType,
    institution: 'Broker',
    accountType,
    cashBalance: value,
    cds: [],
    holdings: [],
  })
  const portfolio: Portfolio = {
    id: 'p',
    name: 'Test',
    asOfDate: '2026-11-17',
    accounts: [account('401k', 1_500_000)],
  }
  // Owner 63 in 2026: 65 in 2028 (senior deduction year), 66 in 2029 (not).
  const profile: UserProfile = {
    currentAge: 63,
    targetRetirementAge: 64,
    annualExpenses: 70_000,
    socialSecurityAge: 70,
    socialSecurityMonthly: 3_000,
  }
  const tax = (p: UserProfile, age: number) =>
    projectRetirement(portfolio, p, { paths: 1 }).expectedPath.years.find(
      y => y.age === age
    )!.taxes.federal

  it('REQ-MCP-84 lowers tax at 65 in 2028 by the senior deduction and keeps the extra deduction after', () => {
    // Same withdrawals at 64 and 65 apart from inflation; the deductions at
    // 65 (2028) cut tax, and 2029 keeps only the $2,100 extra deduction.
    const at64 = tax(profile, 64)
    const at65 = tax(profile, 65)
    const at66 = tax(profile, 66)
    expect(at65).toBeLessThan(at64)
    expect(at66).toBeGreaterThan(at65)
    // A profile one year younger reaches 65 in 2029, after the deduction ends.
    const younger = { ...profile, currentAge: 62, targetRetirementAge: 63 }
    expect(tax(younger, 65)).toBeGreaterThan(at65)
  })
})
