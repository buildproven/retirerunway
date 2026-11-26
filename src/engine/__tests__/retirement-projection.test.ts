// The v2 retirement projection (REQ-MCP-39, REQ-MCP-40): values, not shape.
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { calculatePortfolioValue } from '../portfolio-math'
import {
  DEFAULT_PLANNING_AGE,
  bucketOf,
  projectRetirement,
  projectionCharts,
  projectionWarnings,
  rmdDivisor,
  startingBuckets,
  taxableSocialSecurity,
} from '../retirement-projection'
import type { AccountType, Portfolio, UserProfile } from '../types'

function account(
  id: string,
  accountType: AccountType,
  value: number,
  basis = value
) {
  return {
    id,
    name: id,
    institution: 'Test',
    accountType,
    cds: [],
    cashBalance: 0,
    holdings: [
      {
        id: `${id}-eq`,
        symbol: 'EQ',
        name: 'Equity',
        assetClass: 'us_equity' as const,
        shares: 1,
        costBasis: basis * 0.6,
        currentPrice: value * 0.6,
        currentValue: value * 0.6,
      },
      {
        id: `${id}-bd`,
        symbol: 'BD',
        name: 'Bond',
        assetClass: 'us_bond' as const,
        shares: 1,
        costBasis: basis * 0.4,
        currentPrice: value * 0.4,
        currentValue: value * 0.4,
      },
    ],
  }
}

function portfolio(...accounts: ReturnType<typeof account>[]): Portfolio {
  return { id: 'p', name: 'Test', asOfDate: '2026-11-17', accounts }
}

const base: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 90_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 4_000,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
}

const mixed = portfolio(
  account('k', '401k', 800_000),
  account('b', 'brokerage', 100_000, 60_000),
  account('r', 'roth_ira', 50_000),
  account('n', 'nqdc', 100_000)
)

const yearAt = (result: ReturnType<typeof projectRetirement>, age: number) => {
  const year = result.expectedPath.years.find(y => y.age === age)
  if (year === undefined) throw new Error(`no year ${age}`)
  return year
}

describe('REQ-MCP-39: accounts, rules and tax', () => {
  it('REQ-MCP-39 puts each account type in its bucket and keeps the portfolio total', () => {
    expect(bucketOf('brokerage')).toBe('taxable')
    expect(bucketOf('401k')).toBe('employerPlan')
    expect(bucketOf('457b')).toBe('employerPlan')
    expect(bucketOf('rollover_ira')).toBe('ira')
    expect(bucketOf('roth_401k')).toBe('roth')
    expect(bucketOf('hsa')).toBe('roth')
    expect(bucketOf('nqdc')).toBe('nqdc')
    const start = startingBuckets(mixed)
    expect(start.balances).toEqual({
      taxable: 100_000,
      employerPlan: 800_000,
      ira: 0,
      roth: 50_000,
      nqdc: 100_000,
    })
    expect(Object.values(start.balances).reduce((a, b) => a + b, 0)).toBe(
      calculatePortfolioValue(mixed)
    )
    expect(start.taxableGainFraction).toBeCloseTo(0.4, 10)
  })

  it('REQ-MCP-39 taxes Social Security by the IRS provisional-income formula', () => {
    const mfj = 'married_filing_jointly'
    expect(taxableSocialSecurity(75_000, 0, mfj)).toBe(2_750)
    expect(taxableSocialSecurity(75_000, 50_000, mfj)).toBe(42_975)
    expect(taxableSocialSecurity(40_000, 1_000_000, mfj)).toBe(34_000)
    expect(taxableSocialSecurity(30_000, 5_000, 'single')).toBe(0)
    expect(taxableSocialSecurity(0, 100_000, mfj)).toBe(0)
  })

  it('REQ-MCP-39 uses the Uniform Lifetime Table from 75', () => {
    expect(rmdDivisor(74)).toBeUndefined()
    expect(rmdDivisor(75)).toBe(24.6)
    expect(rmdDivisor(90)).toBe(12.2)
    expect(rmdDivisor(110)).toBe(4.6)
  })

  it('REQ-MCP-39 starts withdrawals at the retirement age, not the year after', () => {
    const result = projectRetirement(mixed, base, { paths: 10 })
    expect(yearAt(result, 59).withdrawals.total).toBe(0)
    expect(yearAt(result, 60).withdrawals.total).toBeGreaterThan(0)
  })

  it('REQ-MCP-39 draws taxable money first, then the 401(k), and Roth last', () => {
    const noNqdc = portfolio(
      account('k', '401k', 600_000),
      account('b', 'brokerage', 100_000, 60_000),
      account('r', 'roth_ira', 200_000)
    )
    const result = projectRetirement(noNqdc, base, { paths: 1 })
    const first = yearAt(result, 60)
    expect(first.withdrawals.taxable).toBeGreaterThan(0)
    expect(first.withdrawals.employerPlan).toBe(0)
    expect(first.withdrawals.roth).toBe(0)
    let previous = yearAt(result, 59)
    for (const year of result.expectedPath.years.filter(y => y.age >= 60)) {
      // The 401(k) pays only once taxable money is used up (RMDs aside), and
      // Roth only once the 401(k) is.
      if (year.withdrawals.employerPlan > year.rmd + 1) {
        expect(year.endBalances.taxable).toBeLessThanOrEqual(1)
      }
      if (year.withdrawals.roth > 0)
        expect(previous.endBalances.employerPlan).toBeLessThan(
          year.withdrawals.total
        )
      previous = year
    }
    expect(
      result.expectedPath.years.some(y => y.withdrawals.employerPlan > 0)
    ).toBe(true)
  })

  it('REQ-MCP-39 charges the 10% penalty before 59½ unless the Rule of 55 applies', () => {
    const k = portfolio(account('k', '401k', 1_500_000))
    const early = { ...base, targetRetirementAge: 56, annualContributions: 0 }
    const noRule = projectRetirement(
      k,
      { ...early, separationAge: 54 },
      { paths: 1 }
    )
    const rule55 = projectRetirement(
      k,
      { ...early, separationAge: 56 },
      { paths: 1 }
    )
    expect(yearAt(noRule, 57).taxes.penalty).toBeGreaterThan(0)
    expect(yearAt(noRule, 57).taxes.penalty).toBeCloseTo(
      yearAt(noRule, 57).withdrawals.employerPlan * 0.1,
      -1
    )
    expect(rule55.expectedPath.lifetimePenalty).toBe(0)
    expect(yearAt(noRule, 60).taxes.penalty).toBe(0)
    // The Rule of 55 covers the employer plan, not an IRA.
    const ira = portfolio(account('i', 'rollover_ira', 1_500_000))
    const iraRule = projectRetirement(
      ira,
      { ...early, separationAge: 56 },
      { paths: 1 }
    )
    expect(yearAt(iraRule, 57).taxes.penalty).toBeGreaterThan(0)
  })

  it('REQ-MCP-39 charges no 10% penalty on a 457(b) after separation, at any age', () => {
    const early = {
      ...base,
      currentAge: 51,
      targetRetirementAge: 52,
      separationAge: 52,
      annualContributions: 0,
    }
    const g = projectRetirement(
      portfolio(account('g', '457b', 1_500_000)),
      early,
      { paths: 1 }
    )
    expect(yearAt(g, 53).withdrawals.employerPlan).toBeGreaterThan(0)
    expect(g.expectedPath.lifetimePenalty).toBe(0)
    // Mixed with a 401(k): the 457(b) pays first, penalty free; once it is
    // used up the 401(k) pays with the penalty until 60.
    const mixed457 = projectRetirement(
      portfolio(account('g', '457b', 300_000), account('k', '401k', 1_500_000)),
      early,
      { paths: 1 }
    )
    expect(yearAt(mixed457, 53).taxes.penalty).toBe(0)
    expect(yearAt(mixed457, 58).taxes.penalty).toBeGreaterThan(0)
    const all401k = projectRetirement(
      portfolio(account('k', '401k', 1_800_000)),
      early,
      { paths: 1 }
    )
    expect(mixed457.expectedPath.lifetimePenalty).toBeGreaterThan(0)
    expect(mixed457.expectedPath.lifetimePenalty).toBeLessThan(
      all401k.expectedPath.lifetimePenalty
    )
    // Savings into an all-457(b) plan stay penalty free.
    const saving = projectRetirement(
      portfolio(account('g', '457b', 300_000)),
      { ...early, currentAge: 45, annualContributions: 30_000 },
      { paths: 1 }
    )
    expect(yearAt(saving, 53).withdrawals.employerPlan).toBeGreaterThan(0)
    expect(saving.expectedPath.lifetimePenalty).toBe(0)
    // Before separation the 457(b) cannot pay, and penalized 401(k)
    // withdrawals then do not use it up: from separation it pays penalty free.
    const lateSeparation = projectRetirement(
      portfolio(account('g', '457b', 300_000), account('k', '401k', 1_500_000)),
      { ...early, separationAge: 54 },
      { paths: 1 }
    )
    expect(yearAt(lateSeparation, 53).taxes.penalty).toBeGreaterThan(0)
    expect(yearAt(lateSeparation, 54).taxes.penalty).toBe(0)
    expect(lateSeparation.expectedPath.lifetimePenalty).toBeLessThan(
      projectRetirement(
        portfolio(account('k', '401k', 1_800_000)),
        { ...early, separationAge: 54 },
        { paths: 1 }
      ).expectedPath.lifetimePenalty
    )
  })

  it('REQ-MCP-39 takes RMDs from 75 even when income covers spending', () => {
    const k = portfolio(account('k', '401k', 1_000_000))
    const rich = {
      ...base,
      annualExpenses: 40_000,
      socialSecurityMonthly: 6_000,
    }
    const result = projectRetirement(k, rich, { paths: 1 })
    const at74 = yearAt(result, 74)
    const at75 = yearAt(result, 75)
    expect(at74.rmd).toBe(0)
    // Today's dollars: the year-74 balance is a year less inflated.
    expect(at75.rmd).toBeCloseTo(
      at74.endBalances.employerPlan / 24.6 / 1.03,
      -1
    )
    // The surplus after tax is kept, in the taxable bucket.
    expect(at75.endBalances.taxable).toBeGreaterThan(at74.endBalances.taxable)
  })

  it('REQ-MCP-39 pays NQDC in equal shares over the payout years', () => {
    const n = portfolio(
      account('k', '401k', 500_000),
      account('n', 'nqdc', 140_000)
    )
    const result = projectRetirement(
      n,
      { ...base, nqdcPayout: { startAge: 60, years: 7 } },
      { paths: 1 }
    )
    expect(yearAt(result, 59).withdrawals.nqdc).toBe(0)
    expect(yearAt(result, 60).withdrawals.nqdc).toBeGreaterThan(0)
    expect(yearAt(result, 66).endBalances.nqdc).toBe(0)
    expect(yearAt(result, 67).withdrawals.nqdc).toBe(0)
    // Without a schedule it is one lump sum at retirement.
    const lump = projectRetirement(n, base, { paths: 1 })
    expect(yearAt(lump, 60).endBalances.nqdc).toBe(0)
    expect(yearAt(lump, 60).taxes.federal).toBeGreaterThan(
      yearAt(result, 60).taxes.federal
    )
  })

  it('REQ-MCP-39 exempts retirement withdrawals from state tax where the state does', () => {
    const k = portfolio(account('k', '401k', 1_500_000))
    const taxed = projectRetirement(k, base, { paths: 1 })
    const exempt = projectRetirement(
      k,
      { ...base, stateExemptsRetirementIncome: true },
      { paths: 1 }
    )
    expect(yearAt(taxed, 61).taxes.state).toBeGreaterThan(0)
    expect(yearAt(exempt, 61).taxes.state).toBe(0)
  })

  it('REQ-MCP-39 grows tax faster than spending (brackets are progressive)', () => {
    const k = portfolio(account('k', '401k', 3_000_000))
    const low = yearAt(
      projectRetirement(k, { ...base, annualExpenses: 60_000 }, { paths: 1 }),
      61
    )
    const high = yearAt(
      projectRetirement(k, { ...base, annualExpenses: 180_000 }, { paths: 1 }),
      61
    )
    expect(high.taxes.federal / high.withdrawals.total).toBeGreaterThan(
      low.taxes.federal / low.withdrawals.total
    )
  })
})

describe('REQ-MCP-40: household, horizon, success rate and charts', () => {
  it('REQ-MCP-40 projects to age 95 by default, or to planningAge', () => {
    expect(DEFAULT_PLANNING_AGE).toBe(95)
    const result = projectRetirement(mixed, base, { paths: 10 })
    expect(result.expectedPath.years.at(-1)?.age).toBe(95)
    expect(result.monteCarlo.percentiles).toHaveLength(95 - 53)
    const to90 = projectRetirement(
      mixed,
      { ...base, planningAge: 90 },
      { paths: 10 }
    )
    expect(to90.expectedPath.years.at(-1)?.age).toBe(90)
  })

  it('REQ-MCP-40 takes whole-year current and planning ages only', () => {
    expect(userProfileSchema.safeParse(base).success).toBe(true)
    for (const bad of [
      { ...base, currentAge: 53.5 },
      { ...base, planningAge: 95.5 },
      {
        ...base,
        filingStatus: 'married_joint' as const,
        spouse: { currentAge: 51.5 },
      },
      // Whole ages for retirement, claiming and spending phases too: the
      // historical replay and phase lookups index by whole age.
      { ...base, targetRetirementAge: 60.5 },
      { ...base, socialSecurityAge: 67.5 },
      { ...base, spendingPhases: [{ startAge: 65.5, annualExpenses: 1 }] },
    ]) {
      expect(userProfileSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('REQ-MCP-40 projects a fractional current or planning age without failing', () => {
    for (const profile of [
      { ...base, currentAge: 53.5 },
      { ...base, planningAge: 95.5 },
    ]) {
      const result = projectRetirement(mixed, profile, { paths: 10 })
      expect(result.monteCarlo.percentiles).toHaveLength(
        result.expectedPath.years.length
      )
      expect(result.monteCarlo.percentiles.map(p => p.age)).toEqual(
        result.expectedPath.years.map(y => y.age)
      )
      expect(result.monteCarlo.successRate).toBeGreaterThanOrEqual(0)
      expect(result.monteCarlo.successRate).toBeLessThanOrEqual(1)
    }
  })

  it("REQ-MCP-40 adds the spouse's Social Security from the spouse's own claiming age", () => {
    const spouse = {
      currentAge: 51,
      socialSecurityAge: 67,
      socialSecurityMonthly: 2_000,
    }
    const result = projectRetirement(mixed, { ...base, spouse }, { paths: 10 })
    // Primary claims at 67; the spouse turns 67 when the primary is 69.
    expect(yearAt(result, 67).socialSecurity).toBe(48_000)
    expect(yearAt(result, 68).socialSecurity).toBe(48_000)
    expect(yearAt(result, 69).socialSecurity).toBe(72_000)
    expect(yearAt(result, 69).spouseAge).toBe(67)
    expect(result.filingStatus).toBe('married_filing_jointly')
    const alone = projectRetirement(mixed, base, { paths: 200 })
    const both = projectRetirement(mixed, { ...base, spouse }, { paths: 200 })
    expect(both.monteCarlo.successRate).toBeGreaterThanOrEqual(
      alone.monteCarlo.successRate
    )
  })

  it('REQ-MCP-40 adds pre-Medicare healthcare until 65, half while a younger spouse is under 65', () => {
    const spouse = {
      currentAge: 52,
      socialSecurityAge: 67,
      socialSecurityMonthly: 2_000,
    }
    const result = projectRetirement(
      mixed,
      { ...base, spouse, preMedicareHealthcare: 30_000 },
      { paths: 10 }
    )
    expect(yearAt(result, 59).healthcare).toBe(0)
    expect(yearAt(result, 60).healthcare).toBe(30_000)
    expect(yearAt(result, 64).healthcare).toBe(30_000)
    expect(yearAt(result, 65).healthcare).toBe(15_000)
    expect(yearAt(result, 66).healthcare).toBe(0)
  })

  it('REQ-MCP-40 lowers the success rate as spending rises, and raises it with savings', () => {
    const rate = (profile: UserProfile) =>
      projectRetirement(mixed, profile, { paths: 300 }).monteCarlo.successRate
    const spendMore = [60_000, 90_000, 120_000].map(spend =>
      rate({ ...base, annualExpenses: spend })
    )
    expect(spendMore[0]).toBeGreaterThan(spendMore[1])
    expect(spendMore[1]).toBeGreaterThan(spendMore[2])
    expect(rate({ ...base, annualContributions: 60_000 })).toBeGreaterThan(
      rate(base)
    )
  })

  it('REQ-MCP-40 gives byte-identical output for the same inputs and seed', () => {
    const a = projectRetirement(mixed, base, { seed: 7, paths: 200 })
    const b = projectRetirement(mixed, base, { seed: 7, paths: 200 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const c = projectRetirement(mixed, base, { seed: 8, paths: 200 })
    expect(c.monteCarlo.percentiles).not.toEqual(a.monteCarlo.percentiles)
  })

  it('REQ-MCP-40 reports where failing paths run out, and orders the percentile band', () => {
    const tight = projectRetirement(
      mixed,
      { ...base, annualExpenses: 140_000 },
      { paths: 300 }
    )
    expect(tight.monteCarlo.successRate).toBeLessThan(0.5)
    const depletion = tight.monteCarlo.depletionAge
    expect(depletion).not.toBeNull()
    expect(depletion?.p10).toBeLessThanOrEqual(depletion?.p50 ?? 0)
    expect(depletion?.p10).toBeGreaterThanOrEqual(60)
    for (const band of tight.monteCarlo.percentiles) {
      expect(band.p10).toBeLessThanOrEqual(band.p50)
      expect(band.p50).toBeLessThanOrEqual(band.p90)
    }
  })

  it('REQ-MCP-40 builds three charts with one value per age per series', () => {
    const result = projectRetirement(mixed, base, { paths: 50 })
    const charts = projectionCharts(result)
    for (const chart of Object.values(charts)) {
      expect(chart.x.length).toBe(95 - 53)
      for (const series of chart.series)
        expect(series.values).toHaveLength(chart.x.length)
      expect(chart.series.length).toBeLessThanOrEqual(6)
    }
    expect(charts.balanceByAge.series[1].values).toEqual(
      result.monteCarlo.percentiles.map(band => band.p50)
    )
    const at60 = charts.incomeAndSpendingByAge.x.indexOf(60)
    expect(charts.incomeAndSpendingByAge.series[2].values[at60]).toBe(
      yearAt(result, 60).withdrawals.total
    )
  })

  it('REQ-MCP-40 warns about inputs it ignores or misses', () => {
    const warnings = projectionWarnings(mixed, {
      ...base,
      withdrawalTaxRate: 0.1,
      stateTaxRate: undefined,
    })
    expect(warnings.join('\n')).toMatch(/withdrawalTaxRate .* ignored/)
    expect(warnings.join('\n')).toMatch(/no preMedicareHealthcare/)
    expect(warnings.join('\n')).toMatch(/no nqdcPayout/)
    expect(warnings.join('\n')).toMatch(/no stateTaxRate/)
    const doubled = projectionWarnings(mixed, {
      ...base,
      preMedicareHealthcare: 30_000,
      nqdcPayout: { startAge: 60, years: 5 },
      spendingPhases: [{ startAge: 60, annualExpenses: 120_000 }],
    })
    expect(doubled).toEqual([
      'check that spendingPhases from 60 do not also include health insurance (preMedicareHealthcare adds it)',
    ])
  })

  it('REQ-MCP-40 names the mortgage payment taken to be inside spending and when it stops', () => {
    const mortgage = {
      balance: 300_000,
      asOfDate: '2026-11-02',
      rate: 0.02875,
      monthlyPayment: 1_450.0,
      payoffDate: '2050-11-01',
    }
    const warnings = projectionWarnings(mixed, { ...base, mortgage })
    const text = warnings.join('\n')
    expect(text).toMatch(/include the mortgage payment of \$17,400\/yr/)
    expect(text).toMatch(/it stops at 77/)
    expect(text).not.toMatch(/cannot include it/)

    const sold = projectionWarnings(mixed, {
      ...base,
      mortgage,
      homeSale: { age: 60 },
    })
    expect(sold.join('\n')).toMatch(/it stops at 60/)

    const tooLow = projectionWarnings(mixed, {
      ...base,
      mortgage,
      annualExpenses: 12_000,
      spendingPhases: undefined,
    })
    expect(tooLow.join('\n')).toMatch(
      /spending at 60 \(\$12,000\) is below the mortgage payment \(\$17,400\/yr\), so it cannot include it/
    )

    const none = projectionWarnings(mixed, { ...base, mortgage: undefined })
    expect(none.join('\n')).not.toMatch(/mortgage payment/)
  })
})
