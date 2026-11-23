// Social Security claiming-age arithmetic (REQ-MCP-49) and survivor
// benefits (REQ-MCP-48), from the SSA rules for anyone born 1960 or later:
// full retirement age 67; claiming early cuts the benefit 5/9 of 1% a month
// for the first 36 months and 5/12 of 1% a month beyond (30% at 62);
// delaying adds 8% a year up to 70. A survivor benefit is the deceased's
// benefit, reduced from 100% at the survivor's full retirement age to 71.5%
// at 60, and none before 60. Whole years of age only.

/** Full retirement age for anyone born 1960 or later. */
export const FULL_RETIREMENT_AGE = 67
export const EARLIEST_CLAIM_AGE = 62
export const LATEST_CLAIM_AGE = 70
export const EARLIEST_SURVIVOR_AGE = 60
/** Survivor benefit at 60 as a share of the deceased's benefit. */
export const SURVIVOR_SHARE_AT_60 = 0.715

/** The benefit at `claimAge` as a share of the full-retirement-age benefit. */
export function claimFactor(claimAge: number): number {
  const age = Math.min(Math.max(claimAge, EARLIEST_CLAIM_AGE), LATEST_CLAIM_AGE)
  if (age >= FULL_RETIREMENT_AGE) {
    return 1 + 0.08 * (age - FULL_RETIREMENT_AGE)
  }
  const monthsEarly = Math.round((FULL_RETIREMENT_AGE - age) * 12)
  const first = Math.min(monthsEarly, 36)
  const beyond = Math.max(0, monthsEarly - 36)
  return 1 - first * (5 / 900) - beyond * (5 / 1200)
}

/** The full-retirement-age benefit implied by a benefit claimed at `claimAge`. */
export function fullRetirementBenefit(
  monthly: number,
  claimAge: number
): number {
  return monthly / claimFactor(claimAge)
}

/** The monthly benefit when claiming at `newClaimAge`, from one quoted at `claimAge`. */
export function benefitAtClaimAge(
  monthly: number,
  claimAge: number,
  newClaimAge: number
): number {
  return fullRetirementBenefit(monthly, claimAge) * claimFactor(newClaimAge)
}

/** The survivor benefit as a share of the deceased's benefit, at the survivor's age. */
export function survivorFactor(survivorAge: number): number {
  if (survivorAge < EARLIEST_SURVIVOR_AGE) return 0
  if (survivorAge >= FULL_RETIREMENT_AGE) return 1
  const span = FULL_RETIREMENT_AGE - EARLIEST_SURVIVOR_AGE
  return (
    SURVIVOR_SHARE_AT_60 +
    ((1 - SURVIVOR_SHARE_AT_60) * (survivorAge - EARLIEST_SURVIVOR_AGE)) / span
  )
}

/**
 * The spousal benefit at `claimAge` as a share of its full-retirement-age
 * amount: 25/36 of 1% a month for the first 36 months early, 5/12 of 1%
 * beyond (65% at 62); no delayed credits after 67 (REQ-MCP-54).
 */
export function spousalFactor(claimAge: number): number {
  const age = Math.min(
    Math.max(claimAge, EARLIEST_CLAIM_AGE),
    FULL_RETIREMENT_AGE
  )
  const monthsEarly = Math.round((FULL_RETIREMENT_AGE - age) * 12)
  const first = Math.min(monthsEarly, 36)
  const beyond = Math.max(0, monthsEarly - 36)
  return 1 - first * (25 / 3600) - beyond * (5 / 1200)
}

/**
 * The spousal top-up a month on top of a spouse's own benefit: half the
 * other spouse's full-retirement-age benefit less the spouse's own
 * full-retirement-age benefit, if positive, reduced for a start before 67.
 * Paid only once both have claimed (REQ-MCP-54), so the reduction follows
 * `startAge`, the spouse's own age when the top-up starts (SSA): the later
 * of their own claim and the other spouse's claim. It defaults to the
 * spouse's own claim age.
 */
export function spousalExcess(
  own: { monthly: number; claimAge: number },
  other: { monthly: number; claimAge: number },
  startAge: number = own.claimAge
): number {
  const ownFull = fullRetirementBenefit(own.monthly, own.claimAge)
  const otherFull = fullRetirementBenefit(other.monthly, other.claimAge)
  const excess = Math.max(0, otherFull / 2 - ownFull)
  return excess * spousalFactor(Math.max(own.claimAge, startAge))
}

/**
 * The 2026 Social Security Trustees Report (June 9, 2026): the OASI trust
 * fund, which pays retirement and survivor benefits, is depleted in the
 * fourth quarter of 2032, after which 78% of scheduled benefits are payable
 * unless Congress acts (REQ-MCP-59).
 */
export const SOCIAL_SECURITY_CUT_2026 = {
  share: 0.22,
  startYear: 2033,
  source:
    '2026 Trustees Report: OASI reserves depleted Q4 2032, 78% of scheduled benefits payable',
} as const

/** Share of scheduled benefits paid in calendarYear under the cut (1 when none). */
export function socialSecurityPaidShare(
  cut: { share?: number; startYear?: number } | undefined,
  calendarYear: number
): number {
  if (cut === undefined) return 1
  const share = Math.min(
    0.5,
    Math.max(0, cut.share ?? SOCIAL_SECURITY_CUT_2026.share)
  )
  const startYear = cut.startYear ?? SOCIAL_SECURITY_CUT_2026.startYear
  return calendarYear >= startYear ? 1 - share : 1
}
