/**
 * Zod validation schemas for API route inputs
 * Provides type-safe validation for all incoming requests
 */

import { z } from 'zod'
import { FILING_STATUSES } from '@/engine/tax-brackets'
import { ACCOUNT_TYPES } from '@/engine/types'

// Engine types validation
const AccountTypeEnum = z.enum(ACCOUNT_TYPES)

const AssetClassEnum = z.enum([
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
])

const CDTermMonthsEnum = z.union([
  z.literal(3),
  z.literal(6),
  z.literal(9),
  z.literal(12),
  z.literal(18),
  z.literal(24),
  z.literal(36),
  z.literal(48),
  z.literal(60),
])

const HoldingSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1),
  assetClass: AssetClassEnum,
  shares: z.number().nonnegative(),
  costBasis: z.number(),
  currentPrice: z.number().nonnegative(),
  currentValue: z.number(),
})

const CDSchema = z.object({
  id: z.string().min(1),
  institution: z.string().min(1),
  principal: z.number().positive(),
  apy: z.number().min(0).max(1),
  termMonths: CDTermMonthsEnum,
  maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  earlyWithdrawalPenaltyMonths: z.number().int().nonnegative(),
})

const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  institution: z.string().min(1),
  accountType: AccountTypeEnum,
  holdings: z.array(HoldingSchema),
  cds: z.array(CDSchema),
  cashBalance: z.number().nonnegative(),
})

export const PortfolioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accounts: z.array(AccountSchema).min(1),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

const UserProfileFieldsSchema = z.object({
  currentAge: z.number().int().min(18).max(120),
  targetRetirementAge: z.number().int().min(50).max(120),
  annualExpenses: z.number().positive(),
  socialSecurityAge: z.number().int().min(62).max(70).optional(),
  socialSecurityMonthly: z.number().nonnegative().optional(),
  pensionMonthly: z.number().nonnegative().optional(),
  otherIncomeMonthly: z.number().nonnegative().optional(),
  stateTaxRate: z.number().min(0).max(1).optional(),
  federalTaxBracket: z.number().min(0).max(1).optional(),
  annualContributions: z.number().nonnegative().optional(),
  socialSecurityCola: z.boolean().optional(),
  withdrawalTaxRate: z.number().min(0).max(0.6).optional(),
  spendingPhases: z
    .array(
      z.object({
        startAge: z.number().int().min(18).max(120),
        annualExpenses: z.number().nonnegative(),
      })
    )
    .optional(),
  home: z.object({ estimatedValue: z.number().nonnegative() }).optional(),
  homeSale: z
    .object({
      age: z.number().int().min(18).max(120),
      salePrice: z.number().nonnegative().optional(),
      sellingCostRate: z.number().min(0).max(0.5).optional(),
      replacementHomeCost: z.number().nonnegative().optional(),
      annualHousingCostChange: z.number().optional(),
    })
    .optional(),
  spouse: z
    .object({
      currentAge: z.number().int().min(18).max(120),
      socialSecurityAge: z.number().int().min(62).max(70).optional(),
      socialSecurityMonthly: z.number().nonnegative().optional(),
    })
    .optional(),
  planningAge: z.number().int().min(60).max(110).optional(),
  filingStatus: z
    .enum(['single', 'married_filing_jointly', 'head_of_household'])
    .optional(),
  stateExemptsRetirementIncome: z.boolean().optional(),
  preMedicareHealthcare: z.number().nonnegative().optional(),
  separationAge: z.number().int().min(18).max(120).optional(),
  nqdcPayout: z
    .object({
      startAge: z.number().int().min(18).max(120),
      years: z.number().int().min(1).max(30),
    })
    .optional(),
  acaPremiumTaxCredit: z.boolean().optional(),
  householdSize: z.number().int().min(1).max(10).optional(),
})

export const UserProfileSchema = UserProfileFieldsSchema.superRefine(
  (profile, context) => {
    if (profile.targetRetirementAge < profile.currentAge) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetRetirementAge'],
        message: 'Target retirement age must be at or after current age.',
      })
    }
    const phases = profile.spendingPhases ?? []
    for (let i = 1; i < phases.length; i++) {
      if (phases[i].startAge <= phases[i - 1].startAge) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spendingPhases', i, 'startAge'],
          message: 'Spending phases must be in increasing startAge order.',
        })
      }
    }
    if (
      profile.planningAge !== undefined &&
      profile.planningAge <=
        Math.max(profile.currentAge, profile.targetRetirementAge)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['planningAge'],
        message: 'Planning age must be after current and retirement age.',
      })
    }
    const sale = profile.homeSale
    if (sale !== undefined) {
      if (sale.age <= profile.currentAge) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['homeSale', 'age'],
          message: 'Home sale age must be after current age.',
        })
      }
      if (sale.salePrice === undefined && profile.home === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['homeSale', 'salePrice'],
          message: 'Pass homeSale.salePrice or a home with estimatedValue.',
        })
      }
    }
  }
)

const WhatIfOverridesFieldsSchema = UserProfileFieldsSchema.pick({
  targetRetirementAge: true,
  annualExpenses: true,
  socialSecurityAge: true,
  socialSecurityMonthly: true,
  pensionMonthly: true,
  otherIncomeMonthly: true,
})
  .partial()
  .strict()

// The what-if prompt instructs the LLM to emit `null` for fields it did not
// change (see buildWhatIfPrompt in src/ai/what-if.ts). Strip those before
// validating so an explicit null is treated the same as an absent field
// instead of failing the field's own type/range check.
export const WhatIfOverridesSchema = z.preprocess(value => {
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([, fieldValue]) => fieldValue !== null
    )
  )
}, WhatIfOverridesFieldsSchema)

export const WhatIfModelResponseSchema = z
  .object({
    overrides: WhatIfOverridesSchema.optional().default({}),
    explanation: z.string().min(1).max(500).optional(),
  })
  .strict()

// AI API schemas
const ProviderSchema = z.enum(['openai', 'anthropic', 'perplexity'])

export const NarrateRequestSchema = z.object({
  context: z.object({
    portfolio: PortfolioSchema,
    userProfile: UserProfileSchema,
    scenarios: z.array(z.any()),
    riskScore: z.any(),
    tradePlan: z.any(),
    ladderPlan: z.any(),
  }),
  provider: ProviderSchema,
  apiKey: z.string().min(10),
  model: z.string().optional(),
})

export const WhatIfRequestSchema = z.object({
  question: z.string().min(1).max(500),
  currentProfile: UserProfileSchema,
  provider: ProviderSchema,
  apiKey: z.string().min(10),
})

// Engine API schemas
export const AnalyzeRequestSchema = z.object({
  portfolio: PortfolioSchema,
  userProfile: UserProfileSchema,
  options: z
    .object({
      includeMonteCarlo: z.boolean().optional(),
      includeAlerts: z.boolean().optional(),
      tradeMode: z.enum(['standard', 'minimal']).optional(),
    })
    .optional(),
})

const FilingStatusSchema = z.enum(FILING_STATUSES)

export const TaxRequestSchema = z.object({
  portfolio: PortfolioSchema.optional(),
  userProfile: UserProfileSchema,
  filingStatus: FilingStatusSchema.optional(),
  ordinaryIncome: z.number().nonnegative().optional(),
  capitalGains: z.number().optional(),
  includeRothOptimizer: z.boolean().optional(),
})

// Payment API schemas
export const StripeCheckoutRequestSchema = z.object({}).strict()

// Plaid API schemas
export const PlaidCreateLinkTokenRequestSchema = z.object({
  userId: z.string().min(1).optional(),
})

export const PlaidExchangeTokenRequestSchema = z.object({
  publicToken: z.string().min(1),
})
