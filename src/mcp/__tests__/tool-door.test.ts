// @vitest-environment node
// The stable surface (REQ-MCP-73, REQ-MCP-74): run_tool reaches every tool by
// name, get_briefing lists them, update_profile changes only what changes.
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
import { patchProfile } from '../profile-patch'
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
  client = new Client({ name: 'tool-door-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-door-'))
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

describe('REQ-MCP-73: run_tool and the live tool list', () => {
  it('REQ-MCP-73 runs a tool by name and returns exactly what the tool returns', async () => {
    const direct = ok(await call('get_profile'))
    const viaDoor = ok(await call('run_tool', { tool: 'get_profile' }))
    expect(viaDoor).toEqual(direct)
    const guard = ok(
      await call('run_tool', {
        tool: 'spending_guardrails',
        arguments: { seed: 42 },
      })
    )
    expect(guard.canSpend).toEqual(
      ok(await call('spending_guardrails', { seed: 42 })).canSpend
    )
  }, 120_000)

  it('REQ-MCP-73 checks arguments against the tool schema and names the field', async () => {
    const bad = await call('run_tool', {
      tool: 'save_plan_notes',
      arguments: { section: 'nope', text: 'x', expectedRevision: 0 },
    })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toMatch(/arguments\.section/)
    const extra = await call('run_tool', {
      tool: 'get_profile',
      arguments: { surprise: true },
    })
    expect(extra.isError).toBe(true)
  })

  it('REQ-MCP-73 refuses unknown tools, itself and deletion, and lists what it can run', async () => {
    for (const tool of ['no_such_tool', 'run_tool', 'delete_user_data']) {
      const out = await call('run_tool', { tool })
      expect(out.isError).toBe(true)
      expect(JSON.stringify(out.content)).toMatch(/project_retirement/)
    }
  })

  it('REQ-MCP-73 get_briefing lists every tool with its arguments', async () => {
    const out = ok(await call('get_briefing'))
    const tools = out.tools as {
      name: string
      summary: string
      arguments: string[]
    }[]
    const { tools: listed } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(listed.map(t => t.name).sort())
    expect(tools.find(t => t.name === 'run_tool')?.arguments).toEqual([
      'tool*',
      'arguments',
    ])
    expect(tools.find(t => t.name === 'import_balances')?.arguments).toEqual(
      expect.arrayContaining(['text*', 'asOfDate*', 'earmarks'])
    )
    for (const t of tools) expect(t.summary.length).toBeGreaterThan(5)
    expect(SERVER_INSTRUCTIONS).toMatch(/run_tool/)
  })

  it('REQ-MCP-73 publishes an open arguments object so new fields never need a new chat', async () => {
    const { tools } = await client.listTools()
    const door = tools.find(t => t.name === 'run_tool')
    const args = (
      door?.inputSchema.properties as Record<
        string,
        { type?: string; additionalProperties?: unknown }
      >
    ).arguments
    expect(args.type).toBe('object')
    expect(args.additionalProperties).not.toBe(false)
  })
})

describe('REQ-MCP-74: update_profile', () => {
  it('REQ-MCP-74 sets nested fields, replaces arrays, removes fields and keeps the rest', async () => {
    const out = ok(
      await call('update_profile', {
        set: {
          consumerDebt: 12_000,
          'planRules.outsideCash': 9_000,
          'planRules.targetEquityShare': 0.6,
        },
        remove: ['home'],
      })
    )
    expect(out.changed).toEqual([
      'consumerDebt',
      'planRules.outsideCash',
      'planRules.targetEquityShare',
      'home',
    ])
    const saved = ok(await call('get_profile')).profile as UserProfile
    expect(saved.consumerDebt).toBe(12_000)
    expect(saved.planRules?.outsideCash).toBe(9_000)
    expect(saved.home).toBeUndefined()
    expect(saved.spouse).toEqual(profile.spouse)
    const again = ok(
      await call('update_profile', { set: { consumerDebt: 12_000 } })
    )
    expect(again.changed).toEqual([])
  })

  it('REQ-MCP-74 refuses an unknown field or a bad value and saves nothing', async () => {
    const before = ok(await call('get_profile')).updatedAt
    const unknown = await call('update_profile', { set: { madeUpField: 1 } })
    expect(unknown.isError).toBe(true)
    const bad = await call('update_profile', { set: { currentAge: -4 } })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toMatch(/currentAge/)
    const proto = await call('update_profile', { set: { '__proto__.x': 1 } })
    expect(proto.isError).toBe(true)
    expect(ok(await call('get_profile')).updatedAt).toBe(before)
  })

  it('REQ-MCP-74 patchProfile replaces arrays whole and refuses paths through a value', () => {
    const base = { a: { list: [1, 2] }, n: 1 }
    const { profile: next, changed } = patchProfile(base, { 'a.list': [3] })
    expect(next).toEqual({ a: { list: [3] }, n: 1 })
    expect(changed).toEqual(['a.list'])
    expect(base.a.list).toEqual([1, 2])
    expect(() => patchProfile(base, { 'n.x': 1 })).toThrow(/not an object/)
    expect(() => patchProfile(base, { 'a..b': 1 })).toThrow(/not a field path/)
  })
})
