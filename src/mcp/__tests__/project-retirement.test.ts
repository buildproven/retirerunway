// @vitest-environment node
// project_retirement through the MCP server (REQ-MCP-39..41): saved data,
// warnings first, charts ready to draw, a reproducible provenance stamp, and
// instructions that say to use it and show its charts.
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
  separationAge: 60,
}

interface Chart {
  x: number[]
  series: { name: string; values: number[] }[]
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
  client = new Client({ name: 'project-retirement-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rr-project-'))
  process.env.RETIRE_RUNWAY_DATA_DIR = join(root, 'data')
})

afterEach(() => {
  delete process.env.RETIRE_RUNWAY_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

async function saveAll(saved: UserProfile = profile): Promise<void> {
  ok(await call('save_profile', { profile: saved }))
  ok(
    await call('import_positions', {
      csv: fixture,
      asOfDate: '2026-11-17',
      save: true,
    })
  )
}

describe('REQ-MCP-39: project_retirement uses the saved data', () => {
  it('REQ-MCP-39 runs on the saved profile and newest snapshot and names them', async () => {
    await saveAll()
    const out = ok(await call('project_retirement'))
    const summary = out.summary as Record<string, unknown>
    expect(summary.planningAge).toBe(95)
    expect(summary.successRate).toBeGreaterThanOrEqual(0)
    expect(summary.successRate).toBeLessThanOrEqual(1)
    const provenance = out.provenance as Record<string, unknown>
    expect(provenance.seed).toBe(42)
    const assumptions = provenance.assumptions as Record<string, unknown>
    expect(assumptions.savedData).toMatchObject({
      profile: { file: 'profile.json' },
      portfolio: { asOfDate: '2026-11-17' },
    })
    expect(assumptions.modelVersion).toBe('2.9.0')
    expect(assumptions.bothSpousesLiveToPlanningAge).toBe(true)
  })

  it('REQ-MCP-39 names the missing saved data when nothing is saved', async () => {
    const result = await call('project_retirement')
    expect(result.isError).toBe(true)
    const text = JSON.stringify(result.structuredContent)
    expect(text).toContain('save_profile')
    expect(text).toContain('import_positions')
  })

  it('REQ-MCP-39 gives the same output hash for the same inputs and seed', async () => {
    await saveAll()
    const a = ok(await call('project_retirement', { seed: 7 }))
    const b = ok(await call('project_retirement', { seed: 7 }))
    const hashes = (out: Record<string, unknown>) => {
      const stamp = out.provenance as { inputHash: string; outputHash: string }
      return [stamp.inputHash, stamp.outputHash]
    }
    expect(hashes(a)).toEqual(hashes(b))
    expect(hashes(a)[1]).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(a.summary).toEqual(b.summary)
  })

  it('REQ-MCP-39 refuses a planning age before retirement and unknown fields', async () => {
    await saveAll()
    const early = await call('project_retirement', {
      profile: { ...profile, planningAge: 58 },
    })
    expect(early.isError).toBe(true)
    expect(JSON.stringify(early.structuredContent)).toContain('planningAge')
    const unknown = await call('project_retirement', {
      profile: { ...profile, lifeInsurance: true },
    })
    expect(unknown.isError).toBe(true)
  })

  it('REQ-MCP-39 saves and returns the new profile fields', async () => {
    ok(
      await call('save_profile', {
        profile: {
          ...profile,
          nqdcPayout: { startAge: 60, years: 7 },
          planningAge: 92,
        },
      })
    )
    const saved = ok(await call('get_profile'))
    expect((saved.profile as UserProfile).spouse).toEqual(profile.spouse)
    expect((saved.profile as UserProfile).nqdcPayout).toEqual({
      startAge: 60,
      years: 7,
    })
  })
})

describe('REQ-MCP-40: warnings first and charts ready to draw', () => {
  it('REQ-MCP-40 puts warnings first and flags ignored and missing inputs', async () => {
    await saveAll({
      ...profile,
      withdrawalTaxRate: 0.1,
      preMedicareHealthcare: undefined,
    })
    const out = ok(await call('project_retirement'))
    expect(Object.keys(out).slice(0, 4)).toEqual([
      'warnings',
      'summary',
      'charts',
      'projection',
    ])
    const warnings = (out.warnings as string[]).join('\n')
    expect(warnings).toMatch(/withdrawalTaxRate .* ignored/)
    expect(warnings).toMatch(/no preMedicareHealthcare/)
  })

  it('REQ-MCP-40 returns three charts whose series line up with their ages', async () => {
    await saveAll()
    const out = ok(await call('project_retirement'))
    const charts = out.charts as Record<string, Chart>
    expect(Object.keys(charts)).toEqual([
      'balanceByAge',
      'incomeAndSpendingByAge',
      'accountsByAge',
    ])
    for (const chart of Object.values(charts)) {
      expect(chart.x[0]).toBe(54)
      expect(chart.x.at(-1)).toBe(95)
      for (const series of chart.series) {
        expect(series.values).toHaveLength(chart.x.length)
        for (const value of series.values)
          expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('REQ-MCP-40 leaves portfolio_analysis unchanged', async () => {
    await saveAll()
    const before = ok(await call('portfolio_analysis', { seed: 42 }))
    expect(
      (before.monteCarlo as { percentiles: unknown[] }).percentiles
    ).toHaveLength(30)
  })
})

describe('REQ-MCP-41: the instructions say to use project_retirement and show its charts', () => {
  it('REQ-MCP-41 points success rates at project_retirement and names the charts', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/success rate, use project_retirement/)
    expect(SERVER_INSTRUCTIONS).toContain('charts.balanceByAge')
    expect(SERVER_INSTRUCTIONS).toMatch(/phone/)
    expect(SERVER_INSTRUCTIONS).toMatch(/today's dollars/)
  })
})
