// @vitest-environment node
// Authorization server for the hosted MCP endpoint, GitHub faked
// (REQ-MCP-27..32, BUI-1857).
import { createHash, generateKeyPairSync } from 'node:crypto'
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose'
import type { CryptoKey } from 'jose'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  ssrfProtection,
  type DnsResolver,
  type PinnedAddress,
} from '@/lib/ssrf-protection'
import { GET as metadataRoute } from '@/app/.well-known/oauth-authorization-server/route'
import { GET as authorizeRoute } from '@/app/oauth/authorize/route'
import { GET as githubCallbackRoute } from '@/app/oauth/github/callback/route'
import { GET as jwksRoute } from '@/app/oauth/jwks/route'
import { POST as registerRoute } from '@/app/oauth/register/route'
import { POST as tokenRoute } from '@/app/oauth/token/route'
import { authorizeMcpRequest } from '../http-auth'
import { createHostedOAuthServer, createOAuthServer } from '../oauth-server'
import type { OAuthServer } from '../oauth-server'

const ISSUER = 'https://rr.example.test'
const MCP_URL = `${ISSUER}/api/mcp`
const OWNER = 'Owner-Login'
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const LOOPBACK_REDIRECT = 'http://localhost:53682/callback'
const CIMD_URL = 'https://client.example.test/oauth/client.json'
const CIMD_HOST = 'client.example.test'
const PUBLIC_IP = '93.184.216.34'
// DNS for the SSRF check, faked: host -> addresses. Real DNS is never used.
let dnsTable: Record<string, { v4?: string[]; v6?: string[] }> = {}
let resolverCalls: string[] = []
const fakeResolver: DnsResolver = {
  async resolve4(host) {
    resolverCalls.push(host)
    const row = dnsTable[host]
    if (row === undefined) throw new Error(`ENOTFOUND ${host}`)
    return row.v4 ?? []
  },
  async resolve6(host) {
    const row = dnsTable[host]
    if (row === undefined) throw new Error(`ENOTFOUND ${host}`)
    return row.v6 ?? []
  },
}
const GITHUB_ID = 'gh-oauth-client'
const GITHUB_SECRET = 'gh-oauth-secret'
// The installation token the GitHub App endpoints mint for the data repo.
const DATA_TOKEN = 'ghs-data-token'
const APP_INSTALLATION_URL =
  'https://api.github.com/repos/owner/rr-data/installation'
const APP_ACCESS_TOKENS_URL =
  'https://api.github.com/app/installations/7/access_tokens'
const LEDGER_URL =
  'https://api.github.com/repos/owner/rr-data/contents/retire-runway/oauth-grants.json'

let env: Record<string, string>
let privateKey: CryptoKey
let clock: number
let githubCalls: { url: string; body: string }[]
let clientDocument: unknown
let server: OAuthServer
// The owner's data repo, faked: one file with a sha that changes per write.
let ledger: { text: string; sha: string } | undefined
let ledgerWrites: number
let ledgerFailure: number | undefined
// Holds every write until this many reads have happened, to force a race.
let ledgerReads: number
let holdWritesUntilReads: number

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true })
  privateKey = pair.privateKey
  env = {
    RETIRE_RUNWAY_OAUTH_ISSUER: ISSUER,
    RETIRE_RUNWAY_OAUTH_JWKS_URL: `${ISSUER}/oauth/jwks`,
    RETIRE_RUNWAY_OWNER_SUBJECT: OWNER,
    RETIRE_RUNWAY_OAUTH_SIGNING_KEY: JSON.stringify(
      await exportJWK(pair.privateKey)
    ),
    OWNER_GITHUB_LOGIN: OWNER,
    RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_ID: GITHUB_ID,
    RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_SECRET: GITHUB_SECRET,
    RETIRE_RUNWAY_DATA_REPO: 'owner/rr-data',
    RETIRE_RUNWAY_DATA_PATH: 'retire-runway',
    RETIRE_RUNWAY_GITHUB_APP_ID: '123456',
    RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY: generateKeyPairSync('rsa', {
      modulusLength: 2048,
    })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString(),
  }
})

// The GitHub contents API for the spent-grant file. A PUT must send the sha
// of the current file (none when there is no file), as GitHub requires.
async function ledgerApi(init: RequestInit): Promise<Response> {
  const auth = new Headers(init.headers).get('authorization')
  expect(auth).toBe(`Bearer ${DATA_TOKEN}`)
  await Promise.resolve()
  if (ledgerFailure !== undefined) {
    return Response.json({ message: 'boom' }, { status: ledgerFailure })
  }
  if ((init.method ?? 'GET') === 'GET') {
    ledgerReads += 1
    if (ledger === undefined) return Response.json({}, { status: 404 })
    return Response.json({
      type: 'file',
      sha: ledger.sha,
      encoding: 'base64',
      content: Buffer.from(ledger.text).toString('base64'),
    })
  }
  while (ledgerReads < holdWritesUntilReads) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  const body = JSON.parse(String(init.body)) as {
    sha?: string
    content: string
    message: string
  }
  expect(body.message).toBe('data: oauth oauth-grants.json')
  if (ledger !== undefined && body.sha === undefined) {
    return Response.json({ message: '"sha" was not supplied' }, { status: 422 })
  }
  if (ledger !== undefined && body.sha !== ledger.sha) {
    return Response.json({ message: 'conflict' }, { status: 409 })
  }
  ledgerWrites += 1
  ledger = {
    text: Buffer.from(body.content, 'base64').toString('utf8'),
    sha: `sha-${ledgerWrites}`,
  }
  return Response.json({ content: { sha: ledger.sha } }, { status: 200 })
}

function ledgerIds(): Record<string, number> {
  return (
    JSON.parse(ledger?.text ?? '{"spent":{}}') as {
      spent: Record<string, number>
    }
  ).spent
}

// GitHub and the client metadata host, faked. The GitHub code
// `gh-code:<login>` signs in `<login>`.
async function fakeFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const body = typeof init.body === 'string' ? init.body : ''
  if (input === LEDGER_URL) return ledgerApi(init)
  if (input === APP_INSTALLATION_URL) return Response.json({ id: 7 })
  if (input === APP_ACCESS_TOKENS_URL) {
    return Response.json(
      {
        token: DATA_TOKEN,
        expires_at: new Date(clock + 3_600_000).toISOString(),
      },
      { status: 201 }
    )
  }
  githubCalls.push({ url: input, body })
  if (input === 'https://github.com/login/oauth/access_token') {
    const { code } = JSON.parse(body) as { code: string }
    return Response.json(
      code.startsWith('gh-code:')
        ? { access_token: `gh-token:${code.slice(8)}` }
        : { error: 'bad_verification_code' }
    )
  }
  if (input === 'https://api.github.com/user') {
    const auth = new Headers(init.headers).get('authorization') ?? ''
    return Response.json({ login: auth.replace('Bearer gh-token:', '') })
  }
  if (input === CIMD_URL) return Response.json(clientDocument as object)
  return new Response('not found', { status: 404 })
}

function newServer(overrides: Record<string, string> = {}): OAuthServer {
  return createHostedOAuthServer({
    env: { ...env, ...overrides },
    fetch: fakeFetch,
    now: () => clock,
    resolver: fakeResolver,
  })
}

function newFactoryServerWithoutHostedStore(): OAuthServer {
  const factoryEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        ![
          'RETIRE_RUNWAY_DATA_REPO',
          'RETIRE_RUNWAY_DATA_PATH',
          'RETIRE_RUNWAY_GITHUB_APP_ID',
          'RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY',
        ].includes(name)
    )
  )
  return createOAuthServer({
    env: factoryEnv,
    fetch: fakeFetch,
    now: () => clock,
    resolver: fakeResolver,
  })
}

beforeEach(() => {
  clock = Date.now()
  dnsTable = { [CIMD_HOST]: { v4: [PUBLIC_IP] } }
  resolverCalls = []
  githubCalls = []
  ledger = undefined
  ledgerWrites = 0
  ledgerFailure = undefined
  ledgerReads = 0
  holdWritesUntilReads = 0
  clientDocument = {
    client_id: CIMD_URL,
    client_name: 'Test client',
    redirect_uris: [CLAUDE_REDIRECT, LOOPBACK_REDIRECT],
    token_endpoint_auth_method: 'none',
  }
  server = newServer()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function pkce(): { verifier: string; challenge: string } {
  const verifier =
    `${'v'.repeat(30)}${Math.random().toString(36).slice(2, 20)}`.padEnd(
      43,
      'x'
    )
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

async function register(
  body: unknown,
  target: OAuthServer = server
): Promise<Response> {
  return target.register(
    new Request(`${ISSUER}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  )
}

async function registerClient(redirectUris: string[]): Promise<string> {
  const response = await register({
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { client_id: string }).client_id
}

function authorizeRequest(params: Record<string, string>): Request {
  return new Request(`${ISSUER}/oauth/authorize?${new URLSearchParams(params)}`)
}

function authorizeParams(
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state-1',
    resource: MCP_URL,
    ...extra,
  }
}

interface SignedIn {
  readonly response: Response
  readonly code?: string
  readonly clientState?: string | null
}

// The owner's browser: authorize, GitHub, then the GitHub callback.
async function signIn(
  login: string,
  clientId: string,
  challenge: string,
  options: { redirectUri?: string; cookie?: string | null } = {}
): Promise<SignedIn> {
  const start = await server.authorize(
    authorizeRequest(
      authorizeParams(clientId, challenge, {
        redirect_uri: options.redirectUri ?? CLAUDE_REDIRECT,
      })
    )
  )
  expect(start.status).toBe(302)
  const github = new URL(start.headers.get('location') ?? '')
  expect(`${github.origin}${github.pathname}`).toBe(
    'https://github.com/login/oauth/authorize'
  )
  const cookie =
    options.cookie !== undefined
      ? options.cookie
      : (start.headers.get('set-cookie') ?? '').split(';')[0]
  const response = await server.githubCallback(
    new Request(
      `${ISSUER}/oauth/github/callback?${new URLSearchParams({
        code: `gh-code:${login}`,
        state: github.searchParams.get('state') ?? '',
      })}`,
      { headers: cookie ? { cookie } : {} }
    )
  )
  const location = response.headers.get('location')
  if (location === null) return { response }
  const back = new URL(location)
  return {
    response,
    code: back.searchParams.get('code') ?? undefined,
    clientState: back.searchParams.get('state'),
  }
}

function tokenRequest(fields: Record<string, string>): Request {
  return new Request(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
}

async function exchange(
  clientId: string,
  code: string,
  verifier: string,
  redirectUri = CLAUDE_REDIRECT
): Promise<Response> {
  return server.token(
    tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    })
  )
}

function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return server.token(
    tokenRequest({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    })
  )
}

interface Tokens {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

async function ownerTokens(): Promise<{ clientId: string; tokens: Tokens }> {
  const clientId = await registerClient([CLAUDE_REDIRECT])
  const { verifier, challenge } = pkce()
  const signed = await signIn(OWNER, clientId, challenge)
  expect(signed.code).toBeDefined()
  const response = await exchange(clientId, signed.code ?? '', verifier)
  expect(response.status).toBe(200)
  return { clientId, tokens: (await response.json()) as Tokens }
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error
}

describe('REQ-MCP-27: authorization server metadata', () => {
  it('serves RFC 8414 metadata with the endpoints, S256 and CIMD', async () => {
    const response = server.metadata(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`)
    )
    expect(response.status).toBe(200)
    const metadata = (await response.json()) as Record<string, unknown>
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      jwks_uri: `${ISSUER}/oauth/jwks`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      response_types_supported: ['code'],
    })
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none')
    expect(metadata.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
    ])
  })

  it('is served by the well-known route from the configured issuer', async () => {
    vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', `${ISSUER}/`)
    const response = metadataRoute(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`)
    )
    expect(response.status).toBe(200)
    expect(((await response.json()) as { issuer: string }).issuer).toBe(ISSUER)
  })

  it('answers 500 naming the issuer variable when it is unset', async () => {
    vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', '')
    const response = metadataRoute(
      new Request(`${ISSUER}/.well-known/oauth-authorization-server`)
    )
    expect(response.status).toBe(500)
    expect(((await response.json()) as { missing: string[] }).missing).toEqual([
      'RETIRE_RUNWAY_OAUTH_ISSUER',
    ])
  })

  it('names each missing setting when it cannot sign in', async () => {
    const bare = newServer({
      RETIRE_RUNWAY_OAUTH_SIGNING_KEY: '',
      OWNER_GITHUB_LOGIN: '',
    })
    const keys = await bare.jwks(new Request(`${ISSUER}/oauth/jwks`))
    expect(keys.status).toBe(500)
    expect(((await keys.json()) as { missing: string[] }).missing).toEqual([
      'RETIRE_RUNWAY_OAUTH_SIGNING_KEY',
    ])
    const start = await newServer({ OWNER_GITHUB_LOGIN: '' }).authorize(
      authorizeRequest({})
    )
    expect(start.status).toBe(500)
    expect(((await start.json()) as { missing: string[] }).missing).toEqual([
      'OWNER_GITHUB_LOGIN',
    ])
  })

  it('rejects a signing key that is not a private ES256 JWK', async () => {
    for (const key of ['not json', JSON.stringify({ kty: 'oct', k: 'AAAA' })]) {
      const response = await newServer({
        RETIRE_RUNWAY_OAUTH_SIGNING_KEY: key,
      }).jwks(new Request(`${ISSUER}/oauth/jwks`))
      expect(response.status).toBe(500)
    }
  })

  it('publishes only the public half of the signing key', async () => {
    const response = await jwksRoute(new Request(`${ISSUER}/oauth/jwks`))
    // The route reads process.env, which holds no key here.
    expect(response.status).toBe(500)
    vi.stubEnv(
      'RETIRE_RUNWAY_OAUTH_SIGNING_KEY',
      env.RETIRE_RUNWAY_OAUTH_SIGNING_KEY
    )
    vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', ISSUER)
    const ok = await jwksRoute(new Request(`${ISSUER}/oauth/jwks`))
    const { keys } = (await ok.json()) as { keys: Record<string, unknown>[] }
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256', use: 'sig' })
    expect(keys[0]).not.toHaveProperty('d')
    expect(typeof keys[0]?.kid).toBe('string')
  })
})

describe('REQ-MCP-28: only Claude redirects are accepted', () => {
  it('registers a client for the Claude and loopback redirects (DCR)', async () => {
    const redirects = [
      CLAUDE_REDIRECT,
      'http://localhost:53682/callback',
      'http://localhost/callback',
      'http://127.0.0.1:8123/callback',
    ]
    const response = await register({
      redirect_uris: redirects,
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    })
    expect(response.status).toBe(201)
    const client = (await response.json()) as Record<string, unknown>
    expect(client).toMatchObject({
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      client_name: 'Claude',
    })
    expect(typeof client.client_id).toBe('string')
    expect(client).not.toHaveProperty('client_secret')
  })

  it.each([
    ['another https host', 'https://evil.example.test/api/mcp/auth_callback'],
    ['another Claude path', 'https://claude.ai/api/mcp/other'],
    ['a Claude path with a query', `${CLAUDE_REDIRECT}?x=1`],
    ['plain http on claude.ai', 'http://claude.ai/api/mcp/auth_callback'],
    ['a loopback path other than /callback', 'http://localhost:1234/other'],
    ['a loopback callback with a query', 'http://localhost:1234/callback?a=1'],
    ['a loopback callback with a fragment', 'http://localhost:1234/callback#a'],
    ['https on loopback', 'https://localhost:1234/callback'],
    [
      'a host that only starts with localhost',
      'http://localhost.evil.test:1234/callback',
    ],
    ['a userinfo trick', 'http://localhost:1234@evil.test/callback'],
    ['another loopback form', 'http://[::1]:1234/callback'],
    ['a non-URL', 'not a url'],
    ['a custom scheme', 'myapp://callback'],
  ])('rejects %s', async (_label, uri) => {
    const response = await register({ redirect_uris: [CLAUDE_REDIRECT, uri] })
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('invalid_redirect_uri')
  })

  it('rejects empty, missing, oversized and non-string redirect lists', async () => {
    for (const redirect_uris of [
      [],
      undefined,
      'https://claude.ai/api/mcp/auth_callback',
      [42],
      Array.from({ length: 6 }, () => CLAUDE_REDIRECT),
    ]) {
      const response = await register({ redirect_uris })
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('invalid_redirect_uri')
    }
  })

  it('rejects a body that is not a JSON object and a client that wants a secret', async () => {
    for (const body of ['{oops', '[]', 'null', '"x"']) {
      const response = await register(body)
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('invalid_client_metadata')
    }
    const secret = await register({
      redirect_uris: [CLAUDE_REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    })
    expect(secret.status).toBe(400)
    expect(await errorOf(secret)).toBe('invalid_client_metadata')
    const huge = await register(
      JSON.stringify({
        redirect_uris: [CLAUDE_REDIRECT],
        pad: 'x'.repeat(20_000),
      })
    )
    expect(huge.status).toBe(400)
  })

  it('is served by the register route', async () => {
    vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', ISSUER)
    vi.stubEnv(
      'RETIRE_RUNWAY_OAUTH_SIGNING_KEY',
      env.RETIRE_RUNWAY_OAUTH_SIGNING_KEY
    )
    const response = await registerRoute(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT] }),
      })
    )
    expect(response.status).toBe(201)
  })

  it('accepts a client ID metadata document (CIMD) and signs in through it', async () => {
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, CIMD_URL, challenge, {
      redirectUri: LOOPBACK_REDIRECT,
    })
    expect(signed.code).toBeDefined()
    expect(signed.response.headers.get('location')).toMatch(
      /^http:\/\/localhost:53682\/callback\?/
    )
    const response = await exchange(
      CIMD_URL,
      signed.code ?? '',
      verifier,
      LOOPBACK_REDIRECT
    )
    expect(response.status).toBe(200)
  })

  it.each([
    [
      'a document whose client_id is another URL',
      {
        client_id: 'https://other.example.test/c.json',
        redirect_uris: [CLAUDE_REDIRECT],
      },
    ],
    [
      'a document with a foreign redirect',
      {
        client_id: CIMD_URL,
        redirect_uris: [CLAUDE_REDIRECT, 'https://evil.example.test/cb'],
      },
    ],
    [
      'a document that wants a client secret',
      {
        client_id: CIMD_URL,
        redirect_uris: [CLAUDE_REDIRECT],
        token_endpoint_auth_method: 'client_secret_post',
      },
    ],
    ['a document with no redirects', { client_id: CIMD_URL }],
    ['a document that is not an object', ['x']],
  ])('refuses %s', async (_label, document) => {
    clientDocument = document
    const response = await server.authorize(
      authorizeRequest(authorizeParams(CIMD_URL, pkce().challenge))
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it.each([
    ['an IP address', 'https://203.0.113.9/client.json'],
    ['a loopback host', 'https://localhost/client.json'],
    ['an internal name', 'https://metadata.internal/client.json'],
    ['a bare host with no path', 'https://client.example.test/'],
    ['a single-label host', 'https://intranet/client.json'],
    ['an IPv6 host', 'https://[::1]/client.json'],
    ['URL userinfo', 'https://user:pw@client.example.test/c.json'],
  ])('never fetches a client ID that is %s', async (_label, clientId) => {
    const response = await server.authorize(
      authorizeRequest(authorizeParams(clientId, pkce().challenge))
    )
    expect(response.status).toBe(400)
    expect(githubCalls).toEqual([])
  })

  it('refuses a document that cannot be fetched or is too large', async () => {
    const failing = createOAuthServer({
      env,
      now: () => clock,
      resolver: fakeResolver,
      fetch: async () => {
        throw new Error('offline')
      },
    })
    const offline = await failing.authorize(
      authorizeRequest(authorizeParams(CIMD_URL, pkce().challenge))
    )
    expect(offline.status).toBe(400)
    const large = createOAuthServer({
      env,
      now: () => clock,
      resolver: fakeResolver,
      fetch: async () => new Response('{"pad":"' + 'x'.repeat(20_000) + '"}'),
    })
    const response = await large.authorize(
      authorizeRequest(authorizeParams(CIMD_URL, pkce().challenge))
    )
    expect(response.status).toBe(400)
  })

  it('answers 400 and no redirect for an unknown client or an unregistered redirect', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { challenge } = pkce()
    const cases = [
      authorizeParams('not-a-registered-client', challenge),
      authorizeParams(clientId, challenge, {
        redirect_uri: 'https://evil.example.test/cb',
      }),
      authorizeParams(clientId, challenge, { redirect_uri: LOOPBACK_REDIRECT }),
      { ...authorizeParams(clientId, challenge), redirect_uri: '' },
      { response_type: 'code' },
    ]
    for (const params of cases) {
      const response = await server.authorize(authorizeRequest(params))
      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('content-type')).toContain('text/html')
    }
  })

  it('refuses a client ID signed with another key', async () => {
    const other = await generateKeyPair('ES256')
    const forged = await new SignJWT({ redirect_uris: [CLAUDE_REDIRECT] })
      .setProtectedHeader({ alg: 'ES256', typ: 'rr-client+jwt' })
      .setIssuer(ISSUER)
      .setAudience('urn:retire-runway:client')
      .sign(other.privateKey)
    const response = await server.authorize(
      authorizeRequest(authorizeParams(forged, pkce().challenge))
    )
    expect(response.status).toBe(400)
  })

  it('sends protocol errors for a trusted redirect back to the client', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { challenge } = pkce()
    const cases: [Record<string, string>, string][] = [
      [
        authorizeParams(clientId, challenge, { response_type: 'token' }),
        'unsupported_response_type',
      ],
      [
        authorizeParams(clientId, challenge, {
          code_challenge_method: 'plain',
        }),
        'invalid_request',
      ],
      [authorizeParams(clientId, 'short'), 'invalid_request'],
      [
        authorizeParams(clientId, challenge, {
          resource: 'https://other.example.test/api/mcp',
        }),
        'invalid_target',
      ],
    ]
    for (const [params, error] of cases) {
      const response = await server.authorize(authorizeRequest(params))
      expect(response.status).toBe(302)
      const back = new URL(response.headers.get('location') ?? '')
      expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_REDIRECT)
      expect(back.searchParams.get('error')).toBe(error)
      expect(back.searchParams.get('state')).toBe('client-state-1')
      expect(back.searchParams.has('code')).toBe(false)
    }
    const noMethod = authorizeParams(clientId, challenge)
    delete noMethod.code_challenge_method
    const response = await server.authorize(authorizeRequest(noMethod))
    expect(
      new URL(response.headers.get('location') ?? '').searchParams.get('error')
    ).toBe('invalid_request')
  })
})

describe('REQ-MCP-29: the owner signs in and gets tokens', () => {
  it('REQ-MCP-29: local routes complete code exchange without hosted-store settings', async () => {
    for (const [name, value] of Object.entries(env)) {
      if (
        ![
          'RETIRE_RUNWAY_DATA_REPO',
          'RETIRE_RUNWAY_DATA_PATH',
          'RETIRE_RUNWAY_GITHUB_APP_ID',
          'RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY',
        ].includes(name)
      ) {
        vi.stubEnv(name, value)
      }
    }
    vi.stubEnv('RETIRE_RUNWAY_DATA_REPO', '')
    vi.stubEnv('RETIRE_RUNWAY_DATA_PATH', '')
    vi.stubEnv('RETIRE_RUNWAY_GITHUB_APP_ID', '')
    vi.stubEnv('RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY', '')
    vi.stubGlobal('fetch', fakeFetch)
    const { verifier, challenge } = pkce()
    const registration = await registerRoute(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT] }),
      })
    )
    const clientId = ((await registration.json()) as { client_id: string })
      .client_id
    const start = await authorizeRoute(
      authorizeRequest(authorizeParams(clientId, challenge))
    )
    const github = new URL(start.headers.get('location') ?? '')
    const callback = await githubCallbackRoute(
      new Request(
        `${ISSUER}/oauth/github/callback?${new URLSearchParams({
          code: `gh-code:${OWNER}`,
          state: github.searchParams.get('state') ?? '',
        })}`,
        {
          headers: {
            cookie: (start.headers.get('set-cookie') ?? '').split(';')[0],
          },
        }
      )
    )
    const code = new URL(
      callback.headers.get('location') ?? ''
    ).searchParams.get('code')

    const response = await tokenRoute(
      tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: code ?? '',
        code_verifier: verifier,
        redirect_uri: CLAUDE_REDIRECT,
      })
    )

    expect(response.status).toBe(200)
    expect(typeof ((await response.json()) as Tokens).access_token).toBe(
      'string'
    )
  })

  it('REQ-MCP-29: a factory server exchanges a code without hosted-store settings', async () => {
    server = newFactoryServerWithoutHostedStore()

    const { tokens } = await ownerTokens()

    expect(typeof tokens.access_token).toBe('string')
    expect(typeof tokens.refresh_token).toBe('string')
  })

  it('issues a code after GitHub sign-in and tokens for a valid verifier', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    expect(signed.response.status).toBe(302)
    expect(signed.clientState).toBe('client-state-1')
    expect(signed.code).toBeDefined()
    // GitHub got the app credentials and the callback URL.
    const exchangeCall = githubCalls.find(call =>
      call.url.endsWith('/access_token')
    )
    expect(JSON.parse(exchangeCall?.body ?? '{}')).toMatchObject({
      client_id: GITHUB_ID,
      client_secret: GITHUB_SECRET,
      redirect_uri: `${ISSUER}/oauth/github/callback`,
    })

    const response = await exchange(clientId, signed.code ?? '', verifier)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const tokens = (await response.json()) as Tokens
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.expires_in).toBe(3600)
    expect(typeof tokens.refresh_token).toBe('string')
    const claims = decodeJwt(tokens.access_token)
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: OWNER,
      aud: MCP_URL,
      client_id: clientId,
      scope: 'mcp',
    })
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(3600)
  })

  it('matches the owner login without regard to case but issues the configured subject', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER.toUpperCase(), clientId, challenge)
    const response = await exchange(clientId, signed.code ?? '', verifier)
    const tokens = (await response.json()) as Tokens
    expect(decodeJwt(tokens.access_token).sub).toBe(OWNER)
  })

  it('accepts the token body only as application/x-www-form-urlencoded', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    const fields = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: signed.code ?? '',
      code_verifier: verifier,
      redirect_uri: CLAUDE_REDIRECT,
    }
    const asJson = await server.token(
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      })
    )
    expect(asJson.status).toBe(400)
    expect(await errorOf(asJson)).toBe('invalid_request')
    // The refused request did not spend the code.
    const withCharset = await server.token(
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: new URLSearchParams(fields).toString(),
      })
    )
    expect(withCharset.status).toBe(200)
  })

  it('answers invalid_request for missing or repeated fields and unsupported_grant_type for others', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const cases: [string, string][] = [
      ['', 'invalid_request'],
      ['grant_type=authorization_code', 'invalid_request'],
      [
        `grant_type=authorization_code&client_id=${clientId}`,
        'invalid_request',
      ],
      [`grant_type=refresh_token&client_id=${clientId}`, 'invalid_request'],
      [
        `grant_type=refresh_token&client_id=${clientId}&client_id=x&refresh_token=y`,
        'invalid_request',
      ],
      [`grant_type=password&client_id=${clientId}`, 'unsupported_grant_type'],
      [`client_id=${clientId}`, 'unsupported_grant_type'],
    ]
    for (const [body, error] of cases) {
      const response = await server.token(
        new Request(`${ISSUER}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        })
      )
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe(error)
    }
  })

  it('issues access tokens the resource server accepts, and no other signed value', async () => {
    const { tokens } = await ownerTokens()
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      expect(String(input)).toBe(`${ISSUER}/oauth/jwks`)
      return server.jwks(new Request(`${ISSUER}/oauth/jwks`))
    })
    const call = (bearer: string): Promise<{ ok: boolean }> =>
      authorizeMcpRequest(
        new Request(MCP_URL, {
          headers: { authorization: `Bearer ${bearer}` },
        }),
        env
      )
    const accepted = await authorizeMcpRequest(
      new Request(MCP_URL, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
      env
    )
    expect(accepted.ok).toBe(true)
    if (accepted.ok) {
      expect(accepted.value.clientId).toMatch(/\S/)
      expect(accepted.value.scopes).toEqual(['mcp'])
    }
    // A refresh token, signed with the same key, is not an access token.
    expect((await call(tokens.refresh_token)).ok).toBe(false)
  })

  it('serves the token route and refuses a non-form body there', async () => {
    const response = await tokenRoute(
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    )
    // The route reads process.env: unset here, so it names the settings.
    expect(response.status).toBe(500)
    vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', ISSUER)
    vi.stubEnv(
      'RETIRE_RUNWAY_OAUTH_SIGNING_KEY',
      env.RETIRE_RUNWAY_OAUTH_SIGNING_KEY
    )
    vi.stubEnv('OWNER_GITHUB_LOGIN', OWNER)
    vi.stubEnv('RETIRE_RUNWAY_DATA_REPO', 'owner/rr-data')
    vi.stubEnv('RETIRE_RUNWAY_DATA_PATH', 'retire-runway')
    vi.stubEnv('RETIRE_RUNWAY_GITHUB_APP_ID', env.RETIRE_RUNWAY_GITHUB_APP_ID)
    vi.stubEnv(
      'RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY',
      env.RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY
    )
    const refused = await tokenRoute(
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    )
    expect(refused.status).toBe(400)
    expect(await errorOf(refused)).toBe('invalid_request')
  })

  it('answers CORS preflight for the token endpoint', () => {
    const response = server.preflight()
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('refuses a code used a second time, expired, or for another client or redirect', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT, LOOPBACK_REDIRECT])
    const other = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    const code = signed.code ?? ''
    expect(await errorOf(await exchange(other, code, verifier))).toBe(
      'invalid_grant'
    )
    expect(
      await errorOf(await exchange(clientId, code, verifier, LOOPBACK_REDIRECT))
    ).toBe('invalid_grant')
    expect((await exchange(clientId, code, verifier)).status).toBe(200)
    const again = await exchange(clientId, code, verifier)
    expect(again.status).toBe(400)
    expect(await errorOf(again)).toBe('invalid_grant')

    const late = await signIn(OWNER, clientId, challenge)
    clock += 61_000
    expect(
      await errorOf(await exchange(clientId, late.code ?? '', verifier))
    ).toBe('invalid_grant')
    expect(await errorOf(await exchange(clientId, 'garbage', verifier))).toBe(
      'invalid_grant'
    )
  })

  it('refuses a code when the owner setting changed after sign-in', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    server = newServer({ OWNER_GITHUB_LOGIN: 'someone-else' })
    expect(
      await errorOf(await exchange(clientId, signed.code ?? '', verifier))
    ).toBe('invalid_grant')
  })
})

describe('REQ-MCP-30: only the owner signs in', () => {
  it('refuses another GitHub login with an error page and no code', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { challenge } = pkce()
    const signed = await signIn('mallory', clientId, challenge)
    expect(signed.response.status).toBe(403)
    expect(signed.response.headers.get('location')).toBeNull()
    expect(signed.response.headers.get('content-type')).toContain('text/html')
    expect(await signed.response.text()).toContain('serves only its owner')
    expect(signed.code).toBeUndefined()
  })

  it('refuses a login that only contains the owner login', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    for (const login of [`${OWNER}-2`, `x${OWNER}`, OWNER.slice(0, 4)]) {
      const signed = await signIn(login, clientId, pkce().challenge)
      expect(signed.response.status).toBe(403)
      expect(signed.code).toBeUndefined()
    }
  })

  it('refuses a sign-in that did not start in this browser (login CSRF)', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { challenge } = pkce()
    for (const cookie of [null, 'rr_oauth_nonce=not-the-nonce']) {
      const signed = await signIn(OWNER, clientId, challenge, { cookie })
      expect(signed.response.status).toBe(400)
      expect(signed.code).toBeUndefined()
    }
  })

  it('sets the nonce cookie HttpOnly, Lax and scoped to the callback', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const start = await server.authorize(
      authorizeRequest(authorizeParams(clientId, pkce().challenge))
    )
    const cookie = start.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^rr_oauth_nonce=\S+;/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/oauth/github/callback')
  })

  it('refuses a mistyped, foreign, garbage or expired state', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const start = await server.authorize(
      authorizeRequest(authorizeParams(clientId, pkce().challenge))
    )
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]
    const state =
      new URL(start.headers.get('location') ?? '').searchParams.get('state') ??
      ''
    const callback = (value: string): Promise<Response> =>
      server.githubCallback(
        new Request(
          `${ISSUER}/oauth/github/callback?${new URLSearchParams({ code: `gh-code:${OWNER}`, state: value })}`,
          { headers: { cookie } }
        )
      )
    // Signed with the server key but typed as another kind of value.
    const mistyped = await new SignJWT({
      cid: clientId,
      ru: CLAUDE_REDIRECT,
      cc: 'x',
      n: cookie.split('=')[1],
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'rr-code+jwt' })
      .setIssuer(ISSUER)
      .setAudience('urn:retire-runway:state')
      .setExpirationTime('10m')
      .sign(privateKey)
    expect((await callback(mistyped)).status).toBe(400)
    // Signed with a key the server does not know.
    const stranger = await generateKeyPair('ES256')
    const foreign = await new SignJWT({ n: cookie.split('=')[1] })
      .setProtectedHeader({ alg: 'ES256', typ: 'rr-state+jwt' })
      .setIssuer(ISSUER)
      .setAudience('urn:retire-runway:state')
      .setExpirationTime('10m')
      .sign(stranger.privateKey)
    expect((await callback(foreign)).status).toBe(400)
    expect((await callback('garbage')).status).toBe(400)
    clock += 11 * 60_000
    const expired = await callback(state)
    expect(expired.status).toBe(400)
    expect(expired.headers.get('location')).toBeNull()
  })

  it('refuses a callback with no state, a GitHub error or no code', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const start = await server.authorize(
      authorizeRequest(authorizeParams(clientId, pkce().challenge))
    )
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]
    const state =
      new URL(start.headers.get('location') ?? '').searchParams.get('state') ??
      ''
    for (const query of [
      '',
      `state=${state}&error=access_denied`,
      `state=${state}`,
      `state=${state}&code=`,
    ]) {
      const response = await server.githubCallback(
        new Request(`${ISSUER}/oauth/github/callback?${query}`, {
          headers: { cookie },
        })
      )
      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
    }
  })

  it('answers 502 and no code when GitHub fails or does not confirm the login', async () => {
    const failures: Record<string, (url: string) => Promise<Response>> = {
      'a rejected code': async () =>
        Response.json({ error: 'bad_verification_code' }),
      'a GitHub outage': async () => new Response('down', { status: 503 }),
      'a network error': async () => {
        throw new Error('network down')
      },
      'a user reply with no login': async url =>
        url.endsWith('/access_token')
          ? Response.json({ access_token: 'gh-token:x' })
          : Response.json({}),
    }
    for (const fail of Object.values(failures)) {
      server = createOAuthServer({
        env,
        now: () => clock,
        resolver: fakeResolver,
        fetch: (url, init) =>
          url === CIMD_URL ? fakeFetch(url, init) : fail(url),
      })
      const registered = await server.register(
        new Request(`${ISSUER}/oauth/register`, {
          method: 'POST',
          body: JSON.stringify({ redirect_uris: [CLAUDE_REDIRECT] }),
        })
      )
      const id = ((await registered.json()) as { client_id: string }).client_id
      const signed = await signIn(OWNER, id, pkce().challenge)
      expect(signed.response.status).toBe(502)
      expect(signed.code).toBeUndefined()
    }
  })

  it('never puts a GitHub secret or token in an error page', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const signed = await signIn('mallory', clientId, pkce().challenge)
    const page = await signed.response.text()
    expect(page).not.toContain(GITHUB_SECRET)
    expect(page).not.toContain('gh-token')
  })
})

describe('REQ-MCP-31: refresh tokens rotate', () => {
  it('REQ-MCP-31: a factory server rotates and rejects reuse without hosted-store settings', async () => {
    server = newFactoryServerWithoutHostedStore()
    const { clientId, tokens } = await ownerTokens()

    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200)
    expect(await errorOf(await refresh(clientId, tokens.refresh_token))).toBe(
      'invalid_grant'
    )
  })

  it('issues a new access and refresh token and spends the old refresh token', async () => {
    const { clientId, tokens } = await ownerTokens()
    const response = await refresh(clientId, tokens.refresh_token)
    expect(response.status).toBe(200)
    const next = (await response.json()) as Tokens
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect(next.access_token).not.toBe(tokens.access_token)
    expect(decodeJwt(next.access_token)).toMatchObject({
      sub: OWNER,
      aud: MCP_URL,
      client_id: clientId,
    })
    const third = await refresh(clientId, next.refresh_token)
    expect(third.status).toBe(200)
  })

  it('answers invalid_grant when a refresh token is reused', async () => {
    const { clientId, tokens } = await ownerTokens()
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200)
    const reused = await refresh(clientId, tokens.refresh_token)
    expect(reused.status).toBe(400)
    expect(await errorOf(reused)).toBe('invalid_grant')
  })

  it('ends the whole token family when a spent refresh token comes back', async () => {
    const { clientId, tokens } = await ownerTokens()
    const next = (await (
      await refresh(clientId, tokens.refresh_token)
    ).json()) as Tokens
    expect(await errorOf(await refresh(clientId, tokens.refresh_token))).toBe(
      'invalid_grant'
    )
    // The newer token of that family is revoked too.
    expect(await errorOf(await refresh(clientId, next.refresh_token))).toBe(
      'invalid_grant'
    )
  })

  it('answers invalid_grant when a refresh token is expired', async () => {
    const { clientId, tokens } = await ownerTokens()
    clock += 31 * 24 * 60 * 60 * 1000
    const response = await refresh(clientId, tokens.refresh_token)
    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('invalid_grant')
  })

  it('answers invalid_grant for garbage, an access token, a code, or another client', async () => {
    const { clientId, tokens } = await ownerTokens()
    const stranger = await registerClient([CLAUDE_REDIRECT])
    const code = (await signIn(OWNER, clientId, pkce().challenge)).code ?? ''
    for (const [id, value] of [
      [clientId, 'garbage'],
      [clientId, tokens.access_token],
      [clientId, code],
      [stranger, tokens.refresh_token],
    ]) {
      const response = await refresh(id, value)
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('invalid_grant')
    }
    // The wrong-client attempt did not spend the token.
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200)
  })

  it('refuses to refresh once the owner setting names someone else', async () => {
    const { clientId, tokens } = await ownerTokens()
    server = newServer({ OWNER_GITHUB_LOGIN: 'someone-else' })
    expect(await errorOf(await refresh(clientId, tokens.refresh_token))).toBe(
      'invalid_grant'
    )
  })

  it('does not accept a code as a refresh token or the reverse', async () => {
    const { clientId, tokens } = await ownerTokens()
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    const asCode = await exchange(clientId, tokens.refresh_token, verifier)
    expect(await errorOf(asCode)).toBe('invalid_grant')
    expect((await exchange(clientId, signed.code ?? '', verifier)).status).toBe(
      200
    )
  })
})

describe('REQ-MCP-31: reuse is caught on every server instance', () => {
  it('keeps the spent record in the data repo, not in the instance', async () => {
    const { clientId, tokens } = await ownerTokens()
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200)
    // A second, freshly started instance sees the same record.
    server = newServer()
    const reused = await refresh(clientId, tokens.refresh_token)
    expect(reused.status).toBe(400)
    expect(await errorOf(reused)).toBe('invalid_grant')
    const ids = Object.keys(ledgerIds())
    expect(ids.some(id => id.startsWith('code:'))).toBe(true)
    expect(ids.some(id => id.startsWith('refresh:'))).toBe(true)
    expect(ids.some(id => id.startsWith('family:'))).toBe(true)
  })

  it('refuses a code reused on another instance', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    expect((await exchange(clientId, signed.code ?? '', verifier)).status).toBe(
      200
    )
    server = newServer()
    const again = await exchange(clientId, signed.code ?? '', verifier)
    expect(await errorOf(again)).toBe('invalid_grant')
  })

  it('lets only one of two instances refreshing the same token at once win', async () => {
    const { clientId, tokens } = await ownerTokens()
    const first = newServer()
    const second = newServer()
    const fields = {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    }
    // Both instances read the record (revocation check, then claim) before
    // either writes, so both write against the same sha.
    holdWritesUntilReads = ledgerReads + 4
    const replies = await Promise.all([
      first.token(tokenRequest(fields)),
      second.token(tokenRequest(fields)),
    ])
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 400])
  })

  it('keeps a family revoked until its newest token has expired', async () => {
    const day = 24 * 60 * 60 * 1000
    const { clientId, tokens } = await ownerTokens()
    clock += 10 * day
    const next = (await (
      await refresh(clientId, tokens.refresh_token)
    ).json()) as Tokens
    clock += day
    expect(await errorOf(await refresh(clientId, tokens.refresh_token))).toBe(
      'invalid_grant'
    )
    // Past the reused token's own expiry (day 30), before the newer one's
    // (day 40): the family must still be revoked.
    clock += 24 * day
    const late = await refresh(clientId, next.refresh_token)
    expect(late.status).toBe(400)
    expect(await errorOf(late)).toBe('invalid_grant')
  })

  it('drops expired entries from the record when it writes', async () => {
    const { clientId, tokens } = await ownerTokens()
    const codeIds = Object.keys(ledgerIds()).filter(id =>
      id.startsWith('code:')
    )
    expect(codeIds).toHaveLength(1)
    clock += 2 * 60 * 1000
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200)
    expect(Object.keys(ledgerIds())).not.toContain(codeIds[0])
  })

  it('issues no token and answers 503 when the record cannot be read or written', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    ledgerFailure = 500
    const response = await exchange(clientId, signed.code ?? '', verifier)
    expect(response.status).toBe(503)
    const body = (await response.json()) as Record<string, string>
    expect(body.error).toBe('temporarily_unavailable')
    // The detail names the owner's private data repo: server log only.
    expect(body.error_description).toBe(
      'the spent-grant record is unavailable; try again later'
    )
    expect(JSON.stringify(body)).not.toContain('rr-data')
    expect(JSON.stringify(body)).not.toContain(DATA_TOKEN)
    expect(body).not.toHaveProperty('access_token')
  })

  it('answers 503 when the record is not JSON or GitHub is unreachable', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    ledger = { text: 'not json', sha: 'sha-x' }
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    expect((await exchange(clientId, signed.code ?? '', verifier)).status).toBe(
      503
    )
    ledger = undefined
    server = createHostedOAuthServer({
      env,
      now: () => clock,
      resolver: fakeResolver,
      fetch: async (url, init) => {
        if (url === LEDGER_URL) throw new Error(`offline ${DATA_TOKEN}`)
        return fakeFetch(url, init)
      },
    })
    const again = await signIn(OWNER, clientId, challenge)
    const offline = await exchange(clientId, again.code ?? '', verifier)
    expect(offline.status).toBe(503)
    expect(await offline.text()).not.toContain(DATA_TOKEN)
  })

  it('answers 500 naming the data repo settings when they are unset or invalid', async () => {
    const unset = await newServer({
      RETIRE_RUNWAY_DATA_REPO: '',
      RETIRE_RUNWAY_GITHUB_APP_ID: '',
    }).token(tokenRequest({ grant_type: 'refresh_token' }))
    expect(unset.status).toBe(500)
    expect(((await unset.json()) as { missing: string[] }).missing).toEqual([
      'RETIRE_RUNWAY_DATA_REPO',
      'RETIRE_RUNWAY_GITHUB_APP_ID',
    ])
    const invalid: Record<string, string>[] = [
      { RETIRE_RUNWAY_DATA_REPO: 'not-a-repo' },
      { RETIRE_RUNWAY_DATA_REPO: 'owner/..' },
      { RETIRE_RUNWAY_DATA_PATH: 'retire-runway/../other' },
    ]
    for (const overrides of invalid) {
      const response = await newServer(overrides).token(
        tokenRequest({ grant_type: 'refresh_token' })
      )
      expect(response.status).toBe(500)
    }
  })
})

describe('REQ-MCP-32: PKCE is verified', () => {
  it('REQ-MCP-32: a factory server rejects bad PKCE without hosted-store settings', async () => {
    server = newFactoryServerWithoutHostedStore()
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const signed = await signIn(OWNER, clientId, pkce().challenge)

    const response = await exchange(
      clientId,
      signed.code ?? '',
      pkce().verifier
    )

    expect(response.status).toBe(400)
    expect(await errorOf(response)).toBe('invalid_grant')
  })

  it('answers invalid_grant when the verifier does not match', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    const wrong = await exchange(clientId, signed.code ?? '', pkce().verifier)
    expect(wrong.status).toBe(400)
    expect(await errorOf(wrong)).toBe('invalid_grant')
  })

  it('answers invalid_grant for a verifier that is malformed', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    for (const verifier of [
      'short',
      'x'.repeat(129),
      `${'a'.repeat(42)} `,
      'é'.repeat(43),
    ]) {
      const signed = await signIn(OWNER, clientId, pkce().challenge)
      const response = await exchange(clientId, signed.code ?? '', verifier)
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('invalid_grant')
    }
  })

  it('spends the code on a wrong verifier, so a stolen code allows one guess', async () => {
    const clientId = await registerClient([CLAUDE_REDIRECT])
    const { verifier, challenge } = pkce()
    const signed = await signIn(OWNER, clientId, challenge)
    expect(
      await errorOf(
        await exchange(clientId, signed.code ?? '', pkce().verifier)
      )
    ).toBe('invalid_grant')
    expect(
      await errorOf(await exchange(clientId, signed.code ?? '', verifier))
    ).toBe('invalid_grant')
  })
})

// Claude Code's client metadata document lists portless loopback redirects
// and signs in on a random port (RFC 8252 §7.3, BUI-1941).
describe('REQ-MCP-28: a loopback redirect matches on any port', () => {
  const CLAUDE_CODE_REDIRECTS = [
    'http://localhost/callback',
    'http://127.0.0.1/callback',
  ]

  beforeEach(() => {
    clientDocument = {
      client_id: CIMD_URL,
      client_name: 'Claude Code',
      redirect_uris: CLAUDE_CODE_REDIRECTS,
      token_endpoint_auth_method: 'none',
    }
  })

  it.each([
    ['localhost', 'http://localhost:51124/callback'],
    ['127.0.0.1', 'http://127.0.0.1:51124/callback'],
  ])(
    'REQ-MCP-28: signs in on %s with a port the metadata does not name',
    async (_host, redirectUri) => {
      const { verifier, challenge } = pkce()
      const signed = await signIn(OWNER, CIMD_URL, challenge, { redirectUri })
      expect(signed.code).toBeDefined()
      expect(signed.response.headers.get('location')).toMatch(
        new RegExp(`^${redirectUri.replace(/[.]/g, '\\.')}\\?`)
      )
      const response = await exchange(
        CIMD_URL,
        signed.code ?? '',
        verifier,
        redirectUri
      )
      expect(response.status).toBe(200)
    }
  )

  it('REQ-MCP-28: matches a registered port to another port', async () => {
    const clientId = await registerClient(['http://localhost:8123/callback'])
    const signed = await signIn(OWNER, clientId, pkce().challenge, {
      redirectUri: 'http://localhost:51124/callback',
    })
    expect(signed.code).toBeDefined()
  })

  it.each([
    ['another path', 'http://localhost:51124/other'],
    ['another host', 'http://evil.com:51124/callback'],
    ['https', 'https://localhost:51124/callback'],
    ['the other loopback host', 'http://127.0.0.1:5/callback'],
    ['a query', 'http://localhost:51124/callback?a=1'],
    ['a fragment', 'http://localhost:51124/callback#a'],
    ['user info', 'http://user@localhost:51124/callback'],
    ['a trailing slash', 'http://localhost:51124/callback/'],
    ['a non-URL', 'not a url'],
  ])(
    'REQ-MCP-28: refuses %s against a localhost-only client with 400',
    async (_label, redirectUri) => {
      const clientId = await registerClient(['http://localhost/callback'])
      const response = await server.authorize(
        authorizeRequest(
          authorizeParams(clientId, pkce().challenge, {
            redirect_uri: redirectUri,
          })
        )
      )
      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
    }
  )

  it.each([
    ['a port', 'https://claude.ai:8443/api/mcp/auth_callback'],
    ['a query', 'https://claude.ai/api/mcp/auth_callback?a=1'],
    ['a loopback redirect', 'http://localhost:51124/callback'],
  ])(
    'REQ-MCP-28: accepts only the exact hosted callback, refusing %s',
    async (_label, redirectUri) => {
      const clientId = await registerClient([CLAUDE_REDIRECT])
      const response = await server.authorize(
        authorizeRequest(
          authorizeParams(clientId, pkce().challenge, {
            redirect_uri: redirectUri,
          })
        )
      )
      expect(response.status).toBe(400)
      expect(response.headers.get('location')).toBeNull()
      const signed = await signIn(OWNER, clientId, pkce().challenge)
      expect(signed.code).toBeDefined()
    }
  )

  it.each([
    ['the registered portless redirect', 'http://localhost/callback'],
    ['another port', 'http://localhost:51125/callback'],
  ])(
    'REQ-MCP-28: the token exchange refuses %s instead of the authorize redirect',
    async (_label, otherRedirect) => {
      const { verifier, challenge } = pkce()
      const signed = await signIn(OWNER, CIMD_URL, challenge, {
        redirectUri: 'http://localhost:51124/callback',
      })
      const response = await exchange(
        CIMD_URL,
        signed.code ?? '',
        verifier,
        otherRedirect
      )
      expect(response.status).toBe(400)
      expect(await errorOf(response)).toBe('invalid_grant')
    }
  )
})

describe('REQ-MCP-28: a client metadata document goes through the SSRF check', () => {
  it.each([
    ['a private address', { v4: ['10.1.2.3'] }],
    ['loopback', { v4: ['127.0.0.1'] }],
    ['the cloud metadata address', { v4: ['169.254.169.254'] }],
    ['one public and one private address', { v4: [PUBLIC_IP, '10.1.2.3'] }],
    ['a private IPv6 address', { v4: [], v6: ['fd00::1'] }],
  ])(
    'refuses a client_id URL that resolves to %s, without fetching it',
    async (_name, row) => {
      dnsTable = { [CIMD_HOST]: row }
      const fetched: string[] = []
      const guarded = createOAuthServer({
        env,
        now: () => clock,
        resolver: fakeResolver,
        fetch: async (url, init) => {
          fetched.push(url)
          return fakeFetch(url, init)
        },
      })
      const response = await guarded.authorize(
        authorizeRequest(authorizeParams(CIMD_URL, pkce().challenge))
      )
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('refused')
      expect(fetched).not.toContain(CIMD_URL)
    }
  )

  it('refuses a host that does not resolve', async () => {
    dnsTable = {}
    const response = await server.authorize(
      authorizeRequest(authorizeParams(CIMD_URL, pkce().challenge))
    )
    expect(response.status).toBe(400)
  })

  it('fetches the document pinned to the address the check allowed', async () => {
    const pins: (PinnedAddress | undefined)[] = []
    const pinned = createOAuthServer({
      env,
      now: () => clock,
      resolver: fakeResolver,
      fetch: async (url, init, pin) => {
        if (url === CIMD_URL) pins.push(pin)
        return fakeFetch(url, init)
      },
    })
    await pinned.authorize(
      authorizeRequest(authorizeParams(CIMD_URL, pkce().challenge))
    )
    expect(resolverCalls).toContain(CIMD_HOST)
    expect(pins).toEqual([pinOfFor(PUBLIC_IP)])
  })

  it('the library refuses private addresses on its own', async () => {
    dnsTable = { 'internal.example.test': { v4: ['10.0.0.1'] } }
    const refused = await ssrfProtection.validateUrl(
      'https://internal.example.test/x',
      undefined,
      fakeResolver
    )
    expect(refused.allowed).toBe(false)
  })
})

function pinOfFor(ip: string): PinnedAddress {
  return { address: ip, family: ip.includes(':') ? 6 : 4 }
}
