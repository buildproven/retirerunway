// @vitest-environment node
// get_briefing and save_plan_notes through the MCP server: notes saved one
// section at a time with a revision check (REQ-MCP-35), refused when they
// hold sensitive content or run long (REQ-MCP-36), a briefing in a fixed
// order with the fixing tool on every check and up to five next actions
// (REQ-MCP-37), and instructions that say how to use them (REQ-MCP-38).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
import packageJson from '../../../package.json'
import { WHATS_NEW } from '../instructions'
import { SECTION_KEYS } from '../plan-notes'
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

interface Briefing {
  checks: {
    warnings: { message: string; fixWith: string }[]
    missing: { field: string; why: string; fixWith: string }[]
  }
  notes: {
    file: string | null
    migratedFromSingleText: boolean
    sections: {
      section: string
      title: string
      text: string
      revision: number
      updatedAt: string | null
    }[]
  }
  nextActions: { action: string; tool: string | null }[]
  server: { version: string; whatsNew: string[] }
}

let client: Client
let root: string
let dataDir: string

async function call(
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

function content(result: CallToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>
}

async function briefing(): Promise<Briefing> {
  const result = await call('get_briefing')
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  return content(result) as unknown as Briefing
}

function section(b: Briefing, key: string) {
  const found = b.notes.sections.find(s => s.section === key)
  if (found === undefined) throw new Error(`no section ${key}`)
  return found
}

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createPlanServer().connect(serverTransport)
  client = new Client({ name: 'sectioned-briefing-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rr-sections-'))
  dataDir = join(root, 'data')
  process.env.RETIRE_RUNWAY_DATA_DIR = dataDir
})

afterEach(() => {
  delete process.env.RETIRE_RUNWAY_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('REQ-MCP-35: save_plan_notes saves one section with a revision check', () => {
  it('REQ-MCP-35 saves a section, returns its revision, and leaves the others', async () => {
    const saved = await call('save_plan_notes', {
      section: 'openItems',
      text: '- ACA quote',
      expectedRevision: 0,
    })
    expect(saved.isError).toBeFalsy()
    expect(content(saved)).toMatchObject({
      ok: true,
      file: 'notes.json',
      section: 'openItems',
      revision: 1,
    })
    const b = await briefing()
    expect(section(b, 'openItems')).toMatchObject({
      text: '- ACA quote',
      revision: 1,
    })
    expect(section(b, 'decisions')).toMatchObject({
      text: '',
      revision: 0,
      updatedAt: null,
    })
  })

  it('REQ-MCP-35 returns a conflict naming the current revision and saves nothing', async () => {
    await call('save_plan_notes', {
      section: 'decisions',
      text: 'Retire at 60.',
      expectedRevision: 0,
    })
    await call('save_plan_notes', {
      section: 'decisions',
      text: 'Retire at 60; downsize.',
      expectedRevision: 1,
    })
    const stale = await call('save_plan_notes', {
      section: 'decisions',
      text: 'Retire at 58.',
      expectedRevision: 1,
    })
    expect(stale.isError).toBe(true)
    const body = content(stale)
    expect(body.conflict).toEqual({
      section: 'decisions',
      expectedRevision: 1,
      currentRevision: 2,
    })
    expect(JSON.stringify(body.errors)).toContain('revision 2')
    expect(section(await briefing(), 'decisions')).toMatchObject({
      text: 'Retire at 60; downsize.',
      revision: 2,
    })
  })

  it('REQ-MCP-35 migrates saved single-text notes into their sections without losing anything', async () => {
    const legacy =
      '# Plan\n\n## Decisions\n- Retire at 60\n- Downsize\n\n## Scenario being weighed\n- Keep house: 48.1%\n\n## Confirmed figures\n- SS $50K/yr at 67\n\n## Open items\n- ACA quote\n'
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'notes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-18T00:00:00.000Z',
        notes: legacy,
      })
    )
    const before = await briefing()
    expect(before.notes.migratedFromSingleText).toBe(true)
    expect(section(before, 'decisions')).toEqual({
      section: 'decisions',
      title: 'Decisions',
      text: '# Plan\n\n## Decisions\n- Retire at 60\n- Downsize',
      revision: 1,
      updatedAt: '2026-11-18T00:00:00.000Z',
    })
    expect(section(before, 'scenarios').text).toBe(
      '## Scenario being weighed\n- Keep house: 48.1%'
    )
    expect(section(before, 'confirmedFigures').text).toBe(
      '## Confirmed figures\n- SS $50K/yr at 67'
    )
    expect(section(before, 'openItems')).toMatchObject({
      text: '## Open items\n- ACA quote',
      revision: 1,
    })
    expect(section(before, 'agentLog').revision).toBe(0)
    // The open item shows up as a next action.
    expect(before.nextActions.map(a => a.action)).toContain(
      'Open item: ACA quote'
    )
    // Saving one section writes the sectioned file and keeps the others.
    await call('save_plan_notes', {
      section: 'agentLog',
      text: '- 2026-11-19: migrated notes',
      expectedRevision: 0,
    })
    const after = await briefing()
    expect(after.notes.migratedFromSingleText).toBe(false)
    expect(section(after, 'scenarios').text).toBe(
      '## Scenario being weighed\n- Keep house: 48.1%'
    )
    const file = JSON.parse(readFileSync(join(dataDir, 'notes.json'), 'utf8'))
    expect(file.version).toBe(2)
    expect(file.sections.confirmedFigures.text).toBe(
      '## Confirmed figures\n- SS $50K/yr at 67'
    )
  })

  it('REQ-MCP-35 rejects an unknown section and a missing revision at the schema', async () => {
    expect(
      (
        await call('save_plan_notes', {
          section: 'misc',
          text: 'x',
          expectedRevision: 0,
        })
      ).isError
    ).toBe(true)
    expect(
      (await call('save_plan_notes', { section: 'decisions', text: 'x' }))
        .isError
    ).toBe(true)
    expect((await call('save_plan_notes', { notes: 'x' })).isError).toBe(true)
  })
})

describe('REQ-MCP-36: save_plan_notes refuses sensitive or long text', () => {
  it.each([
    ['card 4111 1111 1111 1111', 'card number'],
    ['SSN 123-45-6789', 'Social Security number'],
    ['Schwab account number 87654321', 'account or routing number'],
    ['passport X1234567', 'government ID number'],
    ['Empower password: hunter2', 'password'],
  ])(
    'REQ-MCP-36 refuses %j, names a %s, and keeps the old text',
    async (text, kind) => {
      await call('save_plan_notes', {
        section: 'confirmedFigures',
        text: 'keep',
        expectedRevision: 0,
      })
      const result = await call('save_plan_notes', {
        section: 'confirmedFigures',
        text,
        expectedRevision: 1,
      })
      expect(result.isError).toBe(true)
      const errors = JSON.stringify(content(result).errors)
      expect(errors).toContain(kind)
      expect(errors).toContain('Confirmed figures')
      expect(section(await briefing(), 'confirmedFigures')).toMatchObject({
        text: 'keep',
        revision: 1,
      })
    }
  )

  it('REQ-MCP-36 warns in the briefing about stored notes over the cap or holding sensitive text', async () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, 'notes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-11-18T00:00:00.000Z',
        notes: `SSN 123-45-6789\n${'x'.repeat(4_100)}`,
      })
    )
    const b = await briefing()
    const notesWarnings = b.checks.warnings.filter(
      w => w.fixWith === 'save_plan_notes'
    )
    expect(notesWarnings.map(w => w.message).join('\n')).toMatch(
      /Decisions holds 4,116 characters/
    )
    expect(notesWarnings.map(w => w.message).join('\n')).toMatch(
      /Social Security number/
    )
    expect(JSON.stringify(b.checks)).not.toContain('123-45-6789')
  })
})

describe('REQ-MCP-37: get_briefing order, fixes, next actions and version', () => {
  it('REQ-MCP-37 returns its fields in the fixed order', async () => {
    const result = await call('get_briefing')
    expect(Object.keys(content(result))).toEqual([
      'ok',
      'checks',
      'profile',
      'snapshots',
      'snapshotCount',
      'notes',
      'nextActions',
      'server',
      'tools',
    ])
    expect(
      Object.keys((content(result) as unknown as Briefing).checks)
    ).toEqual(['warnings', 'missing'])
  })

  it('REQ-MCP-37 names the tool that fixes each missing input', async () => {
    const b = await briefing()
    expect(b.checks.missing.map(m => [m.field, m.fixWith])).toEqual([
      ['profile', 'save_profile'],
      ['snapshot', 'import_positions'],
    ])
    await call('save_profile', {
      profile: {
        currentAge: 53,
        targetRetirementAge: 60,
        annualExpenses: 96_000,
      },
    })
    const bare = await briefing()
    expect(bare.checks.missing.length).toBeGreaterThan(1)
    for (const item of bare.checks.missing) {
      expect(item.fixWith).toMatch(/^(save_profile|import_positions)$/)
    }
  })

  it('REQ-MCP-37 names save_profile on the mortgage payoff warning', async () => {
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
    const b = await briefing()
    expect(b.checks.warnings).toHaveLength(1)
    expect(b.checks.warnings[0].fixWith).toBe('save_profile')
  })

  it('REQ-MCP-37 lists every section in order, even when nothing is saved', async () => {
    const b = await briefing()
    expect(b.notes.file).toBeNull()
    expect(b.notes.sections.map(s => s.section)).toEqual([...SECTION_KEYS])
  })

  it('REQ-MCP-37 returns at most five next actions: fixes first, then open items', async () => {
    await call('save_plan_notes', {
      section: 'openItems',
      text: '- one\n- two\n- three\n- four\n- five\n- six',
      expectedRevision: 0,
    })
    const b = await briefing()
    expect(b.nextActions).toHaveLength(5)
    expect(b.nextActions[0]).toEqual({
      action: expect.stringMatching(/^Set profile/),
      tool: 'save_profile',
    })
    expect(b.nextActions[1].tool).toBe('import_positions')
    expect(b.nextActions.slice(2).map(a => a.action)).toEqual([
      'Open item: one',
      'Open item: two',
      'Open item: three',
    ])
  })

  it('REQ-MCP-47 asks for planRules when everything else is in place, then suggests plan_check', async () => {
    await call('save_profile', { profile: complete })
    await call('import_positions', {
      csv: fixture,
      asOfDate: '2026-11-17',
      save: true,
    })
    const b = await briefing()
    expect(b.checks).toEqual({ warnings: [], missing: [] })
    expect(b.nextActions).toEqual([
      {
        action: expect.stringMatching(
          /^Draft your plan rules with propose_plan_rules/
        ),
        tool: 'propose_plan_rules',
      },
    ])
    await call('save_profile', {
      profile: { ...complete, planRules: { targetEquityShare: 0.64 } },
    })
    const after = await briefing()
    expect(after.nextActions).toEqual([
      { action: expect.stringMatching(/^Run plan_check/), tool: 'plan_check' },
    ])
  })

  it("REQ-MCP-37 reports the server version and what's new", async () => {
    const b = await briefing()
    expect(b.server.version).toBe(packageJson.version)
    expect(b.server.whatsNew).toEqual([...WHATS_NEW])
    expect(b.server.whatsNew.length).toBeGreaterThan(0)
    expect(b.server.whatsNew.length).toBeLessThanOrEqual(5)
  })
})

describe('REQ-MCP-38: the instructions say how to keep context', () => {
  it('REQ-MCP-38 says to start with get_briefing and save by tool, one section at a time', () => {
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('Start every conversation with get_briefing')
    expect(instructions).toContain(
      'Save every figure the user confirms with save_profile'
    )
    expect(instructions).toMatch(/save_plan_notes[^.]*one section at a time/i)
    expect(instructions).toContain('expectedRevision')
    for (const key of SECTION_KEYS) expect(instructions).toContain(key)
  })
})
