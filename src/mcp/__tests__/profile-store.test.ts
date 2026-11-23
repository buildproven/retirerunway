// @vitest-environment node
// Local user data store for the MCP server (REQ-MCP-10..15, BUI-1803).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
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
import { calculatePortfolioValue } from '@/engine/portfolio-math'
import type { Portfolio, UserProfile } from '@/engine/types'
import { createPlanServer } from '../server'
import {
  removeAccountNumbers,
  resolveDataDir,
  snapshotPortfolio,
} from '../user-store'

const repoRoot = resolve(__dirname, '..', '..', '..')
const fixtureDir = resolve(
  repoRoot,
  'skills',
  'retire-runway',
  'fixtures',
  'csv'
)

// Data directories the repo guard tests point inside the repo and skill folder.
const REPO_PROBE_DIR = 'rr-user-data-test'
const skillProbeDir = join(repoRoot, 'skills', 'retire-runway', REPO_PROBE_DIR)

function csvFixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf8')
}

const profile: UserProfile = {
  currentAge: 56,
  targetRetirementAge: 57,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2_500,
  stateTaxRate: 0.05,
  federalTaxBracket: 0.22,
}

interface FieldError {
  field: string
  message: string
}

interface SavedData {
  profile?: { file: string; updatedAt: string }
  portfolio?: { file: string; asOfDate: string }
}

let client: Client
let root: string
let dataDir: string

async function call(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

function errorText(result: CallToolResult): string {
  return result.content
    .map(block => ('text' in block ? block.text : ''))
    .join('\n')
}

function ok(result: CallToolResult): Record<string, unknown> {
  expect(result.isError, errorText(result)).toBeFalsy()
  expect(result.structuredContent, errorText(result)).toBeDefined()
  return result.structuredContent as Record<string, unknown>
}

function fieldErrors(result: CallToolResult): FieldError[] {
  expect(result.isError).toBe(true)
  const payload = result.structuredContent as {
    ok: boolean
    errors: FieldError[]
  }
  expect(payload.ok).toBe(false)
  return payload.errors
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

/** Every file and directory under `dir`, relative to it, sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map(entry => entry.split('\\').join('/'))
    .sort()
}

function withoutProvenance(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const { provenance: _omitted, ...rest } = payload
  return rest
}

function savedPortfolio(asOfDate: string): Portfolio {
  const file = JSON.parse(
    readFileSync(join(dataDir, 'snapshots', `${asOfDate}.json`), 'utf8')
  ) as { portfolio: Portfolio }
  return file.portfolio
}

async function saveSnapshot(asOfDate: string, fixture = 'fidelity-sample.csv') {
  return ok(
    await call('import_positions', {
      csv: csvFixture(fixture),
      asOfDate,
      save: true,
    })
  )
}

beforeAll(async () => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createPlanServer().connect(serverTransport)
  client = new Client({ name: 'profile-store-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rr-mcp-store-'))
  dataDir = join(root, 'data')
  process.env.RETIRE_RUNWAY_DATA_DIR = dataDir
})

afterEach(() => {
  delete process.env.RETIRE_RUNWAY_DATA_DIR
  rmSync(root, { recursive: true, force: true })
  // If the repo guard regresses, the guard tests write here; clean up so one
  // failure does not leave files in the repo or fail later tests.
  rmSync(join(repoRoot, REPO_PROBE_DIR), { recursive: true, force: true })
  rmSync(skillProbeDir, { recursive: true, force: true })
})

describe('REQ-MCP-10: user data lives in the data directory only', () => {
  it('REQ-MCP-10 defaults to ~/.retire-runway and expands a leading ~ in RETIRE_RUNWAY_DATA_DIR', () => {
    expect(resolveDataDir({})).toBe(join(homedir(), '.retire-runway'))
    expect(resolveDataDir({ RETIRE_RUNWAY_DATA_DIR: '' })).toBe(
      join(homedir(), '.retire-runway')
    )
    expect(resolveDataDir({ RETIRE_RUNWAY_DATA_DIR: '~/rr-data' })).toBe(
      join(homedir(), 'rr-data')
    )
    expect(resolveDataDir({ RETIRE_RUNWAY_DATA_DIR: dataDir })).toBe(dataDir)
  })

  it('REQ-MCP-10 creates the directory with mode 700 and each file with mode 600', async () => {
    ok(await call('save_profile', { profile }))
    await saveSnapshot('2026-03-01')
    expect(mode(dataDir)).toBe(0o700)
    expect(mode(join(dataDir, 'snapshots'))).toBe(0o700)
    expect(mode(join(dataDir, 'profile.json'))).toBe(0o600)
    expect(mode(join(dataDir, 'snapshots', '2026-03-01.json'))).toBe(0o600)
  })

  it('REQ-MCP-10 writes mode-600 files into an existing directory without changing its mode', async () => {
    mkdirSync(dataDir, { mode: 0o755 })
    chmodSync(dataDir, 0o755)
    ok(await call('save_profile', { profile }))
    await saveSnapshot('2026-03-01')
    expect(mode(dataDir)).toBe(0o755)
    expect(mode(join(dataDir, 'profile.json'))).toBe(0o600)
    expect(mode(join(dataDir, 'snapshots'))).toBe(0o700)
    expect(mode(join(dataDir, 'snapshots', '2026-03-01.json'))).toBe(0o600)
  })

  // Only a case-insensitive filesystem (the macOS default) maps the
  // upper-case path to the repo; elsewhere it is a different directory.
  it.runIf(existsSync(repoRoot.toUpperCase()))(
    'REQ-MCP-10 finds the repo directory when the data directory path differs only in letter case',
    async () => {
      process.env.RETIRE_RUNWAY_DATA_DIR = join(
        repoRoot.toUpperCase(),
        REPO_PROBE_DIR
      )
      const errors = fieldErrors(await call('save_profile', { profile }))
      expect(errors.map(error => error.field)).toEqual([
        'RETIRE_RUNWAY_DATA_DIR',
      ])
      expect(existsSync(join(repoRoot, REPO_PROBE_DIR))).toBe(false)
    }
  )

  it('REQ-MCP-10 writes nothing outside the data directory and leaves no temporary files', async () => {
    ok(await call('save_profile', { profile }))
    ok(
      await call('save_profile', {
        profile: { ...profile, annualExpenses: 90_000 },
      })
    )
    await saveSnapshot('2026-03-01')
    await saveSnapshot('2026-03-01')
    expect(readdirSync(root)).toEqual(['data'])
    expect(tree(dataDir)).toEqual([
      'profile.json',
      'snapshots',
      'snapshots/2026-03-01.json',
    ])
  })

  it('REQ-MCP-10 refuses a data directory inside the package or repo directory and writes nothing', async () => {
    for (const inside of [
      repoRoot,
      join(repoRoot, REPO_PROBE_DIR),
      skillProbeDir,
    ]) {
      process.env.RETIRE_RUNWAY_DATA_DIR = inside
      const errors = fieldErrors(await call('save_profile', { profile }))
      expect(errors.map(error => error.field)).toEqual([
        'RETIRE_RUNWAY_DATA_DIR',
      ])
      expect(errors[0].message).toMatch(/package|repo/)
    }
    expect(existsSync(join(repoRoot, REPO_PROBE_DIR))).toBe(false)
    expect(existsSync(skillProbeDir)).toBe(false)
    expect(existsSync(join(repoRoot, 'profile.json'))).toBe(false)
  })

  it('REQ-MCP-10 refuses a symlink that points the data directory into the repo', async () => {
    const link = join(root, 'link')
    symlinkSync(repoRoot, link)
    process.env.RETIRE_RUNWAY_DATA_DIR = join(link, REPO_PROBE_DIR)
    const errors = fieldErrors(await call('save_profile', { profile }))
    expect(errors.map(error => error.field)).toEqual(['RETIRE_RUNWAY_DATA_DIR'])
    expect(existsSync(join(repoRoot, REPO_PROBE_DIR))).toBe(false)
  })

  it('REQ-MCP-10 refuses a repo subdirectory whose name starts with two dots', () => {
    expect(() =>
      resolveDataDir({ RETIRE_RUNWAY_DATA_DIR: join(repoRoot, '..data') })
    ).toThrow(/inside the retire-runway package/)
    expect(
      resolveDataDir({ RETIRE_RUNWAY_DATA_DIR: join(repoRoot, '..', 'data') })
    ).toBe(resolve(repoRoot, '..', 'data'))
  })

  it('REQ-MCP-10 refuses a relative data directory', async () => {
    process.env.RETIRE_RUNWAY_DATA_DIR = 'relative/data'
    const errors = fieldErrors(await call('save_profile', { profile }))
    expect(errors.map(error => error.field)).toEqual(['RETIRE_RUNWAY_DATA_DIR'])
    expect(errors[0].message).toMatch(/absolute/)
  })
})

describe('REQ-MCP-11: save_profile', () => {
  it('REQ-MCP-11 writes profile.json with the profile and its updatedAt', async () => {
    const before = Date.now()
    const payload = ok(await call('save_profile', { profile }))
    expect(payload).toMatchObject({ ok: true, file: 'profile.json', profile })
    const updatedAt = payload.updatedAt as string
    expect(Date.parse(updatedAt)).toBeGreaterThanOrEqual(before - 1_000)
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt)
    const file = JSON.parse(readFileSync(join(dataDir, 'profile.json'), 'utf8'))
    expect(file).toEqual({ version: 1, updatedAt, profile })
  })

  it('REQ-MCP-11 returns field-level errors from the portfolio_analysis schema and writes nothing', async () => {
    const errors = fieldErrors(
      await call('save_profile', {
        profile: {
          ...profile,
          annualExpenses: -1,
          currentAge: 60,
          targetRetirementAge: 55,
        },
      })
    )
    expect(errors.map(error => error.field).sort()).toEqual([
      'profile.annualExpenses',
      'profile.targetRetirementAge',
    ])
    expect(existsSync(dataDir)).toBe(false)
  })

  it('REQ-MCP-11 keeps the saved profile when a later save is invalid', async () => {
    ok(await call('save_profile', { profile }))
    const before = readFileSync(join(dataDir, 'profile.json'), 'utf8')
    fieldErrors(
      await call('save_profile', { profile: { ...profile, currentAge: 10 } })
    )
    expect(readFileSync(join(dataDir, 'profile.json'), 'utf8')).toBe(before)
  })

  it('REQ-MCP-11 rejects an unknown profile key before writing', async () => {
    const result = await call('save_profile', {
      profile: { ...profile, retireAge: 60 },
    })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toMatch(/retireAge/)
    expect(existsSync(dataDir)).toBe(false)
  })
})

describe('REQ-MCP-12: get_profile', () => {
  it('REQ-MCP-12 says no profile is saved and creates nothing', async () => {
    const payload = ok(await call('get_profile', {}))
    expect(payload.ok).toBe(true)
    expect(payload.saved).toBe(false)
    expect(payload.message).toMatch(/no profile saved/)
    expect(payload.message).toMatch(/save_profile/)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('REQ-MCP-12 returns the saved profile and its updatedAt', async () => {
    const saved = ok(await call('save_profile', { profile }))
    const payload = ok(await call('get_profile', {}))
    expect(payload).toEqual({
      ok: true,
      saved: true,
      file: 'profile.json',
      profile,
      updatedAt: saved.updatedAt,
    })
  })

  it('REQ-MCP-12 reports an unreadable profile.json instead of hiding it', async () => {
    mkdirSync(dataDir, { mode: 0o700 })
    writeFileSync(join(dataDir, 'profile.json'), '{ not json', { mode: 0o600 })
    const errors = fieldErrors(await call('get_profile', {}))
    expect(errors[0].field).toBe('profile')
    expect(errors[0].message).toMatch(/profile\.json/)

    writeFileSync(
      join(dataDir, 'profile.json'),
      JSON.stringify({
        version: 1,
        updatedAt: 'x',
        profile: { currentAge: 'old' },
      })
    )
    expect(fieldErrors(await call('get_profile', {}))[0].message).toMatch(
      /profile\.json/
    )
  })
})

describe('REQ-MCP-13: import_positions save and list_snapshots', () => {
  it('REQ-MCP-13 stores the portfolio as snapshots/<asOf>.json with no account number', async () => {
    const payload = await saveSnapshot('2026-03-01')
    const imported = payload.portfolio as Portfolio
    expect(payload.saved).toEqual({
      file: 'snapshots/2026-03-01.json',
      asOfDate: '2026-03-01',
      totalValue: calculatePortfolioValue(imported),
    })
    const text = readFileSync(
      join(dataDir, 'snapshots', '2026-03-01.json'),
      'utf8'
    )
    expect(text).not.toMatch(/Z12345|A98765/)
    for (const account of imported.accounts) {
      // Content-hash IDs come from the account name, so they would let the number be recovered.
      expect(text).not.toContain(account.id)
    }
    const portfolio = savedPortfolio('2026-03-01')
    expect(portfolio.asOfDate).toBe('2026-03-01')
    expect(portfolio.accounts.map(account => account.name)).toEqual([
      'Employer 401k',
      'Traditional IRA',
    ])
    expect(calculatePortfolioValue(portfolio)).toBe(
      calculatePortfolioValue(imported)
    )
    expect(portfolio.accounts.map(account => account.accountType)).toEqual(
      imported.accounts.map(account => account.accountType)
    )
  })

  it('REQ-MCP-13 removes account numbers in each common form and keeps account names distinct', async () => {
    expect(removeAccountNumbers('Employer 401k Z12345')).toBe('Employer 401k')
    expect(removeAccountNumbers('Roth IRA 22222')).toBe('Roth IRA')
    expect(removeAccountNumbers('Individual-12345678')).toBe('Individual')
    expect(removeAccountNumbers('Brokerage (...9876)')).toBe('Brokerage')
    expect(removeAccountNumbers('XXXX-5678')).toBe('')
    expect(removeAccountNumbers('Joint #****4321 Account')).toBe(
      'Joint Account'
    )
    expect(removeAccountNumbers('403b Plan')).toBe('403b Plan')
    expect(removeAccountNumbers('Taxable')).toBe('Taxable')
    expect(
      snapshotPortfolio(
        {
          name: 'P',
          accounts: ['IRA 11111', 'IRA (2)', 'IRA 22222'].map(name => ({
            id: name,
            name,
            institution: 'Generic',
            accountType: 'traditional_ira' as const,
            holdings: [],
            cds: [],
            cashBalance: 1,
          })),
        },
        '2026-04-01'
      ).accounts.map(account => account.name)
    ).toEqual(['IRA', 'IRA (2)', 'IRA (3)'])

    await saveSnapshot('2026-04-01', 'account-numbers.csv')
    const text = readFileSync(
      join(dataDir, 'snapshots', '2026-04-01.json'),
      'utf8'
    )
    expect(text).not.toMatch(/33333|44444|12345678|9876|5678|55555/)
    const names = savedPortfolio('2026-04-01').accounts.map(
      account => account.name
    )
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'Traditional IRA',
      'Traditional IRA (2)',
      'Individual',
      'Brokerage',
      'Account 5',
      'Employer 401k',
    ])
  })

  it('REQ-MCP-13 lists each snapshot with its date and total value, newest first', async () => {
    expect(ok(await call('list_snapshots', {}))).toEqual({
      ok: true,
      snapshots: [],
    })
    expect(existsSync(dataDir)).toBe(false)

    await saveSnapshot('2026-03-01')
    await saveSnapshot('2026-04-01', 'schwab-sample.csv')
    const payload = ok(await call('list_snapshots', {}))
    expect(payload.snapshots).toEqual([
      {
        asOfDate: '2026-04-01',
        file: 'snapshots/2026-04-01.json',
        totalValue: calculatePortfolioValue(savedPortfolio('2026-04-01')),
      },
      {
        asOfDate: '2026-03-01',
        file: 'snapshots/2026-03-01.json',
        totalValue: calculatePortfolioValue(savedPortfolio('2026-03-01')),
      },
    ])
    const values = (payload.snapshots as { totalValue: number }[]).map(
      s => s.totalValue
    )
    expect(values[1]).toBeGreaterThan(values[0])
    expect(values[0]).toBe(84_000 + 57_600)
  })

  it('REQ-MCP-13 saves nothing without save: true, without an as-of date, or with no accounts', async () => {
    ok(
      await call('import_positions', {
        csv: csvFixture('fidelity-sample.csv'),
        asOfDate: '2026-03-01',
      })
    )
    expect(existsSync(dataDir)).toBe(false)

    const undated = fieldErrors(
      await call('import_positions', {
        csv: csvFixture('fidelity-sample.csv'),
        save: true,
      })
    )
    expect(undated.map(error => error.field)).toEqual(['asOfDate'])

    const empty = fieldErrors(
      await call('import_positions', {
        csv: '',
        asOfDate: '2026-03-01',
        save: true,
      })
    )
    expect(empty.map(error => error.field)).toEqual(['csv'])
    expect(existsSync(dataDir)).toBe(false)
  })

  it('REQ-MCP-13 saves nothing when the parsed positions total $0', async () => {
    const errors = fieldErrors(
      await call('import_positions', {
        csv: 'Account,Symbol,Description,Quantity\nMain,VTI,Vanguard Total Stock,10\n',
        asOfDate: '2026-03-01',
        save: true,
      })
    )
    expect(errors.map(error => error.field)).toEqual(['csv'])
    expect(errors[0].message).toMatch(/total \$0/)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('REQ-MCP-13 saves a 2026 Fidelity export with its footer date and value, without account numbers', async () => {
    const payload = ok(
      await call('import_positions', {
        csv: csvFixture('fidelity-2026.csv'),
        save: true,
      })
    )
    const saved = payload.saved as { asOfDate: string; totalValue: number }
    expect(saved.asOfDate).toBe('2026-11-02')
    expect(saved.totalValue).toBe(54_350)
    const stored = readFileSync(
      join(dataDir, 'snapshots', '2026-11-02.json'),
      'utf8'
    )
    for (const number of ['Z11111111', '22222', '333333333', '55555555']) {
      expect(stored).not.toContain(number)
    }
  })

  it('REQ-MCP-13 reports an unreadable snapshot by file name', async () => {
    await saveSnapshot('2026-03-01')
    writeFileSync(join(dataDir, 'snapshots', '2026-03-01.json'), '[]')
    const errors = fieldErrors(await call('list_snapshots', {}))
    expect(errors[0].field).toBe('portfolio')
    expect(errors[0].message).toMatch(/snapshots\/2026-03-01\.json/)
  })

  it('REQ-MCP-13 ignores files in snapshots/ that are not dated snapshots', async () => {
    await saveSnapshot('2026-03-01')
    writeFileSync(join(dataDir, 'snapshots', 'notes.txt'), 'x')
    writeFileSync(join(dataDir, 'snapshots', '2026-13-99.json'), '{}')
    const payload = ok(await call('list_snapshots', {}))
    expect(
      (payload.snapshots as { asOfDate: string }[]).map(s => s.asOfDate)
    ).toEqual(['2026-03-01'])
  })
})

describe('REQ-MCP-14: portfolio tools fall back to the saved profile and newest snapshot', () => {
  it('REQ-MCP-14 portfolio_analysis with nothing passed equals a call with the saved ones, and the stamp names them', async () => {
    const saved = ok(await call('save_profile', { profile }))
    await saveSnapshot('2026-02-01', 'schwab-sample.csv')
    await saveSnapshot('2026-03-01')
    const portfolio = savedPortfolio('2026-03-01')

    const fromSaved = ok(await call('portfolio_analysis', {}))
    const explicit = ok(
      await call('portfolio_analysis', { portfolio, profile })
    )
    expect(withoutProvenance(fromSaved)).toEqual(withoutProvenance(explicit))
    expect(fromSaved.riskScore).toBeDefined()

    const stamp = fromSaved.provenance as {
      inputHash: string
      outputHash: string
      seed: number
      assumptions: { savedData: SavedData; asOfDate: string }
    }
    const reference = explicit.provenance as typeof stamp
    expect(stamp.inputHash).toBe(reference.inputHash)
    expect(stamp.outputHash).toBe(reference.outputHash)
    expect(stamp.seed).toBe(42)
    expect(stamp.assumptions.asOfDate).toBe('2026-03-01')
    expect(stamp.assumptions.savedData).toEqual({
      profile: { file: 'profile.json', updatedAt: saved.updatedAt },
      portfolio: { file: 'snapshots/2026-03-01.json', asOfDate: '2026-03-01' },
    })
    expect(reference.assumptions.savedData).toBeUndefined()
  })

  it('REQ-MCP-14 uses the saved value only for the missing argument', async () => {
    const saved = ok(await call('save_profile', { profile }))
    await saveSnapshot('2026-03-01')
    const portfolio = savedPortfolio('2026-03-01')
    const other = { ...profile, annualExpenses: 60_000 }

    const onlyPortfolioSaved = ok(
      await call('portfolio_analysis', {
        profile: other,
        includeMonteCarlo: false,
      })
    )
    const explicit = ok(
      await call('portfolio_analysis', {
        portfolio,
        profile: other,
        includeMonteCarlo: false,
      })
    )
    expect(withoutProvenance(onlyPortfolioSaved)).toEqual(
      withoutProvenance(explicit)
    )
    expect(
      (
        onlyPortfolioSaved.provenance as {
          assumptions: { savedData: SavedData }
        }
      ).assumptions.savedData
    ).toEqual({
      portfolio: { file: 'snapshots/2026-03-01.json', asOfDate: '2026-03-01' },
    })

    const onlyProfileSaved = ok(await call('trade_plan', { portfolio }))
    expect(
      (onlyProfileSaved.provenance as { assumptions: { savedData: SavedData } })
        .assumptions.savedData
    ).toEqual({ profile: { file: 'profile.json', updatedAt: saved.updatedAt } })
  })

  it('REQ-MCP-14 tax_strategy and trade_plan use the saved data as if passed in', async () => {
    ok(await call('save_profile', { profile }))
    await saveSnapshot('2026-03-01')
    const portfolio = savedPortfolio('2026-03-01')
    for (const [tool, extra] of [
      ['tax_strategy', { filingStatus: 'married_filing_jointly' }],
      ['trade_plan', {}],
    ] as const) {
      const fromSaved = ok(await call(tool, { ...extra }))
      const explicit = ok(await call(tool, { ...extra, portfolio, profile }))
      expect(withoutProvenance(fromSaved)).toEqual(withoutProvenance(explicit))
      const a = fromSaved.provenance as {
        inputHash: string
        assumptions: { savedData: SavedData }
      }
      const b = explicit.provenance as typeof a
      expect(a.inputHash).toBe(b.inputHash)
      expect(Object.keys(a.assumptions.savedData).sort()).toEqual([
        'portfolio',
        'profile',
      ])
    }
  })

  it('REQ-MCP-14 returns field-level errors naming save_profile and import_positions when nothing is saved', async () => {
    for (const tool of ['portfolio_analysis', 'tax_strategy', 'trade_plan']) {
      const errors = fieldErrors(await call(tool, {}))
      expect(errors.map(error => error.field)).toEqual(['profile', 'portfolio'])
      expect(errors[0].message).toMatch(/save_profile/)
      expect(errors[1].message).toMatch(/import_positions/)
    }
    ok(await call('save_profile', { profile }))
    const errors = fieldErrors(await call('portfolio_analysis', {}))
    expect(errors.map(error => error.field)).toEqual(['portfolio'])
    expect(tree(dataDir)).toEqual(['profile.json'])
  })

  it('REQ-MCP-14 applies the value rules to a saved profile that later became invalid', async () => {
    await saveSnapshot('2026-03-01')
    writeFileSync(
      join(dataDir, 'profile.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        profile: { ...profile, annualExpenses: -5 },
      })
    )
    const errors = fieldErrors(await call('portfolio_analysis', {}))
    expect(errors.map(error => error.field)).toEqual(['profile.annualExpenses'])
  })
})

describe('REQ-MCP-15: delete_user_data', () => {
  it('REQ-MCP-15 does nothing without confirm: true', async () => {
    ok(await call('save_profile', { profile }))
    await saveSnapshot('2026-03-01')
    const before = tree(dataDir)

    const missing = await call('delete_user_data', {})
    expect(missing.isError).toBe(true)
    const declined = ok(await call('delete_user_data', { confirm: false }))
    expect(declined).toMatchObject({ ok: false, removed: [] })
    expect(declined.message).toMatch(/confirm/)
    expect(tree(dataDir)).toEqual(before)
  })

  it('REQ-MCP-15 with confirm: true empties the data directory and reports the files removed', async () => {
    ok(await call('save_profile', { profile }))
    await saveSnapshot('2026-03-01')
    await saveSnapshot('2026-04-01', 'schwab-sample.csv')
    const payload = ok(await call('delete_user_data', { confirm: true }))
    expect(payload).toEqual({
      ok: true,
      dataDir,
      removed: [
        'profile.json',
        'snapshots/2026-03-01.json',
        'snapshots/2026-04-01.json',
      ],
      kept: [],
    })
    expect(readdirSync(dataDir)).toEqual([])
    expect(ok(await call('get_profile', {})).saved).toBe(false)
  })

  it('REQ-MCP-15 removes only files the store owns and reports what it kept', async () => {
    ok(await call('save_profile', { profile }))
    writeFileSync(join(dataDir, 'notes.txt'), 'mine')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, '2026-01-01.json'), '{}')
    symlinkSync(outside, join(dataDir, 'snapshots'))
    const payload = ok(await call('delete_user_data', { confirm: true }))
    expect(payload.removed).toEqual(['profile.json'])
    expect(payload.kept).toEqual(['notes.txt', 'snapshots'])
    expect(existsSync(join(outside, '2026-01-01.json'))).toBe(true)
    expect(relative(dataDir, join(dataDir, 'notes.txt'))).toBe('notes.txt')
    expect(existsSync(join(dataDir, 'notes.txt'))).toBe(true)
  })

  it('REQ-MCP-15 reports nothing removed when nothing is saved', async () => {
    expect(ok(await call('delete_user_data', { confirm: true }))).toEqual({
      ok: true,
      dataDir,
      removed: [],
      kept: [],
    })
  })
})

describe('BUI-1831: the saved profile records home value and mortgage', () => {
  const home = {
    estimatedValue: 650_000,
    low: 600_000,
    high: 700_000,
  }
  const mortgage = {
    balance: 210_000,
    asOfDate: '2026-03-01',
    rate: 0.0375,
    monthlyPayment: 2_100,
    payoffDate: '2031-06-01',
  }

  it('BUI-1831 R1 saves and returns home and mortgage', async () => {
    const withHome: UserProfile = { ...profile, home, mortgage }
    const saved = ok(await call('save_profile', { profile: withHome }))
    expect(saved.profile).toEqual(withHome)
    const file = JSON.parse(readFileSync(join(dataDir, 'profile.json'), 'utf8'))
    expect(file.profile.home).toEqual(home)
    expect(file.profile.mortgage).toEqual(mortgage)

    const payload = ok(await call('get_profile', {}))
    expect(payload.profile).toEqual(withHome)
  })

  it('BUI-1831 R1 saves a home with only its value and a mortgage with only its balance', async () => {
    const minimal: UserProfile = {
      ...profile,
      home: { estimatedValue: 400_000 },
      mortgage: { balance: 90_000, asOfDate: '2026-03-01' },
    }
    ok(await call('save_profile', { profile: minimal }))
    expect(ok(await call('get_profile', {})).profile).toEqual(minimal)
  })

  it('BUI-1831 R1 rejects an unknown home or mortgage key and a bad payoff date, and writes nothing', async () => {
    for (const bad of [
      { home: { ...home, sqft: 2_000 } },
      { mortgage: { ...mortgage, lender: 'Bank' } },
      { mortgage: { ...mortgage, payoffDate: '06/01/2031' } },
      { mortgage: { balance: 1, monthlyPayment: 1 } },
    ]) {
      const result = await call('save_profile', {
        profile: { ...profile, ...bad },
      })
      expect(result.isError, JSON.stringify(bad)).toBe(true)
    }
    expect(existsSync(dataDir)).toBe(false)
  })

  it('BUI-1831 R2 portfolio_analysis on the saved profile reports net worth from the saved home', async () => {
    await saveSnapshot('2026-03-01')
    ok(await call('save_profile', { profile: { ...profile, home, mortgage } }))
    const payload = ok(await call('portfolio_analysis', {}))
    const investable = calculatePortfolioValue(savedPortfolio('2026-03-01'))
    expect(payload.netWorth).toEqual({
      investableValue: investable,
      homeValue: 650_000,
      homeValueLow: 600_000,
      homeValueHigh: 700_000,
      mortgageBalance: 210_000,
      homeEquity: 440_000,
      netWorth: investable + 440_000,
    })
  })
})
