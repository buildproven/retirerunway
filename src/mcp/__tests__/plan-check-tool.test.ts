// @vitest-environment node
// plan_check through the MCP server (REQ-MCP-47): saved rules, saved snapshot.
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

// Fixture: 401(k) FXAIX $450K + FXNAX $42K, IRA VTSAX $210K → $702K, 94.0% stocks.
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
  annualExpenses: 70_200,
  planRules: {
    targetEquityShare: 0.64,
    protectedAccountTypes: ['traditional_ira'],
    sellSchedule: [
      { id: 'chunk 1', dueDate: '2026-11-17', symbol: 'FXAIX', amount: 50_000 },
      { id: 'chunk 2', dueDate: '2026-12-15', symbol: 'FXAIX', amount: 50_000 },
    ],
  },
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
  client = new Client({ name: 'plan-check-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-plan-check-'))
  process.env.RETIRE_RUNWAY_DATA_DIR = join(root, 'data')
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

interface Rec {
  kind: string
  amount: number
  action: string
  trades: { accountType: string; estimatedTax: number }[]
}

describe('REQ-MCP-47: plan_check', () => {
  it('REQ-MCP-47 recommends the overdue chunk from the saved rules, never a protected account', async () => {
    ok(await call('save_profile', { profile }))
    const out = ok(await call('plan_check', { asOfDate: '2026-11-20' }))
    expect(out.status).toBe('action_needed')
    const measures = out.measures as { totalValue: number; equityShare: number }
    expect(measures.totalValue).toBe(702_000)
    expect(measures.equityShare).toBeCloseTo(660_000 / 702_000, 10)
    const recs = out.recommendations as Rec[]
    expect(recs[0].kind).toBe('scheduled_sale')
    expect(recs[0].amount).toBe(50_000)
    expect(recs[0].action).toMatch(/^Sell \$50,000 FXAIX/)
    expect(
      recs
        .flatMap(rec => rec.trades)
        .some(t => t.accountType === 'traditional_ira')
    ).toBe(false)
    expect(recs[0].trades.every(t => t.estimatedTax === 0)).toBe(true)
    const assumptions = (out.engineAssumptions as { equityMean: number })
      .equityMean
    expect(assumptions).toBeGreaterThan(0)
    const provenance = out.provenance as {
      tool: string
      assumptions: {
        asOfDate: string
        rulesFrom: string
        nothingTraded: boolean
      }
    }
    expect(provenance.tool).toBe('plan_check')
    expect(provenance.assumptions).toMatchObject({
      asOfDate: '2026-11-20',
      rulesFrom: 'saved profile planRules',
      nothingTraded: true,
    })
    // Same inputs, same output hash.
    const again = ok(await call('plan_check', { asOfDate: '2026-11-20' }))
    expect((again.provenance as { outputHash: string }).outputHash).toBe(
      (out.provenance as { outputHash: string }).outputHash
    )
  })

  it('REQ-MCP-47 takes rules as input over the saved ones, and explains what is missing', async () => {
    ok(
      await call('save_profile', {
        profile: { ...profile, planRules: undefined },
      })
    )
    const missing = await call('plan_check', { asOfDate: '2026-11-20' })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('no planRules saved')
    const out = ok(
      await call('plan_check', {
        asOfDate: '2026-11-20',
        rules: { targetEquityShare: 0.94, minCashBufferYears: 0 },
      })
    )
    expect(out.status).toBe('on_plan')
    const bad = await call('plan_check', {
      asOfDate: '2026-11-10',
      rules: { targetEquityShare: 0.6 },
    })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toContain('before the snapshot date')
  })
})
