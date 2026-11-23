// Social Security claiming sweep (REQ-MCP-49): each pair of claiming ages
// for the owner and spouse through the v2 projection on one seed, with the
// benefits moved by the SSA early-reduction and delayed-credit rules, and
// optionally the same pairs under a survivor scenario (REQ-MCP-48), since a
// later claim by the higher earner raises the survivor benefit for life.
// Deterministic: same inputs and seed give the same output. No AI.
import {
  projectRetirement,
  type ProjectionOptions,
} from './retirement-projection'
import {
  EARLIEST_CLAIM_AGE,
  LATEST_CLAIM_AGE,
  benefitAtClaimAge,
} from './social-security'
import type { Portfolio, SurvivorScenario, UserProfile } from './types'

export const DEFAULT_CLAIM_AGES: readonly number[] = [62, 65, 67, 68, 70]
/** Most claiming-age pairs in one sweep (each pair is a full projection). */
export const MAX_CLAIM_PAIRS = 45

export class ClaimingError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
  }
}

export interface ClaimingRow {
  readonly selfAge: number
  readonly spouseAge: number | null
  /** Monthly benefits at those ages, today's dollars. */
  readonly selfMonthly: number
  readonly spouseMonthly: number | null
  readonly successRate: number
  readonly medianBalanceAtPlanningAge: number
  readonly depletionAgeOnFailingPaths: {
    readonly p10: number
    readonly p50: number
  } | null
  /** Expected-path Social Security to the planning age, today's dollars. */
  readonly lifetimeSocialSecurity: number
  /** The same pair under the survivor scenario, when one was given. */
  readonly survivorSuccessRate: number | null
  readonly current: boolean
}

export interface ClaimingExploration {
  readonly planningAge: number
  readonly survivor: SurvivorScenario | null
  readonly rows: readonly ClaimingRow[]
  readonly current: ClaimingRow | null
  readonly best: ClaimingRow
  /** Best minus current, in success-rate points and median dollars at the planning age. */
  readonly bestVsCurrent: {
    readonly successRate: number
    readonly survivorSuccessRate: number | null
    readonly medianBalanceAtPlanningAge: number
  } | null
  readonly charts: {
    readonly successBySelfAge: {
      readonly x: readonly number[]
      readonly series: readonly {
        readonly name: string
        readonly values: readonly number[]
      }[]
    }
  }
}

function checkAges(ages: readonly number[], field: string): number[] {
  const unique = [...new Set(ages)].sort((a, b) => a - b)
  for (const age of unique) {
    if (
      !Number.isInteger(age) ||
      age < EARLIEST_CLAIM_AGE ||
      age > LATEST_CLAIM_AGE
    ) {
      throw new ClaimingError(
        field,
        `ages must be whole years from ${EARLIEST_CLAIM_AGE} to ${LATEST_CLAIM_AGE}`
      )
    }
  }
  if (unique.length === 0)
    throw new ClaimingError(field, 'needs at least one age')
  return unique
}

const pct4 = (value: number) => Math.round(value * 10_000) / 10_000

/**
 * Sweep claiming ages. The saved benefits are quoted at the saved claiming
 * ages; each candidate age moves them by the SSA factors. Rows are ordered by
 * the owner's age, then the spouse's; best is the highest success rate, then
 * the highest survivor success rate, then the highest median balance.
 */
export function exploreClaimingAges(
  portfolio: Portfolio,
  profile: UserProfile,
  options: {
    readonly selfAges?: readonly number[]
    readonly spouseAges?: readonly number[]
    readonly survivor?: SurvivorScenario
    readonly seed?: number
    readonly paths?: number
  } = {}
): ClaimingExploration {
  if (
    profile.socialSecurityMonthly === undefined ||
    profile.socialSecurityAge === undefined
  ) {
    throw new ClaimingError(
      'profile.socialSecurityMonthly',
      'needs your benefit and its claiming age'
    )
  }
  const spouse = profile.spouse
  const hasSpouseBenefit =
    spouse?.socialSecurityMonthly !== undefined &&
    spouse.socialSecurityAge !== undefined
  if (options.survivor !== undefined && spouse === undefined) {
    throw new ClaimingError('survivor', 'needs a spouse in the profile')
  }
  const selfAges = checkAges(options.selfAges ?? DEFAULT_CLAIM_AGES, 'selfAges')
  const spouseAges = hasSpouseBenefit
    ? checkAges(options.spouseAges ?? DEFAULT_CLAIM_AGES, 'spouseAges')
    : []
  const pairs = selfAges.length * Math.max(1, spouseAges.length)
  if (pairs > MAX_CLAIM_PAIRS) {
    throw new ClaimingError(
      'selfAges',
      `${pairs} age pairs; at most ${MAX_CLAIM_PAIRS}`
    )
  }
  const projection: ProjectionOptions = {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  }
  // The pair the saved profile claims at, if it is in the grid.
  const baseProfile: UserProfile = { ...profile }
  delete baseProfile.survivor

  const rows: ClaimingRow[] = []
  for (const selfAge of selfAges) {
    for (const spouseAge of hasSpouseBenefit ? spouseAges : [null]) {
      const selfMonthly = benefitAtClaimAge(
        profile.socialSecurityMonthly,
        profile.socialSecurityAge,
        selfAge
      )
      const spouseMonthly =
        spouseAge === null || !hasSpouseBenefit
          ? null
          : benefitAtClaimAge(
              spouse.socialSecurityMonthly as number,
              spouse.socialSecurityAge as number,
              spouseAge
            )
      const candidate: UserProfile = {
        ...baseProfile,
        socialSecurityAge: selfAge,
        socialSecurityMonthly: selfMonthly,
        ...(spouse === undefined
          ? {}
          : {
              spouse: {
                ...spouse,
                ...(spouseAge === null || spouseMonthly === null
                  ? {}
                  : {
                      socialSecurityAge: spouseAge,
                      socialSecurityMonthly: spouseMonthly,
                    }),
              },
            }),
      }
      const result = projectRetirement(portfolio, candidate, projection)
      const last =
        result.monteCarlo.percentiles[result.monteCarlo.percentiles.length - 1]
      const survivorRate =
        options.survivor === undefined
          ? null
          : projectRetirement(
              portfolio,
              { ...candidate, survivor: options.survivor },
              projection
            ).monteCarlo.successRate
      rows.push({
        selfAge,
        spouseAge,
        selfMonthly: Math.round(selfMonthly),
        spouseMonthly:
          spouseMonthly === null ? null : Math.round(spouseMonthly),
        successRate: result.monteCarlo.successRate,
        medianBalanceAtPlanningAge: last?.p50 ?? 0,
        depletionAgeOnFailingPaths: result.monteCarlo.depletionAge,
        lifetimeSocialSecurity: result.expectedPath.years.reduce(
          (sum, y) => sum + y.socialSecurity,
          0
        ),
        survivorSuccessRate: survivorRate,
        current:
          selfAge === profile.socialSecurityAge &&
          (spouseAge === null || spouseAge === spouse?.socialSecurityAge),
      })
    }
  }

  const ranked = [...rows].sort(
    (a, b) =>
      b.successRate - a.successRate ||
      (b.survivorSuccessRate ?? 0) - (a.survivorSuccessRate ?? 0) ||
      b.medianBalanceAtPlanningAge - a.medianBalanceAtPlanningAge ||
      a.selfAge - b.selfAge ||
      (a.spouseAge ?? 0) - (b.spouseAge ?? 0)
  )
  const best = ranked[0]
  const current = rows.find(row => row.current) ?? null
  const planningAge = profile.planningAge ?? 95

  const spouseSeries = hasSpouseBenefit ? spouseAges : [null]
  return {
    planningAge,
    survivor: options.survivor ?? null,
    rows,
    current,
    best,
    bestVsCurrent:
      current === null
        ? null
        : {
            successRate: pct4(best.successRate - current.successRate),
            survivorSuccessRate:
              best.survivorSuccessRate === null ||
              current.survivorSuccessRate === null
                ? null
                : pct4(best.survivorSuccessRate - current.survivorSuccessRate),
            medianBalanceAtPlanningAge:
              best.medianBalanceAtPlanningAge -
              current.medianBalanceAtPlanningAge,
          },
    charts: {
      successBySelfAge: {
        x: selfAges,
        series: spouseSeries.map(spouseAge => ({
          name:
            spouseAge === null
              ? 'Success rate'
              : `Spouse claims at ${spouseAge}`,
          values: selfAges.map(
            selfAge =>
              rows.find(
                row => row.selfAge === selfAge && row.spouseAge === spouseAge
              )?.successRate ?? 0
          ),
        })),
      },
    },
  }
}
