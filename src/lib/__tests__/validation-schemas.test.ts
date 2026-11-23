import { describe, it, expect } from 'vitest'
import {
  PortfolioSchema,
  UserProfileSchema,
  NarrateRequestSchema,
  WhatIfRequestSchema,
  WhatIfOverridesSchema,
  AnalyzeRequestSchema,
  TaxRequestSchema,
  StripeCheckoutRequestSchema,
  PlaidCreateLinkTokenRequestSchema,
  PlaidExchangeTokenRequestSchema,
} from '../validation-schemas'

describe('UserProfileSchema', () => {
  it('should validate a complete user profile', () => {
    const validProfile = {
      currentAge: 55,
      targetRetirementAge: 62,
      annualExpenses: 75000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 2500,
      pensionMonthly: 1000,
      otherIncomeMonthly: 500,
      stateTaxRate: 0.05,
      federalTaxBracket: 0.22,
    }

    const result = UserProfileSchema.safeParse(validProfile)
    expect(result.success).toBe(true)
  })

  it('should validate minimal required fields', () => {
    const minimalProfile = {
      currentAge: 60,
      targetRetirementAge: 65,
      annualExpenses: 50000,
    }

    const result = UserProfileSchema.safeParse(minimalProfile)
    expect(result.success).toBe(true)
  })

  it('should reject invalid age ranges', () => {
    const invalidAge = {
      currentAge: 15,
      targetRetirementAge: 65,
      annualExpenses: 50000,
    }

    const result = UserProfileSchema.safeParse(invalidAge)
    expect(result.success).toBe(false)
  })

  it('should reject negative expenses', () => {
    const negativeExpenses = {
      currentAge: 55,
      targetRetirementAge: 65,
      annualExpenses: -50000,
    }

    const result = UserProfileSchema.safeParse(negativeExpenses)
    expect(result.success).toBe(false)
  })

  it('should reject a retirement age before the current age', () => {
    const result = UserProfileSchema.safeParse({
      currentAge: 65,
      targetRetirementAge: 60,
      annualExpenses: 50000,
    })

    expect(result.success).toBe(false)
  })
})

describe('WhatIfOverridesSchema', () => {
  it('accepts a constrained partial override', () => {
    const result = WhatIfOverridesSchema.safeParse({
      targetRetirementAge: 60,
      annualExpenses: 55000,
    })

    expect(result.success).toBe(true)
  })

  it.each([
    { targetRetirementAge: 60.5 },
    { targetRetirementAge: Number.NaN },
    { annualExpenses: -1 },
    { unexpectedField: 1 },
  ])('rejects invalid override %#', override => {
    expect(WhatIfOverridesSchema.safeParse(override).success).toBe(false)
  })

  it('treats explicit null fields (the prompted LLM shape for unchanged fields) as absent', () => {
    const result = WhatIfOverridesSchema.safeParse({
      targetRetirementAge: 60,
      annualExpenses: null,
      socialSecurityAge: null,
      socialSecurityMonthly: null,
      pensionMonthly: null,
      otherIncomeMonthly: null,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ targetRetirementAge: 60 })
    }
  })
})

describe('PortfolioSchema', () => {
  it('should validate a complete portfolio', () => {
    const validPortfolio = {
      id: 'port-123',
      name: 'My Portfolio',
      accounts: [
        {
          id: 'acc-1',
          name: 'Fidelity 401k',
          institution: 'Fidelity',
          accountType: '401k',
          holdings: [
            {
              id: 'hold-1',
              symbol: 'VTI',
              name: 'Vanguard Total Stock Market ETF',
              assetClass: 'us_equity',
              shares: 100,
              costBasis: 20000,
              currentPrice: 220,
              currentValue: 22000,
            },
          ],
          cds: [],
          cashBalance: 5000,
        },
      ],
      asOfDate: '2026-02-03',
    }

    const result = PortfolioSchema.safeParse(validPortfolio)
    expect(result.success).toBe(true)
  })

  it('should reject portfolio with no accounts', () => {
    const noAccounts = {
      id: 'port-123',
      name: 'Empty Portfolio',
      accounts: [],
      asOfDate: '2026-02-03',
    }

    const result = PortfolioSchema.safeParse(noAccounts)
    expect(result.success).toBe(false)
  })

  it('should reject invalid date format', () => {
    const invalidDate = {
      id: 'port-123',
      name: 'My Portfolio',
      accounts: [
        {
          id: 'acc-1',
          name: 'Test Account',
          institution: 'Test',
          accountType: 'brokerage',
          holdings: [],
          cds: [],
          cashBalance: 0,
        },
      ],
      asOfDate: '02/03/2026',
    }

    const result = PortfolioSchema.safeParse(invalidDate)
    expect(result.success).toBe(false)
  })

  it('should validate CD with proper term months', () => {
    const portfolioWithCD = {
      id: 'port-123',
      name: 'CD Portfolio',
      accounts: [
        {
          id: 'acc-1',
          name: 'Savings Account',
          institution: 'Bank',
          accountType: 'brokerage',
          holdings: [],
          cds: [
            {
              id: 'cd-1',
              institution: 'Bank',
              principal: 10000,
              apy: 0.045,
              termMonths: 12,
              maturityDate: '2027-02-03',
              purchaseDate: '2026-02-03',
              earlyWithdrawalPenaltyMonths: 3,
            },
          ],
          cashBalance: 1000,
        },
      ],
      asOfDate: '2026-02-03',
    }

    const result = PortfolioSchema.safeParse(portfolioWithCD)
    expect(result.success).toBe(true)
  })

  it('should reject invalid CD term months', () => {
    const invalidCDTerm = {
      id: 'port-123',
      name: 'CD Portfolio',
      accounts: [
        {
          id: 'acc-1',
          name: 'Savings Account',
          institution: 'Bank',
          accountType: 'brokerage',
          holdings: [],
          cds: [
            {
              id: 'cd-1',
              institution: 'Bank',
              principal: 10000,
              apy: 0.045,
              termMonths: 15,
              maturityDate: '2027-02-03',
              purchaseDate: '2026-02-03',
              earlyWithdrawalPenaltyMonths: 3,
            },
          ],
          cashBalance: 1000,
        },
      ],
      asOfDate: '2026-02-03',
    }

    const result = PortfolioSchema.safeParse(invalidCDTerm)
    expect(result.success).toBe(false)
  })
})

describe('NarrateRequestSchema', () => {
  it('should validate complete narration request', () => {
    const validRequest = {
      context: {
        portfolio: {
          id: 'port-1',
          name: 'Test',
          accounts: [
            {
              id: 'acc-1',
              name: 'Test',
              institution: 'Test',
              accountType: 'brokerage',
              holdings: [],
              cds: [],
              cashBalance: 0,
            },
          ],
          asOfDate: '2026-02-03',
        },
        userProfile: {
          currentAge: 55,
          targetRetirementAge: 65,
          annualExpenses: 60000,
        },
        scenarios: [],
        riskScore: {},
        tradePlan: {},
        ladderPlan: {},
      },
      provider: 'anthropic',
      apiKey: 'sk-ant-1234567890',
      model: 'claude-3-5-sonnet-20241022',
    }

    const result = NarrateRequestSchema.safeParse(validRequest)
    expect(result.success).toBe(true)
  })

  it('should reject short API keys', () => {
    const shortKey = {
      context: {
        portfolio: {
          id: 'port-1',
          name: 'Test',
          accounts: [
            {
              id: 'acc-1',
              name: 'Test',
              institution: 'Test',
              accountType: 'brokerage',
              holdings: [],
              cds: [],
              cashBalance: 0,
            },
          ],
          asOfDate: '2026-02-03',
        },
        userProfile: {
          currentAge: 55,
          targetRetirementAge: 65,
          annualExpenses: 60000,
        },
        scenarios: [],
        riskScore: {},
        tradePlan: {},
        ladderPlan: {},
      },
      provider: 'anthropic',
      apiKey: 'short',
    }

    const result = NarrateRequestSchema.safeParse(shortKey)
    expect(result.success).toBe(false)
  })

  it('should reject invalid provider', () => {
    const invalidProvider = {
      context: {
        portfolio: {
          id: 'port-1',
          name: 'Test',
          accounts: [
            {
              id: 'acc-1',
              name: 'Test',
              institution: 'Test',
              accountType: 'brokerage',
              holdings: [],
              cds: [],
              cashBalance: 0,
            },
          ],
          asOfDate: '2026-02-03',
        },
        userProfile: {
          currentAge: 55,
          targetRetirementAge: 65,
          annualExpenses: 60000,
        },
        scenarios: [],
        riskScore: {},
        tradePlan: {},
        ladderPlan: {},
      },
      provider: 'groq',
      apiKey: 'sk-1234567890',
    }

    const result = NarrateRequestSchema.safeParse(invalidProvider)
    expect(result.success).toBe(false)
  })
})

describe('WhatIfRequestSchema', () => {
  it('should validate what-if request', () => {
    const validRequest = {
      question: 'What if I retire at 60 instead of 65?',
      currentProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      provider: 'openai',
      apiKey: 'sk-1234567890',
    }

    const result = WhatIfRequestSchema.safeParse(validRequest)
    expect(result.success).toBe(true)
  })

  it('should accept the Perplexity provider advertised by the UI', () => {
    const result = WhatIfRequestSchema.safeParse({
      question: 'What if I retire at 60?',
      currentProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      provider: 'perplexity',
      apiKey: 'pplx-1234567890',
    })

    expect(result.success).toBe(true)
  })

  it('should reject empty question', () => {
    const emptyQuestion = {
      question: '',
      currentProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      provider: 'openai',
      apiKey: 'sk-1234567890',
    }

    const result = WhatIfRequestSchema.safeParse(emptyQuestion)
    expect(result.success).toBe(false)
  })

  it('should reject overly long questions', () => {
    const longQuestion = {
      question: 'x'.repeat(501),
      currentProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      provider: 'openai',
      apiKey: 'sk-1234567890',
    }

    const result = WhatIfRequestSchema.safeParse(longQuestion)
    expect(result.success).toBe(false)
  })
})

describe('AnalyzeRequestSchema', () => {
  it('should validate analyze request with options', () => {
    const validRequest = {
      portfolio: {
        id: 'port-1',
        name: 'Test',
        accounts: [
          {
            id: 'acc-1',
            name: 'Test',
            institution: 'Test',
            accountType: 'brokerage',
            holdings: [],
            cds: [],
            cashBalance: 0,
          },
        ],
        asOfDate: '2026-02-03',
      },
      userProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      options: {
        includeMonteCarlo: true,
        includeAlerts: false,
        tradeMode: 'minimal',
      },
    }

    const result = AnalyzeRequestSchema.safeParse(validRequest)
    expect(result.success).toBe(true)
  })

  it('should accept analyze request without options', () => {
    const noOptions = {
      portfolio: {
        id: 'port-1',
        name: 'Test',
        accounts: [
          {
            id: 'acc-1',
            name: 'Test',
            institution: 'Test',
            accountType: 'brokerage',
            holdings: [],
            cds: [],
            cashBalance: 0,
          },
        ],
        asOfDate: '2026-02-03',
      },
      userProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
    }

    const result = AnalyzeRequestSchema.safeParse(noOptions)
    expect(result.success).toBe(true)
  })
})

describe('TaxRequestSchema', () => {
  it('should validate tax request with all fields', () => {
    const validRequest = {
      portfolio: {
        id: 'port-1',
        name: 'Test',
        accounts: [
          {
            id: 'acc-1',
            name: 'Test',
            institution: 'Test',
            accountType: 'brokerage',
            holdings: [],
            cds: [],
            cashBalance: 0,
          },
        ],
        asOfDate: '2026-02-03',
      },
      userProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      filingStatus: 'married_filing_jointly',
      ordinaryIncome: 80000,
      capitalGains: 15000,
      includeRothOptimizer: true,
    }

    const result = TaxRequestSchema.safeParse(validRequest)
    expect(result.success).toBe(true)
  })

  it('should accept tax request without portfolio', () => {
    const noPortfolio = {
      userProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      filingStatus: 'single',
    }

    const result = TaxRequestSchema.safeParse(noPortfolio)
    expect(result.success).toBe(true)
  })

  it.each(['single', 'married_filing_jointly', 'head_of_household'])(
    'accepts engine-supported filing status %s',
    filingStatus => {
      const result = TaxRequestSchema.safeParse({
        userProfile: {
          currentAge: 55,
          targetRetirementAge: 65,
          annualExpenses: 60000,
        },
        filingStatus,
      })

      expect(result.success).toBe(true)
    }
  )

  it.each(['married', 'married_separate'])(
    'rejects unsupported filing status %s',
    filingStatus => {
      const result = TaxRequestSchema.safeParse({
        userProfile: {
          currentAge: 55,
          targetRetirementAge: 65,
          annualExpenses: 60000,
        },
        filingStatus,
      })

      expect(result.success).toBe(false)
    }
  )
})

describe('StripeCheckoutRequestSchema', () => {
  it('should validate checkout request', () => {
    const validRequest = {}

    const result = StripeCheckoutRequestSchema.safeParse(validRequest)
    expect(result.success).toBe(true)
  })

  it('should reject caller-supplied pricing or identity', () => {
    const emptyFields = { priceId: 'price_attacker', userId: 'user_abc123' }

    const result = StripeCheckoutRequestSchema.safeParse(emptyFields)
    expect(result.success).toBe(false)
  })
})

describe('PlaidCreateLinkTokenRequestSchema', () => {
  it('should validate with userId', () => {
    const validRequest = {
      userId: 'user_123',
    }

    const result = PlaidCreateLinkTokenRequestSchema.safeParse(validRequest)
    expect(result.success).toBe(true)
  })

  it('should validate without userId', () => {
    const noUserId = {}

    const result = PlaidCreateLinkTokenRequestSchema.safeParse(noUserId)
    expect(result.success).toBe(true)
  })
})

describe('PlaidExchangeTokenRequestSchema', () => {
  it('should validate exchange token request', () => {
    const validRequest = {
      publicToken: 'public-sandbox-1234567890',
    }

    const result = PlaidExchangeTokenRequestSchema.safeParse(validRequest)
    expect(result.success).toBe(true)
  })

  it('should reject empty token', () => {
    const emptyToken = {
      publicToken: '',
    }

    const result = PlaidExchangeTokenRequestSchema.safeParse(emptyToken)
    expect(result.success).toBe(false)
  })

  it('should reject missing token', () => {
    const missingToken = {}

    const result = PlaidExchangeTokenRequestSchema.safeParse(missingToken)
    expect(result.success).toBe(false)
  })
})
