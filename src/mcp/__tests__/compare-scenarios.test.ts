// @vitest-environment node
// compare_retirement_scenarios and the ACA fields through the MCP server
// (REQ-MCP-42, REQ-MCP-43).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import type { UserProfile } from '@/engine/types'
import { SERVER_INSTRUCTIONS } from '../instructions'
import { createPlanServer } from '../server'

const fixture = readFileSync(
  resolve(
    __dirname,
    '..',
    '..',
    '..',
    'skills',
    'retire-runway',
    'fixtures',
    'csv',
    'fidelity-sample.csv'
  ),
  'utf8'
)

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 60_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
  stateExemptsRetirementIncome: true,
  spouse: {
    currentAge: 52,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_500,
  },
  preMedicareHealthcare: 24_000,
  home: { estimatedValue: 600_000, low: 550_000, high: 650_000 },
}

interface Scenario {
  name: string
  successRate: number
  lifetimeAcaCredit: number
}

let client: Client
let root: string

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

function ok(result: CallToolResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  return result.structuredContent as Record<string, unknown>
}

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createPlanServer().connect(serverTransport)
  client = new Client({ name: 'compare-scenarios-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-compare-'))
  process.env.RETIRE_RUNWAY_DATA_DIR = join(root, 'data')
  ok(await call('save_profile', { profile }))
  ok(
    await call('import_positions', {
      csv: fixture,
      asOfDate: '2026-11-17',
      save: true,
    })
  )
})

afterEach(() => {
  delete process.env.RETIRE_RUNWAY_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

const downsize = { homeSale: { age: 60, replacementHomeCost: 300_000 } }

describe('REQ-MCP-43: compare_retirement_scenarios', () => {
  it('REQ-MCP-43 runs the saved plan and each scenario, current plan first', async () => {
    const out = ok(
      await call('compare_retirement_scenarios', {
        scenarios: [
          { name: 'Downsize at 60', changes: downsize },
          { name: 'Spend $20K more', changes: { annualExpenses: 80_000 } },
        ],
      })
    )
    const scenarios = out.scenarios as Scenario[]
    expect(scenarios.map(s => s.name)).toEqual([
      'Current plan',
      'Downsize at 60',
      'Spend $20K more',
    ])
    expect(scenarios[2].successRate).toBeLessThanOrEqual(
      scenarios[0].successRate
    )
    const direct = ok(await call('project_retirement'))
    expect(scenarios[0].successRate).toBe(
      (direct.summary as { successRate: number }).successRate
    )
    const charts = out.charts as Record<
      string,
      { x: unknown[]; series: { values: number[] }[] }
    >
    expect(Object.keys(charts)).toEqual([
      'successRates',
      'medianBalanceByAge',
      'poorMarketBalanceByAge',
    ])
    expect(charts.successRates.x).toEqual([
      'Current plan',
      'Downsize at 60',
      'Spend $20K more',
    ])
    const stamp = out.provenance as {
      seed: number
      assumptions: Record<string, unknown>
    }
    expect(stamp.seed).toBe(42)
    expect(stamp.assumptions.savedData).toBeDefined()
    // The profiles used are returned, so the agent can save the one adopted.
    const profiles = out.profiles as { name: string; profile: UserProfile }[]
    expect(profiles[1].profile.homeSale?.replacementHomeCost).toBe(300_000)
  })

  it('REQ-MCP-43 drops removed fields and names scenario errors', async () => {
    ok(await call('save_profile', { profile: { ...profile, ...downsize } }))
    const out = ok(
      await call('compare_retirement_scenarios', {
        scenarios: [
          { name: 'Keep the house', changes: {}, remove: ['homeSale'] },
        ],
      })
    )
    const profiles = out.profiles as { profile: UserProfile }[]
    expect(profiles[1].profile.homeSale).toBeUndefined()
    const bad = await call('compare_retirement_scenarios', {
      scenarios: [{ name: 'Bad', changes: { targetRetirementAge: 40 } }],
    })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.structuredContent)).toContain('Bad')
  })

  it('REQ-MCP-43 refuses duplicate names, more than four scenarios and unknown fields', async () => {
    const duplicate = await call('compare_retirement_scenarios', {
      scenarios: [
        { name: 'A', changes: {} },
        { name: 'A', changes: {} },
      ],
    })
    expect(duplicate.isError).toBe(true)
    const many = await call('compare_retirement_scenarios', {
      scenarios: [1, 2, 3, 4, 5].map(n => ({ name: `S${n}`, changes: {} })),
    })
    expect(many.isError).toBe(true)
    const unknown = await call('compare_retirement_scenarios', {
      scenarios: [{ name: 'X', changes: { lottery: true } }],
    })
    expect(unknown.isError).toBe(true)
  })
})

describe('REQ-MCP-42: the ACA credit through the tools', () => {
  it('REQ-MCP-42 saves the ACA fields and states the rules used', async () => {
    ok(
      await call('save_profile', {
        profile: { ...profile, acaPremiumTaxCredit: true, householdSize: 2 },
      })
    )
    const out = ok(await call('project_retirement'))
    const assumptions = (
      out.provenance as { assumptions: Record<string, string> }
    ).assumptions
    expect(assumptions.acaPremiumTaxCredit).toMatch(/Rev\. Proc\. 2026-26/)
    expect(assumptions.acaPremiumTaxCredit).toMatch(/400%/)
  })

  it('REQ-MCP-42 shows the credit as its own scenario result', async () => {
    const out = ok(
      await call('compare_retirement_scenarios', {
        scenarios: [
          {
            name: 'Downsize + ACA credit',
            changes: { ...downsize, acaPremiumTaxCredit: true },
          },
        ],
      })
    )
    const [current, withCredit] = out.scenarios as Scenario[]
    expect(current.lifetimeAcaCredit).toBe(0)
    expect(withCredit.lifetimeAcaCredit).toBeGreaterThan(0)
  })

  it('REQ-MCP-42 tells the agent how to use the credit and the comparison', () => {
    expect(SERVER_INSTRUCTIONS).toContain('compare_retirement_scenarios')
    expect(SERVER_INSTRUCTIONS).toContain('acaPremiumTaxCredit')
    expect(SERVER_INSTRUCTIONS).toMatch(/400% of the poverty line/)
  })
})
