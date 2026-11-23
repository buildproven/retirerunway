import type { Scenario } from './types'

export interface RegressionFixture {
  readonly id: string
  readonly description: string
  readonly scenario: Scenario
  readonly expected: Readonly<{
    age: number
    income?: number
    spending?: number
    withdrawal?: Readonly<Record<string, number>>
    fundingGap?: number
    endBalance?: Readonly<Record<string, number>>
  }>
}

function fixtureScenario(
  id: string,
  profile: Scenario['profile'],
  accounts: Scenario['accounts'],
  incomeStreams: Scenario['incomeStreams'],
  spendingStreams: Scenario['spendingStreams'],
  durationYears = 3,
  baseCurrency = 'USD',
  fxRates: Scenario['fxRates'] = []
): Scenario {
  return {
    id,
    profile,
    assumptions: {
      durationYears,
      inflationRate: 0,
      asOfDate: '2026-01-01',
      baseCurrency,
    },
    fxRates,
    accounts,
    incomeStreams,
    spendingStreams,
    lifeEvents: [],
  }
}

const profile = {
  currentAge: 54,
  targetRetirementAge: 55,
  filingStatus: 'married_filing_jointly' as const,
}

const spending = (amount: number, currency = 'USD') => ({
  id: 'essential-spend',
  category: 'essential living',
  owner: 'household' as const,
  currency,
  amount,
  start: { age: 55 },
  annualInflationRate: 0,
  essential: true,
  reduciblePercent: 0,
})

const income = (
  id: string,
  gross: number,
  startAge: number,
  currency = 'USD',
  owner: 'primary' | 'spouse' = 'primary'
) => ({
  id,
  name: id,
  owner,
  currency,
  gross,
  start: { age: startAge },
  annualGrowthRate: 0,
  taxCategory: 'ordinary' as const,
  reliability: 1,
  includedInBase: true,
})

const account = (
  id: string,
  type: Scenario['accounts'][number]['type'],
  balance: number,
  options: Partial<Scenario['accounts'][number]> = {}
) => ({
  id,
  name: id,
  type,
  currency: 'USD',
  balance,
  annualReturnRate: 0,
  ...options,
})

export const REGRESSION_FIXTURES: readonly RegressionFixture[] = [
  {
    id: 'married-knoxville-outside-income',
    description:
      'Married Knoxville household with $150K demonstrated outside income.',
    scenario: fixtureScenario(
      'married-knoxville-outside-income',
      profile,
      [account('bridge', 'brokerage', 100_000)],
      [income('outside-income', 150_000, 55)],
      [spending(100_000)]
    ),
    expected: { age: 55, income: 150_000, spending: 100_000, fundingGap: 0 },
  },
  {
    id: 'married-south-australia-fx',
    description:
      'Married South Australia scenario converts effective-date AUD values to USD.',
    scenario: fixtureScenario(
      'married-south-australia-fx',
      profile,
      [account('aud-bridge', 'brokerage', 100_000, { currency: 'AUD' })],
      [income('aud-income', 100_000, 55, 'AUD')],
      [spending(75_000, 'AUD')],
      2,
      'USD',
      [{ from: 'AUD', to: 'USD', effectiveDate: '2026-01-01', rate: 0.66 }]
    ),
    expected: { age: 55, income: 66_000, spending: 49_500, fundingGap: 0 },
  },
  {
    id: 'divorced-roanoke-no-maintenance',
    description: 'Divorced Roanoke household with no maintenance income.',
    scenario: fixtureScenario(
      'divorced-roanoke-no-maintenance',
      { ...profile, filingStatus: 'single' },
      [account('bridge', 'brokerage', 100_000)],
      [],
      [spending(50_000)]
    ),
    expected: {
      age: 55,
      income: 0,
      spending: 50_000,
      withdrawal: { bridge: 50_000 },
    },
  },
  {
    id: 'divorced-knoxville-maintenance',
    description: 'Divorced Knoxville household with $50K maintenance income.',
    scenario: fixtureScenario(
      'divorced-knoxville-maintenance',
      { ...profile, filingStatus: 'single' },
      [account('bridge', 'brokerage', 100_000)],
      [income('maintenance', 50_000, 55)],
      [spending(60_000)]
    ),
    expected: {
      age: 55,
      income: 50_000,
      spending: 60_000,
      withdrawal: { bridge: 13_877.5 },
    },
  },
  {
    id: 'rule-55-qualifying-withdrawal',
    description: 'Employer 401(k) is accessible after separation at age 55.',
    scenario: fixtureScenario(
      'rule-55-qualifying-withdrawal',
      { ...profile, filingStatus: 'single' },
      [account('employer-plan', '401k', 100_000, { separationAge: 55 })],
      [],
      [spending(40_000)]
    ),
    expected: {
      age: 55,
      withdrawal: { 'employer-plan': 43_042.61 },
      fundingGap: 0,
    },
  },
  {
    id: 'rule-55-nonqualifying-rollover',
    description: 'A rollover IRA remains restricted before age 59½.',
    scenario: fixtureScenario(
      'rule-55-nonqualifying-rollover',
      { ...profile, filingStatus: 'single' },
      [account('rollover', 'rollover_ira', 100_000)],
      [],
      [spending(40_000)]
    ),
    expected: { age: 55, withdrawal: {}, fundingGap: 40_000 },
  },
  {
    id: 'social-security-at-62',
    description:
      'Worker Social Security claimed at 62 is represented as dated income.',
    scenario: fixtureScenario(
      'social-security-at-62',
      { ...profile, currentAge: 61, filingStatus: 'single' },
      [account('bridge', 'brokerage', 100_000)],
      [income('social-security', 24_000, 62)],
      [spending(30_000)]
    ),
    expected: { age: 62, income: 24_000, withdrawal: { bridge: 6_830 } },
  },
  {
    id: 'spouse-and-divorced-spouse-benefit',
    description:
      'Household benefit streams remain explicit and independently auditable.',
    scenario: fixtureScenario(
      'spouse-and-divorced-spouse-benefit',
      { ...profile, currentAge: 61, filingStatus: 'single' },
      [account('bridge', 'brokerage', 100_000)],
      [
        income('worker-benefit', 24_000, 62),
        income('spouse-benefit', 12_000, 62, 'USD', 'spouse'),
      ],
      [spending(30_000)]
    ),
    expected: { age: 62, income: 36_000, fundingGap: 0 },
  },
  {
    id: 'year-one-market-fall',
    description:
      'A deterministic first-year -30% market return reduces the account balance.',
    scenario: fixtureScenario(
      'year-one-market-fall',
      { ...profile, filingStatus: 'single' },
      [account('portfolio', 'brokerage', 100_000, { annualReturnRate: -0.3 })],
      [],
      [],
      1
    ),
    expected: { age: 55, endBalance: { portfolio: 70_000 } },
  },
  {
    id: 'no-taxable-assets-before-59-half',
    description:
      'A household with only restricted retirement assets reports a liquidity gap.',
    scenario: fixtureScenario(
      'no-taxable-assets-before-59-half',
      { ...profile, filingStatus: 'single' },
      [account('traditional', 'traditional_ira', 100_000)],
      [],
      [spending(30_000)]
    ),
    expected: { age: 55, withdrawal: {}, fundingGap: 30_000 },
  },
  {
    id: 'nqdc-distribution-schedule',
    description:
      'NQDC remains restricted until its explicitly scheduled access age.',
    scenario: fixtureScenario(
      'nqdc-distribution-schedule',
      { ...profile, filingStatus: 'single' },
      [account('nqdc', 'nqdc', 100_000, { accessibleAge: 60 })],
      [],
      [spending(30_000)],
      8
    ),
    expected: { age: 55, withdrawal: {}, fundingGap: 30_000 },
  },
  {
    id: 'age-pension-zero',
    description: 'Age Pension is explicitly zero rather than silently assumed.',
    scenario: fixtureScenario(
      'age-pension-zero',
      { ...profile, filingStatus: 'single' },
      [account('bridge', 'brokerage', 100_000)],
      [],
      [spending(30_000)]
    ),
    expected: { age: 55, income: 0, withdrawal: { bridge: 30_000 } },
  },
]
