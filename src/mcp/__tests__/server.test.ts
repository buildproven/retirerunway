// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  analyzePlan,
  buildScenario,
  comparePlanAnalyses,
  planToJson,
} from '@/engine/plan'
import type { PlanIntakeValues, Scenario } from '@/engine/plan'
import { runPlanMonteCarlo } from '@/engine/plan/monte-carlo'
import { REGRESSION_FIXTURES } from '@/engine/plan/regression-fixtures'
import { stamp } from '../../../skills/retire-runway/scripts/provenance'
import { createPlanServer, intakeErrorField } from '../server'

const repoRoot = resolve(__dirname, '..', '..', '..')

const TOOL_NAMES = [
  'analyze_plan',
  'build_plan',
  'compare_plans',
  'compare_retirement_scenarios',
  'delete_user_data',
  'explain_change',
  'explore_claiming_ages',
  'explore_roth_conversions',
  'get_briefing',
  'get_profile',
  'historical_backtest',
  'import_positions',
  'list_snapshots',
  'plan_check',
  'plan_monte_carlo',
  'plan_verdict',
  'portfolio_analysis',
  'project_retirement',
  'propose_plan_rules',
  'save_plan_notes',
  'save_profile',
  'spending_guardrails',
  'tax_strategy',
  'trade_plan',
]

// Required arguments per tool. The portfolio tools fall back to the saved
// profile and newest snapshot (REQ-MCP-14), so they require none.
const REQUIRED_ARGUMENTS: Record<string, string[]> = {
  analyze_plan: ['scenario'],
  build_plan: ['intake'],
  compare_plans: ['current', 'previous'],
  compare_retirement_scenarios: ['scenarios'],
  delete_user_data: ['confirm'],
  explain_change: [],
  explore_claiming_ages: [],
  explore_roth_conversions: [],
  get_briefing: [],
  get_profile: [],
  historical_backtest: [],
  import_positions: ['csv'],
  list_snapshots: [],
  plan_check: [],
  plan_verdict: [],
  plan_monte_carlo: ['numPaths', 'scenario', 'seed'],
  portfolio_analysis: [],
  spending_guardrails: [],
  project_retirement: [],
  propose_plan_rules: [],
  save_plan_notes: ['expectedRevision', 'section', 'text'],
  save_profile: ['profile'],
  tax_strategy: [],
  trade_plan: [],
}

const intake: PlanIntakeValues = {
  currentAge: 58,
  targetRetirementAge: 62,
  durationYears: 10,
  filingStatus: 'married_filing_jointly',
  acaHouseholdSize: 2,
  acaResidenceRegion: 'contiguous_us',
  annualExpenses: 60_000,
  essentialExpenses: 40_000,
  cashBalance: 30_000,
  brokerageBalance: 400_000,
  traditionalBalance: 500_000,
  rothBalance: 200_000,
  annualWorkIncome: 100_000,
  annualOutsideIncome: 20_000,
  annualSocialSecurity: 0,
  annualSocialSecurityAtFullRetirementAge: 24_000,
  socialSecurityStartAge: 67,
  annualHealthcare: 12_000,
  reserveFloor: 50_000,
  housingProceeds: 0,
  housingEventAge: 70,
  housingCommitment: 'available',
}

function fixture(id: string): Scenario {
  const found = REGRESSION_FIXTURES.find(item => item.id === id)
  if (!found) throw new Error(`missing regression fixture ${id}`)
  return found.scenario
}

/**
 * A regression fixture with the work-income and healthcare streams that plan
 * analysis needs for its stress cases.
 */
function analyzable(id: string): Scenario {
  const scenario = fixture(id)
  return {
    ...scenario,
    incomeStreams: [
      {
        id: 'work-income',
        name: 'Salary',
        owner: 'primary',
        currency: 'USD',
        gross: 90_000,
        start: { age: 54 },
        end: { age: 54 },
        annualGrowthRate: 0,
        taxCategory: 'ordinary',
        reliability: 1,
        includedInBase: true,
      },
      ...scenario.incomeStreams,
    ],
    spendingStreams: [
      ...scenario.spendingStreams,
      {
        id: 'healthcare-spend',
        category: 'healthcare',
        owner: 'household',
        currency: 'USD',
        amount: 8_000,
        start: { age: 55 },
        annualInflationRate: 0,
        essential: true,
        reduciblePercent: 0,
      },
    ],
  }
}

/** A JSON round trip, as the scenario crosses the MCP wire. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent, errorText(result)).toBeDefined()
  const text = result.content.find(block => block.type === 'text')
  // The text block carries the same payload for clients without structured output.
  expect(text && 'text' in text ? JSON.parse(text.text) : undefined).toEqual(
    result.structuredContent
  )
  return result.structuredContent as Record<string, unknown>
}

function errorText(result: CallToolResult): string {
  return result.content
    .map(block => ('text' in block ? block.text : ''))
    .join('\n')
}

let client: Client

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createPlanServer().connect(serverTransport)
  client = new Client({ name: 'plan-mcp-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

describe('REQ-MCP-1: plan MCP server tools and strict schemas', () => {
  it('REQ-MCP-1 lists exactly the twenty-three plan, portfolio and user data tools, each with a strict input schema', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual(TOOL_NAMES)
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect([...(tool.inputSchema.required ?? [])].sort(), tool.name).toEqual(
        REQUIRED_ARGUMENTS[tool.name]
      )
    }
  })

  it('REQ-MCP-1 rejects an unknown argument instead of ignoring it', async () => {
    const result = (await client.callTool({
      name: 'analyze_plan',
      arguments: {
        scenario: fixture('married-knoxville-outside-income'),
        extra: true,
      },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(errorText(result)).toMatch(/extra/)
  })

  it('REQ-MCP-1 rejects an unknown key nested inside a scenario', async () => {
    const scenario = wire(fixture('married-knoxville-outside-income'))
    const result = (await client.callTool({
      name: 'analyze_plan',
      arguments: {
        scenario: {
          ...scenario,
          accounts: [{ ...scenario.accounts[0], typo: 1 }],
        },
      },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(errorText(result)).toMatch(/typo/)
  })

  it('REQ-MCP-1 serves the tools over stdio when `npm run mcp` starts', async () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    expect(packageJson.scripts.mcp).toBe('node src/mcp/run.mjs')

    const stdioClient = new Client({ name: 'plan-mcp-stdio', version: '0.0.0' })
    await stdioClient.connect(
      new StdioClientTransport({
        command: 'npm',
        args: ['run', '--silent', 'mcp'],
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? '' },
        stderr: 'pipe',
      })
    )
    try {
      const { tools } = await stdioClient.listTools()
      expect(tools.map(tool => tool.name).sort()).toEqual(TOOL_NAMES)
    } finally {
      await stdioClient.close()
    }
  }, 60_000)
})

describe('REQ-MCP-2: build_plan', () => {
  it('REQ-MCP-2 returns the scenario from buildScenario for valid intake', async () => {
    const payload = structured(
      (await client.callTool({
        name: 'build_plan',
        arguments: { intake },
      })) as CallToolResult
    )
    expect(payload.ok).toBe(true)
    expect(payload.scenario).toEqual(wire(buildScenario(intake)))
    expect(payload.analysisOptions).toEqual({
      reserveFloor: 50_000,
      socialSecurityAge: 67,
    })
    expect(payload.errors).toBeUndefined()
  })

  it('REQ-MCP-2 returns field-level errors and no scenario for invalid intake', async () => {
    const result = (await client.callTool({
      name: 'build_plan',
      arguments: { intake: { ...intake, essentialExpenses: 61_000 } },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    const payload = structured(result)
    expect(payload).toEqual({
      ok: false,
      errors: [
        {
          field: 'essentialExpenses',
          message: 'essentialExpenses cannot exceed annualExpenses',
        },
      ],
    })
  })

  it('REQ-MCP-2 names the field for engine messages that do not use the field key', async () => {
    const result = (await client.callTool({
      name: 'build_plan',
      arguments: { intake: { ...intake, acaResidenceRegion: 'alaska' } },
    })) as CallToolResult
    const payload = structured(result)
    expect(payload.scenario).toBeUndefined()
    expect(payload.errors).toEqual([
      {
        field: 'acaResidenceRegion',
        message: 'Unsupported ACA residence region: alaska',
      },
    ])
  })

  it('REQ-MCP-2 maps every engine intake message to its field', () => {
    expect(
      intakeErrorField('currentAge must be an integer of at least 25')
    ).toBe('currentAge')
    expect(
      intakeErrorField('targetRetirementAge must be after currentAge')
    ).toBe('targetRetirementAge')
    expect(
      intakeErrorField(
        'worker socialSecurityStartAge must be between 62 and 70'
      )
    ).toBe('socialSecurityStartAge')
    expect(
      intakeErrorField(
        'worker fullRetirementAge must match the birth-year ruleset (67)'
      )
    ).toBe('socialSecurityFullRetirementAge')
    expect(
      intakeErrorField(
        'divorced_spouse eligibility must be explicitly confirmed'
      )
    ).toBe('divorcedSpouseEligibilityConfirmed')
    expect(
      intakeErrorField(
        'spouse claimant full retirement age must be between 65 and 67'
      )
    ).toBe('socialSecurityClaimantFullRetirementAge')
    expect(
      intakeErrorField('Unsupported Social Security benefit type: x')
    ).toBe('socialSecurityBenefitType')
    expect(intakeErrorField('something unexpected')).toBe('intake')
  })

  it('REQ-MCP-2 rejects a wrongly typed intake value before the engine runs', async () => {
    const result = (await client.callTool({
      name: 'build_plan',
      arguments: { intake: { ...intake, currentAge: 'fifty-eight' } },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(errorText(result)).toMatch(/currentAge/)
  })
})

describe('REQ-MCP-3: analyze_plan', () => {
  it('REQ-MCP-3 returns the same plan as a direct analyzePlan call, with a provenance stamp', async () => {
    const scenario = analyzable('married-knoxville-outside-income')
    const payload = structured(
      (await client.callTool({
        name: 'analyze_plan',
        arguments: { scenario },
      })) as CallToolResult
    )
    const expected = JSON.parse(planToJson(analyzePlan(wire(scenario))))
    expect(payload.plan).toEqual(expected)
    const plan = payload.plan as {
      verdict: {
        verdict: string
        delayReasons: unknown[]
        cautionReasons: unknown[]
      }
      stress: { id: string; solvent: boolean }[]
      minimumOutsideIncome: number | null
    }
    expect(['GO', 'CAUTION', 'DELAY']).toContain(plan.verdict.verdict)
    expect(plan.verdict.verdict).toBe(expected.verdict.verdict)
    expect(plan.stress.length).toBeGreaterThan(0)
    expect(plan).toHaveProperty('minimumOutsideIncome')

    const provenance = payload.provenance as ReturnType<typeof stamp>
    const reference = stamp('analyze_plan', { scenario }, expected)
    expect(provenance.tool).toBe('analyze_plan')
    expect(provenance.inputHash).toBe(reference.inputHash)
    expect(provenance.outputHash).toBe(reference.outputHash)
    expect(provenance.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(provenance.assumptions).toMatchObject({
      asOfDate: '2026-01-01',
      inflationRate: 0,
      baseCurrency: 'USD',
      durationYears: 3,
    })
    expect(provenance.assumptions.socialSecurityRulesAsOf).toEqual(
      expect.any(String)
    )
  })

  it('REQ-MCP-3 passes analysis options through to the engine', async () => {
    const scenario = analyzable('divorced-knoxville-maintenance')
    const options = {
      outsideIncomeStreamId: 'maintenance',
      reserveFloor: 90_000,
    }
    const payload = structured(
      (await client.callTool({
        name: 'analyze_plan',
        arguments: { scenario, options },
      })) as CallToolResult
    )
    expect(payload.plan).toEqual(
      JSON.parse(planToJson(analyzePlan(wire(scenario), options)))
    )
  })

  it('REQ-MCP-3 returns the engine error, not a verdict, for a scenario the engine cannot analyze', async () => {
    const result = (await client.callTool({
      name: 'analyze_plan',
      arguments: { scenario: fixture('divorced-roanoke-no-maintenance') },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(errorText(result)).toMatch(
      /Plan analysis requires an outside-income stream/
    )
  })

  it('REQ-MCP-3 analyzes a scenario returned by build_plan', async () => {
    const built = structured(
      (await client.callTool({
        name: 'build_plan',
        arguments: { intake },
      })) as CallToolResult
    )
    const result = (await client.callTool({
      name: 'analyze_plan',
      arguments: { scenario: built.scenario, options: built.analysisOptions },
    })) as CallToolResult
    expect(result.isError).toBeFalsy()
    const payload = structured(result)
    const expected = JSON.parse(
      planToJson(
        analyzePlan(buildScenario(intake), {
          reserveFloor: intake.reserveFloor,
          socialSecurityAge: intake.socialSecurityStartAge,
        })
      )
    )
    expect((payload.plan as typeof expected).verdict).toEqual(expected.verdict)
  })
})

describe('REQ-MCP-4: compare_plans and plan_monte_carlo', () => {
  it('REQ-MCP-4 returns comparePlanAnalyses for two scenarios', async () => {
    const previous = analyzable('married-knoxville-outside-income')
    const current: Scenario = {
      ...previous,
      incomeStreams: previous.incomeStreams.map(stream =>
        stream.id === 'outside-income' ? { ...stream, gross: 40_000 } : stream
      ),
    }
    const payload = structured(
      (await client.callTool({
        name: 'compare_plans',
        arguments: { previous, current },
      })) as CallToolResult
    )
    const previousAnalysis = analyzePlan(wire(previous))
    const currentAnalysis = analyzePlan(wire(current))
    const expected = wire(
      comparePlanAnalyses(previousAnalysis, currentAnalysis)
    )
    expect(payload.comparison).toEqual(expected)
    expect(expected.assumptionChanges.length).toBeGreaterThan(0)
    expect(payload.previousVerdict).toBe(previousAnalysis.verdict.verdict)
    expect(payload.currentVerdict).toBe(currentAnalysis.verdict.verdict)
    const provenance = payload.provenance as ReturnType<typeof stamp>
    expect(provenance.tool).toBe('compare_plans')
    expect(provenance.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('REQ-MCP-4 returns runPlanMonteCarlo results and the same seed gives the same result', async () => {
    const scenario = fixture('year-one-market-fall')
    const call = async (seed: number) =>
      structured(
        (await client.callTool({
          name: 'plan_monte_carlo',
          arguments: { scenario, seed, numPaths: 40 },
        })) as CallToolResult
      )
    const first = await call(7)
    const second = await call(7)
    const otherSeed = await call(8)

    expect(first.result).toEqual(
      wire(runPlanMonteCarlo(wire(scenario), { seed: 7, numPaths: 40 }))
    )
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result))
    expect(otherSeed.result).not.toEqual(first.result)

    const firstStamp = first.provenance as ReturnType<typeof stamp>
    const secondStamp = second.provenance as ReturnType<typeof stamp>
    expect(firstStamp.seed).toBe(7)
    expect(secondStamp.inputHash).toBe(firstStamp.inputHash)
    expect(secondStamp.outputHash).toBe(firstStamp.outputHash)
    expect(firstStamp.assumptions).toMatchObject({ seed: 7, numPaths: 40 })
  })

  it('REQ-MCP-4 rejects a path count above the limit or a fractional seed', async () => {
    const scenario = fixture('year-one-market-fall')
    for (const args of [
      { scenario, seed: 1, numPaths: 5_001 },
      { scenario, seed: 1, numPaths: 0 },
      { scenario, seed: 1.5, numPaths: 10 },
    ]) {
      const result = (await client.callTool({
        name: 'plan_monte_carlo',
        arguments: args,
      })) as CallToolResult
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
    }
  })
})
