import { describe, it, expect } from 'vitest'
import type { CD } from '../types'
import {
  calculateAccruedInterest,
  calculatePenaltyAmount,
  calculateBreakEvenDate,
  analyzeCDBreak,
  analyzeAllCDs,
} from '../cd-analysis'

function makeCD(overrides: Partial<CD> = {}): CD {
  return {
    id: 'cd-1',
    institution: 'Fidelity',
    principal: 10000,
    apy: 0.05,
    termMonths: 12,
    maturityDate: '2027-01-15',
    purchaseDate: '2026-01-15',
    earlyWithdrawalPenaltyMonths: 3,
    ...overrides,
  }
}

describe('calculateAccruedInterest', () => {
  it('returns 0 when as-of date is before purchase', () => {
    const cd = makeCD()
    expect(calculateAccruedInterest(cd, '2025-12-01')).toBe(0)
  })

  it('returns full interest at maturity', () => {
    const cd = makeCD()
    const result = calculateAccruedInterest(cd, '2027-01-15')
    expect(result).toBeCloseTo(500, 0) // 10000 * 0.05 * 1 year
  })

  it('returns proportional interest midway', () => {
    const cd = makeCD()
    const result = calculateAccruedInterest(cd, '2026-07-15')
    expect(result).toBeGreaterThan(200)
    expect(result).toBeLessThan(300)
  })

  it('caps at maturity for dates past maturity', () => {
    const cd = makeCD()
    const result = calculateAccruedInterest(cd, '2028-01-01')
    expect(result).toBeCloseTo(500, 0)
  })
})

describe('calculatePenaltyAmount', () => {
  it('calculates 3-month penalty correctly', () => {
    const cd = makeCD({ earlyWithdrawalPenaltyMonths: 3 })
    const result = calculatePenaltyAmount(cd)
    // 10000 * (0.05/365) * 3 * 30 = ~123.29
    expect(result).toBeGreaterThan(120)
    expect(result).toBeLessThan(130)
  })

  it('calculates 6-month penalty correctly', () => {
    const cd = makeCD({ earlyWithdrawalPenaltyMonths: 6 })
    const result = calculatePenaltyAmount(cd)
    // Should be roughly double the 3-month penalty
    expect(result).toBeGreaterThan(240)
    expect(result).toBeLessThan(260)
  })

  it('returns 0 for 0 penalty months', () => {
    const cd = makeCD({ earlyWithdrawalPenaltyMonths: 0 })
    expect(calculatePenaltyAmount(cd)).toBe(0)
  })
})

describe('calculateBreakEvenDate', () => {
  it('returns a date after the as-of date', () => {
    const cd = makeCD()
    const breakEven = calculateBreakEvenDate(cd, '2026-06-01')
    expect(new Date(breakEven).getTime()).toBeGreaterThan(
      new Date('2026-06-01').getTime()
    )
  })

  it('returns maturity date if APY is 0', () => {
    const cd = makeCD({ apy: 0 })
    expect(calculateBreakEvenDate(cd, '2026-06-01')).toBe('2027-01-15')
  })
})

describe('analyzeCDBreak', () => {
  it('recommends hold when CD is near maturity', () => {
    const cd = makeCD()
    const result = analyzeCDBreak(cd, '2026-12-20')
    expect(result.recommendation).toBe('hold')
    expect(result.rationale).toContain('matures within 1 month')
  })

  it('recommends hold when remaining months <= penalty months', () => {
    const cd = makeCD({ earlyWithdrawalPenaltyMonths: 6 })
    const result = analyzeCDBreak(cd, '2026-09-01')
    expect(result.recommendation).toBe('hold')
  })

  it('recommends break when penalty is small relative to remaining term', () => {
    const cd = makeCD({
      termMonths: 60,
      maturityDate: '2031-01-15',
      earlyWithdrawalPenaltyMonths: 3,
    })
    const result = analyzeCDBreak(cd, '2026-07-15')
    expect(result.recommendation).toBe('break')
    expect(result.netProceeds).toBeGreaterThan(cd.principal)
  })

  it('recommends hold when penalty exceeds accrued interest (early break)', () => {
    const cd = makeCD({ earlyWithdrawalPenaltyMonths: 6 })
    const result = analyzeCDBreak(cd, '2026-02-15')
    expect(result.recommendation).toBe('hold')
    expect(result.rationale).toContain('exceeds accrued interest')
  })

  it('returns correct cdId', () => {
    const cd = makeCD({ id: 'my-cd-42' })
    const result = analyzeCDBreak(cd, '2026-06-01')
    expect(result.cdId).toBe('my-cd-42')
  })
})

describe('analyzeAllCDs', () => {
  it('returns analysis for each CD', () => {
    const cds = [makeCD({ id: 'a' }), makeCD({ id: 'b' })]
    const results = analyzeAllCDs(cds, '2026-06-01')
    expect(results).toHaveLength(2)
    expect(results[0].cdId).toBe('a')
    expect(results[1].cdId).toBe('b')
  })

  it('returns empty array for no CDs', () => {
    expect(analyzeAllCDs([], '2026-06-01')).toEqual([])
  })
})
