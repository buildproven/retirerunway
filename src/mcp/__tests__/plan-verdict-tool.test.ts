// @vitest-environment node
// plan_verdict through the MCP server, on saved data (REQ-MCP-56).
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
    name: 'plan-verdict-test',
    version: '0.0.0',
  })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-verdict-'))
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

describe('REQ-MCP-56 plan_verdict', () => {
  it('REQ-MCP-56 returns a verdict, the measures and at most five actions, reproducibly', async () => {
    const out = ok(await call('plan_verdict', { asOfDate: '2026-11-21' }))
    expect(['GO', 'CAUTION', 'DELAY']).toContain(out.verdict)
    const measures = out.measures as {
      successRate: number
      forecastSuccessRate: number
    }
    const v2 = ok(await call('project_retirement'))
    expect(measures.successRate).toBe(
      (v2.summary as { successRate: number }).successRate
    )
    expect((out.actions as string[]).length).toBeLessThanOrEqual(5)
    const provenance = out.provenance as { tool: string; outputHash: string }
    expect(provenance.tool).toBe('plan_verdict')
    const again = ok(await call('plan_verdict', { asOfDate: '2026-11-21' }))
    expect((again.provenance as { outputHash: string }).outputHash).toBe(
      provenance.outputHash
    )
  })
})
