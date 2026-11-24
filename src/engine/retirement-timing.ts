// When can I retire, and which levers bring it forward (REQ-MCP-66, 67).
// Deterministic: every figure comes from projectRetirement on one seed, at
// the long-run means and at the 10-year forecast means. A retirement age
// counts when both success rates reach the owner's goals.
import { VERDICT_THRESHOLDS } from './plan-verdict'
import { projectRetirement } from './retirement-projection'
import type { Portfolio, UserProfile } from './types'

export const TIMING_DEFAULTS = {
  latestAge: 70,
  partTimeMonthly: 2_000,
  partTimeYears: 5,
  extraSavings: 10_000,
  downsizeShare: 0.5,
  sellingCostRate: 0.06,
} as const

export interface TimingGoals {
  readonly successRate: number
  readonly forecastSuccessRate: number
  readonly latestAge: number
}

export function goalsOf(profile: UserProfile): TimingGoals {
  return {
    successRate:
      profile.goals?.successRate ?? VERDICT_THRESHOLDS.go.successRate,
    forecastSuccessRate:
      profile.goals?.forecastSuccessRate ??
      VERDICT_THRESHOLDS.go.forecastSuccessRate,
    latestAge: profile.goals?.latestAge ?? TIMING_DEFAULTS.latestAge,
  }
}

export interface AgeResult {
  readonly age: number
  readonly successRate: number
  readonly forecastSuccessRate: number
  readonly meetsGoal: boolean
}

interface RunOptions {
  readonly seed?: number
  readonly paths?: number
}

/**
 * The profile retiring at `age`: the retirement age moves, and so do the
 * separation age, the deferred-compensation payout start and the first
 * retirement spending phase when they were tied to the old retirement age.
 */
export function retireAt(profile: UserProfile, age: number): UserProfile {
  const old = profile.targetRetirementAge
  const tied = (value: number | undefined) =>
    value === undefined || value === old
  return {
    ...profile,
    targetRetirementAge: age,
    ...(tied(profile.separationAge) ? { separationAge: age } : {}),
    ...(profile.nqdcPayout !== undefined && profile.nqdcPayout.startAge === old
      ? { nqdcPayout: { ...profile.nqdcPayout, startAge: age } }
      : {}),
    ...(profile.spendingPhases === undefined
      ? {}
      : {
          spendingPhases: profile.spendingPhases.map(phase =>
            phase.startAge === old ? { ...phase, startAge: age } : phase
          ),
        }),
    // Income that starts at retirement (part-time work) moves with it.
    ...(profile.otherIncomeStartAge === old
      ? {
          otherIncomeStartAge: age,
          ...(profile.otherIncomeEndAge === undefined
            ? {}
            : { otherIncomeEndAge: profile.otherIncomeEndAge + (age - old) }),
        }
      : {}),
    ...(profile.homeSale !== undefined && profile.homeSale.age === old
      ? { homeSale: { ...profile.homeSale, age } }
      : {}),
  }
}

function forecastOf(profile: UserProfile): UserProfile {
  return {
    ...profile,
    marketAssumptions: { ...profile.marketAssumptions, preset: 'forecast' },
  }
}

export function testAge(
  portfolio: Portfolio,
  profile: UserProfile,
  age: number,
  goals: TimingGoals,
  run: RunOptions
): AgeResult {
  const at = retireAt(profile, age)
  const successRate = projectRetirement(portfolio, at, run).monteCarlo
    .successRate
  const forecastSuccessRate = projectRetirement(portfolio, forecastOf(at), run)
    .monteCarlo.successRate
  return {
    age,
    successRate,
    forecastSuccessRate,
    meetsGoal:
      successRate >= goals.successRate - 1e-9 &&
      forecastSuccessRate >= goals.forecastSuccessRate - 1e-9,
  }
}

export interface EarliestRetirement {
  readonly targetAge: number
  readonly goals: TimingGoals
  /** The earliest age from next year to latestAge that meets both goals, or null. */
  readonly earliestAge: number | null
  /** earliestAge minus the target age (negative: earlier than planned). */
  readonly yearsFromTarget: number | null
  readonly ages: readonly AgeResult[]
  readonly headline: string
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`

/** Every age from next year to latestAge, and the earliest that meets the goals. */
export function earliestRetirement(
  portfolio: Portfolio,
  profile: UserProfile,
  options: RunOptions = {}
): EarliestRetirement {
  const goals = goalsOf(profile)
  const first = Math.floor(profile.currentAge) + 1
  const last = Math.max(first, Math.floor(goals.latestAge))
  const ages: AgeResult[] = []
  for (let age = first; age <= last; age++)
    ages.push(testAge(portfolio, profile, age, goals, options))
  const earliest = ages.find(a => a.meetsGoal)?.age ?? null
  const target = profile.targetRetirementAge
  const goalText = `${pct(goals.successRate)} at long-run returns and ${pct(goals.forecastSuccessRate)} at forecast returns`
  return {
    targetAge: target,
    goals,
    earliestAge: earliest,
    yearsFromTarget: earliest === null ? null : earliest - target,
    ages,
    headline:
      earliest === null
        ? `No retirement age up to ${last} reaches ${goalText}: the plan needs a lever`
        : earliest <= target
          ? `You can retire at ${earliest}, ${target - earliest === 0 ? 'your target age' : `${target - earliest} years before your target of ${target}`}: it reaches ${goalText}`
          : `The earliest age that reaches ${goalText} is ${earliest}, ${earliest - target} years after your target of ${target}`,
  }
}

/**
 * The earliest age in [low, high] that meets the goals, by bisection. The
 * search assumes a later retirement never lowers the chance of success (more
 * saving years, fewer spending years). Fixed-age events (a lump sum, the
 * premium credit) can break that slightly, so earliest_retirement scans every
 * age and is the reference; rank_levers uses this search to stay fast.
 */
export function earliestBySearch(
  portfolio: Portfolio,
  profile: UserProfile,
  goals: TimingGoals,
  run: RunOptions,
  low: number,
  high: number
): AgeResult | null {
  let lo = low
  let hi = high
  let found: AgeResult | null = null
  const top = testAge(portfolio, profile, hi, goals, run)
  if (!top.meetsGoal) return null
  found = top
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const result = testAge(portfolio, profile, mid, goals, run)
    if (result.meetsGoal) {
      found = result
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  return found?.age === lo ? found : testAge(portfolio, profile, lo, goals, run)
}

export type LeverGroup =
  | 'spending'
  | 'savings'
  | 'income'
  | 'housing'
  | 'custom'

export interface Lever {
  readonly id: string
  readonly name: string
  readonly group: LeverGroup
  /** The profile with the lever pulled. */
  readonly apply: (profile: UserProfile) => UserProfile
}

export interface CustomLever {
  readonly name: string
  readonly changes: Partial<UserProfile>
}

function scaleSpending(profile: UserProfile, factor: number): UserProfile {
  return {
    ...profile,
    annualExpenses: profile.annualExpenses * factor,
    ...(profile.spendingPhases === undefined
      ? {}
      : {
          spendingPhases: profile.spendingPhases.map(phase => ({
            ...phase,
            annualExpenses: phase.annualExpenses * factor,
          })),
        }),
  }
}

const dollars = (value: number) =>
  `$${Math.round(value).toLocaleString('en-US')}`

/** The built-in levers that fit this profile. */
export function standardLevers(profile: UserProfile): Lever[] {
  const levers: Lever[] = []
  const firstPhase = [...(profile.spendingPhases ?? [])]
    .filter(p => p.startAge >= profile.targetRetirementAge)
    .sort((a, b) => a.startAge - b.startAge)[0]
  const yearly = firstPhase?.annualExpenses ?? profile.annualExpenses
  for (const share of [0.05, 0.1]) {
    levers.push({
      id: `spend_${share * 100}pct_less`,
      name: `Spend ${share * 100}% less in retirement (about ${dollars((yearly * share) / 12)}/mo)`,
      group: 'spending',
      apply: p => scaleSpending(p, 1 - share),
    })
  }
  if (profile.currentAge < profile.targetRetirementAge)
    levers.push({
      id: 'save_more',
      name: `Save ${dollars(TIMING_DEFAULTS.extraSavings)} more a year until you retire`,
      group: 'savings',
      apply: p => ({
        ...p,
        annualContributions:
          (p.annualContributions ?? 0) + TIMING_DEFAULTS.extraSavings,
      }),
    })
  if (
    profile.otherIncomeMonthly === undefined ||
    profile.otherIncomeMonthly === 0
  )
    levers.push({
      id: 'part_time',
      name: `Earn ${dollars(TIMING_DEFAULTS.partTimeMonthly)}/mo part-time for ${TIMING_DEFAULTS.partTimeYears} years after you retire`,
      group: 'income',
      apply: p => ({
        ...p,
        otherIncomeMonthly: TIMING_DEFAULTS.partTimeMonthly,
        otherIncomeStartAge: p.targetRetirementAge,
        otherIncomeEndAge:
          p.targetRetirementAge + TIMING_DEFAULTS.partTimeYears - 1,
      }),
    })
  if (profile.home !== undefined && profile.homeSale === undefined) {
    const value = profile.home.estimatedValue
    levers.push({
      id: 'downsize',
      name: `Sell the home when you retire and buy one at half the price (${dollars(value * TIMING_DEFAULTS.downsizeShare)})`,
      group: 'housing',
      apply: p => ({
        ...p,
        homeSale: {
          age: p.targetRetirementAge,
          salePrice: value,
          replacementHomeCost: value * TIMING_DEFAULTS.downsizeShare,
          sellingCostRate: TIMING_DEFAULTS.sellingCostRate,
        },
      }),
    })
  }
  return levers
}

export interface LeverResult {
  readonly id: string
  readonly name: string
  readonly group: LeverGroup
  readonly earliestAge: number | null
  /** Years earlier than the plan as it is (positive: earlier). */
  readonly yearsEarlier: number | null
  readonly successAtTarget: number
  readonly forecastSuccessAtTarget: number
  readonly successChange: number
  readonly forecastSuccessChange: number
}

export interface LeverRanking {
  readonly targetAge: number
  readonly goals: TimingGoals
  readonly baseline: {
    readonly earliestAge: number | null
    readonly successAtTarget: number
    readonly forecastSuccessAtTarget: number
  }
  /** Best first: most years earlier, then the largest rise in the worse rate. */
  readonly levers: readonly LeverResult[]
  /** The best lever of each group that helps, pulled together. */
  readonly combined: {
    readonly ids: readonly string[]
    readonly earliestAge: number | null
    readonly yearsEarlier: number | null
    readonly successAtTarget: number
    readonly forecastSuccessAtTarget: number
  } | null
  readonly headline: string
}

function worse(result: {
  successAtTarget: number
  forecastSuccessAtTarget: number
}) {
  return Math.min(result.successAtTarget, result.forecastSuccessAtTarget)
}

/** Each lever's effect on the earliest age and on the target age's success. */
export function rankLevers(
  portfolio: Portfolio,
  profile: UserProfile,
  options: RunOptions & { readonly custom?: readonly CustomLever[] } = {}
): LeverRanking {
  const run: RunOptions = {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.paths === undefined ? {} : { paths: options.paths }),
  }
  const goals = goalsOf(profile)
  const target = profile.targetRetirementAge
  const low = Math.floor(profile.currentAge) + 1
  const high = Math.max(low, Math.floor(goals.latestAge))
  const evaluate = (p: UserProfile) => {
    const atTarget = testAge(portfolio, p, Math.max(low, target), goals, run)
    const earliest = earliestBySearch(portfolio, p, goals, run, low, high)
    return {
      earliestAge: earliest?.age ?? null,
      successAtTarget: atTarget.successRate,
      forecastSuccessAtTarget: atTarget.forecastSuccessRate,
    }
  }
  const base = evaluate(profile)
  // An age past latestAge stands in for "not by latestAge" when comparing.
  const ageKey = (age: number | null) => age ?? high + 1
  const levers: Lever[] = [
    ...standardLevers(profile),
    ...(options.custom ?? []).map((custom, i) => ({
      id: `custom_${i + 1}`,
      name: custom.name,
      group: 'custom' as const,
      apply: (p: UserProfile) => ({ ...p, ...custom.changes }),
    })),
  ]
  const results: LeverResult[] = levers.map(lever => {
    const r = evaluate(lever.apply(profile))
    return {
      id: lever.id,
      name: lever.name,
      group: lever.group,
      earliestAge: r.earliestAge,
      yearsEarlier:
        r.earliestAge === null && base.earliestAge === null
          ? null
          : ageKey(base.earliestAge) - ageKey(r.earliestAge),
      successAtTarget: r.successAtTarget,
      forecastSuccessAtTarget: r.forecastSuccessAtTarget,
      successChange: r.successAtTarget - base.successAtTarget,
      forecastSuccessChange:
        r.forecastSuccessAtTarget - base.forecastSuccessAtTarget,
    }
  })
  results.sort(
    (a, b) =>
      (b.yearsEarlier ?? 0) - (a.yearsEarlier ?? 0) ||
      worse(b) - worse(a) ||
      a.id.localeCompare(b.id)
  )
  // Combine the best helping lever of each built-in group (custom levers stay apart).
  const chosen: Lever[] = []
  for (const group of ['spending', 'savings', 'income', 'housing'] as const) {
    const best = results.find(
      r => r.group === group && worse(r) > worse(base) + 1e-9
    )
    const lever = levers.find(l => l.id === best?.id)
    if (lever !== undefined) chosen.push(lever)
  }
  let combined: LeverRanking['combined'] = null
  if (chosen.length > 1) {
    const all = chosen.reduce((p, lever) => lever.apply(p), profile)
    const r = evaluate(all)
    combined = {
      ids: chosen.map(l => l.id),
      earliestAge: r.earliestAge,
      yearsEarlier:
        r.earliestAge === null && base.earliestAge === null
          ? null
          : ageKey(base.earliestAge) - ageKey(r.earliestAge),
      successAtTarget: r.successAtTarget,
      forecastSuccessAtTarget: r.forecastSuccessAtTarget,
    }
  }
  const top = results[0]
  const baseText =
    base.earliestAge === null
      ? `no age up to ${high} reaches your goals yet`
      : `the earliest age that reaches your goals is ${base.earliestAge}`
  return {
    targetAge: target,
    goals,
    baseline: base,
    levers: results,
    combined,
    headline:
      top === undefined
        ? `Today ${baseText}; no levers fit this profile`
        : `Today ${baseText}. Biggest single lever: ${top.name}${top.earliestAge === null ? '' : ` (earliest ${top.earliestAge})`}${combined?.earliestAge == null ? '' : `; together the best levers make it ${combined.earliestAge}`}`,
  }
}
