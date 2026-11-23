// Social Security cut from a calendar year (REQ-MCP-59).
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { projectRetirement, projectionWarnings } from '../retirement-projection'
import {
  SOCIAL_SECURITY_CUT_2026,
  socialSecurityPaidShare,
} from '../social-security'
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
          costBasis: 1_500_000,
          currentPrice: 1_500_000,
          currentValue: 1_500_000,
        },
      ],
    },
  ],
}

// Owner 60 in 2026 (67 in 2033); spouse 59. $50K and $25K a year at 67.
const couple: UserProfile = {
  currentAge: 60,
  targetRetirementAge: 60,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 50_000 / 12,
  spouse: {
    currentAge: 59,
    socialSecurityAge: 67,
    socialSecurityMonthly: 25_000 / 12,
  },
  preMedicareHealthcare: 20_000,
  planningAge: 90,
}

const yearAt = (profile: UserProfile, age: number) => {
  const year = projectRetirement(portfolio, profile, {
    paths: 10,
  }).expectedPath.years.find(y => y.age === age)
  if (year === undefined) throw new Error(`no year ${age}`)
  return year
}

describe('REQ-MCP-59 Social Security cut', () => {
  it('follows the 2026 Trustees Report by default: 78% payable from 2033', () => {
    expect(SOCIAL_SECURITY_CUT_2026.share).toBe(0.22)
    expect(SOCIAL_SECURITY_CUT_2026.startYear).toBe(2033)
    expect(socialSecurityPaidShare(undefined, 2040)).toBe(1)
    expect(socialSecurityPaidShare({}, 2032)).toBe(1)
    expect(socialSecurityPaidShare({}, 2033)).toBeCloseTo(0.78, 10)
    expect(socialSecurityPaidShare({ share: 0.9 }, 2040)).toBe(0.5)
  })

  it('cuts every benefit from the start year, including the spouse', () => {
    const cut: UserProfile = { ...couple, socialSecurityCut: {} }
    // Owner 67 in 2033: own benefit at 78%.
    expect(yearAt(couple, 67).socialSecurity).toBe(50_000)
    expect(yearAt(cut, 67).socialSecurity).toBeCloseTo(39_000, 6)
    // Both claimed by 68: $75K scheduled, $58,500 paid.
    expect(yearAt(cut, 70).socialSecurity).toBeCloseTo(58_500, 6)
  })

  it('starts a custom cut in its own year and lowers the success rate', () => {
    const later: UserProfile = {
      ...couple,
      socialSecurityCut: { share: 0.2, startYear: 2040 },
    }
    expect(yearAt(later, 73).socialSecurity).toBe(75_000) // 2039
    expect(yearAt(later, 74).socialSecurity).toBeCloseTo(60_000, 6) // 2040
    const lean: UserProfile = { ...couple, annualExpenses: 110_000 }
    const base = projectRetirement(portfolio, lean, { paths: 200 })
    const cut = projectRetirement(
      portfolio,
      { ...lean, socialSecurityCut: {} },
      { paths: 200 }
    )
    expect(cut.monteCarlo.successRate).toBeLessThan(base.monteCarlo.successRate)
  })

  it('names the cut in the warnings and validates the profile field', () => {
    expect(
      projectionWarnings(portfolio, { ...couple, socialSecurityCut: {} })
    ).toContain(
      'Social Security cut: every benefit is 78% of scheduled from 2033 (2026 Trustees Report: OASI reserves depleted Q4 2032, 78% of scheduled benefits payable)'
    )
    const ok = userProfileSchema.safeParse({
      ...couple,
      socialSecurityCut: { share: 0.17, startYear: 2034 },
    })
    expect(ok.success).toBe(true)
    const tooBig = userProfileSchema.safeParse({
      ...couple,
      socialSecurityCut: { share: 0.6 },
    })
    expect(tooBig.success).toBe(false)
  })
})
