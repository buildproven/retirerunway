// @vitest-environment node
// Market assumptions (REQ-MCP-51), income gap (REQ-MCP-52) and the v1
// tools' v2 summary (REQ-MCP-53) through the MCP server, on saved data.
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
  currentAge: 58,
  targetRetirementAge: 60,
  annualExpenses: 60_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_000,
  spouse: {
    currentAge: 57,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_500,
  },
  planningAge: 92,
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
  client = new Client({
    name: 'market-gap-test',
    version: '0.0.0',
  })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-mig-'))
  process.env.RETIRE_RUNWAY_DATA_DIR = join(root, 'data')
  ok(
    await call('import_positions', {
      csv: fixture,
      asOfDate: '2026-11-17',
      save: true,
    })
  )
  ok(await call('save_profile', { profile }))
})

afterEach(() => {
  delete process.env.RETIRE_RUNWAY_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('REQ-MCP-51..53 market, gap and v1 alignment tools', () => {
  it('REQ-MCP-51 REQ-MCP-52 compares the forecast preset and an income gap as profile changes', async () => {
    const out = ok(
      await call('compare_retirement_scenarios', {
        scenarios: [
          {
            name: 'Forecast returns',
            changes: { marketAssumptions: { preset: 'forecast' } },
          },
          {
            name: 'Job gap at 59',
            changes: {
              incomeGap: { startAge: 59, months: 9, severance: 20000 },
            },
          },
        ],
      })
    )
    const rates = Object.fromEntries(
      (out.scenarios as { name: string; successRate: number }[]).map(s => [
        s.name,
        s.successRate,
      ])
    )
    expect(rates['Forecast returns']).toBeLessThanOrEqual(rates['Current plan'])
    expect(rates['Job gap at 59']).toBeLessThanOrEqual(rates['Current plan'])
    const bad = await call('save_profile', {
      profile: { ...profile, marketAssumptions: { preset: 'rosy' } },
    })
    expect(bad.isError).toBe(true)
  })

  it('REQ-MCP-53 portfolio_analysis carries the v2 success rate beside the v1 one', async () => {
    const out = ok(await call('portfolio_analysis'))
    const projection = out.projection as { model: string; successRate: number }
    expect(projection.model).toBe('project_retirement (v2)')
    const v2 = ok(await call('project_retirement'))
    expect(projection.successRate).toBe(
      (v2.summary as { successRate: number }).successRate
    )
  })
})
