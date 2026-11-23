import type { FilingStatus } from '../tax-brackets'
import type { Account, AccountType, Portfolio } from '../types'
import { expectedWorkerFullRetirementAge } from './social-security'
import { ACA_DEFAULT_CONTRIBUTION_RATE, buildAcaRules } from './healthcare'
import type {
  HealthcareACAResidenceRegion,
  LifeEventCommitment,
  Scenario,
  SocialSecurityBenefitType,
} from './types'

export const PLAN_AS_OF_DATE = '2026-01-01'
const SOCIAL_SECURITY_BENEFIT_TYPES = new Set<SocialSecurityBenefitType>([
  'worker',
  'spouse',
  'divorced_spouse',
  'survivor',
])

export interface PlanIntakeValues {
  readonly currentAge: number
  readonly targetRetirementAge: number
  readonly durationYears: number
  readonly filingStatus: FilingStatus
  readonly acaHouseholdSize: number
  readonly acaResidenceRegion: HealthcareACAResidenceRegion
  readonly annualExpenses: number
  readonly essentialExpenses: number
  readonly cashBalance: number
  readonly brokerageBalance: number
  readonly traditionalBalance: number
  readonly rothBalance: number
  readonly annualWorkIncome: number
  readonly annualOutsideIncome: number
  /** Legacy claimed annual cash amount; preserved when no FRA amount is supplied. */
  readonly annualSocialSecurity: number
  /** New explicit worker/deceased-record amount payable at that record's FRA. */
  readonly annualSocialSecurityAtFullRetirementAge?: number
  readonly socialSecurityStartAge: number
  readonly socialSecurityBenefitType?: SocialSecurityBenefitType
  readonly socialSecurityWorkerClaimAge?: number
  readonly socialSecurityWorkerBirthYear?: number
  readonly divorcedSpouseEligibilityConfirmed?: boolean
  readonly socialSecurityFullRetirementAge?: number
  readonly socialSecurityClaimantFullRetirementAge?: number
  readonly annualHealthcare: number
  readonly reserveFloor: number
  readonly housingProceeds: number
  readonly housingEventAge: number
  readonly housingCommitment: LifeEventCommitment
}

const NON_NEGATIVE_FIELDS: readonly (keyof PlanIntakeValues)[] = [
  'annualExpenses',
  'essentialExpenses',
  'cashBalance',
  'brokerageBalance',
  'traditionalBalance',
  'rothBalance',
  'annualWorkIncome',
  'annualOutsideIncome',
  'annualSocialSecurity',
  'annualHealthcare',
  'reserveFloor',
  'housingProceeds',
]

export function validatePlanIntake(values: PlanIntakeValues): void {
  for (const field of NON_NEGATIVE_FIELDS) {
    const value = values[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${field} must be a finite non-negative number`)
    }
  }
  if (
    values.annualSocialSecurityAtFullRetirementAge !== undefined &&
    (!Number.isFinite(values.annualSocialSecurityAtFullRetirementAge) ||
      values.annualSocialSecurityAtFullRetirementAge < 0)
  ) {
    throw new Error(
      'annualSocialSecurityAtFullRetirementAge must be a finite non-negative number'
    )
  }
  if (!Number.isInteger(values.currentAge) || values.currentAge < 25) {
    throw new Error('currentAge must be an integer of at least 25')
  }
  if (
    !Number.isInteger(values.targetRetirementAge) ||
    values.targetRetirementAge <= values.currentAge
  ) {
    throw new Error('targetRetirementAge must be after currentAge')
  }
  if (
    !Number.isInteger(values.durationYears) ||
    values.durationYears < values.targetRetirementAge - values.currentAge
  ) {
    throw new Error('durationYears must include the target retirement year')
  }
  if (values.essentialExpenses > values.annualExpenses) {
    throw new Error('essentialExpenses cannot exceed annualExpenses')
  }
  if (
    !Number.isInteger(values.acaHouseholdSize) ||
    values.acaHouseholdSize <= 0
  ) {
    throw new Error('acaHouseholdSize must be a positive integer')
  }
  if (values.acaResidenceRegion !== 'contiguous_us') {
    throw new Error(
      `Unsupported ACA residence region: ${values.acaResidenceRegion}`
    )
  }
  const useModeledSocialSecurity =
    (values.annualSocialSecurityAtFullRetirementAge ?? 0) > 0
  const useLegacySocialSecurity =
    !useModeledSocialSecurity && values.annualSocialSecurity > 0
  if (
    (useModeledSocialSecurity || useLegacySocialSecurity) &&
    (!Number.isFinite(values.socialSecurityStartAge) ||
      values.socialSecurityStartAge < values.currentAge)
  ) {
    throw new Error(
      'socialSecurityStartAge must be an age at or after currentAge'
    )
  }
  if (useModeledSocialSecurity) {
    const fullRetirementAge = values.socialSecurityFullRetirementAge ?? 67
    if (
      !Number.isFinite(fullRetirementAge) ||
      fullRetirementAge < 65 ||
      fullRetirementAge > 67
    ) {
      throw new Error(
        'socialSecurityFullRetirementAge must be between 65 and 67'
      )
    }
    const socialSecurityBenefitType =
      values.socialSecurityBenefitType ?? 'worker'
    if (!SOCIAL_SECURITY_BENEFIT_TYPES.has(socialSecurityBenefitType)) {
      throw new Error(
        `Unsupported Social Security benefit type: ${socialSecurityBenefitType}`
      )
    }
    if (
      socialSecurityBenefitType === 'worker' &&
      (values.socialSecurityStartAge < 62 || values.socialSecurityStartAge > 70)
    ) {
      throw new Error('worker socialSecurityStartAge must be between 62 and 70')
    }
    if (
      socialSecurityBenefitType === 'worker' &&
      values.socialSecurityStartAge > fullRetirementAge &&
      (!Number.isInteger(values.socialSecurityWorkerBirthYear) ||
        values.socialSecurityWorkerBirthYear! < 1943)
    ) {
      throw new Error(
        'worker delayed credits require socialSecurityWorkerBirthYear 1943 or later'
      )
    }
    if (
      socialSecurityBenefitType === 'worker' &&
      values.socialSecurityWorkerBirthYear !== undefined
    ) {
      const expectedFullRetirementAge = expectedWorkerFullRetirementAge(
        values.socialSecurityWorkerBirthYear
      )
      if (
        expectedFullRetirementAge === undefined ||
        Math.abs(fullRetirementAge - expectedFullRetirementAge) > 1e-6
      ) {
        throw new Error(
          `worker fullRetirementAge must match the birth-year ruleset (${expectedFullRetirementAge ?? 'unsupported'})`
        )
      }
    }
    if (
      (socialSecurityBenefitType === 'spouse' ||
        socialSecurityBenefitType === 'divorced_spouse') &&
      values.socialSecurityStartAge < 62
    ) {
      throw new Error(
        `${socialSecurityBenefitType} socialSecurityStartAge must be at least 62`
      )
    }
    if (
      socialSecurityBenefitType === 'survivor' &&
      values.socialSecurityStartAge < 60
    ) {
      throw new Error('survivor socialSecurityStartAge must be at least 60')
    }
    if (
      socialSecurityBenefitType === 'spouse' &&
      (!Number.isFinite(values.socialSecurityWorkerClaimAge) ||
        values.socialSecurityWorkerClaimAge! < 62 ||
        values.socialSecurityWorkerClaimAge! > 70)
    ) {
      throw new Error(
        `${socialSecurityBenefitType} socialSecurityWorkerClaimAge must be between 62 and 70`
      )
    }
    if (
      socialSecurityBenefitType === 'divorced_spouse' &&
      values.divorcedSpouseEligibilityConfirmed !== true
    ) {
      throw new Error(
        'divorced_spouse eligibility must be explicitly confirmed'
      )
    }
    if (socialSecurityBenefitType !== 'worker') {
      const claimantFullRetirementAge =
        values.socialSecurityClaimantFullRetirementAge
      if (
        typeof claimantFullRetirementAge !== 'number' ||
        !Number.isFinite(claimantFullRetirementAge) ||
        claimantFullRetirementAge < 65 ||
        claimantFullRetirementAge > 67
      ) {
        throw new Error(
          `${socialSecurityBenefitType} claimant full retirement age must be between 65 and 67`
        )
      }
    }
  }
  if (
    values.housingProceeds > 0 &&
    (!Number.isInteger(values.housingEventAge) ||
      values.housingEventAge <= values.currentAge ||
      values.housingEventAge > values.currentAge + values.durationYears)
  ) {
    throw new Error('housingEventAge must fall inside the projection horizon')
  }
}

/** The four intake balances a saved positions snapshot supplies. */
export type PlanIntakeBalances = Pick<
  PlanIntakeValues,
  'cashBalance' | 'brokerageBalance' | 'traditionalBalance' | 'rothBalance'
>

type BalanceBucket = 'taxable' | 'traditionalBalance' | 'rothBalance'

/**
 * Tax treatment of each portfolio account type. Taxable (brokerage) money
 * splits into the cash reserve and the brokerage bucket; money inside a
 * tax-advantaged wrapper stays in that wrapper's bucket whatever it holds.
 * An HSA is modelled as tax-deferred: non-medical withdrawals are ordinary
 * income, so the plan never treats it as tax-free.
 */
const ACCOUNT_BUCKET: Readonly<Record<AccountType, BalanceBucket>> = {
  brokerage: 'taxable',
  traditional_ira: 'traditionalBalance',
  rollover_ira: 'traditionalBalance',
  '401k': 'traditionalBalance',
  '403b': 'traditionalBalance',
  '457b': 'traditionalBalance',
  nqdc: 'traditionalBalance',
  hsa: 'traditionalBalance',
  roth_ira: 'rothBalance',
  roth_401k: 'rothBalance',
}

function finiteAmount(account: Account, label: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `snapshot account ${account.id} ${label} must be a finite number`
    )
  }
  return value
}

/** Cash, CDs and cash-like holdings in an account, then everything else. */
function accountParts(account: Account): { cash: number; invested: number } {
  let cash = finiteAmount(account, 'cashBalance', account.cashBalance)
  let invested = 0
  for (const cd of account.cds) {
    cash += finiteAmount(account, `CD ${cd.id} principal`, cd.principal)
  }
  for (const holding of account.holdings) {
    const value = finiteAmount(
      account,
      `holding ${holding.id} currentValue`,
      holding.currentValue
    )
    if (
      holding.assetClass === 'cash' ||
      holding.assetClass === 'money_market' ||
      holding.assetClass === 'cd'
    ) {
      cash += value
    } else {
      invested += value
    }
  }
  return { cash, invested }
}

/**
 * Maps a saved positions snapshot to the plan intake balances, so a plan
 * built after a new import uses the newest snapshot rather than balances
 * typed in earlier. The four balances sum to the snapshot's total value.
 */
export function planBalancesFromPortfolio(
  portfolio: Portfolio
): PlanIntakeBalances {
  const balances = {
    cashBalance: 0,
    brokerageBalance: 0,
    traditionalBalance: 0,
    rothBalance: 0,
  }
  for (const account of portfolio.accounts) {
    const bucket: BalanceBucket | undefined = Object.hasOwn(
      ACCOUNT_BUCKET,
      account.accountType
    )
      ? ACCOUNT_BUCKET[account.accountType]
      : undefined
    if (bucket === undefined) {
      throw new Error(
        `snapshot account ${account.id} has unsupported account type ${String(account.accountType)}`
      )
    }
    const { cash, invested } = accountParts(account)
    if (bucket === 'taxable') {
      balances.cashBalance += cash
      balances.brokerageBalance += invested
    } else {
      balances[bucket] += cash + invested
    }
  }
  return balances
}

/**
 * The intake values with the four balances taken from the snapshot; every
 * other field is kept. Throws the intake validation error when the snapshot
 * gives a bucket the plan cannot model (for example a net negative cash
 * reserve from a margin debit).
 */
export function withSnapshotBalances(
  values: PlanIntakeValues,
  portfolio: Portfolio
): PlanIntakeValues {
  const updated: PlanIntakeValues = {
    ...values,
    ...planBalancesFromPortfolio(portfolio),
  }
  validatePlanIntake(updated)
  return updated
}

function asOfYear(): number {
  return Number(PLAN_AS_OF_DATE.slice(0, 4))
}

function monthAtAge(age: number, currentAge: number): string {
  const year = asOfYear() + Math.max(1, age - currentAge)
  return `${year}-01`
}

export function buildScenario(values: PlanIntakeValues): Scenario {
  validatePlanIntake(values)

  const livingExpenses = values.annualExpenses - values.essentialExpenses
  const accounts = [
    {
      id: 'cash-reserve',
      name: 'Cash reserve',
      type: 'cash' as const,
      currency: 'USD',
      balance: values.cashBalance,
      annualReturnRate: 0.02,
    },
    {
      id: 'brokerage',
      name: 'Taxable brokerage',
      type: 'brokerage' as const,
      currency: 'USD',
      balance: values.brokerageBalance,
      annualReturnRate: 0.05,
      capitalGainsRatio: 0.5,
    },
    {
      id: 'traditional',
      name: 'Traditional retirement account',
      type: 'traditional_ira' as const,
      currency: 'USD',
      balance: values.traditionalBalance,
      annualReturnRate: 0.05,
    },
    {
      id: 'roth',
      name: 'Roth account',
      type: 'roth_ira' as const,
      currency: 'USD',
      balance: values.rothBalance,
      annualReturnRate: 0.05,
    },
  ]

  const incomeStreams = [
    {
      id: 'work-income',
      name: 'Work income',
      owner: 'primary' as const,
      currency: 'USD',
      gross: values.annualWorkIncome,
      start: { age: values.currentAge },
      end: { age: values.targetRetirementAge - 1 },
      annualGrowthRate: 0.02,
      taxCategory: 'ordinary' as const,
      reliability: 1,
      includedInBase: true,
    },
    ...((values.annualSocialSecurityAtFullRetirementAge ?? 0) <= 0 &&
    values.annualSocialSecurity > 0
      ? [
          {
            id: 'social-security',
            name: 'Social Security',
            owner: 'household' as const,
            currency: 'USD',
            gross: values.annualSocialSecurity,
            start: { age: values.socialSecurityStartAge },
            annualGrowthRate: 0.02,
            taxCategory: 'ordinary' as const,
            reliability: 0.95,
            includedInBase: true,
          },
        ]
      : []),
    {
      id: 'outside-income',
      name: 'Outside income',
      owner: 'primary' as const,
      currency: 'USD',
      gross: values.annualOutsideIncome,
      start: { age: values.targetRetirementAge },
      annualGrowthRate: 0.02,
      taxCategory: 'ordinary' as const,
      reliability: 0.8,
      includedInBase: true,
    },
  ]

  const spendingStreams = [
    {
      id: 'essential-spending',
      category: 'Essential spending',
      owner: 'household' as const,
      currency: 'USD',
      amount: values.essentialExpenses,
      start: { age: values.targetRetirementAge },
      annualInflationRate: 0.03,
      essential: true,
      reduciblePercent: 0,
    },
    {
      id: 'discretionary-spending',
      category: 'Discretionary spending',
      owner: 'household' as const,
      currency: 'USD',
      amount: livingExpenses,
      start: { age: values.targetRetirementAge },
      annualInflationRate: 0.03,
      essential: false,
      reduciblePercent: 0.5,
    },
    {
      id: 'healthcare-spending',
      category: 'Healthcare',
      owner: 'household' as const,
      currency: 'USD',
      amount: 0,
      start: { age: values.targetRetirementAge },
      annualInflationRate: 0.05,
      essential: true,
      reduciblePercent: 0,
    },
  ]

  const lifeEvents = [
    {
      id: 'work-exit',
      kind: 'work_exit' as const,
      name: 'Target work exit',
      date: { age: values.targetRetirementAge },
      commitment: 'committed' as const,
    },
    ...(values.housingProceeds > 0
      ? [
          {
            id: 'housing-transaction',
            kind: 'housing_transaction' as const,
            name: 'Housing transaction',
            date: { age: values.housingEventAge },
            amount: values.housingProceeds,
            currency: 'USD',
            commitment: values.housingCommitment,
          },
        ]
      : []),
  ]

  const coverageStartMonth = monthAtAge(
    values.targetRetirementAge,
    values.currentAge
  )
  const medicareStartMonth = monthAtAge(
    Math.max(65, values.targetRetirementAge),
    values.currentAge
  )
  const coverageEndMonth = `${asOfYear() + values.durationYears + 1}-01`
  const monthlyHealthcare = values.annualHealthcare / 12
  const medicareStartsWithinHorizon = medicareStartMonth < coverageEndMonth
  const healthcarePhases =
    values.targetRetirementAge < 65
      ? [
          {
            id: 'retirement-healthcare-aca',
            kind: 'aca' as const,
            startMonth: coverageStartMonth,
            endMonthExclusive: medicareStartsWithinHorizon
              ? medicareStartMonth
              : coverageEndMonth,
            currency: 'USD',
            monthlyPremium: monthlyHealthcare,
            monthlyOutOfPocket: 0,
          },
          ...(medicareStartsWithinHorizon
            ? [
                {
                  id: 'retirement-healthcare-medicare',
                  kind: 'medicare' as const,
                  startMonth: medicareStartMonth,
                  endMonthExclusive: coverageEndMonth,
                  currency: 'USD',
                  monthlyPremium: monthlyHealthcare,
                  monthlyOutOfPocket: 0,
                },
              ]
            : []),
        ]
      : [
          {
            id: 'retirement-healthcare-medicare',
            kind: 'medicare' as const,
            startMonth: coverageStartMonth,
            endMonthExclusive: coverageEndMonth,
            currency: 'USD',
            monthlyPremium: monthlyHealthcare,
            monthlyOutOfPocket: 0,
          },
        ]

  return {
    id: 'retirement-plan',
    profile: {
      currentAge: values.currentAge,
      targetRetirementAge: values.targetRetirementAge,
      filingStatus: values.filingStatus,
    },
    assumptions: {
      durationYears: values.durationYears,
      inflationRate: 0.03,
      asOfDate: PLAN_AS_OF_DATE,
      baseCurrency: 'USD',
    },
    fxRates: [],
    accounts,
    incomeStreams,
    socialSecurityBenefits:
      (values.annualSocialSecurityAtFullRetirementAge ?? 0) > 0
        ? [
            {
              id: 'social-security',
              name: 'Social Security',
              benefitType: values.socialSecurityBenefitType ?? 'worker',
              owner: 'household' as const,
              currency: 'USD',
              primaryInsuranceAmount:
                values.annualSocialSecurityAtFullRetirementAge! / 12,
              fullRetirementAge: values.socialSecurityFullRetirementAge ?? 67,
              claimantFullRetirementAge:
                values.socialSecurityClaimantFullRetirementAge,
              claimAge: values.socialSecurityStartAge,
              associatedWorkerClaimAge: values.socialSecurityWorkerClaimAge,
              workerBirthYear: values.socialSecurityWorkerBirthYear,
              divorcedSpouseEligibilityConfirmed:
                values.divorcedSpouseEligibilityConfirmed,
              annualCOLARate: 0.02,
              reliability: 0.95,
              includedInBase: true,
            },
          ]
        : [],
    spendingStreams,
    lifeEvents,
    healthcare: {
      annualInflationRate: 0.05,
      aca: {
        householdSize: values.acaHouseholdSize,
        residenceRegion: values.acaResidenceRegion,
        rulesByTaxYear: buildAcaRules(
          asOfYear() + 1,
          asOfYear() + values.durationYears
        ),
        benchmarkAnnualPremium: values.annualHealthcare,
        contributionRate: ACA_DEFAULT_CONTRIBUTION_RATE,
      },
      phases: healthcarePhases,
    },
  }
}
