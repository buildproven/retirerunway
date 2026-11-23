import type {
  IncomeStream,
  Scenario,
  SocialSecurityBenefit,
  SocialSecurityBenefitType,
} from './types'

const WORKER_MINIMUM_CLAIM_AGE = 62
const SPOUSE_MINIMUM_CLAIM_AGE = 62
const SURVIVOR_MINIMUM_CLAIM_AGE = 60
const MAX_WORKER_CLAIM_AGE = 70
export const SOCIAL_SECURITY_RULES_AS_OF = '2025-12-31'
export const SOCIAL_SECURITY_RULES_SOURCE =
  'https://www.ssa.gov/policy/about/oasdi-reference.html'
export const SOCIAL_SECURITY_MAX_TAXABLE_FRACTION = 0.85
const BENEFIT_TYPES = new Set<SocialSecurityBenefitType>([
  'worker',
  'spouse',
  'divorced_spouse',
  'survivor',
])

export function expectedWorkerFullRetirementAge(
  birthYear: number
): number | undefined {
  if (birthYear < 1943) return undefined
  if (birthYear <= 1954) return 66
  if (birthYear === 1955) return 66 + 2 / 12
  if (birthYear === 1956) return 66 + 4 / 12
  if (birthYear === 1957) return 66 + 6 / 12
  if (birthYear === 1958) return 66 + 8 / 12
  if (birthYear === 1959) return 66 + 10 / 12
  return 67
}

export interface SocialSecurityBenefitResult {
  readonly benefitType: SocialSecurityBenefitType
  readonly baseMonthlyBenefit: number
  readonly adjustmentFactor: number
  readonly monthlyBenefit: number
  readonly annualBenefit: number
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function monthsBetween(startAge: number, endAge: number): number {
  return Math.max(0, Math.round((endAge - startAge) * 12))
}

function workerEarlyFactor(
  claimAge: number,
  fullRetirementAge: number
): number {
  const monthsEarly = monthsBetween(claimAge, fullRetirementAge)
  const first36 = Math.min(monthsEarly, 36)
  const remaining = Math.max(0, monthsEarly - 36)
  return 1 - first36 * (5 / 9 / 100) - remaining * (5 / 12 / 100)
}

function spouseEarlyFactor(
  claimAge: number,
  fullRetirementAge: number
): number {
  const monthsEarly = monthsBetween(claimAge, fullRetirementAge)
  const first36 = Math.min(monthsEarly, 36)
  const remaining = Math.max(0, monthsEarly - 36)
  return 1 - first36 * (25 / 36 / 100) - remaining * (5 / 12 / 100)
}

function survivorEarlyFactor(
  claimAge: number,
  fullRetirementAge: number
): number {
  // SSA keeps the survivor-benefit minimum at 71.5% at age 60. For a
  // survivor FRA after 65, the monthly reduction is adjusted so that the
  // same 28.5% total reduction is spread across the longer period.
  const monthsFromAge60ToFRA = monthsBetween(60, fullRetirementAge)
  const monthsEarly = Math.min(
    monthsFromAge60ToFRA,
    monthsBetween(claimAge, fullRetirementAge)
  )
  return 1 - (monthsEarly / monthsFromAge60ToFRA) * 0.285
}

function workerAdjustmentFactor(
  claimAge: number,
  fullRetirementAge: number
): number {
  if (claimAge < fullRetirementAge) {
    return workerEarlyFactor(claimAge, fullRetirementAge)
  }
  const monthsDelayed = monthsBetween(
    fullRetirementAge,
    Math.min(claimAge, MAX_WORKER_CLAIM_AGE)
  )
  // The current planning rule is 8% per year, or 2/3 of 1% per month, for
  // workers born in 1943 or later. Birth year is not an intake field, so the
  // assumption is explicit and can be revised with a versioned ruleset.
  return 1 + monthsDelayed * (2 / 3 / 100)
}

function validateCommon(benefit: SocialSecurityBenefit): void {
  if (!BENEFIT_TYPES.has(benefit.benefitType)) {
    throw new Error(
      `Unsupported Social Security benefit type: ${benefit.benefitType}`
    )
  }
  if (!benefit.id.trim()) throw new Error('Social Security benefit needs an id')
  if (!benefit.name.trim())
    throw new Error('Social Security benefit needs a name')
  if (
    !Number.isFinite(benefit.primaryInsuranceAmount) ||
    benefit.primaryInsuranceAmount <= 0
  ) {
    throw new Error('primaryInsuranceAmount must be a finite positive number')
  }
  if (
    !Number.isFinite(benefit.fullRetirementAge) ||
    benefit.fullRetirementAge < 65 ||
    benefit.fullRetirementAge > 67
  ) {
    throw new Error('fullRetirementAge must be between 65 and 67')
  }
  if (!Number.isFinite(benefit.claimAge)) {
    throw new Error('claimAge must be a finite number')
  }
  if (
    benefit.benefitType === 'spouse' &&
    (!Number.isFinite(benefit.associatedWorkerClaimAge) ||
      benefit.associatedWorkerClaimAge! < WORKER_MINIMUM_CLAIM_AGE ||
      benefit.associatedWorkerClaimAge! > MAX_WORKER_CLAIM_AGE)
  ) {
    throw new Error(
      `${benefit.benefitType} associatedWorkerClaimAge must be between 62 and 70`
    )
  }
  if (
    benefit.benefitType === 'worker' &&
    benefit.claimAge > benefit.fullRetirementAge &&
    (!Number.isInteger(benefit.workerBirthYear) ||
      benefit.workerBirthYear! < 1943)
  ) {
    throw new Error(
      'worker delayed credits require workerBirthYear 1943 or later'
    )
  }
  if (
    benefit.benefitType === 'worker' &&
    benefit.workerBirthYear !== undefined
  ) {
    const expectedFullRetirementAge = expectedWorkerFullRetirementAge(
      benefit.workerBirthYear
    )
    if (
      expectedFullRetirementAge === undefined ||
      Math.abs(benefit.fullRetirementAge - expectedFullRetirementAge) > 1e-6
    ) {
      throw new Error(
        `worker fullRetirementAge must match the birth-year ruleset (${expectedFullRetirementAge ?? 'unsupported'})`
      )
    }
  }
  if (
    benefit.benefitType === 'divorced_spouse' &&
    benefit.divorcedSpouseEligibilityConfirmed !== true
  ) {
    throw new Error('divorced_spouse eligibility must be explicitly confirmed')
  }
  if (
    benefit.benefitType !== 'worker' &&
    (!Number.isFinite(benefit.claimantFullRetirementAge) ||
      benefit.claimantFullRetirementAge! < 65 ||
      benefit.claimantFullRetirementAge! > 67)
  ) {
    throw new Error(
      `${benefit.benefitType} claimantFullRetirementAge must be between 65 and 67`
    )
  }
  if (!Number.isFinite(benefit.annualCOLARate) || benefit.annualCOLARate < -1) {
    throw new Error('annualCOLARate must be a finite rate greater than -100%')
  }
  if (
    benefit.taxableFraction !== undefined &&
    (!Number.isFinite(benefit.taxableFraction) ||
      benefit.taxableFraction < 0 ||
      benefit.taxableFraction > 1)
  ) {
    throw new Error('taxableFraction must be between 0 and 1')
  }
  if (
    !Number.isFinite(benefit.reliability) ||
    benefit.reliability < 0 ||
    benefit.reliability > 1
  ) {
    throw new Error('reliability must be between 0 and 1')
  }
}

export function validateSocialSecurityBenefit(
  benefit: SocialSecurityBenefit
): void {
  validateCommon(benefit)
  const minimumClaimAge =
    benefit.benefitType === 'survivor'
      ? SURVIVOR_MINIMUM_CLAIM_AGE
      : benefit.benefitType === 'worker'
        ? WORKER_MINIMUM_CLAIM_AGE
        : SPOUSE_MINIMUM_CLAIM_AGE
  if (benefit.claimAge < minimumClaimAge) {
    throw new Error(
      `${benefit.benefitType} claimAge must be at least ${minimumClaimAge}`
    )
  }
  if (
    benefit.benefitType === 'worker' &&
    benefit.claimAge > MAX_WORKER_CLAIM_AGE
  ) {
    throw new Error('worker claimAge cannot exceed 70')
  }
  if (
    benefit.deceasedWorkerBenefitAmount !== undefined &&
    (!Number.isFinite(benefit.deceasedWorkerBenefitAmount) ||
      benefit.deceasedWorkerBenefitAmount <= 0)
  ) {
    throw new Error(
      'deceasedWorkerBenefitAmount must be a finite positive number when provided'
    )
  }
}

export function calculateSocialSecurityBenefit(
  benefit: SocialSecurityBenefit
): SocialSecurityBenefitResult {
  validateSocialSecurityBenefit(benefit)
  const calculationClaimAge = incomeStartAge(benefit)
  const calculationFullRetirementAge =
    benefit.benefitType === 'worker'
      ? benefit.fullRetirementAge
      : benefit.claimantFullRetirementAge!
  const baseMonthlyBenefit =
    benefit.benefitType === 'spouse' ||
    benefit.benefitType === 'divorced_spouse'
      ? benefit.primaryInsuranceAmount * 0.5
      : benefit.benefitType === 'survivor'
        ? (benefit.deceasedWorkerBenefitAmount ??
          benefit.primaryInsuranceAmount)
        : benefit.primaryInsuranceAmount

  const adjustmentFactor =
    benefit.benefitType === 'worker'
      ? workerAdjustmentFactor(
          calculationClaimAge,
          calculationFullRetirementAge
        )
      : benefit.benefitType === 'spouse' ||
          benefit.benefitType === 'divorced_spouse'
        ? calculationClaimAge < calculationFullRetirementAge
          ? spouseEarlyFactor(calculationClaimAge, calculationFullRetirementAge)
          : 1
        : calculationClaimAge < calculationFullRetirementAge
          ? survivorEarlyFactor(
              calculationClaimAge,
              calculationFullRetirementAge
            )
          : 1

  const monthlyBenefit = roundMoney(baseMonthlyBenefit * adjustmentFactor)
  return {
    benefitType: benefit.benefitType,
    baseMonthlyBenefit: roundMoney(baseMonthlyBenefit),
    adjustmentFactor: roundMoney(adjustmentFactor),
    monthlyBenefit,
    annualBenefit: roundMoney(monthlyBenefit * 12),
  }
}

export function annualSocialSecurityBenefitAtAge(
  benefit: SocialSecurityBenefit,
  age: number
): number {
  validateSocialSecurityBenefit(benefit)
  const startAge = incomeStartAge(benefit)
  if (age < startAge) return 0
  const result = calculateSocialSecurityBenefit(benefit)
  return roundMoney(
    result.annualBenefit *
      Math.pow(1 + benefit.annualCOLARate, Math.max(0, age - startAge))
  )
}

function incomeStartAge(benefit: SocialSecurityBenefit): number {
  if (benefit.benefitType === 'spouse') {
    return Math.max(benefit.claimAge, benefit.associatedWorkerClaimAge ?? 0)
  }
  return benefit.claimAge
}

export function materializeSocialSecurityIncomeStreams(
  scenario: Scenario
): readonly IncomeStream[] {
  const benefits = scenario.socialSecurityBenefits ?? []
  const existingIds = new Set(scenario.incomeStreams.map(stream => stream.id))
  const benefitIds = new Set<string>()
  return benefits.map(benefit => {
    validateSocialSecurityBenefit(benefit)
    if (existingIds.has(benefit.id) || benefitIds.has(benefit.id)) {
      throw new Error(
        `Social Security benefit id ${benefit.id} collides with an income stream or another benefit`
      )
    }
    benefitIds.add(benefit.id)
    const result = calculateSocialSecurityBenefit(benefit)
    return {
      id: benefit.id,
      name: benefit.name,
      owner: benefit.owner,
      currency: benefit.currency,
      gross: result.annualBenefit,
      start: { age: incomeStartAge(benefit) },
      annualGrowthRate: benefit.annualCOLARate,
      taxCategory: 'ordinary' as const,
      taxableFraction:
        benefit.taxableFraction ?? SOCIAL_SECURITY_MAX_TAXABLE_FRACTION,
      reliability: benefit.reliability,
      includedInBase: benefit.includedInBase,
    }
  })
}
