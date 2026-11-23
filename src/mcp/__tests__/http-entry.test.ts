// @vitest-environment node
// Hosted MCP entry over Streamable HTTP, protected as an OAuth resource
// server (REQ-MCP-22..26, BUI-1856).
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { CryptoKey, JWK } from 'jose'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { DELETE, GET, POST } from '@/app/api/mcp/route'
import { GET as metadataGET } from '@/app/.well-known/oauth-protected-resource/route'
import type { UserProfile } from '@/engine/types'
import { createPlanServer } from '../server'

const ORIGIN = 'https://rr.example.test'
const MCP_URL = `${ORIGIN}/api/mcp`
const METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource`
const ISSUER = 'https://auth.example.test'
const JWKS_URL = `${ISSUER}/jwks`
const OWNER = 'owner-subject-1'
const CHALLENGE = `Bearer resource_metadata="${METADATA_URL}"`

const CONFIG_ENV = [
  'RETIRE_RUNWAY_OAUTH_ISSUER',
  'RETIRE_RUNWAY_OAUTH_JWKS_URL',
  'RETIRE_RUNWAY_OWNER_SUBJECT',
] as const

const profile: UserProfile = {
  currentAge: 56,
  targetRetirementAge: 57,
  annualExpenses: 80_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2_500,
  stateTaxRate: 0.05,
  federalTaxBracket: 0.22,
}

let signingKey: CryptoKey
let otherKey: CryptoKey
let publicJwk: JWK
let dataDir: string

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  signingKey = pair.privateKey
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }
  otherKey = (await generateKeyPair('ES256')).privateKey
})

interface TokenOptions {
  /** `null` leaves the subject claim out. */
  subject?: string | null
  audience?: string
  issuer?: string
  key?: CryptoKey
  expiresIn?: string | number
}

async function token(options: TokenOptions = {}): Promise<string> {
  const jwt = new SignJWT({ scope: 'mcp' }).setProtectedHeader({
    alg: 'ES256',
    kid: 'k1',
  })
  if (options.subject !== null) jwt.setSubject(options.subject ?? OWNER)
  return jwt
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? MCP_URL)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '10m')
    .sign(options.key ?? signingKey)
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rr-http-entry-'))
  vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', ISSUER)
  vi.stubEnv('RETIRE_RUNWAY_OAUTH_JWKS_URL', JWKS_URL)
  vi.stubEnv('RETIRE_RUNWAY_OWNER_SUBJECT', OWNER)
  vi.stubEnv('RETIRE_RUNWAY_DATA_DIR', dataDir)
  vi.stubEnv('RETIRE_RUNWAY_DATA_REPO', '')
  vi.stubEnv('RETIRE_RUNWAY_DATA_PATH', '')
  vi.stubEnv('RETIRE_RUNWAY_GITHUB_TOKEN', '')
  // The token check fetches the issuer's signing keys; serve them here.
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === JWKS_URL) return Response.json({ keys: [publicJwk] })
    throw new Error(`unexpected fetch ${url}`)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true })
})

/** Routes each request to the route handler for its method. */
async function route(request: Request): Promise<Response> {
  if (request.method === 'POST') return POST(request)
  if (request.method === 'GET') return GET(request)
  if (request.method === 'DELETE') return DELETE(request)
  throw new Error(`no handler for ${request.method}`)
}

function rawCall(headers: Record<string, string> = {}): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'save_profile', arguments: { profile } },
    }),
  })
}

function profileSaved(): boolean {
  return existsSync(join(dataDir, 'profile.json'))
}

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: 'http-entry-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: async (input, init) => route(new Request(input, init)),
  })
  await client.connect(transport)
  return client
}

async function stdioToolNames(): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = createPlanServer()
  await server.connect(serverSide)
  const client = new Client({ name: 'stdio-reference', version: '1.0.0' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools.map(tool => tool.name).sort()
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.isError ?? false).toBe(false)
  return result.structuredContent as Record<string, unknown>
}

describe('hosted MCP endpoint', () => {
  it('REQ-MCP-22: a call without a bearer token gets 401 with the resource metadata challenge and runs no tool', async () => {
    const response = await POST(rawCall())
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(CHALLENGE)
    expect(profileSaved()).toBe(false)

    for (const method of ['GET', 'DELETE'] as const) {
      const other = await route(new Request(MCP_URL, { method }))
      expect(other.status).toBe(401)
      expect(other.headers.get('www-authenticate')).toBe(CHALLENGE)
    }
  })

  it('REQ-MCP-22: an invalid, expired, foreign-audience, foreign-issuer or foreign-key token gets the same 401 and runs no tool', async () => {
    const bad = [
      'Bearer not-a-jwt',
      'Basic dXNlcjpwYXNz',
      'Bearer ',
      `Bearer ${await token({ expiresIn: Math.floor(Date.now() / 1000) - 60 })}`,
      `Bearer ${await token({ audience: `${ORIGIN}/api/other` })}`,
      `Bearer ${await token({ issuer: 'https://evil.example.test' })}`,
      `Bearer ${await token({ key: otherKey })}`,
      `Bearer ${await token({ subject: null })}`,
      `Bearer ${await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
        .setSubject(OWNER)
        .setIssuer(ISSUER)
        .setAudience(MCP_URL)
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode('a shared secret of 32 bytes!!!!'))}`,
    ]
    for (const authorization of bad) {
      const response = await POST(rawCall({ authorization }))
      expect(response.status, authorization).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe(CHALLENGE)
    }
    expect(profileSaved()).toBe(false)
  })

  it('REQ-MCP-22: when the issuer keys cannot be loaded the route answers 502 naming the key URL and runs no tool', async () => {
    // A key URL no earlier test loaded, so no cached key set answers for it.
    const downUrl = `${ISSUER}/jwks-down`
    vi.stubEnv('RETIRE_RUNWAY_OAUTH_JWKS_URL', downUrl)
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }))
    const response = await POST(
      rawCall({ authorization: `Bearer ${await token()}` })
    )
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error_description: string }
    expect(body.error_description).toContain(downUrl)
    expect(profileSaved()).toBe(false)
  })

  it('REQ-MCP-23: the protected resource metadata names the MCP URL and the configured issuer first', async () => {
    const response = await metadataGET(new Request(METADATA_URL))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.resource).toBe(MCP_URL)
    expect(body.authorization_servers).toEqual([ISSUER])
    // The 401 challenge points at this same document.
    const challenge = (await POST(rawCall())).headers.get('www-authenticate')
    expect(challenge).toBe(`Bearer resource_metadata="${METADATA_URL}"`)
  })

  it('REQ-MCP-23: the metadata document answers 500 naming the issuer variable when it is not set', async () => {
    vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', '')
    const response = await metadataGET(new Request(METADATA_URL))
    expect(response.status).toBe(500)
    const body = (await response.json()) as { missing: string[] }
    expect(body.missing).toEqual(['RETIRE_RUNWAY_OAUTH_ISSUER'])
  })

  it('REQ-MCP-24: an owner token serves the same tools as the stdio server and runs get_profile', async () => {
    const client = await connect(await token())
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name).sort()
    expect(names).toEqual(await stdioToolNames())
    expect(names).toContain('get_profile')

    const empty = structured(
      (await client.callTool({
        name: 'get_profile',
        arguments: {},
      })) as CallToolResult
    )
    expect(empty).toMatchObject({ ok: true, saved: false })

    structured(
      (await client.callTool({
        name: 'save_profile',
        arguments: { profile },
      })) as CallToolResult
    )
    expect(profileSaved()).toBe(true)
    const saved = structured(
      (await client.callTool({
        name: 'get_profile',
        arguments: {},
      })) as CallToolResult
    )
    expect(saved).toMatchObject({ ok: true, saved: true, profile })
    await client.close()
  })

  it('REQ-MCP-25: a valid token for another subject gets 403 and runs no tool', async () => {
    const response = await POST(
      rawCall({
        authorization: `Bearer ${await token({ subject: 'someone-else' })}`,
      })
    )
    expect(response.status).toBe(403)
    expect(profileSaved()).toBe(false)
  })

  it.each(CONFIG_ENV)(
    'REQ-MCP-26: with %s unset the route answers 500 naming it and serves no tool',
    async name => {
      vi.stubEnv(name, '')
      const response = await POST(
        rawCall({ authorization: `Bearer ${await token()}` })
      )
      expect(response.status).toBe(500)
      const body = (await response.json()) as { missing: string[] }
      expect(body.missing).toEqual([name])
      expect(profileSaved()).toBe(false)
    }
  )

  it('REQ-MCP-26: with no configuration the route answers 500 naming every variable, even without a token', async () => {
    for (const name of CONFIG_ENV) vi.stubEnv(name, '')
    const response = await POST(rawCall())
    expect(response.status).toBe(500)
    const body = (await response.json()) as { missing: string[]; error: string }
    expect(body.missing).toEqual([...CONFIG_ENV])
    expect(body.error).toBe('server_error')
    expect(profileSaved()).toBe(false)
  })

  it.each([
    ['RETIRE_RUNWAY_OAUTH_JWKS_URL', 'not a url'],
    ['RETIRE_RUNWAY_OAUTH_ISSUER', 'http://auth.example.test'],
  ])(
    'REQ-MCP-26: with %s set to %s (not an https URL) the route answers 500 naming it',
    async (name, value) => {
      vi.stubEnv(name, value)
      const response = await POST(
        rawCall({ authorization: `Bearer ${await token()}` })
      )
      expect(response.status).toBe(500)
      const body = (await response.json()) as { invalid: string[] }
      expect(body.invalid).toEqual([name])
      expect(profileSaved()).toBe(false)
    }
  )
})
