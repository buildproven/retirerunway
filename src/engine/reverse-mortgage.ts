/**
 * REQ-MCP-86: an FHA reverse mortgage (HECM) line of credit, opened as a
 * standby and drawn only when the accounts run short. Pure and
 * deterministic: everything here follows from the profile and the date.
 *
 * Principal limit = principal limit factor (by the youngest borrower's age,
 * HUD table at a 6% expected rate) x the maximum claim amount (the home's
 * value, capped at the FHA limit). The line first pays off any mortgage and
 * the upfront costs; the rest is the line, which grows each year at the loan
 * rate plus annual mortgage insurance, as the loan balance does. Draws are
 * loan proceeds: not taxed and not income. The loan is repaid from the home
 * when it is sold, never more than the home is worth (non-recourse).
 */
import { mortgageBalanceAtYearStart } from './portfolio-math'
import type { UserProfile } from './types'

/** FHA HECM maximum claim amount for 2026 (HUD Mortgagee Letter 2025-23). */
export const HECM_LIMIT = { year: 2026, amount: 1_249_125 } as const

/**
 * HUD principal limit factors at a 6.0% expected rate (table for case
 * numbers from Oct 2, 2017): age 62 35.7%, 72 41.6%, 90 61.8%. Between the
 * points the factor is interpolated in a straight line; below 62 none.
 */
export const PLF_AT_SIX_PERCENT: readonly (readonly [number, number])[] = [
  [62, 0.357],
  [72, 0.416],
  [90, 0.618],
]

export const REVERSE_MORTGAGE_DEFAULTS = {
  /** 2% upfront mortgage insurance plus about 1% closing costs, of the claim amount. */
  upfrontCostRate: 0.03,
  /** Margin over the 10-year Treasury yield, plus 0.5% annual insurance. */
  growthOverTreasury: 0.02,
  /** Growth when no Treasury yield is saved. */
  fallbackGrowth: 0.065,
  minimumAge: 62,
} as const

export function principalLimitFactor(youngestAge: number): number {
  const points = PLF_AT_SIX_PERCENT
  if (youngestAge < points[0][0]) return 0
  for (let i = 1; i < points.length; i++) {
    const [a, fa] = points[i - 1]
    const [b, fb] = points[i]
    if (youngestAge <= b) return fa + ((fb - fa) * (youngestAge - a)) / (b - a)
  }
  return points[points.length - 1][1]
}

export interface ReverseMortgagePlan {
  /** The owner's age when the line is opened. */
  readonly openAge: number
  readonly youngestAge: number
  readonly maxClaim: number
  readonly principalLimitFactor: number
  readonly principalLimit: number
  readonly upfrontCosts: number
  /** The mortgage balance paid off at opening (today's dollars). */
  readonly mortgagePayoff: number
  /** The line left to draw on at opening (today's dollars). */
  readonly line: number
  /** Nominal yearly growth of the line and the loan balance. */
  readonly growthRate: number
  /** False when the principal limit does not cover the payoff and costs. */
  readonly opens: boolean
}

/** The youngest borrower's age in the year the owner is `age`. */
function youngestAt(profile: UserProfile, age: number): number {
  const spouse = profile.spouse
  return spouse === undefined
    ? age
    : Math.min(age, spouse.currentAge + (age - profile.currentAge))
}

/** REQ-MCP-86: the earliest owner age at which both borrowers are 62. */
export function earliestReverseMortgageAge(profile: UserProfile): number {
  const youngestNow = youngestAt(profile, profile.currentAge)
  return (
    profile.currentAge +
    Math.max(0, REVERSE_MORTGAGE_DEFAULTS.minimumAge - youngestNow)
  )
}

export function reverseMortgagePlan(
  profile: UserProfile,
  asOfDate: string
): ReverseMortgagePlan | undefined {
  const rm = profile.reverseMortgage
  const home = profile.home?.estimatedValue
  if (rm === undefined || home === undefined) return undefined
  // The projection's first year is currentAge + 1, so a line set to open
  // now (or earlier) opens in that first year; otherwise it would never open
  // while the mortgage payment still stopped.
  const openAge = Math.max(
    rm.openAge,
    earliestReverseMortgageAge(profile),
    profile.currentAge + 1
  )
  const youngestAge = youngestAt(profile, openAge)
  // Today's dollars: the home and the FHA limit are both assumed to keep
  // pace with prices.
  const maxClaim = Math.min(Math.max(0, home), HECM_LIMIT.amount)
  const factor = rm.principalLimitFactor ?? principalLimitFactor(youngestAge)
  const principalLimit = factor * maxClaim
  const upfrontCosts =
    (rm.upfrontCostRate ?? REVERSE_MORTGAGE_DEFAULTS.upfrontCostRate) * maxClaim
  const year = Number(asOfDate.slice(0, 4)) + (openAge - profile.currentAge)
  // The balance is in dollars of that year; bring it back to today's at 3%.
  const years = Math.max(0, openAge - profile.currentAge)
  const mortgagePayoff =
    mortgageBalanceAtYearStart(profile, year) / Math.pow(1.03, years)
  const line = principalLimit - upfrontCosts - mortgagePayoff
  const growthRate =
    rm.growthRate ??
    (profile.marketData?.treasury10y !== undefined
      ? profile.marketData.treasury10y +
        REVERSE_MORTGAGE_DEFAULTS.growthOverTreasury
      : REVERSE_MORTGAGE_DEFAULTS.fallbackGrowth)
  const sold = profile.homeSale !== undefined && profile.homeSale.age <= openAge
  return {
    openAge,
    youngestAge,
    maxClaim,
    principalLimitFactor: factor,
    principalLimit,
    upfrontCosts,
    mortgagePayoff,
    line: Math.max(0, line),
    growthRate,
    opens: line > 0 && !sold,
  }
}
