// ---------------------------------------------------------------------------
// RetireRunway – Retirement projection v2 (FR-23, REQ-MCP-39..41)
//
// A seeded Monte Carlo and an expected-return path over five account buckets
// to a planning age (default 95): both spouses' Social Security, pre-Medicare
// healthcare, federal tax from the brackets, state tax, the 10% early
// withdrawal penalty with the Rule of 55, RMDs from 75 and an NQDC payout
// schedule. Every figure is in today's dollars. Deterministic: same inputs
// and seed give the same output (NFR-01). No AI.
// ---------------------------------------------------------------------------

import { MONTE_CARLO_DEFAULTS } from './config'
import {
  annualExpensesAt,
  baseExpensesAt,
  calculateEquityFraction,
  calculatePortfolioValue,
  homeSaleAt,
  mortgagePaymentEndAge,
} from './portfolio-math'
import { IRMAA_LOOKBACK_YEARS, irmaaCeiling, irmaaFor } from './irmaa'
import { meansForYear, resolveMarketAssumptions } from './market-assumptions'
import {
  EARLIEST_SURVIVOR_AGE,
  FULL_RETIREMENT_AGE,
  LATEST_CLAIM_AGE,
  benefitAtClaimAge,
  spousalExcess,
  socialSecurityPaidShare,
  SOCIAL_SECURITY_CUT_2026,
  survivorFactor,
} from './social-security'
import { boxMullerNormal, percentile, seededRandom } from './stats'
import {
  calculateCapitalGainsTax,
  calculateOrdinaryTax,
  getFederalBrackets,
  getStandardDeduction,
} from './tax-brackets'
import type { FilingStatus } from './tax-brackets'
import type { AccountType, Portfolio, UserProfile } from './types'

export const DEFAULT_PLANNING_AGE = 95
/** First whole age past 59½: tax-deferred and Roth money pays out without the penalty. */
export const PENALTY_FREE_AGE = 60
export const RULE_OF_55_AGE = 55
export const MEDICARE_AGE = 65
/** RMDs start at 75 for anyone born in 1960 or later (SECURE 2.0). */
export const RMD_START_AGE = 75
export const EARLY_WITHDRAWAL_PENALTY = 0.1
/**
 * Social Security taxation thresholds on provisional income. Set in law in
 * 1983 and 1993 and never indexed, so they stay fixed in dollars.
 */
export const SOCIAL_SECURITY_THRESHOLDS: Readonly<
  Record<FilingStatus, readonly [number, number]>
> = {
  single: [25_000, 34_000],
  head_of_household: [25_000, 34_000],
  married_filing_jointly: [32_000, 44_000],
}

/**
 * The taxable part of a year's Social Security (IRS Pub. 915): none below
 * the first threshold of provisional income (other income plus half the
 * benefit), up to 50% between the thresholds, up to 85% above. Nominal.
 */
export function taxableSocialSecurity(
  benefit: number,
  otherIncome: number,
  filingStatus: FilingStatus
): number {
  if (benefit <= 0) return 0
  const [base, upper] = SOCIAL_SECURITY_THRESHOLDS[filingStatus]
  const provisional = otherIncome + benefit / 2
  if (provisional <= base) return 0
  if (provisional <= upper) {
    return Math.min(0.5 * (provisional - base), 0.5 * benefit)
  }
  return Math.min(
    0.85 * benefit,
    0.85 * (provisional - upper) + Math.min(0.5 * (upper - base), 0.5 * benefit)
  )
}
export const PROJECTION_PATHS = MONTE_CARLO_DEFAULTS.NUM_PATHS

/**
 * HHS poverty guidelines for 2026, 48 contiguous states and DC: the line
 * used for 2027 Marketplace coverage. Indexed to inflation in projections.
 */
export const POVERTY_LINE_2026 = {
  firstPerson: 15_960,
  eachAdditional: 5_680,
} as const

/**
 * The applicable percentage table for 2027 (Rev. Proc. 2026-26): the share
 * of household income expected toward the benchmark silver premium, by
 * household income as a share of the poverty line. Linear within a band.
 * The enhanced credits expired after 2025, so there is no credit above 400%.
 */
export const ACA_APPLICABLE_PERCENTAGES: readonly {
  readonly from: number
  readonly to: number
  readonly initial: number
  readonly final: number
}[] = [
  { from: 0, to: 1.33, initial: 0.0215, final: 0.0215 },
  { from: 1.33, to: 1.5, initial: 0.0323, final: 0.043 },
  { from: 1.5, to: 2, initial: 0.043, final: 0.0678 },
  { from: 2, to: 2.5, initial: 0.0678, final: 0.0866 },
  { from: 2.5, to: 3, initial: 0.0866, final: 0.1022 },
  { from: 3, to: 4, initial: 0.1022, final: 0.1022 },
]
/** Above this share of the poverty line there is no premium tax credit. */
export const ACA_SUBSIDY_CLIFF = 4

export function povertyLine(householdSize: number): number {
  const size = Math.max(1, Math.round(householdSize))
  return (
    POVERTY_LINE_2026.firstPerson +
    POVERTY_LINE_2026.eachAdditional * (size - 1)
  )
}

/** The applicable percentage at `ratio` (household income / poverty line), or undefined above the cliff. */
export function applicablePercentage(ratio: number): number | undefined {
  if (ratio > ACA_SUBSIDY_CLIFF) return undefined
  for (const band of ACA_APPLICABLE_PERCENTAGES) {
    if (ratio < band.to || band.to === ACA_SUBSIDY_CLIFF) {
      const span = band.to - band.from
      const t =
        span === 0 ? 0 : Math.min(1, Math.max(0, (ratio - band.from) / span))
      return band.initial + (band.final - band.initial) * t
    }
  }
  return undefined
}

/**
 * The premium tax credit, in today's dollars: the benchmark premium less
 * the applicable percentage of MAGI, never below 0 or above the premium.
 */
export function premiumTaxCredit(
  benchmarkPremium: number,
  magi: number,
  householdSize: number
): number {
  if (benchmarkPremium <= 0) return 0
  const percentage = applicablePercentage(
    Math.max(0, magi) / povertyLine(householdSize)
  )
  if (percentage === undefined) return 0
  return Math.min(
    benchmarkPremium,
    Math.max(0, benchmarkPremium - percentage * Math.max(0, magi))
  )
}
export const PROJECTION_MODEL_VERSION = '2.8.0'

/** IRS Uniform Lifetime Table divisors (2022), ages 75–105. */
const RMD_DIVISORS: Readonly<Record<number, number>> = {
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22.0,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16.0,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
  101: 6.0,
  102: 5.6,
  103: 5.2,
  104: 4.9,
  105: 4.6,
}

export function rmdDivisor(age: number): number | undefined {
  if (age < RMD_START_AGE) return undefined
  return RMD_DIVISORS[Math.min(age, 105)]
}

export const BUCKETS = [
  'taxable',
  'employerPlan',
  'ira',
  'roth',
  'nqdc',
] as const
export type Bucket = (typeof BUCKETS)[number]
export type Buckets = Record<Bucket, number>

/** The bucket an account's money is in. HSA counts as tax-free (Roth). */
export function bucketOf(accountType: AccountType): Bucket {
  switch (accountType) {
    case 'brokerage':
      return 'taxable'
    case '401k':
    case '403b':
    case '457b':
      return 'employerPlan'
    case 'traditional_ira':
    case 'rollover_ira':
      return 'ira'
    case 'roth_ira':
    case 'roth_401k':
    case 'hsa':
      return 'roth'
    case 'nqdc':
      return 'nqdc'
  }
}

function emptyBuckets(): Buckets {
  return { taxable: 0, employerPlan: 0, ira: 0, roth: 0, nqdc: 0 }
}

export interface StartingBuckets {
  readonly balances: Buckets
  /** Share of the taxable bucket that is unrealized gain (0–1). */
  readonly taxableGainFraction: number
  /** The 457(b) part of the employer-plan bucket: no 10% penalty after separation. */
  readonly employerPlan457: number
}

/** The portfolio split into buckets, with the same totals as calculatePortfolioValue. */
export function startingBuckets(portfolio: Portfolio): StartingBuckets {
  const balances = emptyBuckets()
  let taxableGain = 0
  let employerPlan457 = 0
  for (const account of portfolio.accounts) {
    const bucket = bucketOf(account.accountType)
    let value = account.cashBalance
    for (const holding of account.holdings) {
      value += holding.currentValue
      if (bucket === 'taxable') {
        taxableGain += Math.max(0, holding.currentValue - holding.costBasis)
      }
    }
    for (const cd of account.cds) value += cd.principal
    balances[bucket] += value
    if (account.accountType === '457b') employerPlan457 += value
  }
  const taxableGainFraction =
    balances.taxable > 0 ? Math.min(1, taxableGain / balances.taxable) : 0
  return { balances, taxableGainFraction, employerPlan457 }
}

export function filingStatusOf(profile: UserProfile): FilingStatus {
  return (
    profile.filingStatus ??
    (profile.spouse === undefined ? 'single' : 'married_filing_jointly')
  )
}

export function planningAgeOf(profile: UserProfile): number {
  return profile.planningAge ?? DEFAULT_PLANNING_AGE
}

/** One projection year, nominal dollars. */
interface YearFlows {
  readonly age: number
  readonly spending: number
  readonly healthcare: number
  readonly acaCredit: number
  readonly magi: number
  readonly irmaa: number
  readonly irmaaTier: number
  readonly rothConversion: number
  readonly socialSecurity: number
  readonly otherIncome: number
  readonly withdrawals: Buckets
  readonly rmd: number
  readonly federalTax: number
  readonly stateTax: number
  readonly penalty: number
  readonly shortfall: number
  readonly balances: Buckets
}

interface Draws {
  readonly withdrawals: Buckets
  readonly penalized: number
  readonly shortfall: number
  /** How much of the employer-plan withdrawal (beyond RMDs) came from its 457(b) part. */
  readonly used457: number
}

interface Context {
  readonly profile: UserProfile
  readonly asOfDate: string
  readonly filingStatus: FilingStatus
  readonly householdSize: number
  readonly nqdcStart: number
  readonly nqdcYears: number
  readonly separationAge: number
  readonly conversion: RothConversionStrategy
  readonly conversionEndAge: number
}

/**
 * How much pre-tax money to convert to Roth each retired year up to
 * conversionEndAge (REQ-MCP-46). Each strategy is a ceiling, in today's
 * dollars, that the year's conversion fills:
 * - fillBracket: taxable ordinary income up to the top of the bracket taxed
 *   at `rate` (0.12, 0.22, 0.24, ...).
 * - irmaaTier: AGI up to the ceiling of IRMAA `tier` (0 = no surcharge).
 * - acaThenIrmaa: while anyone is under 65 with acaPremiumTaxCredit, ACA
 *   MAGI up to 400% of the poverty line; from then, AGI up to IRMAA tier 0.
 */
export type RothConversionStrategy =
  | { readonly kind: 'none' }
  | { readonly kind: 'fillBracket'; readonly rate: number }
  | { readonly kind: 'irmaaTier'; readonly tier: number }
  | { readonly kind: 'acaThenIrmaa' }

function spouseAgeAt(profile: UserProfile, age: number): number | undefined {
  const spouse = profile.spouse
  return spouse === undefined
    ? undefined
    : spouse.currentAge + (age - profile.currentAge)
}

/** REQ-MCP-55: true from the year after the owner's death (with a spouse). */
function ownerDeadAt(profile: UserProfile, age: number): boolean {
  const scenario = profile.survivor
  return (
    scenario !== undefined &&
    scenario.deceased === 'self' &&
    profile.spouse !== undefined &&
    age > scenario.deathAge
  )
}

/** Default survivor spending as a share of the couple's (beyond the mortgage payment). */
export const SURVIVOR_SPENDING_SHARE = 0.75

/**
 * REQ-MCP-48: from the year after the death in profile.survivor, the
 * survivor's age (undefined while both are alive, or with no spouse).
 */
function survivorAgeAt(profile: UserProfile, age: number): number | undefined {
  const scenario = profile.survivor
  if (scenario === undefined || profile.spouse === undefined) return undefined
  if (age <= scenario.deathAge) return undefined
  return scenario.deceased === 'self' ? spouseAgeAt(profile, age) : age
}

/** The Social Security the deceased was getting, or had earned, at death (monthly). */
function deceasedBenefitMonthly(profile: UserProfile): number {
  const scenario = profile.survivor
  if (scenario === undefined) return 0
  const benefit =
    scenario.deceased === 'self'
      ? {
          monthly: profile.socialSecurityMonthly,
          claimAge: profile.socialSecurityAge,
          ageAtDeath: scenario.deathAge,
        }
      : {
          monthly: profile.spouse?.socialSecurityMonthly,
          claimAge: profile.spouse?.socialSecurityAge,
          ageAtDeath: spouseAgeAt(profile, scenario.deathAge),
        }
  if (
    benefit.monthly === undefined ||
    benefit.claimAge === undefined ||
    benefit.ageAtDeath === undefined
  ) {
    return 0
  }
  if (benefit.ageAtDeath >= benefit.claimAge) return benefit.monthly
  // Died before claiming: the full-retirement-age benefit plus any delayed
  // credits earned by the age at death.
  const earnedAge = Math.min(
    Math.max(benefit.ageAtDeath, FULL_RETIREMENT_AGE),
    LATEST_CLAIM_AGE
  )
  return benefitAtClaimAge(benefit.monthly, benefit.claimAge, earnedAge)
}

/** Household Social Security at `age`, nominal. */
function socialSecurityAt(
  profile: UserProfile,
  age: number,
  inflation: number,
  asOfDate: string
): number {
  // REQ-MCP-59: a Trustees-style cut from a calendar year scales every benefit.
  const calendarYear = Number(asOfDate.slice(0, 4)) + (age - profile.currentAge)
  const cola =
    (profile.socialSecurityCola === false ? 1 : inflation) *
    socialSecurityPaidShare(profile.socialSecurityCut, calendarYear)
  const survivorAge = survivorAgeAt(profile, age)
  if (survivorAge !== undefined) {
    // The survivor keeps the larger of their own benefit (once claimed) and
    // the survivor benefit on the deceased's record. Ages are the survivor's.
    const ownBenefit =
      profile.survivor?.deceased === 'self'
        ? {
            monthly: profile.spouse?.socialSecurityMonthly,
            claimAge: profile.spouse?.socialSecurityAge,
          }
        : {
            monthly: profile.socialSecurityMonthly,
            claimAge: profile.socialSecurityAge,
          }
    const own =
      ownBenefit.claimAge !== undefined && survivorAge >= ownBenefit.claimAge
        ? (ownBenefit.monthly ?? 0)
        : 0
    // A survivor benefit started before full retirement age stays reduced
    // for life (SSA), so its factor is set at the age it starts: the first
    // year it is payable (60 or older). A survivor already on their own
    // benefit then waits for the unreduced benefit at full retirement age.
    const firstSurvivorAge = survivorAgeAt(
      profile,
      Math.floor(profile.survivor?.deathAge ?? age) + 1
    )
    const eligibleAge = Math.max(
      EARLIEST_SURVIVOR_AGE,
      firstSurvivorAge ?? survivorAge
    )
    // Own benefit claimed before full retirement age: take it first and the
    // unreduced survivor benefit at 67 (own first, survivor later). Otherwise
    // the survivor benefit starts as soon as it is payable. A survivorClaimAge
    // overrides both (REQ-MCP-48).
    const ownBeforeFull =
      ownBenefit.claimAge !== undefined &&
      (ownBenefit.monthly ?? 0) > 0 &&
      ownBenefit.claimAge < FULL_RETIREMENT_AGE
    const chosen = profile.survivor?.survivorClaimAge
    const startAge =
      chosen !== undefined
        ? Math.max(eligibleAge, chosen)
        : ownBeforeFull
          ? Math.max(eligibleAge, FULL_RETIREMENT_AGE)
          : eligibleAge
    const survivorBenefit =
      survivorAge < startAge
        ? 0
        : deceasedBenefitMonthly(profile) * survivorFactor(startAge)
    return Math.max(own, survivorBenefit) * 12 * cola
  }
  let total = 0
  const ownerClaimed =
    profile.socialSecurityMonthly !== undefined &&
    profile.socialSecurityAge !== undefined &&
    age >= profile.socialSecurityAge
  if (ownerClaimed) total += (profile.socialSecurityMonthly ?? 0) * 12
  const spouse = profile.spouse
  const spouseAge = spouseAgeAt(profile, age)
  const spouseClaimed =
    spouse?.socialSecurityMonthly !== undefined &&
    spouse.socialSecurityAge !== undefined &&
    spouseAge !== undefined &&
    spouseAge >= spouse.socialSecurityAge
  if (spouseClaimed) total += (spouse?.socialSecurityMonthly ?? 0) * 12
  // REQ-MCP-54: once both have claimed, the lower earner gets a top-up to
  // half the other's full-retirement-age benefit (reduced if claimed early).
  if (ownerClaimed && spouseClaimed) {
    const owner = {
      monthly: profile.socialSecurityMonthly as number,
      claimAge: profile.socialSecurityAge as number,
    }
    const partner = {
      monthly: spouse?.socialSecurityMonthly as number,
      claimAge: spouse?.socialSecurityAge as number,
    }
    // Each top-up starts when the later of the two claims is made, and its
    // reduction follows the receiving spouse's age then (SSA).
    const spouseOffset = (spouseAge as number) - age
    total +=
      12 *
      (spousalExcess(owner, partner, partner.claimAge - spouseOffset) +
        spousalExcess(partner, owner, owner.claimAge + spouseOffset))
  }
  return total * cola
}

/** Pension and other income at `age`, nominal (fixed in dollars, as v1). */
function otherIncomeAt(
  profile: UserProfile,
  age: number
): { pension: number; other: number } {
  const pension =
    profile.pensionMonthly !== undefined && age >= profile.targetRetirementAge
      ? profile.pensionMonthly * 12
      : 0
  let other = 0
  if (profile.otherIncomeMonthly !== undefined) {
    const start = profile.otherIncomeStartAge ?? profile.targetRetirementAge
    const end = profile.otherIncomeEndAge ?? Infinity
    if (age >= start && age <= end) other = profile.otherIncomeMonthly * 12
  }
  return { pension, other }
}

/** Pre-Medicare health insurance at `age`, nominal. */
function healthcareAt(
  profile: UserProfile,
  age: number,
  inflation: number
): number {
  const annual = profile.preMedicareHealthcare ?? 0
  if (annual <= 0) return 0
  // REQ-MCP-55: after the owner's death the survivor buys cover even
  // before the owner's retirement age.
  if (age < profile.targetRetirementAge && !ownerDeadAt(profile, age)) return 0
  const survivorAge = survivorAgeAt(profile, age)
  if (survivorAge !== undefined) {
    return survivorAge < MEDICARE_AGE ? annual * 0.5 * inflation : 0
  }
  if (age < MEDICARE_AGE) return annual * inflation
  const spouseAge = spouseAgeAt(profile, age)
  if (spouseAge !== undefined && spouseAge < MEDICARE_AGE)
    return annual * 0.5 * inflation
  return 0
}

function employerPlanOpen(ctx: Context, age: number): boolean {
  return (
    age >= PENALTY_FREE_AGE ||
    // REQ-MCP-55: a beneficiary's distributions carry no 10% penalty.
    ownerDeadAt(ctx.profile, age) ||
    (ctx.separationAge >= RULE_OF_55_AGE && age >= ctx.separationAge)
  )
}

/**
 * Take `amount` beyond the forced payouts, in order: taxable; the employer
 * plan when open (60+, or the Rule of 55 after separation), else just its
 * 457(b) part (`employerPlan457`) after separation, which has no 10%
 * penalty at any age; the IRA and Roth from 60; then, still short, the
 * employer plan, IRA and Roth with the 10% penalty. What none of them can
 * cover is the shortfall.
 */
function drawDown(
  ctx: Context,
  age: number,
  balances: Buckets,
  forced: Buckets,
  amount: number,
  employerPlan457 = 0
): Draws {
  const withdrawals: Buckets = { ...forced }
  const left: Buckets = {
    taxable: balances.taxable - forced.taxable,
    employerPlan: balances.employerPlan - forced.employerPlan,
    ira: balances.ira - forced.ira,
    roth: balances.roth - forced.roth,
    nqdc: balances.nqdc - forced.nqdc,
  }
  let need = Math.max(0, amount)
  let penalized = 0
  const take = (
    bucket: Bucket,
    withPenalty: boolean,
    cap = Infinity
  ): number => {
    if (need <= 0) return 0
    const amountTaken = Math.min(need, Math.max(0, left[bucket]), cap)
    left[bucket] -= amountTaken
    withdrawals[bucket] += amountTaken
    need -= amountTaken
    if (withPenalty) penalized += amountTaken
    return amountTaken
  }
  const free457 = Math.max(0, employerPlan457)
  let used457 = 0
  take('taxable', false)
  if (employerPlanOpen(ctx, age)) {
    // Open: the 457(b) part pays first.
    used457 = Math.min(free457, take('employerPlan', false))
  } else if (age >= ctx.separationAge) {
    used457 = take('employerPlan', false, free457)
  }
  if (age >= PENALTY_FREE_AGE || ownerDeadAt(ctx.profile, age)) {
    take('ira', false)
    take('roth', false)
  }
  // Paid out early, with the penalty. NQDC pays only on its schedule.
  take('employerPlan', true)
  take('ira', true)
  take('roth', true)
  return { withdrawals, penalized, shortfall: need, used457 }
}

interface TaxResult {
  readonly federal: number
  readonly state: number
  readonly penalty: number
  /** Adjusted gross income, nominal: the MAGI Medicare's IRMAA uses. */
  readonly agi: number
  /** Ordinary income after the standard deduction, today's dollars. */
  readonly taxableOrdinary: number
}

/**
 * Tax on a year, nominal. Brackets and the standard deduction are indexed
 * to inflation, so tax is figured in today's dollars and scaled back up.
 */
function taxFor(
  ctx: Context,
  gainFraction: number,
  draws: Draws,
  socialSecurity: number,
  pension: number,
  other: number,
  inflation: number,
  conversion = 0
): TaxResult {
  const w = draws.withdrawals
  const preTax = w.employerPlan + w.ira + conversion
  const gainsNominal = w.taxable * gainFraction
  const otherOrdinary = preTax + w.nqdc + pension + other
  const taxableBenefit = taxableSocialSecurity(
    socialSecurity,
    otherOrdinary + gainsNominal,
    ctx.filingStatus
  )
  const ordinary = (otherOrdinary + taxableBenefit) / inflation
  const taxableOrdinary = Math.max(
    0,
    ordinary - getStandardDeduction(ctx.filingStatus)
  )
  const gains = (w.taxable * gainFraction) / inflation
  const federal =
    calculateOrdinaryTax(taxableOrdinary, ctx.filingStatus).total +
    calculateCapitalGainsTax(gains, taxableOrdinary, ctx.filingStatus)
  const stateRate = ctx.profile.stateTaxRate ?? 0
  const stateBase = ctx.profile.stateExemptsRetirementIncome
    ? w.nqdc + other + w.taxable * gainFraction
    : preTax + w.nqdc + pension + other + w.taxable * gainFraction
  return {
    federal: federal * inflation,
    state: stateRate * stateBase,
    penalty: EARLY_WITHDRAWAL_PENALTY * draws.penalized,
    agi: otherOrdinary + taxableBenefit + gainsNominal,
    taxableOrdinary,
  }
}

/** ACA household income (MAGI): AGI plus untaxed Social Security, nominal. */
function magiFor(
  gainFraction: number,
  draws: Draws,
  socialSecurity: number,
  pension: number,
  other: number,
  conversion = 0
): number {
  const w = draws.withdrawals
  return (
    conversion +
    w.employerPlan +
    w.ira +
    w.nqdc +
    pension +
    other +
    socialSecurity +
    w.taxable * gainFraction
  )
}

/** The year's premium tax credit, nominal; 0 unless acaPremiumTaxCredit is set. */
function acaCreditFor(
  ctx: Context,
  grossHealthcare: number,
  magi: number,
  inflation: number
): number {
  if (ctx.profile.acaPremiumTaxCredit !== true || grossHealthcare <= 0) return 0
  return (
    premiumTaxCredit(
      grossHealthcare / inflation,
      magi / inflation,
      ctx.householdSize
    ) * inflation
  )
}

/**
 * A cliff (an IRMAA tier, the ACA 400% line) charges the full step for a
 * dollar over, so conversions stop this far below it, in today's dollars.
 */
export const CLIFF_MARGIN = 100

/**
 * The ceiling a conversion fills this year and where income stands against
 * it, both in today's dollars; undefined when the strategy converts nothing.
 */
function conversionTarget(
  ctx: Context,
  age: number,
  tax: TaxResult,
  acaMagi: number,
  inflation: number
): { readonly ceiling: number; readonly measure: number } | undefined {
  const strategy = ctx.conversion
  const agi = tax.agi / inflation
  switch (strategy.kind) {
    case 'none':
      return undefined
    case 'fillBracket': {
      const bracket = getFederalBrackets(ctx.filingStatus).find(
        b => Math.abs(b.rate - strategy.rate) < 1e-9
      )
      if (bracket === undefined || !Number.isFinite(bracket.max)) {
        return undefined
      }
      return { ceiling: bracket.max, measure: tax.taxableOrdinary }
    }
    case 'irmaaTier':
      return {
        ceiling: irmaaCeiling(strategy.tier, ctx.filingStatus) - CLIFF_MARGIN,
        measure: agi,
      }
    case 'acaThenIrmaa': {
      const spouseAge = spouseAgeAt(ctx.profile, age)
      const onAca =
        ctx.profile.acaPremiumTaxCredit === true &&
        (age < MEDICARE_AGE ||
          (spouseAge !== undefined && spouseAge < MEDICARE_AGE))
      return onAca
        ? {
            ceiling:
              ACA_SUBSIDY_CLIFF * povertyLine(ctx.householdSize) - CLIFF_MARGIN,
            measure: acaMagi / inflation,
          }
        : {
            ceiling: irmaaCeiling(0, ctx.filingStatus) - CLIFF_MARGIN,
            measure: agi,
          }
    }
  }
}

/** The NQDC payout at `age` from a balance: an equal share of what is left. */
function nqdcPayoutAt(ctx: Context, age: number, balance: number): number {
  if (balance <= 0 || age < ctx.nqdcStart) return 0
  const remainingYears = ctx.nqdcStart + ctx.nqdcYears - age
  return remainingYears <= 1 ? balance : balance / remainingYears
}

/** A path's running state: balances and the cost basis of the taxable bucket. */
interface PathState {
  readonly balances: Buckets
  taxableBasis: number
  /** The 457(b) part of balances.employerPlan. */
  employerPlan457: number
  /** AGI by age in today's dollars, for IRMAA's two-year lookback. */
  readonly agiByAge: Map<number, number>
}

/**
 * Medicare IRMAA for the year, nominal: the household's AGI from two years
 * earlier sets the tier, and each person on Medicare (65+) pays it. A
 * lookback year before retirement is not modelled (salary is not an input;
 * a work stoppage lets SSA use the lower current income on form SSA-44).
 */
function irmaaAt(
  ctx: Context,
  age: number,
  state: PathState,
  inflation: number
): { readonly amount: number; readonly tier: number } {
  const spouseAge = spouseAgeAt(ctx.profile, age)
  const survivorAge = survivorAgeAt(ctx.profile, age)
  const enrollees =
    survivorAge !== undefined
      ? survivorAge >= MEDICARE_AGE
        ? 1
        : 0
      : (age >= MEDICARE_AGE ? 1 : 0) +
        (spouseAge !== undefined && spouseAge >= MEDICARE_AGE ? 1 : 0)
  const lookbackAge = age - IRMAA_LOOKBACK_YEARS
  const lookback = state.agiByAge.get(lookbackAge)
  if (
    enrollees === 0 ||
    lookback === undefined ||
    lookbackAge < ctx.profile.targetRetirementAge
  ) {
    return { amount: 0, tier: 0 }
  }
  const { tier, annualPerPerson } = irmaaFor(lookback, ctx.filingStatus)
  return { amount: annualPerPerson * enrollees * inflation, tier }
}

/**
 * One year: add savings and any home sale, take forced payouts (RMD, NQDC),
 * withdraw what spending, healthcare (less any ACA credit) and tax need
 * beyond income, put any surplus in the taxable bucket, then grow every
 * bucket by the year's return. `state` is updated in place.
 */
function stepYear(
  baseCtx: Context,
  age: number,
  state: PathState,
  inflation: number,
  portfolioReturn: number
): YearFlows {
  const ctx = yearContext(baseCtx, age)
  const { profile } = ctx
  const balances = state.balances
  const ownerDead = ownerDeadAt(profile, age)
  // REQ-MCP-52/55: after the owner's death the survivor's spending and health
  // cover replace the income gap's, so the gap ends with the death.
  const gap = ownerDead ? 0 : gapShareAt(profile, age)
  if (age < profile.targetRetirementAge && !ownerDead) {
    // Savings join the 457(b) part in proportion to its share of the plan.
    // REQ-MCP-52: none during an income gap, then the new job's savings.
    const contributions = contributionsAt(profile, age) * (1 - gap)
    if (balances.employerPlan > 0) {
      state.employerPlan457 +=
        contributions *
        Math.min(1, state.employerPlan457 / balances.employerPlan)
    }
    balances.employerPlan += contributions
  }
  if (
    profile.survivor?.lifeInsurance !== undefined &&
    profile.spouse !== undefined &&
    age === Math.floor(profile.survivor.deathAge) + 1
  ) {
    // REQ-MCP-55: a life insurance payout is tax-free basis.
    const payout = Math.max(0, profile.survivor.lifeInsurance) * inflation
    balances.taxable += payout
    state.taxableBasis += payout
  }
  if (profile.incomeGap !== undefined && age === profile.incomeGap.startAge) {
    // After-tax severance is basis in the taxable account.
    const severance = Math.max(0, profile.incomeGap.severance ?? 0) * inflation
    balances.taxable += severance
    state.taxableBasis += severance
  }
  // REQ-MCP-60: after-tax lump sums arrive as basis in the taxable account.
  for (const lump of profile.lumpSums ?? []) {
    if (Math.floor(lump.age) !== age) continue
    const amount = Math.max(0, lump.amount) * inflation
    balances.taxable += amount
    state.taxableBasis += amount
  }
  if (profile.homeSale !== undefined && age === profile.homeSale.age) {
    // Proceeds are basis: the gain on a main home is assumed within the
    // $250,000/$500,000 exclusion, so they add no income (or MAGI).
    const proceeds = Math.max(
      0,
      homeSaleAt(profile, ctx.asOfDate)?.netProceeds ?? 0
    )
    balances.taxable += proceeds
    state.taxableBasis += proceeds
  }
  const gainFraction =
    balances.taxable > 0
      ? Math.min(1, Math.max(0, 1 - state.taxableBasis / balances.taxable))
      : 0

  const retired = age >= profile.targetRetirementAge || ownerDead
  const coupleSpending = retired
    ? annualExpensesAt(profile, age, inflation, ctx.asOfDate)
    : 0
  const spending =
    (survivorAgeAt(profile, age) === undefined
      ? coupleSpending
      : survivorSpending(ctx, age, coupleSpending)) +
    gapSpendingAt(profile, age, gap, inflation)
  const healthcare = healthcareAt(profile, age, inflation)
  const socialSecurity = socialSecurityAt(profile, age, inflation, ctx.asOfDate)
  const { pension, other } = otherIncomeAt(profile, age)
  const income = socialSecurity + pension + other
  const irmaa = irmaaAt(ctx, age, state, inflation)
  const medicareCosts = healthcare + irmaa.amount

  const forced = emptyBuckets()
  const divisor = rmdDivisor(age)
  if (divisor !== undefined) {
    forced.employerPlan = balances.employerPlan / divisor
    forced.ira = balances.ira / divisor
  }
  forced.nqdc = nqdcPayoutAt(ctx, age, balances.nqdc)
  const forcedTotal = forced.employerPlan + forced.ira + forced.nqdc
  // RMDs come from the 457(b) part pro rata; other employer-plan
  // withdrawals come from it first.
  const share457 =
    balances.employerPlan > 0
      ? Math.min(1, state.employerPlan457 / balances.employerPlan)
      : 0
  const available457 = Math.max(
    0,
    state.employerPlan457 - forced.employerPlan * share457
  )

  // Solve for the withdrawal that covers spending, net healthcare and its
  // own tax. Tax grows more slowly than the withdrawal, so fixed passes
  // converge and stay deterministic. The ACA credit falls as income rises
  // and stops at the 400% cliff; if that makes the passes flip between two
  // answers, the year is figured without the credit (conservative).
  // A Roth conversion this year fills the strategy's ceiling; it is solved
  // in the same passes, since the tax it adds needs withdrawals that add
  // income too. The step damps half the gap, so the passes converge.
  const converting =
    ctx.conversion.kind !== 'none' &&
    age >= profile.targetRetirementAge &&
    age <= ctx.conversionEndAge
  const convertible = (d: Draws): number =>
    Math.max(0, balances.ira - d.withdrawals.ira) +
    Math.max(0, balances.employerPlan - d.withdrawals.employerPlan)
  const nextConversion = (d: Draws, t: TaxResult, current: number): number => {
    if (!converting) return 0
    const target = conversionTarget(
      ctx,
      age,
      t,
      magiFor(gainFraction, d, socialSecurity, pension, other, current),
      inflation
    )
    if (target === undefined) return 0
    const gap = (target.ceiling - target.measure) * inflation
    return Math.min(convertible(d), Math.max(0, current + 0.5 * gap))
  }

  const solve = (withCredit: boolean) => {
    const creditFor = (d: Draws, c: number): number =>
      withCredit
        ? acaCreditFor(
            ctx,
            healthcare,
            magiFor(gainFraction, d, socialSecurity, pension, other, c),
            inflation
          )
        : 0
    const taxOf = (d: Draws, c: number): TaxResult =>
      taxFor(ctx, gainFraction, d, socialSecurity, pension, other, inflation, c)
    let conversion = 0
    let extra = Math.max(0, spending + medicareCosts - income - forcedTotal)
    let draws = drawDown(ctx, age, balances, forced, extra, available457)
    let tax = taxOf(draws, conversion)
    let credit = creditFor(draws, conversion)
    let converged = false
    for (let pass = 0; pass < 120; pass++) {
      const taxTotal = tax.federal + tax.state + tax.penalty
      const next = Math.max(
        0,
        spending + medicareCosts - credit + taxTotal - income - forcedTotal
      )
      const nextConv = nextConversion(draws, tax, conversion)
      if (
        Math.abs(next - extra) < 0.01 &&
        Math.abs(nextConv - conversion) < 0.5
      ) {
        converged = true
        break
      }
      extra = next
      conversion = nextConv
      draws = drawDown(ctx, age, balances, forced, extra, available457)
      tax = taxOf(draws, conversion)
      credit = creditFor(draws, conversion)
    }
    return { draws, tax, credit, conversion, converged }
  }
  let solved = solve(true)
  if (!solved.converged && solved.credit > 0) solved = solve(false)
  const { draws, tax, credit, conversion } = solved
  const magi = magiFor(
    gainFraction,
    draws,
    socialSecurity,
    pension,
    other,
    conversion
  )
  state.agiByAge.set(age, tax.agi / inflation)

  const w = draws.withdrawals
  state.taxableBasis = Math.max(
    0,
    state.taxableBasis - w.taxable * (1 - gainFraction)
  )
  for (const bucket of BUCKETS) balances[bucket] -= w[bucket]
  state.employerPlan457 = available457 - draws.used457
  if (conversion > 0) {
    const fromIra = Math.min(conversion, Math.max(0, balances.ira))
    balances.ira -= fromIra
    balances.employerPlan = Math.max(
      0,
      balances.employerPlan - (conversion - fromIra)
    )
    balances.roth += conversion
    state.employerPlan457 = Math.min(
      state.employerPlan457,
      balances.employerPlan
    )
  }
  const cashIn = BUCKETS.reduce((sum, b) => sum + w[b], 0) + income
  const surplus =
    cashIn -
    spending -
    (healthcare - credit) -
    irmaa.amount -
    tax.federal -
    tax.state -
    tax.penalty
  if (surplus > 0) {
    balances.taxable += surplus
    state.taxableBasis += surplus
  }
  for (const bucket of BUCKETS) {
    balances[bucket] = Math.max(0, balances[bucket] * (1 + portfolioReturn))
  }
  state.employerPlan457 = Math.min(
    balances.employerPlan,
    Math.max(0, state.employerPlan457 * (1 + portfolioReturn))
  )
  if (balances.taxable <= 0) state.taxableBasis = 0

  return {
    age,
    spending,
    healthcare,
    acaCredit: credit,
    magi,
    irmaa: irmaa.amount,
    irmaaTier: irmaa.tier,
    rothConversion: conversion,
    socialSecurity,
    otherIncome: pension + other,
    withdrawals: { ...w },
    rmd: forced.employerPlan + forced.ira,
    federalTax: tax.federal,
    stateTax: tax.state,
    penalty: tax.penalty,
    shortfall: draws.shortfall,
    balances: { ...balances },
  }
}

/**
 * REQ-MCP-52: the share of the year at `age` without pay in an income gap
 * (0 outside it, and from retirement on).
 */
function gapShareAt(profile: UserProfile, age: number): number {
  const gap = profile.incomeGap
  if (
    gap === undefined ||
    age < gap.startAge ||
    age >= profile.targetRetirementAge
  ) {
    return 0
  }
  const monthsThisYear = Math.min(
    12,
    Math.max(0, gap.months - 12 * (age - gap.startAge))
  )
  return monthsThisYear / 12
}

/** Yearly savings at `age`: the new job's from the income gap on. */
function contributionsAt(profile: UserProfile, age: number): number {
  const gap = profile.incomeGap
  const base = profile.annualContributions ?? 0
  if (gap === undefined || age < gap.startAge) return base
  return gap.newAnnualContributions ?? base
}

/** Household spending and health insurance paid from savings during the gap (nominal). */
function gapSpendingAt(
  profile: UserProfile,
  age: number,
  share: number,
  inflation: number
): number {
  const gap = profile.incomeGap
  if (gap === undefined || share <= 0) return 0
  const monthly =
    (gap.monthlySpending ?? profile.annualExpenses / 12) +
    (gap.healthcareMonthly ?? (profile.preMedicareHealthcare ?? 0) / 12)
  return monthly * 12 * share * inflation
}

/** The year's context: after a death, the survivor files single as a household of one. */
function yearContext(ctx: Context, age: number): Context {
  if (survivorAgeAt(ctx.profile, age) === undefined) return ctx
  return {
    ...ctx,
    filingStatus: 'single',
    householdSize: Math.max(1, ctx.householdSize - 1),
  }
}

/** The survivor's spending: the mortgage payment in full, the rest scaled by spendingShare. */
function survivorSpending(ctx: Context, age: number, couple: number): number {
  const { profile } = ctx
  const share = profile.survivor?.spendingShare ?? SURVIVOR_SPENDING_SHARE
  const endAge = mortgagePaymentEndAge(profile, ctx.asOfDate)
  const payment =
    endAge !== undefined && age < endAge
      ? 12 * (profile.mortgage?.monthlyPayment ?? 0)
      : 0
  const paid = Math.min(payment, couple)
  return paid + share * (couple - paid)
}

function contextFor(
  portfolio: Portfolio,
  profile: UserProfile,
  options: ProjectionOptions = {}
): Context {
  // REQ-MCP-52: leaving the job at the gap start is the separation that
  // counts for the Rule of 55 on the old employer's plan.
  const separationAge =
    profile.incomeGap !== undefined &&
    profile.incomeGap.startAge < profile.targetRetirementAge
      ? profile.incomeGap.startAge
      : (profile.separationAge ?? profile.targetRetirementAge)
  return {
    profile,
    asOfDate: portfolio.asOfDate,
    filingStatus: filingStatusOf(profile),
    householdSize:
      profile.householdSize ?? (profile.spouse === undefined ? 1 : 2),
    // REQ-MCP-57: an election tied to leaving the job starts at separation.
    nqdcStart:
      profile.nqdcPayout?.onSeparation === true
        ? separationAge
        : (profile.nqdcPayout?.startAge ?? profile.targetRetirementAge),
    nqdcYears: Math.max(1, profile.nqdcPayout?.years ?? 1),
    separationAge,
    conversion: options.rothConversion ?? { kind: 'none' },
    conversionEndAge: options.conversionEndAge ?? RMD_START_AGE - 1,
  }
}

const round = (value: number): number => Math.round(value)

function real(buckets: Buckets, inflation: number): Buckets {
  return {
    taxable: round(buckets.taxable / inflation),
    employerPlan: round(buckets.employerPlan / inflation),
    ira: round(buckets.ira / inflation),
    roth: round(buckets.roth / inflation),
    nqdc: round(buckets.nqdc / inflation),
  }
}

const total = (buckets: Buckets): number =>
  BUCKETS.reduce((sum, bucket) => sum + buckets[bucket], 0)

/** One year of the expected-return path, in today's dollars. */
export interface ProjectionYear {
  readonly age: number
  readonly spouseAge: number | null
  readonly spending: number
  /** Pre-Medicare health insurance before any ACA credit. */
  readonly healthcare: number
  /** ACA premium tax credit (0 unless acaPremiumTaxCredit is set). */
  readonly acaCredit: number
  /** ACA household income: AGI plus untaxed Social Security. */
  readonly magi: number
  /** Medicare IRMAA surcharges (Part B + D) for everyone on Medicare. */
  readonly irmaa: number
  /** IRMAA tier from the AGI two years earlier (0 = none). */
  readonly irmaaTier: number
  /** Pre-tax money converted to Roth this year. */
  readonly rothConversion: number
  readonly socialSecurity: number
  readonly otherIncome: number
  readonly withdrawals: Buckets & { readonly total: number }
  readonly rmd: number
  readonly taxes: {
    readonly federal: number
    readonly state: number
    readonly penalty: number
    readonly total: number
  }
  readonly shortfall: number
  readonly endBalances: Buckets & { readonly total: number }
}

export interface ProjectionPercentiles {
  readonly age: number
  readonly p10: number
  readonly p25: number
  readonly p50: number
  readonly p75: number
  readonly p90: number
}

export interface RetirementProjection {
  readonly modelVersion: string
  readonly planningAge: number
  readonly filingStatus: FilingStatus
  readonly startingBalances: Buckets & { readonly total: number }
  readonly monteCarlo: {
    readonly seed: number
    readonly paths: number
    /** Share of paths that pay every year's spending to the planning age. */
    readonly successRate: number
    /** Among paths that run short: the age money runs out (10th percentile and median). */
    readonly depletionAge: { readonly p10: number; readonly p50: number } | null
    /** Total balance by age, today's dollars. */
    readonly percentiles: ProjectionPercentiles[]
  }
  /** Mean returns and inflation every year. Not the Monte Carlo median. */
  readonly expectedPath: {
    readonly years: ProjectionYear[]
    readonly depletionAge: number | null
    readonly balanceAtRetirement: number
    readonly lifetimeTax: number
    readonly lifetimePenalty: number
    readonly lifetimeAcaCredit: number
    readonly lifetimeIrmaa: number
    readonly lifetimeRothConversion: number
    readonly firstRetirementYear: {
      readonly age: number
      readonly spendingWithHealthcare: number
      readonly withdrawal: number
      /** withdrawal / start-of-retirement balance. */
      readonly withdrawalRate: number
    } | null
  }
}

export interface ProjectionOptions {
  readonly seed?: number
  readonly paths?: number
  /** Roth conversions each retired year (default none). */
  readonly rothConversion?: RothConversionStrategy
  /** Last age to convert (default 74, the year before RMDs). */
  readonly conversionEndAge?: number
}

/**
 * Project a retirement to the planning age. The Monte Carlo draws, per
 * year, an equity return, a bond return and inflation from the same seeded
 * stream as runMonteCarlo; every bucket earns the portfolio's blended
 * return. A path succeeds when no year runs short before the planning age.
 */
export function projectRetirement(
  portfolio: Portfolio,
  profile: UserProfile,
  options: ProjectionOptions = {}
): RetirementProjection {
  const seed = options.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
  const paths = options.paths ?? PROJECTION_PATHS
  const planningAge = planningAgeOf(profile)
  const years = Math.max(0, planningAge - profile.currentAge)
  const start = startingBuckets(portfolio)
  const ctx = contextFor(portfolio, profile, options)
  const startState = (): PathState => ({
    balances: { ...start.balances },
    taxableBasis: start.balances.taxable * (1 - start.taxableGainFraction),
    employerPlan457: start.employerPlan457,
    agiByAge: new Map<number, number>(),
  })
  const totalValue = calculatePortfolioValue(portfolio)
  const equity = calculateEquityFraction(portfolio, totalValue)
  const M = MONTE_CARLO_DEFAULTS

  // Expected-return path (REQ-MCP-51: near-term means, then long-run).
  const expectedYears: ProjectionYear[] = []
  {
    const state = startState()
    let inflation = 1
    for (let i = 0; i < years; i++) {
      const age = profile.currentAge + i + 1
      const means = meansForYear(profile, i)
      inflation *= 1 + means.inflation
      const expectedReturn = equity * means.equity + (1 - equity) * means.bond
      const flow = stepYear(ctx, age, state, inflation, expectedReturn)
      expectedYears.push(toProjectionYear(profile, flow, inflation))
    }
  }

  // Monte Carlo.
  const rand = seededRandom(seed)
  const byYear: number[][] = Array.from({ length: years }, () => [])
  const depletionAges: number[] = []
  let successes = 0
  for (let path = 0; path < paths; path++) {
    const state = startState()
    let inflation = 1
    let depletedAt: number | null = null
    for (let i = 0; i < years; i++) {
      const age = profile.currentAge + i + 1
      const means = meansForYear(profile, i)
      const equityReturn =
        means.equity + M.EQUITY_STD_DEV * boxMullerNormal(rand)
      const bondReturn = means.bond + M.BOND_STD_DEV * boxMullerNormal(rand)
      const drawnInflation =
        means.inflation + M.INFLATION_STD_DEV * boxMullerNormal(rand)
      inflation *= 1 + Math.max(drawnInflation, 0)
      const portfolioReturn = equity * equityReturn + (1 - equity) * bondReturn
      const flow = stepYear(ctx, age, state, inflation, portfolioReturn)
      if (depletedAt === null && flow.shortfall > 1) depletedAt = age
      byYear[i].push(
        depletedAt === null ? total(state.balances) / inflation : 0
      )
    }
    if (depletedAt === null) successes++
    else depletionAges.push(depletedAt)
  }
  depletionAges.sort((a, b) => a - b)

  const percentiles = byYear.map((values, i) => {
    values.sort((a, b) => a - b)
    return {
      age: profile.currentAge + i + 1,
      p10: round(percentile(values, 10)),
      p25: round(percentile(values, 25)),
      p50: round(percentile(values, 50)),
      p75: round(percentile(values, 75)),
      p90: round(percentile(values, 90)),
    }
  })

  const retirementIndex = expectedYears.findIndex(
    year => year.age >= profile.targetRetirementAge
  )
  const startBalanceAtRetirement =
    retirementIndex <= 0
      ? total(start.balances)
      : expectedYears[retirementIndex - 1].endBalances.total
  const firstYear =
    retirementIndex < 0 ? undefined : expectedYears[retirementIndex]
  const depleted = expectedYears.find(year => year.shortfall > 1)
  const startingBalances = {
    ...real(start.balances, 1),
    total: round(total(start.balances)),
  }

  return {
    modelVersion: PROJECTION_MODEL_VERSION,
    planningAge,
    filingStatus: ctx.filingStatus,
    startingBalances,
    monteCarlo: {
      seed,
      paths,
      successRate: paths === 0 ? 0 : successes / paths,
      depletionAge:
        depletionAges.length === 0
          ? null
          : {
              p10: percentile(depletionAges, 10),
              p50: percentile(depletionAges, 50),
            },
      percentiles,
    },
    expectedPath: {
      years: expectedYears,
      depletionAge: depleted?.age ?? null,
      balanceAtRetirement: round(startBalanceAtRetirement),
      lifetimeTax: expectedYears.reduce((sum, y) => sum + y.taxes.total, 0),
      lifetimePenalty: expectedYears.reduce(
        (sum, y) => sum + y.taxes.penalty,
        0
      ),
      lifetimeAcaCredit: expectedYears.reduce((sum, y) => sum + y.acaCredit, 0),
      lifetimeIrmaa: expectedYears.reduce((sum, y) => sum + y.irmaa, 0),
      lifetimeRothConversion: expectedYears.reduce(
        (sum, y) => sum + y.rothConversion,
        0
      ),
      firstRetirementYear:
        firstYear === undefined
          ? null
          : {
              age: firstYear.age,
              spendingWithHealthcare:
                firstYear.spending +
                firstYear.healthcare +
                firstYear.irmaa -
                firstYear.acaCredit,
              withdrawal: firstYear.withdrawals.total,
              withdrawalRate:
                startBalanceAtRetirement > 0
                  ? Math.round(
                      (firstYear.withdrawals.total / startBalanceAtRetirement) *
                        10_000
                    ) / 10_000
                  : 0,
            },
    },
  }
}

/** One year of market returns and inflation, as decimals (REQ-MCP-50). */
export interface MarketYear {
  readonly stocks: number
  readonly bonds: number
  readonly inflation: number
}

export interface SequenceResult {
  /** The first age that runs short, or null if every year is paid. */
  readonly depletionAge: number | null
  /** Total balance at each age's end, today's dollars (0 once depleted). */
  readonly balanceByAge: readonly {
    readonly age: number
    readonly total: number
  }[]
  readonly balanceAtPlanningAge: number
}

/**
 * One path with the given market years (REQ-MCP-50): sequence[i] is the
 * year at age currentAge + 1 + i; a missing entry uses the expected returns
 * and inflation. Same rules as projectRetirement.
 */
export function projectSequence(
  portfolio: Portfolio,
  profile: UserProfile,
  sequence: readonly (MarketYear | undefined)[]
): SequenceResult {
  const planningAge = planningAgeOf(profile)
  const years = Math.max(0, planningAge - profile.currentAge)
  const start = startingBuckets(portfolio)
  const ctx = contextFor(portfolio, profile)
  const state: PathState = {
    balances: { ...start.balances },
    taxableBasis: start.balances.taxable * (1 - start.taxableGainFraction),
    employerPlan457: start.employerPlan457,
    agiByAge: new Map<number, number>(),
  }
  const equity = calculateEquityFraction(
    portfolio,
    calculatePortfolioValue(portfolio)
  )
  let inflation = 1
  let depletionAge: number | null = null
  const balanceByAge: { age: number; total: number }[] = []
  for (let i = 0; i < years; i++) {
    const age = profile.currentAge + i + 1
    const market = sequence[i]
    const means = meansForYear(profile, i)
    const stocks = market?.stocks ?? means.equity
    const bonds = market?.bonds ?? means.bond
    inflation *= 1 + (market?.inflation ?? means.inflation)
    const flow = stepYear(
      ctx,
      age,
      state,
      inflation,
      equity * stocks + (1 - equity) * bonds
    )
    if (depletionAge === null && flow.shortfall > 1) depletionAge = age
    balanceByAge.push({
      age,
      total:
        depletionAge === null ? round(total(state.balances) / inflation) : 0,
    })
  }
  return {
    depletionAge,
    balanceByAge,
    balanceAtPlanningAge: balanceByAge[balanceByAge.length - 1]?.total ?? 0,
  }
}

function toProjectionYear(
  profile: UserProfile,
  flow: YearFlows,
  inflation: number
): ProjectionYear {
  const withdrawals = real(flow.withdrawals, inflation)
  const endBalances = real(flow.balances, inflation)
  const federal = round(flow.federalTax / inflation)
  const state = round(flow.stateTax / inflation)
  const penalty = round(flow.penalty / inflation)
  return {
    age: flow.age,
    spouseAge: spouseAgeAt(profile, flow.age) ?? null,
    spending: round(flow.spending / inflation),
    healthcare: round(flow.healthcare / inflation),
    acaCredit: round(flow.acaCredit / inflation),
    magi: round(flow.magi / inflation),
    irmaa: round(flow.irmaa / inflation),
    irmaaTier: flow.irmaaTier,
    rothConversion: round(flow.rothConversion / inflation),
    socialSecurity: round(flow.socialSecurity / inflation),
    otherIncome: round(flow.otherIncome / inflation),
    withdrawals: { ...withdrawals, total: total(withdrawals) },
    rmd: round(flow.rmd / inflation),
    taxes: { federal, state, penalty, total: federal + state + penalty },
    shortfall: round(flow.shortfall / inflation),
    endBalances: { ...endBalances, total: total(endBalances) },
  }
}

/** A chart a client can draw as is: labels on x, one value per label per series. */
export interface ChartSpec {
  readonly title: string
  readonly style: 'line' | 'bar'
  readonly xLabel: string
  readonly yLabel: string
  readonly x: readonly (number | string)[]
  readonly series: readonly {
    readonly name: string
    readonly values: readonly number[]
  }[]
}

export interface ProjectionCharts {
  readonly balanceByAge: ChartSpec
  readonly incomeAndSpendingByAge: ChartSpec
  readonly accountsByAge: ChartSpec
}

/**
 * Three charts from a projection, in today's dollars: the Monte Carlo
 * balance band, and the expected path's cash flow and account mix.
 */
export function projectionCharts(
  projection: RetirementProjection
): ProjectionCharts {
  const bands = projection.monteCarlo.percentiles
  const years = projection.expectedPath.years
  const ages = years.map(year => year.age)
  return {
    balanceByAge: {
      title: 'Total savings by age (today’s dollars)',
      style: 'line',
      xLabel: 'Age',
      yLabel: 'Today’s dollars',
      x: bands.map(band => band.age),
      series: [
        {
          name: 'Poor markets (10th percentile)',
          values: bands.map(b => b.p10),
        },
        { name: 'Typical (median)', values: bands.map(b => b.p50) },
        {
          name: 'Strong markets (90th percentile)',
          values: bands.map(b => b.p90),
        },
      ],
    },
    incomeAndSpendingByAge: {
      title: 'Where each year’s money comes from (expected returns)',
      style: 'bar',
      xLabel: 'Age',
      yLabel: 'Today’s dollars',
      x: ages,
      series: [
        {
          name: 'Spending + healthcare (after any ACA credit, with IRMAA)',
          values: years.map(
            y => y.spending + y.healthcare + y.irmaa - y.acaCredit
          ),
        },
        { name: 'Social Security', values: years.map(y => y.socialSecurity) },
        {
          name: 'Portfolio withdrawals',
          values: years.map(y => y.withdrawals.total),
        },
        { name: 'Other income', values: years.map(y => y.otherIncome) },
        { name: 'Taxes', values: years.map(y => y.taxes.total) },
      ],
    },
    accountsByAge: {
      title: 'Balance by account type (expected returns)',
      style: 'line',
      xLabel: 'Age',
      yLabel: 'Today’s dollars',
      x: ages,
      series: [
        { name: 'Taxable', values: years.map(y => y.endBalances.taxable) },
        {
          name: '401(k)/403(b)/457(b)',
          values: years.map(y => y.endBalances.employerPlan),
        },
        { name: 'IRA', values: years.map(y => y.endBalances.ira) },
        { name: 'Roth/HSA', values: years.map(y => y.endBalances.roth) },
        { name: 'NQDC', values: years.map(y => y.endBalances.nqdc) },
      ],
    },
  }
}

/**
 * Inputs that change this projection most and are missing or conflict,
 * plus fields it ignores. Deterministic, in a fixed order.
 */
export function projectionWarnings(
  portfolio: Portfolio,
  profile: UserProfile
): string[] {
  const warnings: string[] = []
  if (profile.marketAssumptions !== undefined) {
    const market = resolveMarketAssumptions(profile.marketAssumptions)
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`
    warnings.push(
      `market assumptions: stocks ${pct(market.nearTerm.equity)}, bonds ${pct(market.nearTerm.bond)} and inflation ${pct(market.nearTerm.inflation)} a year for the first ${market.years} years (${market.source}), then the long-run ${pct(market.longRun.equity)}, ${pct(market.longRun.bond)} and ${pct(market.longRun.inflation)}`
    )
  }
  for (const lump of profile.lumpSums ?? []) {
    // Same rule as stepYear: the sum lands in the year whose age is its whole age.
    const arrival = Math.floor(lump.age)
    if (
      arrival <= profile.currentAge ||
      arrival > planningAgeOf(profile) ||
      !Number.isInteger(arrival - profile.currentAge)
    ) {
      warnings.push(
        `lump sum "${lump.name}" is ignored: age ${lump.age}${arrival === lump.age ? '' : ` (counted as ${arrival})`} is outside the projection (${profile.currentAge + 1} to ${planningAgeOf(profile)})`
      )
    } else {
      warnings.push(
        `lump sum "${lump.name}": $${Math.round(lump.amount).toLocaleString('en-US')} after tax in today's dollars arrives at ${arrival} into taxable savings`
      )
    }
  }
  if (profile.socialSecurityCut !== undefined) {
    const cut = profile.socialSecurityCut
    const share = Math.min(
      0.5,
      Math.max(0, cut.share ?? SOCIAL_SECURITY_CUT_2026.share)
    )
    const startYear = cut.startYear ?? SOCIAL_SECURITY_CUT_2026.startYear
    warnings.push(
      `Social Security cut: every benefit is ${Math.round((1 - share) * 100)}% of scheduled from ${startYear}` +
        (cut.share === undefined && cut.startYear === undefined
          ? ` (${SOCIAL_SECURITY_CUT_2026.source})`
          : '')
    )
  }
  if (profile.nqdcPayout?.onSeparation === true) {
    warnings.push(
      `the NQDC payout starts when you leave the job (age ${profile.incomeGap !== undefined && profile.incomeGap.startAge < profile.targetRetirementAge ? profile.incomeGap.startAge : (profile.separationAge ?? profile.targetRetirementAge)}), paid over ${Math.max(1, profile.nqdcPayout.years)} years`
    )
  }
  const gap = profile.incomeGap
  if (gap !== undefined) {
    if (gap.startAge >= profile.targetRetirementAge) {
      warnings.push('incomeGap is ignored: it starts at or after retirement')
    } else {
      const ruleOf55 =
        gap.startAge >= 55
          ? 'leaving at 55 or older opens the old 401(k) under the Rule of 55'
          : 'leaving before 55 means 401(k) withdrawals before 59½ pay the 10% penalty'
      warnings.push(
        `income gap: the job ends at ${gap.startAge} with ${gap.months} months without pay; household spending and health insurance come from savings with no contributions, then savings of $${Math.round(gap.newAnnualContributions ?? profile.annualContributions ?? 0).toLocaleString('en-US')}/yr resume until ${profile.targetRetirementAge}. Salary in the gap years is not taxed in the model; ${ruleOf55}. Check whether leaving starts your NQDC payout`
      )
    }
  }
  const scenario = profile.survivor
  if (scenario !== undefined) {
    if (profile.spouse === undefined) {
      warnings.push('survivor is ignored: the profile has no spouse')
    } else {
      const who = scenario.deceased === 'self' ? 'you die' : 'your spouse dies'
      const share = Math.round(
        (scenario.spendingShare ?? SURVIVOR_SPENDING_SHARE) * 100
      )
      warnings.push(
        `survivor scenario: ${who} at your age ${scenario.deathAge}. From the next year the survivor files single, keeps the larger of their own Social Security and the survivor benefit (started ${scenario.survivorClaimAge !== undefined ? `at ${scenario.survivorClaimAge} or when first payable if later` : 'as soon as it is payable, or at 67 when their own benefit starts before 67'}, at 71.5% at 60 rising to 100% at 67, and kept at that rate), pays healthcare and IRMAA for one and spends ${share}% of the couple's spending beyond the mortgage payment. Accounts pass to the survivor unchanged, with no 10% penalty on a beneficiary's withdrawals; pension, other income and the NQDC payout are unchanged. ${scenario.deceased === 'self' && scenario.deathAge < profile.targetRetirementAge ? 'The death comes before retirement: pay and savings stop and spending starts the next year. ' : ''}${scenario.lifeInsurance === undefined ? 'No life insurance is counted' : `Life insurance of $${Math.round(scenario.lifeInsurance).toLocaleString('en-US')} (today's dollars) is paid tax-free the next year`}`
      )
    }
  }
  if (
    profile.withdrawalTaxRate !== undefined ||
    profile.federalTaxBracket !== undefined
  ) {
    warnings.push(
      'withdrawalTaxRate and federalTaxBracket are ignored here: tax comes from the federal brackets, stateTaxRate and the 10% early withdrawal penalty'
    )
  }
  if (profile.targetRetirementAge < MEDICARE_AGE) {
    if (profile.preMedicareHealthcare === undefined) {
      warnings.push(
        `no preMedicareHealthcare: health insurance from ${profile.targetRetirementAge} to 64 is not modelled unless spendingPhases include it`
      )
    } else {
      const overlap = (profile.spendingPhases ?? []).find(
        phase =>
          phase.startAge >= profile.targetRetirementAge &&
          phase.startAge < MEDICARE_AGE
      )
      if (overlap !== undefined) {
        warnings.push(
          `check that spendingPhases from ${overlap.startAge} do not also include health insurance (preMedicareHealthcare adds it)`
        )
      }
    }
  }
  if (
    startingBuckets(portfolio).balances.nqdc > 0 &&
    profile.nqdcPayout === undefined
  ) {
    warnings.push(
      `no nqdcPayout: the NQDC balance is paid as one lump sum at ${profile.targetRetirementAge}; set nqdcPayout { startAge, years } from the payout election`
    )
  }
  if (
    profile.spouse !== undefined &&
    profile.spouse.socialSecurityMonthly === undefined
  ) {
    warnings.push(
      "no spouse.socialSecurityMonthly: the spouse's Social Security is not counted"
    )
  }
  if (profile.stateTaxRate === undefined) {
    warnings.push('no stateTaxRate: state income tax is 0')
  }
  if (profile.targetRetirementAge > MEDICARE_AGE - IRMAA_LOOKBACK_YEARS) {
    warnings.push(
      `IRMAA is not modelled for Medicare years whose two-year lookback falls before retirement at ${profile.targetRetirementAge} (salary is not an input); after a work stoppage, form SSA-44 asks SSA to use the lower current income`
    )
  }
  const monthly = profile.mortgage?.monthlyPayment
  if (monthly !== undefined && monthly > 0) {
    const payment = Math.round(12 * monthly)
    const endAge = mortgagePaymentEndAge(profile, portfolio.asOfDate)
    const ends =
      endAge === undefined
        ? 'it never stops (no payoffDate or homeSale)'
        : `it stops at ${endAge}`
    warnings.push(
      `spending (annualExpenses and spendingPhases) is taken to include the mortgage payment of ${wholeDollars(payment)}/yr: it is held flat in dollars and ${ends}. Leave the mortgage out, or add the payment to spending, when spending excludes it`
    )
    const retirementSpending = baseExpensesAt(
      profile,
      profile.targetRetirementAge
    )
    if (retirementSpending < payment) {
      warnings.push(
        `spending at ${profile.targetRetirementAge} (${wholeDollars(retirementSpending)}) is below the mortgage payment (${wholeDollars(payment)}/yr), so it cannot include it`
      )
    }
  }
  return warnings
}

/** A whole-dollar amount with thousands separators, without locale data. */
function wholeDollars(amount: number): string {
  const digits = String(Math.round(Math.abs(amount)))
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${amount < 0 ? '-' : ''}$${grouped}`
}
