// @vitest-environment node
// The hosted store reads and writes data with a GitHub App installation
// token (REQ-STORE-APP-1..6, BUI-1917). GitHub is faked by an injected fetch,
// the clock is injected, and the app key is generated per run.
import { generateKeyPairSync } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exportJWK, generateKeyPair, jwtVerify } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { UserProfile } from '@/engine/types'
import { GitStore, openDataStore } from '../git-store'
import {
  APP_ID_ENV,
  APP_KEY_ENV,
  GitHubAppTokenError,
  REUSE_MARGIN_MS,
  createAppTokenSource,
} from '../github-app-token'
import type { TokenCache } from '../github-app-token'
import {
  GrantStoreError,
  createGitHubGrantStore,
  createHostedOAuthServer,
} from '../oauth-server'
import { UserStore, UserStoreError } from '../user-store'

const ROOT = resolve(__dirname, '..', '..', '..')
const APP_ID = '123456'
const REPO = 'owner/rr-data'
const DATA_PATH = 'retire-runway'
const INSTALLATION_ID = 42
const INSTALLATION_URL = `https://api.github.com/repos/${REPO}/installation`
const ACCESS_TOKENS_URL = `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
const PERSONAL_TOKEN = 'github_pat_PERSONAL_TOKEN_MUST_NOT_BE_SENT'
const START = Date.parse('2026-11-12T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

const profile: UserProfile = {
  currentAge: 56,
  targetRetirementAge: 57,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2_500,
  stateTaxRate: 0.05,
  federalTaxBracket: 0.22,
}

let publicKey: KeyObject
let pkcs1Pem: string
let pkcs8Pem: string
let otherPublicKey: KeyObject
let ecPem: string

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  publicKey = pair.publicKey
  // GitHub generates PKCS#1 ("BEGIN RSA PRIVATE KEY") files.
  pkcs1Pem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  pkcs8Pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  otherPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
  ecPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()
})

interface Call {
  readonly url: string
  readonly method: string
  readonly authorization: string
  readonly body: unknown
}

/**
 * GitHub's app endpoints and contents API over an in-memory folder. Each
 * minted token is `ghs_<n>`, unless `nextToken` names one.
 */
class FakeGitHub {
  readonly calls: Call[] = []
  readonly files = new Map<string, { content: string; sha: string }>()
  installed = true
  mints = 0
  tokenLifetimeMs = HOUR
  nextToken: string | undefined
  /** Answers the next contents request with this status. */
  contentsStatus: number | undefined
  contentsMessage = 'Bad credentials'
  installationReply: { status: number; body: unknown } | undefined
  accessTokenReply: { status: number; body: unknown } | undefined
  offline = false
  /** The tokens the access-token endpoint issued, all still valid. */
  readonly issued = new Set<string>()

  constructor(private readonly clock: () => number) {}

  mintCalls(): Call[] {
    return this.calls.filter(call => call.url === ACCESS_TOKENS_URL)
  }

  contentsCalls(): Call[] {
    return this.calls.filter(call => call.url.includes('/contents/'))
  }

  readonly fetch = async (
    input: string,
    init: RequestInit
  ): Promise<Response> => {
    const method = init.method ?? 'GET'
    const authorization = new Headers(init.headers).get('authorization') ?? ''
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : undefined
    this.calls.push({ url: input, method, authorization, body })
    if (this.offline) {
      throw new TypeError(`fetch failed (Authorization: ${authorization})`)
    }
    if (input === INSTALLATION_URL) {
      if (this.installationReply !== undefined) {
        return Response.json(this.installationReply.body, {
          status: this.installationReply.status,
        })
      }
      if (!this.installed) {
        return Response.json({ message: 'Not Found' }, { status: 404 })
      }
      return Response.json({ id: INSTALLATION_ID, app_id: Number(APP_ID) })
    }
    if (input === ACCESS_TOKENS_URL) {
      if (this.accessTokenReply !== undefined) {
        return Response.json(this.accessTokenReply.body, {
          status: this.accessTokenReply.status,
        })
      }
      this.mints += 1
      const token = this.nextToken ?? `ghs_${this.mints}`
      this.issued.add(token)
      return Response.json(
        {
          token,
          expires_at: new Date(
            this.clock() + this.tokenLifetimeMs
          ).toISOString(),
          permissions: { contents: 'write' },
          repository_selection: 'selected',
        },
        { status: 201 }
      )
    }
    const prefix = `https://api.github.com/repos/${REPO}/contents/`
    if (!input.startsWith(prefix)) {
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }
    const token = authorization.replace(/^Bearer /, '')
    if (this.contentsStatus !== undefined) {
      const status = this.contentsStatus
      this.contentsStatus = undefined
      return Response.json({ message: this.contentsMessage }, { status })
    }
    if (!this.issued.has(token)) {
      return Response.json({ message: 'Bad credentials' }, { status: 401 })
    }
    const path = decodeURIComponent(input.slice(prefix.length))
    if (method === 'GET') {
      const file = this.files.get(path)
      if (file === undefined) {
        return Response.json({ message: 'Not Found' }, { status: 404 })
      }
      return Response.json({
        type: 'file',
        sha: file.sha,
        encoding: 'base64',
        content: Buffer.from(file.content).toString('base64'),
      })
    }
    const write = body as { content: string }
    this.files.set(path, {
      content: Buffer.from(write.content, 'base64').toString('utf8'),
      sha: `sha-${this.files.size + 1}`,
    })
    return Response.json({ content: { path } }, { status: 201 })
  }
}

let now: number
let github: FakeGitHub
let cache: TokenCache
const clock = (): number => now

function source(
  overrides: { privateKey?: string; appId?: string; repo?: string } = {}
) {
  return createAppTokenSource({
    appId: overrides.appId ?? APP_ID,
    privateKey: overrides.privateKey ?? pkcs1Pem,
    repo: overrides.repo ?? REPO,
    fetch: github.fetch,
    now: clock,
    cache,
  })
}

function gitStore(tool = 'save_profile'): GitStore {
  return new GitStore({
    repo: REPO,
    path: DATA_PATH,
    token: source(),
    tool,
    fetch: github.fetch,
  })
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const thrown = await promise.then(
    () => undefined,
    (error: unknown) => error
  )
  expect(thrown).toBeInstanceOf(Error)
  return thrown as Error
}

beforeEach(() => {
  now = START
  github = new FakeGitHub(clock)
  cache = new Map()
})

describe('REQ-STORE-APP-1: the store gets an installation token narrowed to the data repo', () => {
  it('REQ-STORE-APP-1 signs an RS256 app JWT with the app key and the GitHub claims', async () => {
    await source().token()
    const lookup = github.calls.find(call => call.url === INSTALLATION_URL)
    expect(lookup?.method).toBe('GET')
    const jwt = (lookup?.authorization ?? '').replace(/^Bearer /, '')
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
      algorithms: ['RS256'],
      currentDate: new Date(now),
    })
    expect(protectedHeader.alg).toBe('RS256')
    expect(payload.iss).toBe(APP_ID)
    const seconds = Math.floor(START / 1000)
    // iat 60 s back against clock drift; exp within GitHub's 10-minute limit.
    expect(payload.iat).toBe(seconds - 60)
    expect(payload.exp).toBeGreaterThan(seconds)
    expect(payload.exp).toBeLessThanOrEqual(seconds + 600)
    // Another key does not verify it.
    await expect(jwtVerify(jwt, otherPublicKey)).rejects.toThrow()
  })

  it('REQ-STORE-APP-1 narrows the token to the data repo and sends the JWT, not a token, to the app endpoints', async () => {
    const token = await source().token()
    expect(token).toBe('ghs_1')
    const [mint] = github.mintCalls()
    expect(mint.method).toBe('POST')
    expect(mint.body).toEqual({ repositories: ['rr-data'] })
    const lookup = github.calls.find(call => call.url === INSTALLATION_URL)
    expect(mint.authorization).toBe(lookup?.authorization)
    expect(mint.authorization).not.toContain('ghs_')
  })

  it('REQ-STORE-APP-1 accepts a PKCS#8 key and a key whose newlines are \\n escapes, as env values hold them', async () => {
    for (const privateKey of [
      pkcs8Pem,
      pkcs1Pem.trim().replace(/\n/g, '\\n'),
    ]) {
      cache = new Map()
      github = new FakeGitHub(clock)
      await expect(source({ privateKey }).token()).resolves.toBe('ghs_1')
      const lookup = github.calls.find(call => call.url === INSTALLATION_URL)
      const jwt = (lookup?.authorization ?? '').replace(/^Bearer /, '')
      await expect(
        jwtVerify(jwt, publicKey, { currentDate: new Date(now) })
      ).resolves.toBeDefined()
    }
  })

  it('REQ-STORE-APP-1 openDataStore uses the git store with the installation token for the contents API', async () => {
    const store = openDataStore(
      'save_profile',
      {
        RETIRE_RUNWAY_DATA_REPO: REPO,
        RETIRE_RUNWAY_DATA_PATH: DATA_PATH,
        // openDataStore uses the process cache: one app per test.
        RETIRE_RUNWAY_GITHUB_APP_ID: 'env-app-1',
        RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY: pkcs1Pem,
      },
      github.fetch
    )
    expect(store).toBeInstanceOf(GitStore)
    await store.saveProfile(profile, '2026-11-12T12:00:00.000Z')
    expect(github.files.has(`${DATA_PATH}/profile.json`)).toBe(true)
    const contents = github.contentsCalls()
    expect(contents.length).toBeGreaterThan(0)
    for (const call of contents) {
      expect(call.authorization).toMatch(/^Bearer ghs_\d+$/)
    }
    expect((await store.readProfile())?.profile).toEqual(profile)
  })

  it('REQ-STORE-APP-1 the hosted spent-grant record uses the installation token', async () => {
    const grants = createGitHubGrantStore({
      repo: REPO,
      path: DATA_PATH,
      tokens: source(),
      fetch: github.fetch,
      now: clock,
    })
    expect(await grants.claim('code:a', Math.floor(now / 1000) + 60)).toBe(true)
    expect(await grants.has('code:a')).toBe(true)
    expect(github.files.has(`${DATA_PATH}/oauth-grants.json`)).toBe(true)
    for (const call of github.contentsCalls()) {
      expect(call.authorization).toBe('Bearer ghs_1')
    }
  })

  it('REQ-STORE-APP-1 reports a bad or non-RSA app key by its setting, never the key', async () => {
    for (const privateKey of ['not a key', ecPem]) {
      const error = await rejection(source({ privateKey }).token())
      expect(error).toBeInstanceOf(GitHubAppTokenError)
      expect((error as GitHubAppTokenError).field).toBe(APP_KEY_ENV)
      expect(error.message).toContain(APP_KEY_ENV)
      expect(error.message).not.toContain('PRIVATE KEY')
    }
    expect(github.calls).toEqual([])
  })

  it('REQ-STORE-APP-1 reports a refused JWT, a GitHub error, an odd reply and an outage without the JWT', async () => {
    github.installationReply = { status: 401, body: { message: 'bad jwt' } }
    const refused = await rejection(source().token())
    expect((refused as GitHubAppTokenError).field).toBe(APP_KEY_ENV)
    expect(refused.message).toContain(APP_ID_ENV)
    expect(refused.message).toContain('clock')

    github.installationReply = { status: 200, body: { id: 'x' } }
    expect((await rejection(source().token())).message).toContain(
      'no installation ID'
    )

    github.installationReply = undefined
    github.accessTokenReply = {
      status: 422,
      body: { message: 'There is at least one repository that does not exist' },
    }
    const unprocessable = await rejection(source().token())
    expect(unprocessable.message).toContain('422')
    expect(unprocessable.message).toContain('does not exist')
    expect(unprocessable.message).toContain(REPO)

    github.accessTokenReply = { status: 201, body: { token: 'ghs_x' } }
    expect((await rejection(source().token())).message).toContain(
      'no token or expiry'
    )

    github.accessTokenReply = undefined
    github.offline = true
    const offline = await rejection(source().token())
    expect(offline.message).toContain('could not reach GitHub')
    expect(offline.message).not.toMatch(/eyJ/)
  })

  it('REQ-STORE-APP-1 the git store reports a token failure as a field-level store error', async () => {
    github.installationReply = { status: 500, body: { message: 'boom' } }
    const error = await rejection(gitStore().readProfile())
    expect(error).toBeInstanceOf(UserStoreError)
    expect((error as UserStoreError).field).toBe(APP_ID_ENV)
    expect(error.message).toContain('500')
    expect(github.contentsCalls()).toEqual([])
  })
})

describe('REQ-STORE-APP-2: a token is reused while more than 5 minutes are left', () => {
  it('REQ-STORE-APP-2 reuses the cached token, then mints a new one at 5 minutes left', async () => {
    expect(await source().token()).toBe('ghs_1')
    // A new source over the same cache: every tool call opens a new store.
    now = START + HOUR - REUSE_MARGIN_MS - 1
    expect(await source().token()).toBe('ghs_1')
    expect(github.mints).toBe(1)
    now = START + HOUR - REUSE_MARGIN_MS
    expect(await source().token()).toBe('ghs_2')
    expect(github.mints).toBe(2)
    now += 1000
    expect(await source().token()).toBe('ghs_2')
    expect(github.mints).toBe(2)
  })

  it('REQ-STORE-APP-2 a store opened per call reuses one token across calls', async () => {
    await gitStore().saveProfile(profile, '2026-11-12T12:00:00.000Z')
    now += 30 * 60 * 1000
    await gitStore('get_profile').readProfile()
    expect(github.mints).toBe(1)
  })

  it('REQ-STORE-APP-2 concurrent calls share one mint', async () => {
    const tokens = await Promise.all([
      source().token(),
      source().token(),
      source().token(),
    ])
    expect(tokens).toEqual(['ghs_1', 'ghs_1', 'ghs_1'])
    expect(github.mints).toBe(1)
  })

  it('REQ-STORE-APP-2 keeps tokens apart per repo and per app', async () => {
    await source().token()
    await source({ appId: '999' }).token()
    expect(github.mints).toBe(2)
  })

  it('REQ-STORE-APP-2 a failed mint is not cached', async () => {
    github.installed = false
    await rejection(source().token())
    github.installed = true
    expect(await source().token()).toBe('ghs_1')
  })

  it('REQ-STORE-APP-2 uses a token GitHub issued with less than 5 minutes left instead of minting again', async () => {
    github.tokenLifetimeMs = 60 * 1000
    expect(await source().token()).toBe('ghs_1')
    expect(github.mints).toBe(1)
  })

  it('REQ-STORE-APP-2 a token GitHub refuses with 401 is dropped, so the next call mints a new one', async () => {
    await gitStore().saveProfile(profile, '2026-11-12T12:00:00.000Z')
    github.issued.clear()
    const error = await rejection(gitStore().readProfile())
    expect(error.message).toContain('401')
    expect(error.message).toContain(APP_ID_ENV)
    expect((await gitStore().readProfile())?.profile).toEqual(profile)
    expect(github.mints).toBe(2)
  })

  it('REQ-STORE-APP-2 the spent-grant record drops a token GitHub refuses', async () => {
    const grants = () =>
      createGitHubGrantStore({
        repo: REPO,
        path: DATA_PATH,
        tokens: source(),
        fetch: github.fetch,
        now: clock,
      })
    await grants().has('code:a')
    github.issued.clear()
    await rejection(grants().has('code:a'))
    expect(await grants().has('code:a')).toBe(false)
    expect(github.mints).toBe(2)
  })
})

describe('REQ-STORE-APP-3: an app not installed on the data repo is an error, not a fallback', () => {
  it('REQ-STORE-APP-3 names the repo and the install step', async () => {
    github.installed = false
    const error = await rejection(source().token())
    expect(error).toBeInstanceOf(GitHubAppTokenError)
    expect((error as GitHubAppTokenError).field).toBe('RETIRE_RUNWAY_DATA_REPO')
    expect(error.message).toContain(REPO)
    expect(error.message).toMatch(/not installed/)
    expect(error.message).toMatch(/Install App/)
    expect(github.mintCalls()).toEqual([])
  })

  it('REQ-STORE-APP-3 an installation removed before the token request gives the same error', async () => {
    github.accessTokenReply = { status: 404, body: { message: 'Not Found' } }
    const error = await rejection(source().token())
    expect(error.message).toContain(`not installed on ${REPO}`)
  })

  it('REQ-STORE-APP-3 the store does not fall back to the local folder', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rr-app-token-'))
    try {
      github.installed = false
      const store = openDataStore(
        'save_profile',
        {
          RETIRE_RUNWAY_DATA_DIR: dataDir,
          RETIRE_RUNWAY_DATA_REPO: REPO,
          RETIRE_RUNWAY_DATA_PATH: DATA_PATH,
          // openDataStore uses the process cache: one app per test.
          RETIRE_RUNWAY_GITHUB_APP_ID: 'env-app-2',
          RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY: pkcs1Pem,
        },
        github.fetch
      )
      expect(store).toBeInstanceOf(GitStore)
      const error = await rejection(
        store.saveProfile(profile, '2026-11-12T12:00:00.000Z')
      )
      expect(error).toBeInstanceOf(UserStoreError)
      expect((error as UserStoreError).field).toBe('RETIRE_RUNWAY_DATA_REPO')
      expect(error.message).toContain(REPO)
      expect(error.message).toMatch(/install/i)
      expect(readdirSync(dataDir)).toEqual([])
      expect(github.contentsCalls()).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('REQ-STORE-APP-3 the spent-grant record reports it as unavailable', async () => {
    github.installed = false
    const error = await rejection(
      createGitHubGrantStore({
        repo: REPO,
        path: DATA_PATH,
        tokens: source(),
        fetch: github.fetch,
        now: clock,
      }).has('code:a')
    )
    expect(error).toBeInstanceOf(GrantStoreError)
    expect(error.message).toContain(`not installed on ${REPO}`)
  })
})

describe('REQ-STORE-APP-4: the personal token is not read', () => {
  it('REQ-STORE-APP-4 a personal token does not select the git store', () => {
    let thrown: unknown
    try {
      openDataStore('save_profile', {
        RETIRE_RUNWAY_DATA_REPO: REPO,
        RETIRE_RUNWAY_DATA_PATH: DATA_PATH,
        RETIRE_RUNWAY_GITHUB_TOKEN: PERSONAL_TOKEN,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UserStoreError)
    const error = thrown as UserStoreError
    expect(error.field).toBe(APP_ID_ENV)
    expect(error.message).toContain(APP_KEY_ENV)
    expect(error.message).not.toContain(PERSONAL_TOKEN)
    const dataDir = join(tmpdir(), 'rr-app-token-unused')
    expect(
      openDataStore('save_profile', {
        RETIRE_RUNWAY_DATA_DIR: dataDir,
        RETIRE_RUNWAY_GITHUB_TOKEN: PERSONAL_TOKEN,
      })
    ).toBeInstanceOf(UserStore)
  })

  it('REQ-STORE-APP-4 a personal token set beside the app is never sent', async () => {
    const store = openDataStore(
      'save_profile',
      {
        RETIRE_RUNWAY_DATA_REPO: REPO,
        RETIRE_RUNWAY_DATA_PATH: DATA_PATH,
        // openDataStore uses the process cache: one app per test.
        RETIRE_RUNWAY_GITHUB_APP_ID: 'env-app-3',
        RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY: pkcs1Pem,
        RETIRE_RUNWAY_GITHUB_TOKEN: PERSONAL_TOKEN,
      },
      github.fetch
    )
    await store.saveProfile(profile, '2026-11-12T12:00:00.000Z')
    expect(github.calls.length).toBeGreaterThan(0)
    for (const call of github.calls) {
      expect(call.authorization).not.toContain(PERSONAL_TOKEN)
    }
  })

  it('REQ-STORE-APP-4 the hosted token endpoint needs the app settings, not the personal token', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const response = await createHostedOAuthServer({
      env: {
        RETIRE_RUNWAY_OAUTH_ISSUER: 'https://rr.example.test',
        RETIRE_RUNWAY_OAUTH_SIGNING_KEY: JSON.stringify(
          await exportJWK(pair.privateKey)
        ),
        OWNER_GITHUB_LOGIN: 'owner',
        RETIRE_RUNWAY_DATA_REPO: REPO,
        RETIRE_RUNWAY_DATA_PATH: DATA_PATH,
        RETIRE_RUNWAY_GITHUB_TOKEN: PERSONAL_TOKEN,
      },
      fetch: github.fetch,
      now: clock,
    }).token(
      new Request('https://rr.example.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token',
      })
    )
    expect(response.status).toBe(500)
    expect(((await response.json()) as { missing: string[] }).missing).toEqual([
      APP_ID_ENV,
      APP_KEY_ENV,
    ])
    expect(github.calls).toEqual([])
  })

  it('REQ-STORE-APP-4 no code, doc or CI workflow names the personal token', () => {
    const files = [
      'src/mcp/git-store.ts',
      'src/mcp/oauth-server.ts',
      'src/mcp/github-app-token.ts',
      'docs/REQUIREMENTS.md',
      'docs/DESIGN.md',
      ...readdirSync(join(ROOT, '.github', 'workflows')).map(
        name => `.github/workflows/${name}`
      ),
    ]
    for (const file of files) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toContain(
        'RETIRE_RUNWAY_GITHUB_TOKEN'
      )
    }
  })
})

describe('REQ-STORE-APP-5: no token length or format is assumed', () => {
  const longToken = `ghs_${APP_ID}_${'eyJhbGciOiJSUzI1NiJ9.'.repeat(40)}sig-_x`

  afterEach(() => {
    github.nextToken = undefined
  })

  for (const token of [longToken, 'x']) {
    it(`REQ-STORE-APP-5 sends a ${token.length}-character token verbatim`, async () => {
      github.nextToken = token
      await gitStore().saveProfile(profile, '2026-11-12T12:00:00.000Z')
      for (const call of github.contentsCalls()) {
        expect(call.authorization).toBe(`Bearer ${token}`)
      }
    })
  }

  it('REQ-STORE-APP-5 redacts a minted token of any length from error text', async () => {
    github.nextToken = longToken
    const store = gitStore()
    await store.readProfile()
    github.contentsStatus = 500
    github.contentsMessage = `server error for ${longToken}`
    const error = await rejection(store.readProfile())
    expect(error.message).toContain('500')
    expect(error.message).toContain('[redacted]')
    expect(error.message).not.toContain(longToken)
  })
})

describe('REQ-STORE-APP-6: the new files are traced to FR-23', () => {
  it('REQ-STORE-APP-6 maps github-app-token.ts and this test to FR-23', () => {
    const matrix = JSON.parse(
      readFileSync(join(ROOT, 'docs', 'traceability.json'), 'utf8')
    ) as { requirements: { id: string; code: string[]; tests: string[] }[] }
    const fr23 = matrix.requirements.find(entry => entry.id === 'FR-23')
    expect(fr23?.code).toContain('src/mcp/github-app-token.ts')
    expect(fr23?.tests).toContain(
      'src/mcp/__tests__/git-store-app-token.test.ts'
    )
  })
})
