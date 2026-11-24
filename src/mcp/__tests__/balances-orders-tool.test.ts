// @vitest-environment node
// explore_withdrawal_order and import_balances through the MCP server
// (REQ-MCP-70, REQ-MCP-72). Invented household and balances only.
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
  planRules: { targetEquityShare: 0.6, outsideCash: 5_000 },
}

const balances = readFileSync(
  resolve(
    __dirname,
    '..',
    '..',
    '..',
    'skills',
    'retire-runway',
    'fixtures',
    'balances',
    'empower-sample.txt'
  ),
  'utf8'
)

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
  client = new Client({ name: 'balances-orders-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-bal-'))
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

describe('REQ-MCP-70: explore_withdrawal_order', () => {
  it('REQ-MCP-70 compares four orders on the saved plan', async () => {
    const out = ok(await call('explore_withdrawal_order'))
    const orders = out.orders as { name: string; successRate: number }[]
    expect(orders).toHaveLength(4)
    expect(out.current).toBe('taxableFirst')
    const direct = ok(await call('project_retirement'))
    expect(orders[0].successRate).toBe(
      (direct.summary as { successRate: number }).successRate
    )
    expect(orders.map(o => o.name)).toContain(out.best)
    expect((out.provenance as { seed: number }).seed).toBe(42)
  }, 60_000)
})

describe('REQ-MCP-72: import_balances', () => {
  it('REQ-MCP-72 reads the list, checks it against the plan and saves nothing', async () => {
    const out = ok(
      await call('import_balances', {
        text: balances,
        asOfDate: '2026-11-24',
        earmarks: [{ account: 'HYSA', amount: 25_000, purpose: 'college' }],
      })
    )
    const totals = out.totals as Record<string, number>
    expect(totals.freeCash).toBe(16_200)
    expect(JSON.stringify(out.lines)).not.toMatch(/4821|7712/)
    const ids = (out.checks as { id: string }[]).map(c => c.id)
    expect(ids).toEqual(
      expect.arrayContaining(['stale-account', 'snapshot-differs'])
    )
    const changes = out.proposedChanges as {
      field: string
      proposed: unknown
    }[]
    expect(
      changes.find(c => c.field === 'planRules.outsideCash')?.proposed
    ).toBe(16_200)
    const saved = ok(await call('get_profile')) as { profile: UserProfile }
    expect(saved.profile.planRules?.outsideCash).toBe(5_000)
  })

  it('REQ-MCP-72 refuses an earmark larger than the account', async () => {
    const out = await call('import_balances', {
      text: balances,
      asOfDate: '2026-11-24',
      earmarks: [{ account: 'HYSA', amount: 99_000, purpose: 'x' }],
    })
    expect(out.isError).toBe(true)
  })
})
