import { describe, expect, it } from 'vitest'
import { projectScenario } from '../projection'
import { ACA_RULE_2026, ACA_RULE_2027, buildAcaRules } from '../healthcare'
import type {
  HealthcareACAConfig,
  HealthcareACAFplRule,
  Scenario,
} from '../types'

const acaRule2027: HealthcareACAFplRule = {
  id: 'test-aca-fpl-2027',
  taxYear: 2027,
  fplYear: 2026,
  effectiveDate: '2026-01-01',
  residenceRegion: 'contiguous_us',
  annualBaseFpl: 15_000,
  annualAdditionalPersonFpl: 5_000,
  minimumFplPercent: 100,
  maximumFplPercent: 400,
  status: 'planning_estimate',
  source: 'test fixture',
}

function acaConfig(
  overrides: Partial<HealthcareACAConfig> = {}
): HealthcareACAConfig {
  return {
    householdSize: 1,
    residenceRegion: 'contiguous_us',
    rulesByTaxYear: { '2027': acaRule2027 },
    benchmarkAnnualPremium: 3_600,
    contributionRate: 0.1,
    ...overrides,
  }
}

const baseScenario: Scenario = {
  id: 'healthcare-fixture',
  profile: {
    currentAge: 60,
    targetRetirementAge: 60,
    filingStatus: 'single',
  },
  assumptions: {
    durationYears: 2,
    inflationRate: 0,
    asOfDate: '2026-01-15',
    baseCurrency: 'USD',
  },
  fxRates: [],
  accounts: [
    {
      id: 'cash',
      name: 'Cash',
      type: 'cash',
      currency: 'USD',
      balance: 100_000,
      annualReturnRate: 0,
    },
  ],
  incomeStreams: [],
  spendingStreams: [],
  lifeEvents: [],
}

describe('healthcare projection', () => {
  function aca2026Scenario(annualIncome: number, householdSize = 1): Scenario {
    return {
      ...baseScenario,
      assumptions: {
        ...baseScenario.assumptions,
        asOfDate: '2025-01-01',
        durationYears: 1,
      },
      incomeStreams: [
        {
          id: 'income',
          name: 'Income',
          owner: 'primary',
          currency: 'USD',
          gross: annualIncome,
          start: { age: 1 },
          annualGrowthRate: 0,
          taxCategory: 'ordinary',
          reliability: 1,
          includedInBase: true,
        },
      ],
      healthcare: {
        annualInflationRate: 0,
        phases: [
          {
            id: 'aca',
            kind: 'aca',
            startMonth: '2026-01',
            endMonthExclusive: '2027-01',
            currency: 'USD',
            monthlyPremium: 1_000,
            monthlyOutOfPocket: 0,
          },
        ],
        aca: {
          householdSize,
          residenceRegion: 'contiguous_us',
          rulesByTaxYear: { '2026': ACA_RULE_2026 },
          benchmarkAnnualPremium: 12_000,
          contributionRate: 0.1,
        },
      },
    }
  }

  it('prorates employer and ACA phases and adds net costs to spending', () => {
    const scenario: Scenario = {
      ...baseScenario,
      healthcare: {
        annualInflationRate: 0,
        phases: [
          {
            id: 'employer',
            kind: 'employer',
            startMonth: '2027-01',
            endMonthExclusive: '2027-07',
            currency: 'USD',
            monthlyPremium: 100,
            monthlyOutOfPocket: 50,
          },
          {
            id: 'aca',
            kind: 'aca',
            startMonth: '2027-07',
            endMonthExclusive: '2028-01',
            currency: 'USD',
            monthlyPremium: 300,
            monthlyOutOfPocket: 20,
          },
        ],
        aca: acaConfig(),
        additionalMagiByYear: { '2027': 15_000 },
      },
    }

    const row = projectScenario(scenario).rows[0]
    expect(row.healthcare?.premium).toBe(2_400)
    expect(row.healthcare?.subsidy).toBe(1_050)
    expect(row.healthcare?.outOfPocket).toBe(420)
    expect(row.healthcare?.total).toBe(1_770)
    expect(row.spending).toBe(1_770)
    expect(row.withdrawalsByAccount.cash).toBeCloseTo(1_770, 1)
    expect(row.healthcare?.byPhase.employer.premium).toBe(600)
  })

  it('uses component inflation overrides without double inflation', () => {
    const scenario: Scenario = {
      ...baseScenario,
      assumptions: { ...baseScenario.assumptions, durationYears: 1 },
      healthcare: {
        annualInflationRate: 0.12,
        phases: [
          {
            id: 'medicare',
            kind: 'medicare',
            startMonth: '2027-01',
            endMonthExclusive: '2028-01',
            currency: 'USD',
            medicareComponents: [
              {
                id: 'part-b',
                kind: 'part_b',
                monthlyPremium: 100,
                annualInflationRate: 0.03,
              },
              {
                id: 'part-d',
                kind: 'part_d',
                monthlyPremium: 50,
              },
            ],
          },
        ],
      },
    }

    const row = projectScenario(scenario).rows[0]
    const expected = Array.from(
      { length: 12 },
      (_, month) =>
        100 * Math.pow(1.03, (12 + month) / 12) +
        50 * Math.pow(1.12, (12 + month) / 12)
    ).reduce((total, amount) => total + amount, 0)
    expect(row.healthcare?.premium).toBeCloseTo(expected, 2)
    expect(row.healthcare?.byPhase.medicare.outOfPocket).toBe(0)
  })

  it('uses annual MAGI for ACA contribution and cap checks', () => {
    const scenario: Scenario = {
      ...baseScenario,
      incomeStreams: [
        {
          id: 'income',
          name: 'Income',
          owner: 'primary',
          currency: 'USD',
          gross: 24_000,
          start: { age: 1 },
          annualGrowthRate: 0,
          taxCategory: 'ordinary',
          reliability: 1,
          includedInBase: true,
        },
      ],
      healthcare: {
        annualInflationRate: 0,
        phases: [
          {
            id: 'aca',
            kind: 'aca',
            startMonth: '2027-01',
            endMonthExclusive: '2028-01',
            currency: 'USD',
            monthlyPremium: 300,
            monthlyOutOfPocket: 0,
          },
        ],
        aca: acaConfig(),
      },
    }

    const row = projectScenario(scenario).rows[0]
    expect(row.healthcare?.subsidy).toBe(1_200)
    expect(row.healthcare?.total).toBe(2_400)
  })

  it('enforces the lower and upper FPL boundaries and reports crossing cost', () => {
    const below = projectScenario(aca2026Scenario(15_649)).rows[0].healthcare
      ?.acaByTaxYear?.['2026']
    const atMinimum = projectScenario(aca2026Scenario(15_650)).rows[0]
      .healthcare?.acaByTaxYear?.['2026']
    const atCliff = projectScenario(aca2026Scenario(62_600)).rows[0].healthcare
      ?.acaByTaxYear?.['2026']
    const above = projectScenario(aca2026Scenario(62_601)).rows[0].healthcare
      ?.acaByTaxYear?.['2026']

    expect(below).toMatchObject({
      eligibilityStatus: 'below_minimum_fpl',
      eligibleForPremiumTaxCredit: false,
      amountBelowMinimum: 1,
    })
    expect(atMinimum).toMatchObject({
      eligibilityStatus: 'eligible',
      eligibleForPremiumTaxCredit: true,
    })
    expect(atCliff).toMatchObject({
      cliffThreshold: 62_600,
      fplPercent: 400,
      eligibilityStatus: 'eligible',
      costOfCrossingCliff: 0,
    })
    expect(above).toMatchObject({
      amountOverCliff: 1,
      eligibilityStatus: 'above_maximum_fpl',
      eligibleForPremiumTaxCredit: false,
      costOfCrossingCliff: 5_740,
    })
  })

  it('uses explicit tax-family size instead of filing status', () => {
    const row = projectScenario(aca2026Scenario(84_600, 2)).rows[0].healthcare
      ?.acaByTaxYear?.['2026']

    expect(row).toMatchObject({
      annualFpl: 21_150,
      cliffThreshold: 84_600,
      eligibilityStatus: 'eligible',
    })
  })

  it('fails closed for married-filing-separately without an exception input', () => {
    const scenario = aca2026Scenario(30_000)
    expect(() =>
      projectScenario({
        ...scenario,
        profile: {
          ...scenario.profile,
          filingStatus:
            'married_filing_separately' as unknown as typeof scenario.profile.filingStatus,
        },
      })
    ).toThrow('not modeled for married-filing-separately')
  })

  it('rejects zero-valued FPL rules before producing non-finite percentages', () => {
    const scenario = aca2026Scenario(30_000)
    expect(() =>
      projectScenario({
        ...scenario,
        healthcare: {
          ...scenario.healthcare!,
          aca: {
            ...scenario.healthcare!.aca!,
            rulesByTaxYear: {
              '2026': { ...ACA_RULE_2026, annualBaseFpl: 0 },
            },
          },
        },
      })
    ).toThrow('must be positive')
  })

  it('rejects invalid rule metadata before projection', () => {
    const scenario = aca2026Scenario(30_000)
    expect(() =>
      projectScenario({
        ...scenario,
        healthcare: {
          ...scenario.healthcare!,
          aca: {
            ...scenario.healthcare!.aca!,
            rulesByTaxYear: {
              '2026': { ...ACA_RULE_2026, effectiveDate: '2026-02-30' },
            },
          },
        },
      })
    ).toThrow('valid effective date')
    expect(() =>
      projectScenario({
        ...scenario,
        healthcare: {
          ...scenario.healthcare!,
          aca: {
            ...scenario.healthcare!.aca!,
            rulesByTaxYear: {
              '2026': {
                ...ACA_RULE_2026,
                status: 'unverified' as never,
              },
            },
          },
        },
      })
    ).toThrow('invalid status')
  })

  it('uses the official 2026 HHS guideline for 2027 projections', () => {
    const rules = buildAcaRules(2027, 2027)
    expect(rules['2027']).toMatchObject({
      annualBaseFpl: ACA_RULE_2027.annualBaseFpl,
      annualAdditionalPersonFpl: ACA_RULE_2027.annualAdditionalPersonFpl,
      status: 'official',
    })
  })

  it('adds the non-taxable Social Security portion to ACA MAGI', () => {
    const scenario: Scenario = {
      ...baseScenario,
      profile: {
        ...baseScenario.profile,
        currentAge: 67,
        targetRetirementAge: 67,
      },
      assumptions: { ...baseScenario.assumptions, durationYears: 1 },
      socialSecurityBenefits: [
        {
          id: 'social-security',
          name: 'Social Security',
          benefitType: 'worker',
          owner: 'household',
          currency: 'USD',
          primaryInsuranceAmount: 1_000,
          fullRetirementAge: 67,
          claimAge: 67,
          annualCOLARate: 0,
          taxableFraction: 0.85,
          reliability: 1,
          includedInBase: true,
        },
      ],
      healthcare: {
        annualInflationRate: 0,
        phases: [
          {
            id: 'aca',
            kind: 'aca',
            startMonth: '2027-01',
            endMonthExclusive: '2028-01',
            currency: 'USD',
            monthlyPremium: 300,
            monthlyOutOfPocket: 0,
          },
        ],
        aca: acaConfig(),
      },
    }

    const row = projectScenario(scenario).rows[0]
    expect(row.healthcare?.acaByTaxYear?.['2027']?.magi).toBe(12_000)
  })

  it('requires an exact rule for every ACA-covered tax year and January alignment', () => {
    const missingRule: Scenario = {
      ...aca2026Scenario(20_000),
      assumptions: {
        ...aca2026Scenario(20_000).assumptions,
        asOfDate: '2026-01-01',
      },
      healthcare: {
        ...aca2026Scenario(20_000).healthcare!,
        phases: [
          {
            id: 'aca',
            kind: 'aca',
            startMonth: '2027-01',
            endMonthExclusive: '2028-01',
            currency: 'USD',
            monthlyPremium: 300,
            monthlyOutOfPocket: 0,
          },
        ],
      },
    }
    expect(() => projectScenario(missingRule)).toThrow(
      'Missing ACA FPL rule for tax year 2027'
    )

    const nonJanuary: Scenario = {
      ...missingRule,
      assumptions: { ...missingRule.assumptions, asOfDate: '2026-02-01' },
      healthcare: {
        ...missingRule.healthcare!,
        aca: acaConfig(),
      },
    }
    expect(() => projectScenario(nonJanuary)).toThrow('January-aligned')
  })

  it('keeps ACA feedback from pretax withdrawals deterministic', () => {
    const scenario: Scenario = {
      ...baseScenario,
      accounts: [
        {
          id: 'retirement',
          name: 'Retirement',
          type: '401k',
          currency: 'USD',
          balance: 100_000,
          annualReturnRate: 0,
          separationAge: 55,
        },
      ],
      spendingStreams: [
        {
          id: 'living',
          category: 'Living expenses',
          owner: 'primary',
          currency: 'USD',
          amount: 50_000,
          start: { age: 60 },
          annualInflationRate: 0,
          essential: true,
          reduciblePercent: 0,
        },
      ],
      healthcare: {
        annualInflationRate: 0,
        phases: [
          {
            id: 'aca',
            kind: 'aca',
            startMonth: '2027-01',
            endMonthExclusive: '2028-01',
            currency: 'USD',
            monthlyPremium: 300,
            monthlyOutOfPocket: 0,
          },
        ],
        aca: acaConfig({
          rulesByTaxYear: {
            '2027': { ...acaRule2027, annualBaseFpl: 12_500 },
          },
        }),
      },
    }

    const first = projectScenario(scenario).rows[0]
    const second = projectScenario(scenario).rows[0]
    expect(first.healthcare?.total).toBeGreaterThan(0)
    expect(second.healthcare?.total).toBe(first.healthcare?.total)
    expect(second.withdrawalsByAccount.retirement).toBe(
      first.withdrawalsByAccount.retirement
    )
  })

  it('fails closed for overlapping phases and out-of-horizon shocks', () => {
    const overlapping: Scenario = {
      ...baseScenario,
      healthcare: {
        annualInflationRate: 0,
        phases: [
          {
            id: 'one',
            kind: 'employer',
            startMonth: '2027-01',
            endMonthExclusive: '2027-07',
            currency: 'USD',
            monthlyPremium: 1,
            monthlyOutOfPocket: 0,
          },
          {
            id: 'two',
            kind: 'aca',
            startMonth: '2027-06',
            endMonthExclusive: '2028-01',
            currency: 'USD',
            monthlyPremium: 1,
            monthlyOutOfPocket: 0,
          },
        ],
      },
    }
    expect(() => projectScenario(overlapping)).toThrow('overlap')

    const outOfHorizon: Scenario = {
      ...baseScenario,
      healthcare: {
        annualInflationRate: 0,
        phases: [],
        shocks: [{ id: 'shock', month: '2029-01', amount: 1, currency: 'USD' }],
      },
    }
    expect(() => projectScenario(outOfHorizon)).toThrow(
      'outside the projection horizon'
    )
  })
})
