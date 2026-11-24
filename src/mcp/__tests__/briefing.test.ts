// @vitest-environment node
// The app carries its own agent context (REQ-MCP-33, REQ-MCP-34): server
// instructions at connect time, plan notes saved with the profile, and one
// get_briefing call that returns profile, snapshots, notes and checks. A
// chat with only the connector then needs no plugin.
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
import { missingInputs } from '../user-data-tools'

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

const complete: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 96_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 4_166.67,
  annualContributions: 40_000,
  withdrawalTaxRate: 0.1,
  spendingPhases: [{ startAge: 60, annualExpenses: 128_000 }],
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

interface Section {
  section: string
  title: string
  text: string
  revision: number
  updatedAt: string | null
}

interface Briefing {
  profile: { updatedAt: string; profile: UserProfile } | null
  snapshots: { asOfDate: string; totalValue: number }[]
  snapshotCount: number
  notes: {
    file: string | null
    migratedFromSingleText: boolean
    sections: Section[]
  }
  checks: {
    missing: { field: string; fixWith: string }[]
    warnings: { message: string; fixWith: string }[]
  }
  nextActions: { action: string; tool: string | null }[]
  server: { version: string; whatsNew: string[] }
}

function sectionText(briefing: Briefing, key: string): string | undefined {
  return briefing.notes.sections.find(section => section.section === key)?.text
}

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createPlanServer().connect(serverTransport)
  client = new Client({ name: 'briefing-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rr-briefing-'))
  process.env.RETIRE_RUNWAY_DATA_DIR = join(root, 'data')
})

afterEach(() => {
  delete process.env.RETIRE_RUNWAY_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('REQ-MCP-34: the server sends its own agent instructions', () => {
  it('REQ-MCP-34 gives every client the instructions at connect time', () => {
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
  })

  it('REQ-MCP-34 tells the agent to start with get_briefing and keep context with save_plan_notes', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(
      /Start every conversation with get_briefing/
    )
    expect(SERVER_INSTRUCTIONS).toMatch(/save_plan_notes/)
    expect(SERVER_INSTRUCTIONS).toMatch(/Never compute or estimate a figure/)
  })

  it('REQ-MCP-34 tells the agent to have the owner reconnect when a new tool is missing', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(
      /names a tool this chat cannot call, tell the owner to reconnect/
    )
  })

  it('REQ-MCP-34 names only tools the server registers', async () => {
    const registered = new Set(
      (await client.listTools()).tools.map(tool => tool.name)
    )
    const named = [
      ...new Set(SERVER_INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []),
    ]
    expect(named.length).toBeGreaterThan(5)
    for (const name of named) expect(registered.has(name), name).toBe(true)
  })
})

describe('REQ-MCP-33: get_briefing and save_plan_notes', () => {
  it('REQ-MCP-33 names the missing profile and snapshot when nothing is saved', async () => {
    const briefing = ok(await call('get_briefing')) as unknown as Briefing
    expect(briefing.profile).toBeNull()
    expect(briefing.notes.sections.every(section => section.text === '')).toBe(
      true
    )
    expect(briefing.snapshots).toEqual([])
    expect(briefing.checks.missing.map(item => item.field)).toEqual([
      'profile',
      'snapshot',
    ])
  })

  it('REQ-MCP-33 returns the saved profile, snapshots and notes in one call', async () => {
    ok(await call('save_profile', { profile: complete }))
    ok(
      await call('import_positions', {
        csv: fixture,
        asOfDate: '2026-11-17',
        save: true,
      })
    )
    const saved = ok(
      await call('save_plan_notes', {
        section: 'decisions',
        text: '- Retire at 60\n- Downsize',
        expectedRevision: 0,
      })
    )
    expect(saved.file).toBe('notes.json')
    const briefing = ok(await call('get_briefing')) as unknown as Briefing
    expect(briefing.profile?.profile).toEqual(complete)
    expect(briefing.snapshotCount).toBe(1)
    expect(briefing.snapshots[0].asOfDate).toBe('2026-11-17')
    expect(briefing.snapshots[0].totalValue).toBeGreaterThan(0)
    expect(sectionText(briefing, 'decisions')).toBe(
      '- Retire at 60\n- Downsize'
    )
    expect(briefing.checks).toEqual({ missing: [], warnings: [] })
  })

  it('REQ-MCP-33 replaces the notes on each save', async () => {
    ok(
      await call('save_plan_notes', {
        section: 'decisions',
        text: 'first',
        expectedRevision: 0,
      })
    )
    ok(
      await call('save_plan_notes', {
        section: 'decisions',
        text: 'second',
        expectedRevision: 1,
      })
    )
    const briefing = ok(await call('get_briefing')) as unknown as Briefing
    expect(sectionText(briefing, 'decisions')).toBe('second')
  })

  it('REQ-MCP-33 rejects a section longer than 4,000 characters and keeps the old text', async () => {
    ok(
      await call('save_plan_notes', {
        section: 'decisions',
        text: 'keep',
        expectedRevision: 0,
      })
    )
    const result = await call('save_plan_notes', {
      section: 'decisions',
      text: 'x'.repeat(4_001),
      expectedRevision: 1,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.structuredContent)).toContain('at most 4,000')
    const briefing = ok(await call('get_briefing')) as unknown as Briefing
    expect(sectionText(briefing, 'decisions')).toBe('keep')
  })

  it('REQ-MCP-33 warns about a mortgage payoff date that does not match the loan', async () => {
    ok(
      await call('save_profile', {
        profile: {
          ...complete,
          mortgage: {
            balance: 300_000,
            asOfDate: '2026-11-02',
            rate: 0.02875,
            monthlyPayment: 1_450.0,
            payoffDate: '2031-08-01',
          },
        },
      })
    )
    const briefing = ok(await call('get_briefing')) as unknown as Briefing
    expect(briefing.checks.warnings).toHaveLength(1)
    expect(briefing.checks.warnings[0].message).toMatch(/2031-08-01.*2050-10/)
  })
})

describe('REQ-MCP-33: missingInputs', () => {
  it('flags savings, healthcare phases, Social Security and tax on a bare early-retirement profile', () => {
    const bare: UserProfile = {
      currentAge: 53,
      targetRetirementAge: 60,
      annualExpenses: 96_000,
    }
    expect(missingInputs(bare, true).map(item => item.field)).toEqual([
      'annualContributions',
      'spendingPhases',
      'socialSecurityMonthly',
      'withdrawalTaxRate',
    ])
  })

  it('does not ask for savings or healthcare phases from someone retired at 66', () => {
    const retired: UserProfile = {
      currentAge: 66,
      targetRetirementAge: 66,
      annualExpenses: 70_000,
      socialSecurityAge: 67,
      socialSecurityMonthly: 3_000,
      withdrawalTaxRate: 0.12,
    }
    expect(missingInputs(retired, true)).toEqual([])
  })
})
