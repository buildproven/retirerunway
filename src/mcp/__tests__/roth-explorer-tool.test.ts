// @vitest-environment node
// explore_roth_conversions through the MCP server (REQ-MCP-46).
import { IRMAA_2027 } from '../../engine/irmaa'
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
  client = new Client({ name: 'roth-explorer-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-roth-'))
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

interface StrategyResult {
  name: string
  successRate: number
  lifetimeRothConversion: number
  conversionsByAge: { age: number; amount: number; irmaaTier: number }[]
}

describe('REQ-MCP-46: explore_roth_conversions', () => {
  it('REQ-MCP-46 runs the five default strategies on the saved plan', async () => {
    const out = ok(await call('explore_roth_conversions'))
    const strategies = out.strategies as StrategyResult[]
    expect(strategies.map(s => s.name)).toEqual([
      'No conversions',
      'Fill the 12% bracket',
      'Fill the 22% bracket',
      'Up to the first IRMAA threshold',
      'Under the ACA line, then IRMAA',
    ])
    expect(strategies[0].lifetimeRothConversion).toBe(0)
    const direct = ok(await call('project_retirement'))
    expect(strategies[0].successRate).toBe(
      (direct.summary as { successRate: number }).successRate
    )
    expect(strategies.map(s => s.name)).toContain(out.best)
    expect(Object.keys(out.charts as object)).toEqual([
      'successRates',
      'lifetimeCosts',
      'conversionsByAge',
    ])
    const stamp = out.provenance as {
      seed: number
      assumptions: Record<string, unknown>
    }
    expect(stamp.seed).toBe(42)
    expect(stamp.assumptions.savedData).toBeDefined()
    // REQ-MCP-84: the stamp names the IRMAA table the engine actually uses.
    expect(stamp.assumptions.irmaa).toBe(
      `CMS ${IRMAA_2027.year} table, two-year lookback`
    )
    expect(String(stamp.assumptions.irmaa)).not.toContain('2026')
  }, 60_000)

  it('REQ-MCP-46 takes a custom list and stops at conversionEndAge', async () => {
    const out = ok(
      await call('explore_roth_conversions', {
        conversionEndAge: 64,
        strategies: [
          { name: 'None', kind: 'none' },
          { name: '24%', kind: 'fillBracket', rate: 0.24 },
        ],
      })
    )
    const strategies = out.strategies as StrategyResult[]
    expect(strategies.map(s => s.name)).toEqual(['None', '24%'])
    expect(strategies[1].lifetimeRothConversion).toBeGreaterThan(0)
    expect(strategies[1].conversionsByAge.every(c => c.age <= 64)).toBe(true)
  }, 60_000)

  it('REQ-MCP-46 refuses a bracket that does not exist and duplicate names', async () => {
    const bad = await call('explore_roth_conversions', {
      strategies: [{ name: 'X', kind: 'fillBracket', rate: 0.13 }],
    })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.structuredContent)).toContain(
      'strategies[0].rate'
    )
    const dup = await call('explore_roth_conversions', {
      strategies: [
        { name: 'A', kind: 'none' },
        { name: 'A', kind: 'acaThenIrmaa' },
      ],
    })
    expect(dup.isError).toBe(true)
    const noTier = await call('explore_roth_conversions', {
      strategies: [{ name: 'T', kind: 'irmaaTier' }],
    })
    expect(noTier.isError).toBe(true)
  })

  it('REQ-MCP-46 is listed and described in the server instructions', async () => {
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain('explore_roth_conversions')
    expect(SERVER_INSTRUCTIONS).toContain('explore_roth_conversions')
  })
})
