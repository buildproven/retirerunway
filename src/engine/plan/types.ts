import type { FilingStatus } from '../tax-brackets'

export type PlanProjectionMode = 'nominal' | 'real'

/** A deterministic year range used to override a plan's default annual rate. */
export interface AnnualRateOverride {
  readonly startYear: number
  readonly endYear: number
  readonly rate: number
}

/** A deterministic year range used to multiply a stream's cash flow. */
export interface AnnualMultiplierOverride {
  readonly startYear: number
  readonly endYear: number
  readonly multiplier: number
}

export type PlanAccountType =
  | 'cash'
  | 'brokerage'
  | 'traditional_ira'
  | 'rollover_ira'
  | '401k'
  | '403b'
  | '457b'
  | 'roth_ira'
  | 'roth_401k'
  | 'nqdc'
  | 'home_equity'

export type PlanTaxCategory = 'ordinary' | 'capital_gains' | 'tax_free'

export type PlanOwner = 'primary' | 'spouse' | 'household'

export type SocialSecurityBenefitType =
  | 'worker'
  | 'spouse'
  | 'divorced_spouse'
  | 'survivor'

export type PlanBoundary =
  | Readonly<{ age: number }>
  | Readonly<{ date: string }>

export type LifeEventKind =
  | 'work_exit'
  | 'housing_transaction'
  | 'divorce'
  | 'relocation'
  | 'college_end'

export type LifeEventCommitment = 'committed' | 'available' | 'aspirational'

export interface FXRate {
  readonly from: string
  readonly to: string
  readonly effectiveDate: string
  /** Units of `to` per one unit of `from`. */
  readonly rate: number
}

export interface PlanProfile {
  readonly currentAge: number
  readonly targetRetirementAge: number
  readonly filingStatus: FilingStatus
  readonly stateTaxRate?: number
}

export interface PlanAccount {
  readonly id: string
  readonly name: string
  readonly type: PlanAccountType
  readonly currency: string
  readonly balance: number
  readonly annualReturnRate: number
  /** Fraction of taxable withdrawals treated as long-term gains. */
  readonly capitalGainsRatio?: number
  /** Employer plan separation age used by the Rule of 55. */
  readonly separationAge?: number
  /** Explicit access age for NQDC or other scheduled assets. */
  readonly accessibleAge?: number
  /** Optional year-specific return schedule; `annualReturnRate` remains the default. */
  readonly returnSchedule?: readonly AnnualRateOverride[]
}

export interface IncomeStream {
  readonly id: string
  readonly name: string
  readonly owner: PlanOwner
  readonly currency: string
  readonly gross: number
  readonly start: PlanBoundary
  readonly end?: PlanBoundary
  readonly annualGrowthRate: number
  readonly taxCategory: PlanTaxCategory
  /** Optional taxable portion for income categories with partial taxation. */
  readonly taxableFraction?: number
  readonly reliability: number
  readonly includedInBase: boolean
  /** Optional year-specific growth schedule; `annualGrowthRate` remains the default. */
  readonly annualGrowthRateSchedule?: readonly AnnualRateOverride[]
  /** Optional deterministic cash-flow multiplier schedule. */
  readonly amountMultiplierSchedule?: readonly AnnualMultiplierOverride[]
}

/**
 * A planning assumption for one Social Security record.
 *
 * `primaryInsuranceAmount` is the monthly amount payable at the worker's
 * full retirement age for a worker record. For spouse and divorced-spouse
 * benefits it is the worker's PIA. Survivor benefits use
 * `deceasedWorkerBenefitAmount` when the worker's actual benefit at death is
 * known; otherwise they use the record PIA.
 */
export interface SocialSecurityBenefit {
  readonly id: string
  readonly name: string
  readonly benefitType: SocialSecurityBenefitType
  readonly owner: PlanOwner
  readonly currency: string
  readonly primaryInsuranceAmount: number
  readonly deceasedWorkerBenefitAmount?: number
  readonly fullRetirementAge: number
  /** Required for spouse, divorced-spouse, and survivor benefits. */
  readonly claimantFullRetirementAge?: number
  readonly claimAge: number
  /** Required for spouse benefits: the associated worker's entitlement age. */
  readonly associatedWorkerClaimAge?: number
  /** Required for delayed worker credits; the 8% rule starts with 1943 cohorts. */
  readonly workerBirthYear?: number
  /** Required confirmation for divorced-spouse eligibility assumptions. */
  readonly divorcedSpouseEligibilityConfirmed?: boolean
  /** User assumption. The engine does not fetch or infer future COLAs. */
  readonly annualCOLARate: number
  /** Defaults to a conservative fixed 85% planning assumption, not a tax calculation. */
  readonly taxableFraction?: number
  readonly reliability: number
  readonly includedInBase: boolean
}

export interface SpendingStream {
  readonly id: string
  readonly category: string
  readonly owner: PlanOwner
  readonly currency: string
  readonly amount: number
  readonly start: PlanBoundary
  readonly end?: PlanBoundary
  readonly annualInflationRate: number
  readonly essential: boolean
  readonly reduciblePercent: number
  /** Optional year-specific inflation schedule; `annualInflationRate` remains the default. */
  readonly annualInflationRateSchedule?: readonly AnnualRateOverride[]
  /** Optional deterministic cash-flow multiplier schedule. */
  readonly amountMultiplierSchedule?: readonly AnnualMultiplierOverride[]
}

export interface LifeEvent {
  readonly id: string
  readonly kind: LifeEventKind
  readonly name: string
  readonly date: PlanBoundary
  /** For a housing transaction, this is the positive net proceeds amount. */
  readonly amount?: number
  readonly currency?: string
  readonly commitment: LifeEventCommitment
}

export interface PlanAssumptions {
  readonly durationYears: number
  readonly inflationRate: number
  readonly asOfDate: string
  readonly baseCurrency: string
  /** Optional year-specific general inflation schedule; `inflationRate` remains the default. */
  readonly inflationRateSchedule?: readonly AnnualRateOverride[]
}

export type HealthcarePhaseKind = 'employer' | 'cobra' | 'aca' | 'medicare'

export type MedicareComponentKind =
  | 'part_b'
  | 'part_d'
  | 'supplemental'
  | 'dental'
  | 'vision'

export interface MedicareComponent {
  readonly id: string
  readonly kind: MedicareComponentKind
  readonly monthlyPremium: number
  readonly monthlyOutOfPocket?: number
  readonly currency?: string
  /** Overrides the plan rate for this component; it never compounds with it. */
  readonly annualInflationRate?: number
}

interface HealthcarePhaseBase {
  readonly id: string
  readonly startMonth: string
  readonly endMonthExclusive: string
  readonly currency: string
}

type AggregateHealthcarePhase = HealthcarePhaseBase & {
  readonly kind: HealthcarePhaseKind
  readonly monthlyPremium: number
  readonly monthlyOutOfPocket: number
  readonly medicareComponents?: never
}

type MedicareComponentPhase = HealthcarePhaseBase & {
  readonly kind: 'medicare'
  readonly medicareComponents: readonly MedicareComponent[]
  readonly monthlyPremium?: never
  readonly monthlyOutOfPocket?: never
}

export type HealthcarePhase = AggregateHealthcarePhase | MedicareComponentPhase

export type HealthcareACAResidenceRegion = 'contiguous_us' | 'alaska' | 'hawaii'

export type HealthcareACARuleStatus = 'official' | 'planning_estimate'

export type HealthcareACAEligibilityStatus =
  | 'eligible'
  | 'below_minimum_fpl'
  | 'above_maximum_fpl'

export interface HealthcareACAFplRule {
  readonly id: string
  readonly taxYear: number
  readonly fplYear: number
  readonly effectiveDate: string
  readonly residenceRegion: HealthcareACAResidenceRegion
  readonly annualBaseFpl: number
  readonly annualAdditionalPersonFpl: number
  readonly minimumFplPercent: number
  readonly maximumFplPercent: number
  readonly status: HealthcareACARuleStatus
  readonly source: string
}

export interface HealthcareACAConfig {
  readonly householdSize: number
  readonly residenceRegion: HealthcareACAResidenceRegion
  readonly rulesByTaxYear: Readonly<Record<string, HealthcareACAFplRule>>
  readonly benchmarkAnnualPremium: number
  readonly contributionRate: number
}

export interface HealthcareShock {
  readonly id: string
  readonly month: string
  readonly amount: number
  /** Shocks must currently be entered in the scenario base currency. */
  readonly currency: string
}

export interface HealthcarePlan {
  readonly annualInflationRate: number
  readonly phases: readonly HealthcarePhase[]
  readonly aca?: HealthcareACAConfig
  /** Keys are calendar years (for example, `2028`). */
  readonly additionalMagiByYear?: Readonly<Record<string, number>>
  readonly shocks?: readonly HealthcareShock[]
}

export interface Scenario {
  readonly id: string
  readonly profile: PlanProfile
  readonly assumptions: PlanAssumptions
  readonly fxRates: readonly FXRate[]
  readonly accounts: readonly PlanAccount[]
  readonly incomeStreams: readonly IncomeStream[]
  readonly socialSecurityBenefits?: readonly SocialSecurityBenefit[]
  readonly spendingStreams: readonly SpendingStream[]
  readonly lifeEvents: readonly LifeEvent[]
  readonly healthcare?: HealthcarePlan
}

export interface ProjectionAccountRow {
  readonly startBalance: number
  readonly growth: number
  readonly withdrawal: number
  readonly endBalance: number
  readonly accessible: boolean
}

export interface ProjectionRow {
  readonly year: number
  readonly date: string
  readonly age: number
  /** Committed events landing in this annual projection bucket. */
  readonly lifeEvents?: readonly LifeEvent[]
  readonly incomeBySource: Readonly<Record<string, number>>
  readonly spendingByCategory: Readonly<Record<string, number>>
  readonly income: number
  readonly spending: number
  readonly essentialSpending: number
  readonly taxes: number
  readonly withdrawalsByAccount: Readonly<Record<string, number>>
  readonly accounts: Readonly<Record<string, ProjectionAccountRow>>
  readonly accessibleBalance: number
  readonly restrictedBalance: number
  readonly fundingGap: number
  readonly healthcare?: HealthcareProjectionRow
}

export interface HealthcarePhaseProjection {
  readonly kind: HealthcarePhaseKind
  readonly premium: number
  readonly outOfPocket: number
  readonly subsidy: number
  readonly shocks: number
}

export interface HealthcareProjectionRow {
  readonly total: number
  readonly premium: number
  readonly outOfPocket: number
  readonly subsidy: number
  readonly shocks: number
  readonly magi?: number
  readonly acaByTaxYear?: Readonly<Record<string, HealthcareACAProjection>>
  readonly byPhase: Readonly<Record<string, HealthcarePhaseProjection>>
}

export interface HealthcareACAProjection {
  readonly taxYear: number
  readonly ruleId: string
  readonly ruleStatus: HealthcareACARuleStatus
  readonly ruleEffectiveDate: string
  readonly ruleSource: string
  readonly annualFpl: number
  readonly minimumThreshold: number
  readonly cliffThreshold: number
  readonly magi: number
  readonly fplPercent: number
  readonly amountBelowMinimum: number
  readonly amountOverCliff: number
  readonly eligibilityStatus: HealthcareACAEligibilityStatus
  readonly eligibleForPremiumTaxCredit: boolean
  readonly subsidyAtCliff: number
  readonly costOfCrossingCliff: number
}

export interface PlanProjection {
  readonly scenarioId: string
  readonly mode: PlanProjectionMode
  readonly rows: readonly ProjectionRow[]
}

export interface PlanProjectionPair {
  readonly nominal: PlanProjection
  readonly real: PlanProjection
}
