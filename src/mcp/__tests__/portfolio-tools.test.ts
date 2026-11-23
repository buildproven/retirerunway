// @vitest-environment node
import { runMonteCarlo } from '../../engine/monte-carlo'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { generateAlerts } from '@/engine/alerts'
import { analyzeAllCDs } from '@/engine/cd-analysis'
import { parsePortfolioCSV } from '@/engine/csv-parser'
import { generateLadderPlan } from '@/engine/ladder-plan'
import { calculateSequenceRisk } from '@/engine/risk-scoring'
import { optimizeRothConversion } from '@/engine/roth-conversion'
import { analyzeRuleOf55 } from '@/engine/rule-of-55'
import { runAllScenarios, runScenario } from '@/engine/scenarios'
import {
  annualExpensesAt,
  calculatePortfolioValue,
} from '@/engine/portfolio-math'
import { calculateTaxBreakdown } from '@/engine/tax-brackets'
import { generateTradePlan } from '@/engine/trade-plan'
import type { Portfolio, UserProfile } from '@/engine/types'
import { stamp } from '../../../skills/retire-runway/scripts/provenance'
import { createPlanServer } from '../server'

const fixtureDir = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'skills',
  'retire-runway',
  'fixtures',
  'csv'
)

function csvFixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf8')
}

const NO_AS_OF_WARNING = 'no as-of date: pass asOfDate'

const FIXTURES = [
  { file: 'fidelity-sample.csv', format: 'fidelity' },
  { file: 'schwab-sample.csv', format: 'schwab' },
  { file: 'vanguard-sample.csv', format: 'vanguard' },
  { file: 'generic-sample.csv', format: 'generic' },
  { file: 'malformed.csv', format: 'generic' },
] as const

const profile: UserProfile = {
  currentAge: 56,
  targetRetirementAge: 57,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2_500,
  stateTaxRate: 0.05,
  federalTaxBracket: 0.22,
}

type Stamp = ReturnType<typeof stamp>

/** A JSON round trip, as values cross the MCP wire. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function errorText(result: CallToolResult): string {
  return result.content
    .map(block => ('text' in block ? block.text : ''))
    .join('\n')
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.isError, errorText(result)).toBeFalsy()
  expect(result.structuredContent, errorText(result)).toBeDefined()
  const text = result.content.find(block => block.type === 'text')
  expect(text && 'text' in text ? JSON.parse(text.text) : undefined).toEqual(
    result.structuredContent
  )
  return result.structuredContent as Record<string, unknown>
}

/** Checks the stamp and that its hashes cover this call's input and output. */
function expectStamp(
  payload: Record<string, unknown>,
  tool: string,
  input: unknown,
  seed?: number
): Stamp {
  const provenance = payload.provenance as Stamp
  const { provenance: _omitted, ...output } = payload
  const reference = stamp(tool, input, output, { seed })
  expect(provenance.tool).toBe(tool)
  expect(provenance.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(provenance.inputHash).toBe(reference.inputHash)
  expect(provenance.outputHash).toBe(reference.outputHash)
  expect(provenance.assumptions).toEqual(expect.any(Object))
  // Only a tool that draws random numbers (portfolio_analysis with Monte Carlo) names a seed.
  expect(provenance.seed).toBe(seed)
  return provenance
}

let client: Client

async function call(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

async function importedPortfolio(): Promise<Portfolio> {
  const payload = structured(
    await call('import_positions', {
      csv: csvFixture('fidelity-sample.csv'),
      asOfDate: '2026-03-01',
    })
  )
  const portfolio = payload.portfolio as Portfolio
  // A CD makes the CD analysis and CD alerts carry real values.
  return {
    ...portfolio,
    accounts: portfolio.accounts.map((account, index) =>
      index === 0
        ? {
            ...account,
            cds: [
              {
                id: 'cd-1',
                institution: 'Ally',
                principal: 50_000,
                apy: 0.045,
                termMonths: 12,
                purchaseDate: '2025-09-01',
                maturityDate: '2026-04-01',
                earlyWithdrawalPenaltyMonths: 3,
              },
            ],
          }
        : account
    ),
  }
}

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createPlanServer().connect(serverTransport)
  client = new Client({ name: 'portfolio-mcp-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('REQ-MCP-5: import_positions', () => {
  for (const { file, format } of FIXTURES) {
    it(`REQ-MCP-5 returns the parsePortfolioCSV result for ${file}`, async () => {
      const csv = csvFixture(file)
      const parsed = parsePortfolioCSV(csv)
      const payload = structured(
        await call('import_positions', { csv, asOfDate: '2026-03-01' })
      )
      expect(payload.format).toBe(format)
      expect(payload.format).toBe(parsed.format)
      expect(payload.warnings).toEqual(parsed.warnings)
      expect(payload.rowsSkipped).toBe(parsed.rowsSkipped)
      expect(payload.rowsImported).toBe(parsed.rowsImported)
      const portfolio = payload.portfolio as Portfolio
      expect(portfolio.accounts).toEqual(wire(parsed.accounts))
      expect(portfolio.asOfDate).toBe('2026-03-01')
      expect(portfolio.id).toMatch(/^loaded-[0-9a-f]{32}$/)
    })
  }

  it('REQ-MCP-5 reports the warnings and skipped rows of a malformed CSV', async () => {
    const payload = structured(
      await call('import_positions', {
        csv: csvFixture('malformed.csv'),
        asOfDate: '2026-03-01',
      })
    )
    expect((payload.portfolio as Portfolio).accounts).toEqual([])
    expect(payload.rowsSkipped).toBe(1)
    expect(payload.warnings).toEqual([])
  })

  it('REQ-MCP-5 returns the parser warning and the as-of warning for an empty CSV', async () => {
    const payload = structured(await call('import_positions', { csv: '' }))
    expect(payload.format).toBe('generic')
    expect((payload.portfolio as Portfolio).accounts).toEqual([])
    expect(payload.rowsSkipped).toBe(0)
    expect(payload.warnings).toEqual(['CSV file is empty', NO_AS_OF_WARNING])
  })

  it('REQ-MCP-5 imports the Fidelity holdings with their values', async () => {
    const payload = structured(
      await call('import_positions', {
        csv: csvFixture('fidelity-sample.csv'),
        asOfDate: '2026-03-01',
      })
    )
    const portfolio = payload.portfolio as Portfolio
    const total = portfolio.accounts
      .flatMap(account => account.holdings)
      .reduce((sum, holding) => sum + holding.currentValue, 0)
    expect(total).toBe(450_000 + 42_000 + 210_000)
    expect(payload.warnings).toEqual([])
  })

  it('REQ-MCP-5 uses the export date in the CSV when asOfDate is absent', async () => {
    const csv = `${csvFixture('fidelity-sample.csv').trimEnd()}\n\n"Date downloaded 01/15/2026 10:30 AM ET"\n`
    const parsed = parsePortfolioCSV(csv)
    const payload = structured(await call('import_positions', { csv }))
    expect((payload.portfolio as Portfolio).asOfDate).toBe('2026-01-15')
    expect(payload.warnings).toEqual(parsed.warnings)
    expect(payload.warnings).not.toContain(NO_AS_OF_WARNING)
  })

  it('REQ-MCP-5 reads an ISO export date from an "as of" line', async () => {
    const csv = `${csvFixture('schwab-sample.csv').trimEnd()}\n"Positions as of 04:01 PM ET, 2026-02-27"\n`
    const payload = structured(await call('import_positions', { csv }))
    expect((payload.portfolio as Portfolio).asOfDate).toBe('2026-02-27')
  })

  it('REQ-MCP-5 prefers the asOfDate argument over the CSV export date', async () => {
    const csv = `${csvFixture('fidelity-sample.csv').trimEnd()}\n"Date downloaded 01/15/2026 10:30 AM ET"\n`
    const payload = structured(
      await call('import_positions', { csv, asOfDate: '2026-03-01' })
    )
    expect((payload.portfolio as Portfolio).asOfDate).toBe('2026-03-01')
  })

  it('REQ-MCP-5 leaves the as-of date out and warns when the CSV has none and asOfDate is absent', async () => {
    const csv = csvFixture('vanguard-sample.csv')
    const parsed = parsePortfolioCSV(csv)
    const payload = structured(await call('import_positions', { csv }))
    expect(payload.portfolio).not.toHaveProperty('asOfDate')
    expect(payload.warnings).toEqual([...parsed.warnings, NO_AS_OF_WARNING])
  })

  it('REQ-MCP-5 ignores an impossible export date in the CSV', async () => {
    const csv = `${csvFixture('fidelity-sample.csv').trimEnd()}\n"Date downloaded 02/30/2026 10:30 AM ET"\n`
    const payload = structured(await call('import_positions', { csv }))
    expect(payload.portfolio).not.toHaveProperty('asOfDate')
    expect(payload.warnings).toContain(NO_AS_OF_WARNING)
  })

  it('REQ-MCP-5 never takes the as-of date from the system clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2031-07-04T12:00:00Z'))
    const csv = csvFixture('generic-sample.csv')
    const first = structured(await call('import_positions', { csv }))
    vi.setSystemTime(new Date('2032-01-01T12:00:00Z'))
    const second = structured(await call('import_positions', { csv }))
    expect(first.portfolio).not.toHaveProperty('asOfDate')
    expect(second.portfolio).toEqual(first.portfolio)
    expect(JSON.stringify(first.portfolio)).not.toMatch(/2031|2032/)
  })

  it('REQ-MCP-5 rejects an impossible asOfDate argument', async () => {
    for (const asOfDate of ['2026-02-30', '03/01/2026']) {
      const result = await call('import_positions', {
        csv: csvFixture('generic-sample.csv'),
        asOfDate,
      })
      expect(result.isError).toBe(true)
      expect(errorText(result)).toMatch(/asOfDate/)
    }
  })

  it('REQ-MCP-5 rejects an unknown argument and a CSV above the size limit', async () => {
    const extra = await call('import_positions', {
      csv: csvFixture('generic-sample.csv'),
      path: '/etc/passwd',
    })
    expect(extra.isError).toBe(true)
    expect(errorText(extra)).toMatch(/path/)

    const huge = await call('import_positions', {
      csv: 'a'.repeat(2_000_001),
    })
    expect(huge.isError).toBe(true)
    expect(huge.structuredContent).toBeUndefined()
  })
})

describe('REQ-MCP-6: portfolio_analysis', () => {
  it('REQ-MCP-6 returns the same risk score, scenarios, ladder, alerts and CD analysis as the engine', async () => {
    const portfolio = await importedPortfolio()
    const payload = structured(
      await call('portfolio_analysis', { portfolio, profile })
    )
    const p = wire(portfolio)
    expect(payload.riskScore).toEqual(wire(calculateSequenceRisk(p, profile)))
    expect(payload.scenarios).toEqual(wire(runAllScenarios(p, profile)))
    expect(payload.ladderPlan).toEqual(wire(generateLadderPlan(p, profile)))
    expect(payload.alerts).toEqual(
      wire(generateAlerts(p, profile, undefined, p.asOfDate))
    )
    const cds = p.accounts.flatMap(account => account.cds)
    expect(payload.cdAnalysis).toEqual(wire(analyzeAllCDs(cds, p.asOfDate)))

    // Values, not only shape.
    const cdAnalysis = payload.cdAnalysis as { cdId: string }[]
    expect(cdAnalysis.map(cd => cd.cdId)).toEqual(['cd-1'])
    expect((payload.scenarios as unknown[]).length).toBe(4)
    const alerts = payload.alerts as { id: string }[]
    expect(alerts.map(alert => alert.id)).toContain('cd-maturity-cd-1')
    const ladder = payload.ladderPlan as { rungs: { year: number }[] }
    expect(ladder.rungs[0]?.year).toBe(2027)

    // Monte Carlo runs by default with seed 42, as /api/v1/analyze does.
    expect(payload.monteCarlo).toEqual(
      wire(runMonteCarlo(p, profile, { seed: 42 }))
    )
    const mc = payload.monteCarlo as { successRate: number }
    expect(mc.successRate).toBeGreaterThanOrEqual(0)
    expect(mc.successRate).toBeLessThanOrEqual(1)

    const provenance = expectStamp(
      payload,
      'portfolio_analysis',
      { portfolio, profile },
      42
    )
    expect(provenance.assumptions).toMatchObject({
      asOfDate: '2026-03-01',
      includeMonteCarlo: true,
    })
  })

  it('REQ-MCP-6 portfolio_analysis takes a seed, and includeMonteCarlo false leaves Monte Carlo out', async () => {
    const portfolio = await importedPortfolio()
    const p = wire(portfolio)
    const seeded = structured(
      await call('portfolio_analysis', { portfolio, profile, seed: 7 })
    )
    expect(seeded.monteCarlo).toEqual(
      wire(runMonteCarlo(p, profile, { seed: 7 }))
    )
    const again = structured(
      await call('portfolio_analysis', { portfolio, profile, seed: 7 })
    )
    expect(again.monteCarlo).toEqual(seeded.monteCarlo)
    expectStamp(
      seeded,
      'portfolio_analysis',
      { portfolio, profile, seed: 7 },
      7
    )

    const off = structured(
      await call('portfolio_analysis', {
        portfolio,
        profile,
        includeMonteCarlo: false,
      })
    )
    expect(off.monteCarlo).toBeUndefined()
    expectStamp(off, 'portfolio_analysis', {
      portfolio,
      profile,
      includeMonteCarlo: false,
    })
  })

  it('REQ-MCP-6 rejects a portfolio with an impossible as-of date', async () => {
    const portfolio = { ...(await importedPortfolio()), asOfDate: '2026-13-45' }
    const result = await call('portfolio_analysis', { portfolio, profile })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toMatch(/portfolio\.asOfDate/)
  })

  it('REQ-MCP-6 returns field-level errors for values the API would reject', async () => {
    const portfolio = await importedPortfolio()
    const result = await call('portfolio_analysis', {
      portfolio,
      profile: { ...profile, annualExpenses: -1 },
    })
    expect(result.isError).toBe(true)
    const payload = result.structuredContent as {
      ok: boolean
      errors: { field: string; message: string }[]
    }
    expect(payload.ok).toBe(false)
    expect(payload.errors.map(error => error.field)).toEqual([
      'profile.annualExpenses',
    ])
  })

  it('REQ-MCP-6 rejects a portfolio with no accounts and an unknown nested key', async () => {
    const empty = await call('portfolio_analysis', {
      portfolio: {
        id: 'p',
        name: 'Empty',
        accounts: [],
        asOfDate: '2026-03-01',
      },
      profile,
    })
    expect(empty.isError).toBe(true)
    expect(errorText(empty)).toMatch(/portfolio\.accounts/)

    const portfolio = await importedPortfolio()
    const typo = await call('portfolio_analysis', {
      portfolio,
      profile: { ...profile, retireAge: 60 },
    })
    expect(typo.isError).toBe(true)
    expect(errorText(typo)).toMatch(/retireAge/)
  })
})

describe('REQ-MCP-7: tax_strategy and trade_plan', () => {
  it('REQ-MCP-7 returns the Roth schedule, Rule of 55 analysis and tax breakdown from the engine', async () => {
    const portfolio = await importedPortfolio()
    const payload = structured(
      await call('tax_strategy', {
        portfolio,
        profile,
        filingStatus: 'married_filing_jointly',
        ordinaryIncome: 90_000,
        capitalGains: 10_000,
      })
    )
    const p = wire(portfolio)
    expect(payload.rothConversion).toEqual(
      wire(
        optimizeRothConversion(p, profile, {
          filingStatus: 'married_filing_jointly',
        })
      )
    )
    expect(payload.ruleOf55).toEqual(wire(analyzeRuleOf55(p, profile)))
    expect(payload.taxBreakdown).toEqual(
      wire(
        calculateTaxBreakdown(90_000, 10_000, 'married_filing_jointly', 0.05)
      )
    )
    const roth = payload.rothConversion as { years: unknown[] }
    expect(roth.years.length).toBeGreaterThan(0)
    const breakdown = payload.taxBreakdown as { totalTax: number }
    expect(breakdown.totalTax).toBeGreaterThan(0)

    const provenance = expectStamp(payload, 'tax_strategy', {
      portfolio,
      profile,
      filingStatus: 'married_filing_jointly',
      ordinaryIncome: 90_000,
      capitalGains: 10_000,
    })
    expect(provenance.assumptions).toMatchObject({
      filingStatus: 'married_filing_jointly',
      ordinaryIncome: 90_000,
      capitalGains: 10_000,
      stateTaxRate: 0.05,
    })
  })

  it('REQ-MCP-7 uses the /api/v1/tax defaults when filing status and income are absent', async () => {
    const portfolio = await importedPortfolio()
    const payload = structured(
      await call('tax_strategy', { portfolio, profile })
    )
    const p = wire(portfolio)
    expect(payload.taxBreakdown).toEqual(
      wire(calculateTaxBreakdown(80_000, 0, 'single', 0.05))
    )
    expect(payload.rothConversion).toEqual(
      wire(optimizeRothConversion(p, profile, { filingStatus: 'single' }))
    )
    expect((payload.provenance as Stamp).assumptions).toMatchObject({
      filingStatus: 'single',
      ordinaryIncome: 80_000,
      capitalGains: 0,
    })
  })

  it('REQ-MCP-7 returns generateTradePlan trades with their reasons', async () => {
    const portfolio = await importedPortfolio()
    const payload = structured(await call('trade_plan', { portfolio, profile }))
    const expected = wire(generateTradePlan(wire(portfolio), profile))
    expect(payload.tradePlan).toEqual(expected)
    expect(expected.trades.length).toBeGreaterThan(0)
    for (const trade of expected.trades) {
      expect(trade.rationale.length).toBeGreaterThan(0)
    }
    const provenance = expectStamp(payload, 'trade_plan', {
      portfolio,
      profile,
    })
    expect(provenance.assumptions).toMatchObject({
      targetCashPosition: expected.targetCashPosition,
      federalTaxBracket: 0.22,
    })
  })

  it('REQ-MCP-7 rejects an unknown filing status', async () => {
    const portfolio = await importedPortfolio()
    const result = await call('tax_strategy', {
      portfolio,
      profile,
      filingStatus: 'joint',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
  })
})

describe('REQ-MCP-8: provenance on every portfolio tool result', () => {
  it('REQ-MCP-8 stamps import_positions with the as-of date source input, csv or none', async () => {
    const base = csvFixture('fidelity-sample.csv')
    const dated = `${base.trimEnd()}\n"Date downloaded 01/15/2026 10:30 AM ET"\n`
    const cases = [
      { args: { csv: base, asOfDate: '2026-03-01' }, source: 'input' },
      { args: { csv: dated }, source: 'csv' },
      { args: { csv: base }, source: 'none' },
    ]
    for (const { args, source } of cases) {
      const payload = structured(await call('import_positions', args))
      const provenance = expectStamp(payload, 'import_positions', args)
      expect(provenance.assumptions).toMatchObject({
        asOfDateSource: source,
        format: 'fidelity',
      })
    }
  })

  it('REQ-MCP-8 gives the same hashes for the same input', async () => {
    const args = { csv: csvFixture('schwab-sample.csv') }
    const first = structured(await call('import_positions', args))
    const second = structured(await call('import_positions', args))
    const a = first.provenance as Stamp
    const b = second.provenance as Stamp
    expect(b.inputHash).toBe(a.inputHash)
    expect(b.outputHash).toBe(a.outputHash)
  })
})

describe('BUI-1831: home value and mortgage in the analyses', () => {
  const home = { estimatedValue: 650_000 }
  // Paid off in 2031; the portfolio is as of 2026, so at age 56 + 5 = 61.
  const mortgage = {
    balance: 210_000,
    asOfDate: '2026-03-01',
    rate: 0.0375,
    monthlyPayment: 2_000,
    payoffDate: '2031-06-01',
  }

  interface Projection {
    age: number
    withdrawal: number
    inflationAdjustedWithdrawal: number
  }
  interface Scenario {
    scenarioType: string
    parameters: { inflationRate: number }
    projections: Projection[]
  }
  interface MonteCarlo {
    successRate: number
    percentiles: { p50: number }[]
  }

  it('BUI-1831 R2 reports net worth with home equity, not spendable', async () => {
    const portfolio = await importedPortfolio()
    const p = wire(portfolio)
    const withHome: UserProfile = {
      ...profile,
      home,
      mortgage: { balance: 210_000, asOfDate: '2026-03-01' },
    }
    const payload = structured(
      await call('portfolio_analysis', { portfolio, profile: withHome })
    )
    const investable = calculatePortfolioValue(p)
    expect(investable).toBeGreaterThan(0)
    expect(payload.netWorth).toEqual({
      investableValue: investable,
      homeValue: 650_000,
      mortgageBalance: 210_000,
      homeEquity: 440_000,
      netWorth: investable + 440_000,
    })
    // Home equity is not spent: the projections run on the investable value only.
    const scenarios = payload.scenarios as {
      projections: { startBalance: number }[]
    }[]
    expect(scenarios[0].projections[0].startBalance).toBe(
      Math.round(investable * 100) / 100
    )
    expect(payload.scenarios).toEqual(wire(runAllScenarios(p, profile)))
    expect(payload.monteCarlo).toEqual(
      wire(runMonteCarlo(p, profile, { seed: 42 }))
    )
    const provenance = payload.provenance as Stamp
    expect(provenance.assumptions).toMatchObject({ homeEquitySpendable: false })

    // A home with no mortgage: net worth is investable value plus home value.
    const noMortgage = structured(
      await call('portfolio_analysis', {
        portfolio,
        profile: { ...profile, home },
        includeMonteCarlo: false,
      })
    )
    expect(noMortgage.netWorth).toEqual({
      investableValue: investable,
      homeValue: 650_000,
      mortgageBalance: 0,
      homeEquity: 650_000,
      netWorth: investable + 650_000,
    })

    // No home: no net worth block, and the stamp names no home assumption.
    const none = structured(
      await call('portfolio_analysis', { portfolio, profile })
    )
    expect(none.netWorth).toBeUndefined()
    expect(
      (none.provenance as Stamp).assumptions.homeEquitySpendable
    ).toBeUndefined()
  })

  it('BUI-1831 R3 drops the mortgage payment after payoff', async () => {
    const portfolio = await importedPortfolio()
    const p = wire(portfolio)
    const withMortgage: UserProfile = { ...profile, home, mortgage }
    const payload = structured(
      await call('portfolio_analysis', { portfolio, profile: withMortgage })
    )
    const scenarios = payload.scenarios as Scenario[]
    const plain = wire(runAllScenarios(p, profile)) as unknown as Scenario[]
    expect(scenarios.length).toBe(4)
    for (const [index, scenario] of scenarios.entries()) {
      const rate = scenario.parameters.inflationRate
      for (const [i, year] of scenario.projections.entries()) {
        // A fixed-rate payment does not inflate: only the rest of the
        // spending grows with inflation, and the payment stops at payoff.
        const other = (80_000 - 24_000) * Math.pow(1 + rate, i)
        const expected = year.age >= 61 ? other : other + 24_000
        expect(year.inflationAdjustedWithdrawal).toBeCloseTo(expected, 2)
      }
      // Long after payoff, no part of the old payment is left in spending.
      const late = scenario.projections.at(-1)!
      expect(late.inflationAdjustedWithdrawal).toBeCloseTo(
        56_000 * Math.pow(1 + rate, scenario.projections.length - 1),
        2
      )
      // Spending never exceeds the same profile without a mortgage (over the
      // years both run; the plain one may run out of money sooner).
      const shared = plain[index].projections.slice(
        0,
        scenario.projections.length
      )
      expect(shared.length).toBeGreaterThan(4)
      for (const [i, year] of shared.entries()) {
        expect(
          scenario.projections[i].inflationAdjustedWithdrawal
        ).toBeLessThanOrEqual(year.inflationAdjustedWithdrawal + 1e-6)
      }
    }

    const mc = payload.monteCarlo as MonteCarlo
    const plainMc = wire(runMonteCarlo(p, profile, { seed: 42 })) as MonteCarlo
    expect(mc).toEqual(wire(runMonteCarlo(p, withMortgage, { seed: 42 })))
    expect(mc.successRate).toBeGreaterThanOrEqual(plainMc.successRate)
    expect(mc.percentiles[4].p50).toBeGreaterThan(plainMc.percentiles[4].p50)

    const provenance = payload.provenance as Stamp
    expect(provenance.assumptions).toMatchObject({
      mortgagePayoff: {
        payoffDate: '2031-06-01',
        payoffAge: 61,
        annualPaymentDropped: 24_000,
      },
    })
  })

  it('BUI-1831 R3 annualExpensesAt starts the drop at the payoff age and never goes below zero', () => {
    // 80,000 includes a fixed 24,000 payment: 56,000 inflates, 24,000 does not.
    const withMortgage: UserProfile = { ...profile, mortgage }
    expect(annualExpensesAt(withMortgage, 60, 1.1, '2026-03-01')).toBeCloseTo(
      85_600,
      6
    )
    expect(annualExpensesAt(withMortgage, 61, 1.1, '2026-03-01')).toBeCloseTo(
      61_600,
      6
    )
    // A later as-of year moves the payoff age earlier.
    expect(annualExpensesAt(withMortgage, 59, 1, '2028-01-01')).toBe(56_000)
    expect(annualExpensesAt(withMortgage, 58, 1, '2028-01-01')).toBe(80_000)
    // A mortgage already paid off drops the payment from the first year.
    expect(
      annualExpensesAt(
        { ...profile, mortgage: { ...mortgage, payoffDate: '2020-01-01' } },
        57,
        1,
        '2026-03-01'
      )
    ).toBe(56_000)
    // A payment larger than the expenses leaves zero, not a negative expense.
    expect(
      annualExpensesAt(
        { ...profile, mortgage: { ...mortgage, monthlyPayment: 10_000 } },
        70,
        1,
        '2026-03-01'
      )
    ).toBe(0)
    // Only the year counts: a month-only payoff and a timestamp as-of date work.
    expect(
      annualExpensesAt(
        { ...profile, mortgage: { ...mortgage, payoffDate: '2031-06' } },
        61,
        1,
        '2026-03-01T16:01:00Z'
      )
    ).toBe(56_000)
    expect(() => annualExpensesAt(withMortgage, 61, 1, '03/01/2026')).toThrow(
      /asOfDate/
    )
    // A payoff needs a real as-of year.
    expect(() => annualExpensesAt(withMortgage, 61, 1, '')).toThrow(/asOfDate/)
  })

  it('BUI-1831 R4 no mortgage leaves projections unchanged', async () => {
    const portfolio = await importedPortfolio()
    const p = wire(portfolio)
    // A mortgage without monthlyPayment or without payoffDate changes nothing.
    const variants: UserProfile[] = [
      { ...profile, home },
      { ...profile, mortgage: { balance: 210_000, asOfDate: '2026-03-01' } },
      {
        ...profile,
        mortgage: { ...mortgage, payoffDate: undefined },
      },
      {
        ...profile,
        mortgage: { ...mortgage, monthlyPayment: undefined },
      },
    ].map(variant => wire(variant))
    const plainScenarios = wire(runAllScenarios(p, profile))
    const plainMc = wire(runMonteCarlo(p, profile, { seed: 42 }))
    for (const variant of variants) {
      const payload = structured(
        await call('portfolio_analysis', { portfolio, profile: variant })
      )
      expect(payload.scenarios).toEqual(plainScenarios)
      expect(payload.monteCarlo).toEqual(plainMc)
      expect(
        (payload.provenance as Stamp).assumptions.mortgagePayoff
      ).toBeUndefined()
    }
    // The plain base case still inflates the full annual expenses every year.
    const base = runScenario('base', p, profile)
    for (const [i, year] of base.projections.entries()) {
      expect(year.inflationAdjustedWithdrawal).toBeCloseTo(
        80_000 * Math.pow(1 + base.parameters.inflationRate, i),
        2
      )
    }
    for (const age of [57, 61, 80]) {
      expect(annualExpensesAt(profile, age, 1.2, '')).toBe(96_000)
    }
  })

  it('stamps a home sale, contributions and spending phases and spends the sale proceeds', async () => {
    const portfolio = await importedPortfolio()
    const p = wire(portfolio)
    const planned: UserProfile = {
      ...profile,
      home,
      mortgage,
      annualContributions: 20_000,
      spendingPhases: [{ startAge: 65, annualExpenses: 70_000 }],
      homeSale: {
        age: 59,
        replacementHomeCost: 300_000,
        annualHousingCostChange: -5_000,
      },
    }
    const payload = structured(
      await call('portfolio_analysis', { portfolio, profile: planned })
    )
    const assumptions = (payload.provenance as Stamp).assumptions
    expect(assumptions.homeEquitySpendable).toBe(true)
    const sale = assumptions.homeSale as {
      age: number
      year: number
      salePrice: number
      sellingCosts: number
      mortgageBalancePaid: number
      netProceeds: number
    }
    expect(sale.age).toBe(59)
    expect(sale.year).toBe(2029)
    expect(sale.salePrice).toBe(650_000)
    expect(sale.sellingCosts).toBe(39_000)
    expect(sale.mortgageBalancePaid).toBeGreaterThan(0)
    expect(sale.mortgageBalancePaid).toBeLessThan(210_000)
    expect(sale.netProceeds).toBeCloseTo(
      650_000 - 39_000 - sale.mortgageBalancePaid - 300_000,
      2
    )
    expect(assumptions.mortgagePayoff).toMatchObject({
      payoffAge: 61,
      paymentEndsAtHomeSaleAge: 59,
    })
    expect(assumptions.contributions).toEqual({
      annualAmount: 20_000,
      untilAge: 57,
      inflationAdjusted: false,
    })
    // The base case gets the proceeds in the sale year and the same engine
    // output the MCP layer returns.
    const scenarios = payload.scenarios as Scenario[]
    const baseCase = scenarios.find(s => s.scenarioType === 'base')!
    const saleYear = baseCase.projections.find(y => y.age === 59) as
      | (Projection & { cashInflow?: number })
      | undefined
    expect(saleYear?.cashInflow).toBeCloseTo(sale.netProceeds, 2)
    expect(payload.monteCarlo).toEqual(
      wire(runMonteCarlo(p, planned, { seed: 42 }))
    )
    // Selling with positive proceeds can only help against keeping the house.
    const kept = wire(
      runMonteCarlo(p, { ...planned, homeSale: undefined }, { seed: 42 })
    )
    expect(
      (payload.monteCarlo as MonteCarlo).successRate
    ).toBeGreaterThanOrEqual(kept.successRate)
  })
})
