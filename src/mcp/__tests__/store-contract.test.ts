// @vitest-environment node
// Store adapters for saved user data (REQ-MCP-17..21, BUI-1858): the local
// folder store and the private GitHub repo store pass one contract, and the
// tools pick the store from the environment.
import { generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  vi,
} from 'vitest'
import type { Portfolio, UserProfile } from '@/engine/types'
import { GitStore, openDataStore } from '../git-store'
import { createPlanServer } from '../server'
import type { DataStore } from '../user-store'
import { UserStore, UserStoreError, snapshotPortfolio } from '../user-store'

const TOKEN = 'ghp_TESTTOKEN0123456789abcdefSECRET'
const APP_ID = '123456'
// The GitHub App key the environment names; generated, never committed.
const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString()
const INSTALLATION_ID = 7
const REPO = 'example-owner/finance-data'
const DATA_PATH = 'retire-runway'
const fixtureDir = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'skills',
  'retire-runway',
  'fixtures',
  'csv'
)

const profile: UserProfile = {
  currentAge: 56,
  targetRetirementAge: 57,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2_500,
  stateTaxRate: 0.05,
  federalTaxBracket: 0.22,
}

function portfolio(asOfDate: string, value = 100_000): Portfolio {
  return snapshotPortfolio(
    {
      name: 'Test',
      accounts: [
        {
          id: 'a',
          name: 'Brokerage 12345678',
          institution: 'Fidelity',
          accountType: 'brokerage',
          cds: [],
          cashBalance: 0,
          holdings: [
            {
              id: 'h',
              symbol: 'VTI',
              name: 'Vanguard Total Stock Market',
              assetClass: 'us_equity',
              shares: 10,
              costBasis: value / 2,
              currentPrice: value / 10,
              currentValue: value,
            },
          ],
        },
      ],
    },
    asOfDate
  )
}

// ---------------------------------------------------------------------------
// A fake GitHub contents API over an in-memory repo.

interface FakeFile {
  content: string
  sha: string
}

interface FakeResponse {
  status: number
  body: unknown
}

class FakeGitHub {
  readonly files = new Map<string, FakeFile>()
  readonly commits: string[] = []
  readonly writes: { method: string; path: string }[] = []
  readonly authorizations = new Set<string>()
  readonly urls: string[] = []
  /** Answers every contents request with this (a bad token, no access). */
  failAll: FakeResponse | undefined
  /** Answers the next contents request whose method matches with this. */
  failNext: (FakeResponse & { method?: string }) | undefined
  /** Number of writes still to answer 409 although the sha matches (branch moved). */
  branchMoves = 0
  /** Runs before each write is applied: another writer racing this one. */
  beforeWrite: ((path: string) => void) | undefined
  private shaCount = 0

  nextSha(): string {
    this.shaCount += 1
    return this.shaCount.toString(16).padStart(40, '0')
  }

  put(path: string, content: string): void {
    this.files.set(path, { content, sha: this.nextSha() })
  }

  json(path: string): unknown {
    const file = this.files.get(path)
    return file === undefined ? undefined : JSON.parse(file.content)
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    this.authorizations.add(headers.get('authorization') ?? '')
    this.urls.push(url.href)
    const answer = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    const repoPrefix = `/repos/${REPO}`
    if (url.hostname !== 'api.github.com') return answer(400, { url: url.href })
    // The GitHub App endpoints mint the installation token TOKEN.
    if (url.pathname === `${repoPrefix}/installation`) {
      return answer(200, { id: INSTALLATION_ID })
    }
    if (
      url.pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`
    ) {
      return answer(201, {
        token: TOKEN,
        expires_at: '2999-01-01T00:00:00Z',
      })
    }
    const contentsPrefix = `${repoPrefix}/contents/`
    if (!url.pathname.startsWith(contentsPrefix)) {
      return answer(404, { message: 'Not Found' })
    }
    const path = url.pathname
      .slice(contentsPrefix.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/')
    if (this.failAll !== undefined) {
      return answer(this.failAll.status, this.failAll.body)
    }
    if (
      this.failNext !== undefined &&
      (this.failNext.method === undefined || this.failNext.method === method)
    ) {
      const failure = this.failNext
      this.failNext = undefined
      return answer(failure.status, failure.body)
    }
    if (method === 'GET') return this.get(path, answer)
    const body = JSON.parse(String(init?.body)) as {
      message: string
      content?: string
      sha?: string
    }
    this.writes.push({ method, path })
    this.beforeWrite?.(path)
    if (this.branchMoves > 0) {
      this.branchMoves -= 1
      return answer(409, { message: 'reference cannot be updated' })
    }
    const existing = this.files.get(path)
    if (method === 'PUT') {
      if (existing !== undefined && body.sha === undefined) {
        return answer(422, {
          message: 'Invalid request.\n\n"sha" wasn\'t supplied.',
        })
      }
      if (body.sha !== undefined && body.sha !== existing?.sha) {
        return answer(409, {
          message: `${path} does not match ${body.sha}`,
        })
      }
      const content = Buffer.from(String(body.content), 'base64').toString(
        'utf8'
      )
      this.put(path, content)
      this.commits.push(body.message)
      return answer(existing === undefined ? 201 : 200, {
        content: { path, sha: this.files.get(path)?.sha },
      })
    }
    if (method === 'DELETE') {
      if (existing === undefined) return answer(404, { message: 'Not Found' })
      if (body.sha !== existing.sha) {
        return answer(409, { message: `${path} does not match ${body.sha}` })
      }
      this.files.delete(path)
      this.commits.push(body.message)
      return answer(200, { content: null })
    }
    return answer(405, { message: 'Method not allowed' })
  }

  private get(
    path: string,
    answer: (status: number, body: unknown) => Response
  ): Response {
    const file = this.files.get(path)
    if (file !== undefined) {
      // GitHub wraps base64 content at 60 characters.
      const encoded = Buffer.from(file.content, 'utf8').toString('base64')
      return answer(200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: file.sha,
        encoding: 'base64',
        content: (encoded.match(/.{1,60}/g) ?? []).join('\n'),
      })
    }
    const prefix = `${path}/`
    const children = new Map<string, 'file' | 'dir'>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue
      const [name, ...rest] = key.slice(prefix.length).split('/')
      children.set(name, rest.length > 0 ? 'dir' : 'file')
    }
    if (children.size === 0) return answer(404, { message: 'Not Found' })
    return answer(
      200,
      [...children].map(([name, type]) => ({
        name,
        path: `${path}/${name}`,
        type,
        sha: this.files.get(`${path}/${name}`)?.sha ?? 'dir',
      }))
    )
  }
}

function gitStore(github: FakeGitHub, tool = 'save_profile'): GitStore {
  return new GitStore({
    repo: REPO,
    path: DATA_PATH,
    token: TOKEN,
    tool,
    fetch: github.fetch,
  })
}

async function storeError(promise: Promise<unknown>): Promise<UserStoreError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(UserStoreError)
  return error as UserStoreError
}

// ---------------------------------------------------------------------------
// The contract both adapters pass.

interface Adapter {
  store: (tool?: string) => DataStore
  /** Writes a file the store does not own at `path` inside the data folder. */
  plant: (path: string, content: string) => void
}

const adapters: Record<string, () => Adapter> = {
  'folder store': () => {
    const dir = join(roots[roots.length - 1], 'data')
    return {
      store: () => new UserStore(dir),
      plant: (path, content) => {
        mkdirSync(join(dir, path, '..'), { recursive: true })
        writeFileSync(join(dir, path), content)
      },
    }
  },
  'git store': () => {
    const github = new FakeGitHub()
    return {
      store: tool => gitStore(github, tool),
      plant: (path, content) => github.put(`${DATA_PATH}/${path}`, content),
    }
  },
}

const roots: string[] = []

beforeEach(() => {
  roots.push(mkdtempSync(join(tmpdir(), 'rr-store-contract-')))
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe.each(Object.keys(adapters))(
  'REQ-MCP-21: the %s passes the store contract',
  name => {
    let adapter: Adapter
    beforeEach(() => {
      adapter = adapters[name]()
    })

    it('REQ-MCP-21 saves a profile and gets it back, and a second save replaces it', async () => {
      expect(await adapter.store().readProfile()).toBeUndefined()
      const saved = await adapter
        .store()
        .saveProfile(profile, '2026-11-01T00:00:00.000Z')
      expect(saved.file).toBe('profile.json')
      expect(await adapter.store().readProfile()).toEqual({
        file: 'profile.json',
        updatedAt: '2026-11-01T00:00:00.000Z',
        profile,
      })
      const changed = { ...profile, annualExpenses: 90_000 }
      await adapter.store().saveProfile(changed, '2026-11-02T00:00:00.000Z')
      const read = await adapter.store().readProfile()
      expect(read?.profile.annualExpenses).toBe(90_000)
      expect(read?.updatedAt).toBe('2026-11-02T00:00:00.000Z')
    })

    it('REQ-MCP-21 saves snapshots and lists them newest first', async () => {
      expect(await adapter.store().listSnapshots()).toEqual([])
      expect(await adapter.store().newestSnapshot()).toBeUndefined()
      const store = adapter.store('import_positions')
      await store.saveSnapshot(portfolio('2026-03-01', 100_000))
      await store.saveSnapshot(portfolio('2026-05-01', 120_000))
      await store.saveSnapshot(portfolio('2026-01-15', 90_000))
      adapter.plant('snapshots/notes.txt', 'not a snapshot')
      const listed = await adapter.store().listSnapshots()
      expect(listed.map(snapshot => snapshot.asOfDate)).toEqual([
        '2026-05-01',
        '2026-03-01',
        '2026-01-15',
      ])
      expect(listed[0].file).toBe('snapshots/2026-05-01.json')
      expect(listed[0].portfolio).toEqual(portfolio('2026-05-01', 120_000))
      const newest = await adapter.store().newestSnapshot()
      expect(newest?.asOfDate).toBe('2026-05-01')
      expect(newest?.portfolio.accounts[0].holdings[0].currentValue).toBe(
        120_000
      )
    })

    it('REQ-MCP-33 saves plan notes, replaces them, and deleteAll removes them', async () => {
      expect(await adapter.store().readNotes()).toBeUndefined()
      const first = await adapter.store('save_plan_notes').saveNotesSection({
        section: 'decisions',
        text: 'Retire at 60; downsize.',
        expectedRevision: 0,
        updatedAt: '2026-11-18T00:00:00.000Z',
      })
      expect(first).toMatchObject({
        ok: true,
        section: 'decisions',
        revision: 1,
      })
      await adapter.store('save_plan_notes').saveNotesSection({
        section: 'decisions',
        text: 'Retire at 60.',
        expectedRevision: 1,
        updatedAt: '2026-11-19T00:00:00.000Z',
      })
      const read = await adapter.store().readNotes()
      expect(read?.file).toBe('notes.json')
      expect(read?.migratedFromSingleText).toBe(false)
      expect(read?.sections.decisions).toEqual({
        text: 'Retire at 60.',
        revision: 2,
        updatedAt: '2026-11-19T00:00:00.000Z',
      })
      await adapter.store().saveProfile(profile, '2026-11-01T00:00:00.000Z')
      const report = await adapter.store('delete_user_data').deleteAll()
      expect([...report.removed].sort()).toEqual(['notes.json', 'profile.json'])
      expect(await adapter.store().readNotes()).toBeUndefined()
    })

    it('REQ-MCP-35 replaces only the named section and leaves the others', async () => {
      const save = (
        section: 'decisions' | 'openItems',
        text: string,
        expectedRevision: number
      ) =>
        adapter.store('save_plan_notes').saveNotesSection({
          section,
          text,
          expectedRevision,
          updatedAt: '2026-11-19T00:00:00.000Z',
        })
      await save('decisions', 'Retire at 60.', 0)
      await save('openItems', '- Get an ACA quote', 0)
      await save('openItems', '- Get an ACA quote\n- Set a downsize target', 1)
      const read = await adapter.store().readNotes()
      expect(read?.sections.decisions).toMatchObject({
        text: 'Retire at 60.',
        revision: 1,
      })
      expect(read?.sections.openItems).toMatchObject({
        text: '- Get an ACA quote\n- Set a downsize target',
        revision: 2,
      })
      expect(read?.sections.scenarios).toEqual({
        text: '',
        revision: 0,
        updatedAt: null,
      })
    })

    it('REQ-MCP-35 refuses a stale revision, names the current one and writes nothing', async () => {
      const store = adapter.store('save_plan_notes')
      await store.saveNotesSection({
        section: 'decisions',
        text: 'Retire at 60.',
        expectedRevision: 0,
        updatedAt: '2026-11-18T00:00:00.000Z',
      })
      const stale = await store.saveNotesSection({
        section: 'decisions',
        text: 'Retire at 58.',
        expectedRevision: 0,
        updatedAt: '2026-11-19T00:00:00.000Z',
      })
      expect(stale).toEqual({
        ok: false,
        section: 'decisions',
        currentRevision: 1,
      })
      expect(
        (await adapter.store().readNotes())?.sections.decisions
      ).toMatchObject({
        text: 'Retire at 60.',
        revision: 1,
      })
    })

    it('REQ-MCP-35 migrates single-text notes into their sections without losing anything', async () => {
      const legacy =
        '# Plan\n\n## Decisions\n- Retire at 60\n\n## Open items\n- ACA quote\n'
      adapter.plant(
        'notes.json',
        JSON.stringify({
          version: 1,
          updatedAt: '2026-11-18T00:00:00.000Z',
          notes: legacy,
        })
      )
      const read = await adapter.store().readNotes()
      expect(read?.migratedFromSingleText).toBe(true)
      expect(read?.sections.decisions).toEqual({
        text: '# Plan\n\n## Decisions\n- Retire at 60',
        revision: 1,
        updatedAt: '2026-11-18T00:00:00.000Z',
      })
      expect(read?.sections.openItems).toEqual({
        text: '## Open items\n- ACA quote',
        revision: 1,
        updatedAt: '2026-11-18T00:00:00.000Z',
      })
      for (const key of [
        'scenarios',
        'confirmedFigures',
        'agentLog',
      ] as const) {
        expect(read?.sections[key]).toEqual({
          text: '',
          revision: 0,
          updatedAt: null,
        })
      }
      // The first save writes sections; the migrated text is kept.
      await adapter.store('save_plan_notes').saveNotesSection({
        section: 'openItems',
        text: '- ACA quote\n- Downsize target',
        expectedRevision: 1,
        updatedAt: '2026-11-19T00:00:00.000Z',
      })
      const after = await adapter.store().readNotes()
      expect(after?.migratedFromSingleText).toBe(false)
      expect(after?.sections.decisions.text).toBe(
        '# Plan\n\n## Decisions\n- Retire at 60'
      )
      expect(after?.sections.openItems).toMatchObject({
        text: '- ACA quote\n- Downsize target',
        revision: 2,
      })
    })

    it('REQ-MCP-33 reports saved notes that are not valid as a field error naming the file', async () => {
      adapter.plant('notes.json', '{ "version": 1, "notes": 42 }')
      const error = await storeError(adapter.store().readNotes())
      expect(error.field).toBe('notes')
      expect(error.message).toContain('notes.json')
    })

    it('REQ-MCP-21 refuses a snapshot without a real calendar date', async () => {
      const error = await storeError(
        adapter.store().saveSnapshot(portfolio('2026-02-30'))
      )
      expect(error.field).toBe('asOfDate')
    })

    it('REQ-MCP-21 delete_user_data removes only its own files', async () => {
      expect(await adapter.store().deleteAll()).toEqual({
        removed: [],
        kept: [],
      })
      await adapter.store().saveProfile(profile, '2026-11-01T00:00:00.000Z')
      await adapter.store().saveSnapshot(portfolio('2026-03-01'))
      await adapter.store().saveSnapshot(portfolio('2026-01-15'))
      adapter.plant('notes.md', 'keep me')
      adapter.plant('snapshots/README.txt', 'keep me too')
      const report = await adapter.store('delete_user_data').deleteAll()
      expect(report).toEqual({
        removed: [
          'profile.json',
          'snapshots/2026-01-15.json',
          'snapshots/2026-03-01.json',
        ],
        kept: ['notes.md', 'snapshots/README.txt'],
      })
      expect(await adapter.store().readProfile()).toBeUndefined()
      expect(await adapter.store().listSnapshots()).toEqual([])
    })

    it('REQ-MCP-21 reports a saved profile that is not valid JSON as a field error naming the file', async () => {
      adapter.plant('profile.json', '{ not json')
      const error = await storeError(adapter.store().readProfile())
      expect(error.field).toBe('profile')
      expect(error.message).toContain('profile.json is not valid JSON')
    })

    it('REQ-MCP-21 reports a snapshot dated differently from its file name', async () => {
      adapter.plant(
        'snapshots/2026-04-01.json',
        JSON.stringify({ version: 1, portfolio: portfolio('2026-03-01') })
      )
      const error = await storeError(adapter.store().listSnapshots())
      expect(error.field).toBe('portfolio')
      expect(error.message).toContain('snapshots/2026-04-01.json')
    })
  }
)

// ---------------------------------------------------------------------------
// Git store behaviour.

describe('REQ-MCP-17: the git store writes the repo folder with one commit per write', () => {
  it('REQ-MCP-17 writes the folder layout with one commit named data: <tool> <file>', async () => {
    const github = new FakeGitHub()
    await gitStore(github, 'save_profile').saveProfile(
      profile,
      '2026-11-01T00:00:00.000Z'
    )
    await gitStore(github, 'import_positions').saveSnapshot(
      portfolio('2026-03-01')
    )
    expect([...github.files.keys()].sort()).toEqual([
      'retire-runway/profile.json',
      'retire-runway/snapshots/2026-03-01.json',
    ])
    expect(github.json('retire-runway/profile.json')).toEqual({
      version: 1,
      updatedAt: '2026-11-01T00:00:00.000Z',
      profile,
    })
    expect(github.json('retire-runway/snapshots/2026-03-01.json')).toEqual({
      version: 1,
      portfolio: portfolio('2026-03-01'),
    })
    await gitStore(github, 'delete_user_data').deleteAll()
    expect(github.commits).toEqual([
      'data: save_profile profile.json',
      'data: import_positions snapshots/2026-03-01.json',
      'data: delete_user_data profile.json',
      'data: delete_user_data snapshots/2026-03-01.json',
    ])
    expect([...github.authorizations]).toEqual([`Bearer ${TOKEN}`])
  })

  it('REQ-MCP-17 accepts a data path with surrounding or doubled slashes and a nested folder', async () => {
    const github = new FakeGitHub()
    await new GitStore({
      repo: REPO,
      path: '/apps//retire-runway/',
      token: TOKEN,
      tool: 'save_profile',
      fetch: github.fetch,
    }).saveProfile(profile, '2026-11-01T00:00:00.000Z')
    expect([...github.files.keys()]).toEqual([
      'apps/retire-runway/profile.json',
    ])
  })

  it('REQ-MCP-17 calls only the contents API of the configured repo folder', async () => {
    const github = new FakeGitHub()
    const store = gitStore(github)
    await store.saveProfile(profile, '2026-11-01T00:00:00.000Z')
    await store.readProfile()
    await store.listSnapshots()
    await store.deleteAll()
    expect(github.urls.length).toBeGreaterThan(0)
    for (const url of github.urls) {
      expect(url).toMatch(
        /^https:\/\/api\.github\.com\/repos\/example-owner\/finance-data\/contents\/retire-runway(\/|$)/
      )
    }
  })

  it('REQ-MCP-17 reports a file too large for the contents API instead of reading it as empty', async () => {
    const github = new FakeGitHub()
    github.put('retire-runway/profile.json', '{}')
    github.failNext = {
      method: 'GET',
      status: 200,
      body: {
        type: 'file',
        path: 'retire-runway/profile.json',
        sha: 'abc',
        encoding: 'none',
        content: '',
      },
    }
    const error = await storeError(gitStore(github).readProfile())
    expect(error.message).toContain(`${REPO}/retire-runway/profile.json`)
    expect(error.message).toContain('too large')
  })

  it('REQ-MCP-17 reports a snapshots folder at the contents API listing limit instead of a truncated list', async () => {
    const github = new FakeGitHub()
    github.failNext = {
      method: 'GET',
      status: 200,
      body: Array.from({ length: 1000 }, (_, index) => ({
        name: `${index}.txt`,
        path: `retire-runway/snapshots/${index}.txt`,
        type: 'file',
        sha: 'x',
      })),
    }
    const error = await storeError(gitStore(github).listSnapshots())
    expect(error.message).toContain('1000')
    expect(error.message).toContain(`${REPO}/retire-runway/snapshots`)
  })

  it('REQ-MCP-17 rejects a malformed repo or a data path that leaves the folder', () => {
    for (const repo of ['finance', 'a/b/c', 'owner/', '/repo', 'own er/repo']) {
      expect(
        () =>
          new GitStore({
            repo,
            path: DATA_PATH,
            token: TOKEN,
            tool: 'save_profile',
          })
      ).toThrow(UserStoreError)
    }
    for (const path of ['../other', 'a/../b', './x', '/', '']) {
      expect(
        () =>
          new GitStore({ repo: REPO, path, token: TOKEN, tool: 'save_profile' })
      ).toThrow(UserStoreError)
    }
  })
})

describe('REQ-MCP-18: the environment picks the store', () => {
  const gitEnv = {
    RETIRE_RUNWAY_DATA_REPO: REPO,
    RETIRE_RUNWAY_DATA_PATH: DATA_PATH,
    RETIRE_RUNWAY_GITHUB_APP_ID: APP_ID,
    RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY: APP_KEY,
  }

  it('REQ-MCP-18 uses the git store when all three variables are set', () => {
    expect(openDataStore('save_profile', gitEnv)).toBeInstanceOf(GitStore)
  })

  it('REQ-MCP-18 uses the local folder store when none is set', () => {
    const dir = join(roots[0], 'data')
    const store = openDataStore('save_profile', {
      RETIRE_RUNWAY_DATA_DIR: dir,
    })
    expect(store).toBeInstanceOf(UserStore)
    expect(store.location).toEqual({ dataDir: dir })
    expect(
      openDataStore('save_profile', {
        RETIRE_RUNWAY_DATA_DIR: dir,
        RETIRE_RUNWAY_DATA_REPO: '',
        RETIRE_RUNWAY_DATA_PATH: '',
        RETIRE_RUNWAY_GITHUB_APP_ID: '',
        RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY: '',
      })
    ).toBeInstanceOf(UserStore)
  })

  it('REQ-MCP-18 names the missing variables when only some are set, never the token', () => {
    let thrown: unknown
    try {
      openDataStore('save_profile', {
        RETIRE_RUNWAY_DATA_REPO: REPO,
        RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY: APP_KEY,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UserStoreError)
    const error = thrown as UserStoreError
    expect(error.field).toBe('RETIRE_RUNWAY_DATA_PATH')
    expect(error.message).toContain('RETIRE_RUNWAY_DATA_PATH')
    expect(error.message).toContain('RETIRE_RUNWAY_GITHUB_APP_ID')
    expect(error.message).not.toContain(APP_KEY)
    expect(error.message).not.toContain('PRIVATE KEY-----')
  })
})

describe('REQ-MCP-19: a write that races another write never overwrites the newer file', () => {
  it('REQ-MCP-19 retries once when the branch moved and the file did not, then commits', async () => {
    const github = new FakeGitHub()
    await gitStore(github).saveProfile(profile, '2026-11-01T00:00:00.000Z')
    github.branchMoves = 1
    await gitStore(github).saveProfile(
      { ...profile, annualExpenses: 90_000 },
      '2026-11-02T00:00:00.000Z'
    )
    expect(github.writes.length).toBe(3)
    expect(github.commits.length).toBe(2)
    expect(
      (github.json('retire-runway/profile.json') as { profile: UserProfile })
        .profile.annualExpenses
    ).toBe(90_000)
  })

  it('REQ-MCP-19 keeps the newer profile when another writer changed it, after one retry', async () => {
    const github = new FakeGitHub()
    await gitStore(github).saveProfile(profile, '2026-11-01T00:00:00.000Z')
    const newer = JSON.stringify({
      version: 1,
      updatedAt: '2026-11-03T00:00:00.000Z',
      profile: { ...profile, annualExpenses: 70_000 },
    })
    github.beforeWrite = path => {
      github.beforeWrite = undefined
      github.put(path, newer)
    }
    const error = await storeError(
      gitStore(github).saveProfile(
        { ...profile, annualExpenses: 90_000 },
        '2026-11-02T00:00:00.000Z'
      )
    )
    expect(github.writes.length).toBe(3)
    expect(github.files.get('retire-runway/profile.json')?.content).toBe(newer)
    expect(error.field).toBe('profile')
    expect(error.message).toContain(`${REPO}/retire-runway/profile.json`)
    expect(error.message).toContain('409')
    expect(error.message).toContain('nothing was overwritten')
  })

  it('REQ-MCP-19 keeps a snapshot another writer created first (GitHub 422 sha not supplied)', async () => {
    const github = new FakeGitHub()
    const theirs = JSON.stringify({
      version: 1,
      portfolio: portfolio('2026-03-01', 50_000),
    })
    github.beforeWrite = path => {
      github.beforeWrite = undefined
      github.put(path, theirs)
    }
    const error = await storeError(
      gitStore(github, 'import_positions').saveSnapshot(portfolio('2026-03-01'))
    )
    expect(github.writes.length).toBe(2)
    expect(
      github.files.get('retire-runway/snapshots/2026-03-01.json')?.content
    ).toBe(theirs)
    expect(github.commits).toEqual([])
    expect(error.field).toBe('portfolio')
    expect(error.message).toContain(
      `${REPO}/retire-runway/snapshots/2026-03-01.json`
    )
    expect(error.message).toContain('422')
  })

  it('REQ-MCP-19 keeps a file another writer changed while delete_user_data ran', async () => {
    const github = new FakeGitHub()
    await gitStore(github).saveProfile(profile, '2026-11-01T00:00:00.000Z')
    github.beforeWrite = path => {
      github.beforeWrite = undefined
      github.put(path, '{"newer":true}')
    }
    const error = await storeError(
      gitStore(github, 'delete_user_data').deleteAll()
    )
    expect(github.files.get('retire-runway/profile.json')?.content).toBe(
      '{"newer":true}'
    )
    expect(error.message).toContain('409')
  })
})

describe('REQ-MCP-20: GitHub errors are field errors naming the repo path and status, never the token', () => {
  const cases: [
    string,
    Partial<FakeGitHub>,
    (store: GitStore) => Promise<unknown>,
  ][] = [
    [
      '401 bad credentials on a read',
      { failAll: { status: 401, body: { message: 'Bad credentials' } } },
      store => store.readProfile(),
    ],
    [
      '401 bad credentials on a listing',
      { failAll: { status: 401, body: { message: 'Bad credentials' } } },
      store => store.listSnapshots(),
    ],
    [
      '404 on a write (no repo, or no access to a private repo)',
      {
        failNext: {
          method: 'PUT',
          status: 404,
          body: { message: 'Not Found' },
        },
      },
      store => store.saveProfile(profile, '2026-11-01T00:00:00.000Z'),
    ],
    [
      '500 on a read that echoes the token',
      {
        failNext: {
          method: 'GET',
          status: 500,
          body: { message: `server error for token ${TOKEN}` },
        },
      },
      store => store.readProfile(),
    ],
    [
      '403 rate limit on a write',
      {
        failNext: {
          method: 'PUT',
          status: 403,
          body: { message: 'API rate limit exceeded' },
        },
      },
      store => store.saveProfile(profile, '2026-11-01T00:00:00.000Z'),
    ],
  ]

  it.each(cases)('REQ-MCP-20 %s', async (_name, setup, operation) => {
    const github = Object.assign(new FakeGitHub(), setup)
    const error = await storeError(operation(gitStore(github)))
    expect(error.message).toContain(REPO)
    expect(error.message).toMatch(/GitHub (returned|answered) \d{3}/)
    expect(error.message).not.toContain(TOKEN)
    expect(error.field).not.toContain(TOKEN)
  })

  it('REQ-MCP-20 names the status and file path of a failed read', async () => {
    const github = new FakeGitHub()
    github.failNext = { method: 'GET', status: 502, body: 'Bad Gateway' }
    const error = await storeError(gitStore(github).readProfile())
    expect(error.field).toBe('profile')
    expect(error.message).toContain(`${REPO}/retire-runway/profile.json`)
    expect(error.message).toContain('502')
  })

  it('REQ-MCP-20 reports a network failure that mentions the token without the token', async () => {
    const store = new GitStore({
      repo: REPO,
      path: DATA_PATH,
      token: TOKEN,
      tool: 'save_profile',
      fetch: async () => {
        throw new TypeError(`fetch failed (Authorization: Bearer ${TOKEN})`)
      },
    })
    const error = await storeError(store.readProfile())
    expect(error.message).toContain(REPO)
    expect(error.message).toContain('fetch failed')
    expect(error.message).not.toContain(TOKEN)
  })
})

describe('REQ-MCP-17: the git store reads a minimal contents API reply', () => {
  /**
   * A fetch double that answers with plain objects holding only `status` and
   * `json()`, files with only `content` and `sha`, listings with only `name`,
   * and 204 for a delete.
   */
  function minimalGitHub() {
    const files = new Map<string, { content: string; sha: string }>()
    const commits: string[] = []
    let count = 0
    const prefix = `https://api.github.com/repos/${REPO}/contents/`
    const fetch = async (input: string, init: RequestInit) => {
      const path = decodeURIComponent(input.slice(prefix.length))
      const method = init.method ?? 'GET'
      const reply = (status: number, body: unknown) => ({
        status,
        json: async () => body,
      })
      if (method === 'GET') {
        const file = files.get(path)
        if (file !== undefined) {
          return reply(200, {
            content: Buffer.from(file.content).toString('base64'),
            sha: file.sha,
          })
        }
        const names = [...files.keys()]
          .filter(key => key.startsWith(`${path}/`))
          .map(key => key.slice(path.length + 1).split('/')[0])
        if (names.length === 0) return reply(404, { message: 'Not Found' })
        return reply(
          200,
          [...new Set(names)].map(name => ({ name }))
        )
      }
      const body = JSON.parse(String(init.body)) as {
        message: string
        content?: string
        sha?: string
      }
      if (body.sha !== files.get(path)?.sha) return reply(409, {})
      commits.push(body.message)
      if (method === 'DELETE') {
        files.delete(path)
        return reply(204, undefined)
      }
      count += 1
      files.set(path, {
        content: Buffer.from(String(body.content), 'base64').toString('utf8'),
        sha: `sha-${count}`,
      })
      return reply(200, {})
    }
    return { files, commits, fetch }
  }

  it('REQ-MCP-17 saves, lists and deletes through a reply with only status and json()', async () => {
    const github = minimalGitHub()
    const store = (tool: string) =>
      new GitStore({
        repo: REPO,
        path: DATA_PATH,
        token: TOKEN,
        tool,
        fetch: github.fetch,
      })
    await store('save_profile').saveProfile(profile, '2026-11-01T00:00:00.000Z')
    await store('import_positions').saveSnapshot(portfolio('2026-03-01'))
    await store('import_positions').saveSnapshot(portfolio('2026-05-01'))
    expect((await store('get_profile').readProfile())?.profile).toEqual(profile)
    expect(
      (await store('list_snapshots').listSnapshots()).map(s => s.asOfDate)
    ).toEqual(['2026-05-01', '2026-03-01'])
    expect(await store('delete_user_data').deleteAll()).toEqual({
      removed: [
        'profile.json',
        'snapshots/2026-03-01.json',
        'snapshots/2026-05-01.json',
      ],
      kept: [],
    })
    expect(github.files.size).toBe(0)
    expect(github.commits).toEqual([
      'data: save_profile profile.json',
      'data: import_positions snapshots/2026-03-01.json',
      'data: import_positions snapshots/2026-05-01.json',
      'data: delete_user_data profile.json',
      'data: delete_user_data snapshots/2026-03-01.json',
      'data: delete_user_data snapshots/2026-05-01.json',
    ])
  })
})

// ---------------------------------------------------------------------------
// The tools over each store.

let client: Client

async function call(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}

function text(result: CallToolResult): string {
  return result.content
    .map(block => ('text' in block ? block.text : ''))
    .join('\n')
}

const ENV_KEYS = [
  'RETIRE_RUNWAY_DATA_DIR',
  'RETIRE_RUNWAY_DATA_REPO',
  'RETIRE_RUNWAY_DATA_PATH',
  'RETIRE_RUNWAY_GITHUB_APP_ID',
  'RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY',
] as const

describe('REQ-MCP-17/18/20: the tools use the store the environment names', () => {
  let saved: Record<string, string | undefined>
  let github: FakeGitHub
  let dataDir: string

  beforeAll(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    await createPlanServer().connect(serverTransport)
    client = new Client({ name: 'store-contract-test', version: '0.0.0' })
    await client.connect(clientTransport)
  })

  afterAll(async () => {
    await client.close()
  })

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
    for (const key of ENV_KEYS) delete process.env[key]
    dataDir = join(roots[0], 'data')
    process.env.RETIRE_RUNWAY_DATA_DIR = dataDir
    github = new FakeGitHub()
    vi.stubGlobal('fetch', github.fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const key of ENV_KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function useGit(): void {
    process.env.RETIRE_RUNWAY_DATA_REPO = REPO
    process.env.RETIRE_RUNWAY_DATA_PATH = DATA_PATH
    process.env.RETIRE_RUNWAY_GITHUB_APP_ID = APP_ID
    process.env.RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY = APP_KEY
  }

  it('REQ-MCP-17 save_profile, import_positions and the portfolio tools read and write the repo folder', async () => {
    useGit()
    expect((await call('save_profile', { profile })).isError).toBeFalsy()
    const imported = await call('import_positions', {
      csv: readFileSync(join(fixtureDir, 'fidelity-sample.csv'), 'utf8'),
      asOfDate: '2026-03-01',
      save: true,
    })
    expect(imported.isError, text(imported)).toBeFalsy()
    expect(github.commits).toEqual([
      'data: save_profile profile.json',
      'data: import_positions snapshots/2026-03-01.json',
    ])
    const got = await call('get_profile', {})
    expect(got.structuredContent).toMatchObject({ saved: true, profile })
    const listed = await call('list_snapshots', {})
    expect(listed.structuredContent).toMatchObject({
      snapshots: [
        { asOfDate: '2026-03-01', file: 'snapshots/2026-03-01.json' },
      ],
    })
    const analysis = await call('portfolio_analysis', {
      includeMonteCarlo: false,
    })
    expect(analysis.isError, text(analysis)).toBeFalsy()
    const deleted = await call('delete_user_data', { confirm: true })
    expect(deleted.structuredContent).toMatchObject({
      ok: true,
      dataRepo: REPO,
      dataPath: DATA_PATH,
      removed: ['profile.json', 'snapshots/2026-03-01.json'],
    })
    expect(github.files.size).toBe(0)
    expect(readdirOrEmpty(dataDir)).toEqual([])
  })

  it('REQ-MCP-18 the tools use the local folder when the git variables are unset', async () => {
    expect((await call('save_profile', { profile })).isError).toBeFalsy()
    expect(github.writes).toEqual([])
    expect(readdirOrEmpty(dataDir)).toEqual(['profile.json'])
    const deleted = await call('delete_user_data', { confirm: true })
    expect(deleted.structuredContent).toMatchObject({ ok: true, dataDir })
  })

  it('REQ-MCP-20 a GitHub error is a field error naming the repo path and status, never the token', async () => {
    useGit()
    github.failNext = {
      method: 'PUT',
      status: 500,
      body: { message: `boom ${TOKEN}` },
    }
    const result = await call('save_profile', { profile })
    expect(result.isError).toBe(true)
    const payload = result.structuredContent as {
      errors: { field: string; message: string }[]
    }
    expect(payload.errors[0].message).toContain(
      `${REPO}/retire-runway/profile.json`
    )
    expect(payload.errors[0].message).toContain('500')
    expect(text(result)).not.toContain(TOKEN)
    github.failAll = { status: 401, body: { message: 'Bad credentials' } }
    for (const [name, args] of [
      ['get_profile', {}],
      ['list_snapshots', {}],
      ['delete_user_data', { confirm: true }],
      ['portfolio_analysis', {}],
    ] as const) {
      const failed = await call(name, args)
      expect(failed.isError, name).toBe(true)
      expect(text(failed), name).toContain('401')
      expect(text(failed), name).not.toContain(TOKEN)
    }
  })
})

function readdirOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}
