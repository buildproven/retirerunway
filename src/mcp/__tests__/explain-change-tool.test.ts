// @vitest-environment node
// explain_change through the MCP server, on saved snapshots (REQ-MCP-58).
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
    name: 'explain-change-test',
    version: '0.0.0',
  })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-explain-'))
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

describe('REQ-MCP-58 explain_change', () => {
  it('REQ-MCP-58 needs two snapshots, then explains the newest against the one before', async () => {
    const one = await call('explain_change')
    expect(one.isError).toBe(true)
    expect(JSON.stringify(one.content)).toContain('needs two saved snapshots')
    ok(
      await call('import_positions', {
        csv: fixture,
        asOfDate: '2026-12-17',
        save: true,
      })
    )
    const out = ok(await call('explain_change', { previousSuccessRate: 0.5 }))
    const from = out.from as { snapshotDate: string; successRate: number }
    const to = out.to as { snapshotDate: string; successRate: number }
    expect(from.snapshotDate).toBe('2026-11-17')
    expect(to.snapshotDate).toBe('2026-12-17')
    // Same holdings on both dates: the portfolio moved nothing.
    expect(out.portfolioEffect).toBe(0)
    expect((out.recorded as { otherEffect: number }).otherEffect).toBeCloseTo(
      to.successRate - 0.5,
      4
    )
    expect((out.provenance as { tool: string }).tool).toBe('explain_change')
    const bad = await call('explain_change', {
      fromDate: '2026-12-17',
      toDate: '2026-11-17',
    })
    expect(bad.isError).toBe(true)
  })
})
