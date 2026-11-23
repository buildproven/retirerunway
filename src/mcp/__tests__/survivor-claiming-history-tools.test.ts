// @vitest-environment node
// Survivor scenario (REQ-MCP-48), claiming sweep (REQ-MCP-49) and historical
// backtest (REQ-MCP-50) through the MCP server, on saved data.
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
    name: 'survivor-claiming-history-test',
    version: '0.0.0',
  })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-sch-'))
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

describe('REQ-MCP-48..50 survivor, claiming and history tools', () => {
  it('REQ-MCP-48 compares a survivor scenario as a profile change', async () => {
    const out = ok(
      await call('compare_retirement_scenarios', {
        scenarios: [
          {
            name: 'Owner dies at 75',
            changes: { survivor: { deceased: 'self', deathAge: 75 } },
          },
        ],
      })
    )
    const scenarios = out.scenarios as { name: string; successRate: number }[]
    expect(scenarios.map(s => s.name)).toContain('Owner dies at 75')
    const bad = await call('save_profile', {
      profile: { ...profile, survivor: { deceased: 'cousin', deathAge: 75 } },
    })
    expect(bad.isError).toBe(true)
  })

  it('REQ-MCP-49 sweeps claiming ages with a survivor check', async () => {
    const out = ok(
      await call('explore_claiming_ages', {
        selfAges: [62, 67, 70],
        spouseAges: [67],
        survivor: { deceased: 'self', deathAge: 75 },
      })
    )
    const rows = out.rows as {
      selfAge: number
      selfMonthly: number
      survivorSuccessRate: number | null
    }[]
    expect(rows.map(r => r.selfAge)).toEqual([62, 67, 70])
    expect(rows.find(r => r.selfAge === 70)?.selfMonthly).toBe(3_720)
    expect(rows.every(r => r.survivorSuccessRate !== null)).toBe(true)
    expect((out.current as { selfAge: number }).selfAge).toBe(67)
    expect((out.provenance as { tool: string; seed: number }).tool).toBe(
      'explore_claiming_ages'
    )
    const bad = await call('explore_claiming_ages', { selfAges: [61] })
    expect(bad.isError).toBe(true)
  })

  it('REQ-MCP-50 backtests every start year 1928-2025 on the saved data', async () => {
    const out = ok(await call('historical_backtest'))
    expect(out.startYears).toBe(98)
    expect(out.firstDataYear).toBe(1928)
    expect(out.lastDataYear).toBe(2025)
    expect(
      (out.named as { startYear: number }[]).map(n => n.startYear)
    ).toEqual([1929, 1937, 1966, 1973, 2000, 2008])
    const chart = (
      out.charts as { namedBalanceByAge: { x: number[]; series: unknown[] } }
    ).namedBalanceByAge
    expect(chart.series).toHaveLength(6)
    expect(chart.x[0]).toBe(59)
    const provenance = out.provenance as { tool: string; outputHash: string }
    expect(provenance.tool).toBe('historical_backtest')
    const again = ok(await call('historical_backtest'))
    expect((again.provenance as { outputHash: string }).outputHash).toBe(
      provenance.outputHash
    )
  })
})
