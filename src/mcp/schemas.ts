// Strict input schemas for the plan MCP tools (REQ-MCP-1).
// The schemas check shape and types only. Value rules (age order,
// non-negative balances, supported regions) stay in the engine, so the
// engine remains the single source of truth for what a valid plan is.
import { SECTION_KEYS } from './plan-notes'
import * as z from 'zod'
import { FILING_STATUSES } from '../engine/tax-brackets'
import { ACCOUNT_TYPES } from '../engine/types'

// Zod 4 numbers reject NaN and Infinity, so every number here is finite.
const finite = z.number()
const owner = z.enum(['primary', 'spouse', 'household'])
const socialSecurityBenefitType = z.enum([
  'worker',
  'spouse',
  'divorced_spouse',
  'survivor',
])
const residenceRegion = z.enum(['contiguous_us', 'alaska', 'hawaii'])
const commitment = z.enum(['committed', 'available', 'aspirational'])

export const planIntakeSchema = z.strictObject({
  currentAge: finite,
  targetRetirementAge: finite,
  durationYears: finite,
  filingStatus: z.enum(FILING_STATUSES),
  acaHouseholdSize: finite,
  acaResidenceRegion: residenceRegion,
  annualExpenses: finite,
  essentialExpenses: finite,
  cashBalance: finite,
  brokerageBalance: finite,
  traditionalBalance: finite,
  rothBalance: finite,
  annualWorkIncome: finite,
  annualOutsideIncome: finite,
  annualSocialSecurity: finite,
  annualSocialSecurityAtFullRetirementAge: finite.optional(),
  socialSecurityStartAge: finite,
  socialSecurityBenefitType: socialSecurityBenefitType.optional(),
  socialSecurityWorkerClaimAge: finite.optional(),
  socialSecurityWorkerBirthYear: finite.optional(),
  divorcedSpouseEligibilityConfirmed: z.boolean().optional(),
  socialSecurityFullRetirementAge: finite.optional(),
  socialSecurityClaimantFullRetirementAge: finite.optional(),
  annualHealthcare: finite,
  reserveFloor: finite,
  housingProceeds: finite,
  housingEventAge: finite,
  housingCommitment: commitment,
})

const rateOverride = z.strictObject({
  startYear: finite,
  endYear: finite,
  rate: finite,
})

const multiplierOverride = z.strictObject({
  startYear: finite,
  endYear: finite,
  multiplier: finite,
})

const boundary = z.union([
  z.strictObject({ age: finite }),
  z.strictObject({ date: z.string() }),
])

const account = z.strictObject({
  id: z.string(),
  name: z.string(),
  type: z.enum([
    'cash',
    'brokerage',
    'traditional_ira',
    'rollover_ira',
    '401k',
    '403b',
    '457b',
    'roth_ira',
    'roth_401k',
    'nqdc',
    'home_equity',
  ]),
  currency: z.string(),
  balance: finite,
  annualReturnRate: finite,
  capitalGainsRatio: finite.optional(),
  separationAge: finite.optional(),
  accessibleAge: finite.optional(),
  returnSchedule: z.array(rateOverride).optional(),
})

const incomeStream = z.strictObject({
  id: z.string(),
  name: z.string(),
  owner,
  currency: z.string(),
  gross: finite,
  start: boundary,
  end: boundary.optional(),
  annualGrowthRate: finite,
  taxCategory: z.enum(['ordinary', 'capital_gains', 'tax_free']),
  taxableFraction: finite.optional(),
  reliability: finite,
  includedInBase: z.boolean(),
  annualGrowthRateSchedule: z.array(rateOverride).optional(),
  amountMultiplierSchedule: z.array(multiplierOverride).optional(),
})

const socialSecurityBenefit = z.strictObject({
  id: z.string(),
  name: z.string(),
  benefitType: socialSecurityBenefitType,
  owner,
  currency: z.string(),
  primaryInsuranceAmount: finite,
  deceasedWorkerBenefitAmount: finite.optional(),
  fullRetirementAge: finite,
  claimantFullRetirementAge: finite.optional(),
  claimAge: finite,
  associatedWorkerClaimAge: finite.optional(),
  workerBirthYear: finite.optional(),
  divorcedSpouseEligibilityConfirmed: z.boolean().optional(),
  annualCOLARate: finite,
  taxableFraction: finite.optional(),
  reliability: finite,
  includedInBase: z.boolean(),
})

const spendingStream = z.strictObject({
  id: z.string(),
  category: z.string(),
  owner,
  currency: z.string(),
  amount: finite,
  start: boundary,
  end: boundary.optional(),
  annualInflationRate: finite,
  essential: z.boolean(),
  reduciblePercent: finite,
  annualInflationRateSchedule: z.array(rateOverride).optional(),
  amountMultiplierSchedule: z.array(multiplierOverride).optional(),
})

const lifeEvent = z.strictObject({
  id: z.string(),
  kind: z.enum([
    'work_exit',
    'housing_transaction',
    'divorce',
    'relocation',
    'college_end',
  ]),
  name: z.string(),
  date: boundary,
  amount: finite.optional(),
  currency: z.string().optional(),
  commitment,
})

const medicareComponent = z.strictObject({
  id: z.string(),
  kind: z.enum(['part_b', 'part_d', 'supplemental', 'dental', 'vision']),
  monthlyPremium: finite,
  monthlyOutOfPocket: finite.optional(),
  currency: z.string().optional(),
  annualInflationRate: finite.optional(),
})

const phaseBase = {
  id: z.string(),
  startMonth: z.string(),
  endMonthExclusive: z.string(),
  currency: z.string(),
}

const healthcarePhase = z.union([
  z.strictObject({
    ...phaseBase,
    kind: z.enum(['employer', 'cobra', 'aca', 'medicare']),
    monthlyPremium: finite,
    monthlyOutOfPocket: finite,
  }),
  z.strictObject({
    ...phaseBase,
    kind: z.literal('medicare'),
    medicareComponents: z.array(medicareComponent),
  }),
])

const acaRule = z.strictObject({
  id: z.string(),
  taxYear: finite,
  fplYear: finite,
  effectiveDate: z.string(),
  residenceRegion,
  annualBaseFpl: finite,
  annualAdditionalPersonFpl: finite,
  minimumFplPercent: finite,
  maximumFplPercent: finite,
  status: z.enum(['official', 'planning_estimate']),
  source: z.string(),
})

const healthcare = z.strictObject({
  annualInflationRate: finite,
  phases: z.array(healthcarePhase),
  aca: z
    .strictObject({
      householdSize: finite,
      residenceRegion,
      rulesByTaxYear: z.record(z.string(), acaRule),
      benchmarkAnnualPremium: finite,
      contributionRate: finite,
    })
    .optional(),
  additionalMagiByYear: z.record(z.string(), finite).optional(),
  shocks: z
    .array(
      z.strictObject({
        id: z.string(),
        month: z.string(),
        amount: finite,
        currency: z.string(),
      })
    )
    .optional(),
})

const scenarioSchema = z.strictObject({
  id: z.string(),
  profile: z.strictObject({
    currentAge: finite,
    targetRetirementAge: finite,
    filingStatus: z.enum(FILING_STATUSES),
    stateTaxRate: finite.optional(),
  }),
  assumptions: z.strictObject({
    durationYears: finite,
    inflationRate: finite,
    asOfDate: z.string(),
    baseCurrency: z.string(),
    inflationRateSchedule: z.array(rateOverride).optional(),
  }),
  fxRates: z.array(
    z.strictObject({
      from: z.string(),
      to: z.string(),
      effectiveDate: z.string(),
      rate: finite,
    })
  ),
  accounts: z.array(account),
  incomeStreams: z.array(incomeStream),
  socialSecurityBenefits: z.array(socialSecurityBenefit).optional(),
  spendingStreams: z.array(spendingStream),
  lifeEvents: z.array(lifeEvent),
  healthcare: healthcare.optional(),
})

const analysisOptionsSchema = z.strictObject({
  outsideIncomeStreamId: z.string().optional(),
  healthcareStreamIds: z.array(z.string()).optional(),
  workIncomeStreamIds: z.array(z.string()).optional(),
  socialSecurityAge: finite.optional(),
  reserveFloor: finite.optional(),
  maximumAffordableHousing: finite.optional(),
  maxGrossIncome: finite.optional(),
  greatLifeIncome: finite.optional(),
})

/** Upper bound on Monte Carlo paths, so one call cannot stall the host. */
const MAX_MONTE_CARLO_PATHS = 5_000

export const buildPlanInput = z.strictObject({ intake: planIntakeSchema })

export const analyzePlanInput = z.strictObject({
  scenario: scenarioSchema,
  options: analysisOptionsSchema.optional(),
})

export const comparePlansInput = z.strictObject({
  previous: scenarioSchema,
  current: scenarioSchema,
  previousOptions: analysisOptionsSchema.optional(),
  currentOptions: analysisOptionsSchema.optional(),
})

export const planMonteCarloInput = z.strictObject({
  scenario: scenarioSchema,
  seed: z.number().int(),
  numPaths: z.number().int().min(1).max(MAX_MONTE_CARLO_PATHS),
})

// Portfolio tool schemas (REQ-MCP-5..7). As above they check shape and types
// only; the portfolio tools apply the /api/v1 value rules in
// src/lib/validation-schemas.ts after this check.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')

/** Upper bound on CSV text, so one call cannot stall the host. */
export const MAX_CSV_CHARS = 2_000_000

const holdingSchema = z.strictObject({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  assetClass: z.enum([
    'us_equity',
    'intl_equity',
    'emerging_equity',
    'us_bond',
    'intl_bond',
    'tips',
    'money_market',
    'cd',
    'reit',
    'commodity',
    'crypto',
    'cash',
    'other',
  ]),
  shares: finite,
  costBasis: finite,
  currentPrice: finite,
  currentValue: finite,
})

const cdSchema = z.strictObject({
  id: z.string(),
  institution: z.string(),
  principal: finite,
  apy: finite,
  termMonths: z.union([
    z.literal(3),
    z.literal(6),
    z.literal(9),
    z.literal(12),
    z.literal(18),
    z.literal(24),
    z.literal(36),
    z.literal(48),
    z.literal(60),
  ]),
  maturityDate: z.string(),
  purchaseDate: z.string(),
  earlyWithdrawalPenaltyMonths: finite,
})

const portfolioAccountSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  institution: z.string(),
  accountType: z.enum(ACCOUNT_TYPES),
  holdings: z.array(holdingSchema),
  cds: z.array(cdSchema),
  cashBalance: finite,
})

export const portfolioSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  accounts: z.array(portfolioAccountSchema),
  asOfDate: z.string(),
})

// REQ-MCP-47: the owner's own rules that plan_check measures the snapshot against.
export const planRulesSchema = z.strictObject({
  targetEquityShare: finite.min(0).max(1),
  driftBand: finite.min(0).max(0.5).optional(),
  minCashBufferYears: finite.min(0).max(10).optional(),
  // REQ-MCP-62: liquid cash outside the snapshot (bank savings).
  outsideCash: finite.min(0).max(100_000_000).optional(),
  protectedAccountTypes: z
    .array(z.enum(ACCOUNT_TYPES))
    .max(ACCOUNT_TYPES.length)
    .optional(),
  sellSchedule: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(40),
        dueDate: isoDate,
        symbol: z.string().trim().min(1).max(12),
        amount: finite.positive(),
        accountType: z.enum(ACCOUNT_TYPES).optional(),
        done: z.boolean().optional(),
      })
    )
    .max(24)
    .optional(),
  bufferSymbols: z.array(z.string().trim().min(1).max(12)).max(20).optional(),
  // REQ-MCP-61: one-off actions that are not stock sales.
  tasks: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(40),
        dueDate: isoDate,
        action: z.string().trim().min(1).max(200),
        done: z.boolean().optional(),
      })
    )
    .max(24)
    .optional(),
  // REQ-MCP-65: the age the liquid cash buffer is needed from.
  bufferStartAge: finite.min(18).max(100).optional(),
  // REQ-MCP-63: a CD or Treasury ladder, one rung maturing each year.
  cdLadder: z
    .strictObject({
      accountType: z.enum(ACCOUNT_TYPES),
      accountName: z.string().trim().min(1).max(60).optional(),
      firstYear: z.number().int().min(2000).max(2100),
      lastYear: z.number().int().min(2000).max(2100),
      total: finite.min(0).max(100_000_000).optional(),
      maxPerIssuer: finite.min(1_000).max(100_000_000).optional(),
    })
    .optional(),
})

// REQ-MCP-63: a current yield read from the broker, with its source and date.
export const rateQuoteSchema = z.strictObject({
  kind: z.enum(['cd', 'treasury']),
  termYears: z.number().int().min(1).max(10),
  apy: finite.min(0).max(0.2),
  callProtected: z.boolean().optional(),
  source: z.string().trim().min(1).max(120),
  quotedOn: isoDate,
})

export const userProfileSchema = z.strictObject({
  currentAge: finite,
  targetRetirementAge: finite,
  annualExpenses: finite,
  socialSecurityAge: finite.optional(),
  socialSecurityMonthly: finite.optional(),
  pensionMonthly: finite.optional(),
  otherIncomeMonthly: finite.optional(),
  otherIncomeStartAge: finite.optional(),
  otherIncomeEndAge: finite.optional(),
  stateTaxRate: finite.optional(),
  federalTaxBracket: finite.optional(),
  home: z
    .strictObject({
      estimatedValue: finite,
      low: finite.optional(),
      high: finite.optional(),
    })
    .optional(),
  mortgage: z
    .strictObject({
      balance: finite,
      asOfDate: isoDate,
      rate: finite.optional(),
      monthlyPayment: finite.optional(),
      payoffDate: isoDate.optional(),
    })
    .optional(),
  annualContributions: finite.optional(),
  socialSecurityCola: z.boolean().optional(),
  withdrawalTaxRate: finite.optional(),
  spendingPhases: z
    .array(
      z.strictObject({
        startAge: finite,
        annualExpenses: finite,
      })
    )
    .optional(),
  homeSale: z
    .strictObject({
      age: finite,
      salePrice: finite.optional(),
      sellingCostRate: finite.optional(),
      replacementHomeCost: finite.optional(),
      annualHousingCostChange: finite.optional(),
    })
    .optional(),
  // Read by project_retirement only (REQ-MCP-39).
  spouse: z
    .strictObject({
      currentAge: finite,
      socialSecurityAge: finite.optional(),
      socialSecurityMonthly: finite.optional(),
    })
    .optional(),
  planningAge: finite.optional(),
  filingStatus: z.enum(FILING_STATUSES).optional(),
  stateExemptsRetirementIncome: z.boolean().optional(),
  preMedicareHealthcare: finite.optional(),
  separationAge: finite.optional(),
  nqdcPayout: z
    .strictObject({
      startAge: finite,
      years: finite,
      onSeparation: z.boolean().optional(),
    })
    .optional(),
  acaPremiumTaxCredit: z.boolean().optional(),
  householdSize: finite.optional(),
  // REQ-MCP-47: the owner's portfolio rules, read by plan_check only.
  planRules: planRulesSchema.optional(),
  // REQ-MCP-68: the owner's goals for the plan.
  goals: z
    .strictObject({
      successRate: finite.min(0.5).max(0.99).optional(),
      forecastSuccessRate: finite.min(0.3).max(0.99).optional(),
      latestAge: finite.min(40).max(80).optional(),
      reviewEveryDays: z.number().int().min(7).max(366).optional(),
    })
    .optional(),
  // REQ-MCP-71: stock share by age.
  glidePath: z
    .array(
      z.strictObject({
        age: finite.min(18).max(110),
        equityShare: finite.min(0).max(1),
      })
    )
    .min(1)
    .max(10)
    .optional(),
  // REQ-MCP-70: which accounts pay spending first.
  withdrawalOrder: z
    .enum(['taxableFirst', 'preTaxFirst', 'proportional'])
    .optional(),
  // REQ-MCP-72: card and other short-term debt to clear.
  consumerDebt: finite.min(0).optional(),
  // REQ-MCP-51: near-term market means (preset 'forecast' or your own), then long-run.
  marketAssumptions: z
    .strictObject({
      preset: z.enum(['forecast', 'long_run']).optional(),
      equityMean: finite.min(-0.1).max(0.2).optional(),
      bondMean: finite.min(-0.1).max(0.15).optional(),
      inflationMean: finite.min(-0.05).max(0.15).optional(),
      years: z.number().int().min(1).max(60).optional(),
    })
    .optional(),
  // REQ-MCP-52: a gap in pay before retirement.
  incomeGap: z
    .strictObject({
      startAge: finite.min(18).max(80),
      months: finite.min(0).max(120),
      severance: finite.min(0).optional(),
      newAnnualContributions: finite.min(0).optional(),
      monthlySpending: finite.min(0).optional(),
      healthcareMonthly: finite.min(0).optional(),
    })
    .optional(),
  // REQ-MCP-60: one-off after-tax money at an age, today's dollars.
  lumpSums: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(40),
        age: finite.min(18).max(120),
        amount: finite.min(0).max(100_000_000),
      })
    )
    .max(10)
    .optional(),
  // REQ-MCP-59: Social Security paid at (1 - share) of scheduled from startYear.
  socialSecurityCut: z
    .strictObject({
      share: finite.min(0).max(0.5).optional(),
      startYear: z.number().int().min(2025).max(2100).optional(),
    })
    .optional(),
  // REQ-MCP-48: one spouse dies at deathAge (the owner's age).
  survivor: z
    .strictObject({
      deceased: z.enum(['self', 'spouse']),
      deathAge: finite.min(18).max(120),
      spendingShare: finite.min(0.3).max(1).optional(),
      lifeInsurance: finite.min(0).optional(),
      survivorClaimAge: finite.min(60).max(70).optional(),
    })
    .optional(),
})

export const importPositionsInput = z.strictObject({
  csv: z.string().max(MAX_CSV_CHARS),
  asOfDate: isoDate.optional(),
  // REQ-MCP-13: also store the portfolio as snapshots/<asOfDate>.json.
  save: z.boolean().optional(),
})

// REQ-MCP-14: a portfolio tool called without `portfolio` or `profile` uses
// the newest saved snapshot or the saved profile.
export const portfolioAnalysisInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  // As /api/v1/analyze: Monte Carlo runs unless turned off; the seed makes it reproducible.
  includeMonteCarlo: z.boolean().optional(),
  seed: z.number().int().optional(),
})

export const taxStrategyInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  filingStatus: z.enum(FILING_STATUSES).optional(),
  ordinaryIncome: finite.optional(),
  capitalGains: finite.optional(),
})

export const tradePlanInput = portfolioAnalysisInput

// REQ-MCP-43: up to four what-ifs over the saved (or given) profile.
const PROFILE_KEYS = Object.keys(userProfileSchema.shape) as [
  string,
  ...string[],
]

export const compareScenariosInput = z.strictObject({
  scenarios: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(40),
        changes: userProfileSchema.partial(),
        remove: z
          .array(z.enum(PROFILE_KEYS))
          .max(PROFILE_KEYS.length)
          .optional(),
      })
    )
    .min(1)
    .max(4),
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  seed: z.number().int().optional(),
})

// REQ-MCP-39: the v2 projection, from the saved data when left out.
export const projectRetirementInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  seed: z.number().int().optional(),
})

// REQ-MCP-47: the snapshot against the owner's rules on a given date.
export const planCheckInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  rules: planRulesSchema.optional(),
  asOfDate: isoDate.optional(),
  rateQuotes: z.array(rateQuoteSchema).max(40).optional(),
})

export const spendingGuardrailsInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  seed: z.number().int().optional(),
  targetSuccess: z.number().gt(0).lt(1).optional(),
  lowerSuccess: z.number().gt(0).lt(1).optional(),
  upperSuccess: z.number().gt(0).lt(1).optional(),
  adjustment: z.number().gt(0).max(0.5).optional(),
})

export const exploreRothConversionsInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  seed: z.number().int().optional(),
  conversionEndAge: z.number().int().min(50).max(80).optional(),
  strategies: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(40),
        kind: z.enum(['none', 'fillBracket', 'irmaaTier', 'acaThenIrmaa']),
        rate: z.number().gt(0).lt(1).optional(),
        tier: z.number().int().min(0).max(4).optional(),
      })
    )
    .min(1)
    .max(6)
    .optional(),
})

const claimAges = z.array(z.number().int().min(62).max(70)).min(1).max(9)

// REQ-MCP-49: Social Security claiming ages swept for the owner and spouse.
export const exploreClaimingAgesInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  seed: z.number().int().optional(),
  selfAges: claimAges.optional(),
  spouseAges: claimAges.optional(),
  survivor: z
    .strictObject({
      deceased: z.enum(['self', 'spouse']),
      deathAge: finite.min(18).max(120),
      spendingShare: finite.min(0.3).max(1).optional(),
      lifeInsurance: finite.min(0).optional(),
      survivorClaimAge: finite.min(60).max(70).optional(),
    })
    .optional(),
})

// REQ-MCP-50: the plan replayed through 1928-2025 market history.
export const historicalBacktestInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
})

// REQ-MCP-56: one GO / CAUTION / DELAY verdict for the month.
// REQ-MCP-66: the earliest retirement age that reaches the goals.
export const earliestRetirementInput = z.strictObject({
  profile: userProfileSchema.optional(),
  portfolio: portfolioSchema.optional(),
  seed: z.number().int().optional(),
})

// REQ-MCP-67: the levers that bring retirement forward, ranked.
export const rankLeversInput = z.strictObject({
  profile: userProfileSchema.optional(),
  portfolio: portfolioSchema.optional(),
  seed: z.number().int().optional(),
  custom: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(60),
        changes: userProfileSchema.partial(),
      })
    )
    .max(4)
    .optional(),
})

// REQ-MCP-69: the plan review.
export const reviewPlanInput = z.strictObject({
  profile: userProfileSchema.optional(),
  portfolio: portfolioSchema.optional(),
  asOfDate: isoDate.optional(),
  seed: z.number().int().optional(),
})

// REQ-MCP-70: compare withdrawal orders.
export const exploreWithdrawalOrderInput = z.strictObject({
  profile: userProfileSchema.optional(),
  portfolio: portfolioSchema.optional(),
  seed: z.number().int().optional(),
})

// REQ-MCP-72: a balance sheet from an aggregator's net-worth list.
export const importBalancesInput = z.strictObject({
  text: z.string().min(1).max(20_000),
  asOfDate: isoDate,
  earmarks: z
    .array(
      z.strictObject({
        account: z.string().trim().min(1).max(60),
        amount: finite.positive(),
        purpose: z.string().trim().min(1).max(80),
      })
    )
    .max(10)
    .optional(),
})

// REQ-MCP-64: the engine's proposed plan rules.
export const proposePlanRulesInput = z.strictObject({
  profile: userProfileSchema.optional(),
  portfolio: portfolioSchema.optional(),
  asOfDate: isoDate.optional(),
  seed: z.number().int().optional(),
})

export const planVerdictInput = z.strictObject({
  portfolio: portfolioSchema.optional(),
  profile: userProfileSchema.optional(),
  seed: z.number().int().optional(),
  asOfDate: isoDate.optional(),
})

// REQ-MCP-58: what moved the number between two saved snapshots.
export const explainChangeInput = z.strictObject({
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  previousSuccessRate: finite.min(0).max(1).optional(),
  seed: z.number().int().optional(),
})

// User data tool schemas (REQ-MCP-11..15).
export const saveProfileInput = z.strictObject({ profile: userProfileSchema })

export const noInput = z.strictObject({})

/** The longest notes text a store reads in one section (version 1 notes held up to this), in characters. */
export const MAX_NOTES_LENGTH = 20_000

// The section cap (4,000 characters) is checked in save_plan_notes so the
// refusal can name the section; this bound only stops oversized requests.
export const savePlanNotesInput = z.strictObject({
  section: z.enum(SECTION_KEYS),
  text: z.string().max(MAX_NOTES_LENGTH),
  expectedRevision: z.number().int().min(0),
})

export const deleteUserDataInput = z.strictObject({
  // Required, so a call that forgets it deletes nothing.
  confirm: z.boolean(),
})

/** A plan report parsed from planToJson: a JSON object (analyze_plan output). */
export const planJsonObject = z.record(z.string(), z.unknown())
