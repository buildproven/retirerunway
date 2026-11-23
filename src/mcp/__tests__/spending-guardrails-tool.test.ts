// @vitest-environment node
// spending_guardrails through the MCP server (REQ-MCP-45).
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
  client = new Client({ name: 'spending-guardrails-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-guardrails-'))
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

interface Guardrails {
  portfolioToday: number
  planned: { monthlySpending: number; successRate: number }
  canSpend: { monthlySpending: number; successRate: number } | null
  lower: { portfolioValue: number; successBefore: number } | null
  upper: { portfolioValue: number; successBefore: number } | null
}

describe('REQ-MCP-45: spending_guardrails', () => {
  it('REQ-MCP-45 gives a monthly number on the saved plan, with a cut below today', async () => {
    const out = ok(await call('spending_guardrails'))
    const g = out.guardrails as Guardrails
    expect(g.planned.monthlySpending).toBe(5_000)
    expect(g.canSpend).not.toBeNull()
    expect(g.canSpend?.successRate).toBeGreaterThanOrEqual(0.85)
    if (g.lower !== null) {
      expect(g.lower.portfolioValue).toBeLessThan(g.portfolioToday)
      expect(g.lower.successBefore).toBeGreaterThan(0.7)
    }
    if (g.upper !== null) {
      expect(g.upper.portfolioValue).toBeGreaterThan(g.portfolioToday)
      expect(g.upper.successBefore).toBeGreaterThanOrEqual(0.99)
    }
    const direct = ok(await call('project_retirement'))
    expect(g.planned.successRate).toBe(
      (direct.summary as { successRate: number }).successRate
    )
    const stamp = out.provenance as {
      seed: number
      assumptions: Record<string, unknown>
    }
    expect(stamp.seed).toBe(42)
    expect(stamp.assumptions.savedData).toBeDefined()
    expect(Array.isArray(out.warnings)).toBe(true)
  }, 60_000)

  it('REQ-MCP-45 refuses guardrail settings out of order', async () => {
    const bad = await call('spending_guardrails', {
      targetSuccess: 0.6,
      lowerSuccess: 0.7,
    })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.structuredContent)).toContain('lowerSuccess')
  })

  it('REQ-MCP-45 is listed and described in the server instructions', async () => {
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain('spending_guardrails')
    expect(SERVER_INSTRUCTIONS).toContain('spending_guardrails')
  })
})
