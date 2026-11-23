// @vitest-environment node
// FR-23 (BUI-1944): the hosted MCP route runs on serverless functions, where
// no other instance can publish to its in-memory event bus and the server
// emits no change events. A `subscriptions/listen` stream therefore must end
// at once instead of holding the function until its 300 s limit, and the
// route must not advertise change notifications it cannot deliver.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
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
import { z } from 'zod'
import { POST } from '@/app/api/mcp/route'

const ORIGIN = 'https://rr.example.test'
const MCP_URL = `${ORIGIN}/api/mcp`
const ISSUER = 'https://auth.example.test'
const JWKS_URL = `${ISSUER}/jwks`
const OWNER = 'owner-subject-1'
const MODERN = '2026-07-28'
/** The card's limit for a stream the route cannot serve (REQ: 5 s). */
const LISTEN_DEADLINE_MS = 5_000

const EVERY_CHANGE = {
  toolsListChanged: true,
  promptsListChanged: true,
  resourcesListChanged: true,
  resourceSubscriptions: ['plan://profile'],
}

type RouteHandler = (request: Request) => Promise<Response>

interface ListenExchange {
  readonly ended: boolean
  readonly elapsedMs: number
  readonly body: string
}

let signingKey: CryptoKey
let publicJwk: JWK
let dataDir: string

beforeAll(async () => {
  const pair = await generateKeyPair('ES256')
  signingKey = pair.privateKey
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }
})

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rr-mcp-listen-'))
  vi.stubEnv('RETIRE_RUNWAY_OAUTH_ISSUER', ISSUER)
  vi.stubEnv('RETIRE_RUNWAY_OAUTH_JWKS_URL', JWKS_URL)
  vi.stubEnv('RETIRE_RUNWAY_OWNER_SUBJECT', OWNER)
  vi.stubEnv('RETIRE_RUNWAY_DATA_DIR', dataDir)
  vi.stubEnv('RETIRE_RUNWAY_DATA_REPO', '')
  vi.stubEnv('RETIRE_RUNWAY_DATA_PATH', '')
  vi.stubEnv('RETIRE_RUNWAY_GITHUB_TOKEN', '')
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === JWKS_URL) return Response.json({ keys: [publicJwk] })
    throw new Error(`unexpected fetch ${url}`)
  })
})

afterEach(() => {
  vi.doUnmock('@/mcp/server')
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(dataDir, { recursive: true, force: true })
})

async function ownerToken(): Promise<string> {
  return new SignJWT({ scope: 'mcp' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject(OWNER)
    .setIssuer(ISSUER)
    .setAudience(MCP_URL)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey)
}

/**
 * Reads the whole response body, or stops at the deadline and cancels the
 * stream, so a hanging stream fails the test instead of hanging it.
 */
async function drain(response: Response): Promise<ListenExchange> {
  const started = performance.now()
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return { ended: true, elapsedMs: 0, body: '' }
  }
  const decoder = new TextDecoder()
  let body = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>(resolve => {
    timer = setTimeout(() => resolve('deadline'), LISTEN_DEADLINE_MS)
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === 'deadline') {
        await reader.cancel()
        return { ended: false, elapsedMs: performance.now() - started, body }
      }
      if (next.done) break
      body += decoder.decode(next.value, { stream: true })
    }
  } finally {
    clearTimeout(timer)
  }
  return { ended: true, elapsedMs: performance.now() - started, body }
}

/**
 * Connects a client to the route over a modern (2026-07-28) connection and
 * records every `subscriptions/listen` exchange the route answers.
 */
async function connect(
  handler: RouteHandler,
  options: { readonly modern: boolean; readonly listChanged?: boolean }
): Promise<{ client: Client; listens: ListenExchange[] }> {
  const bearer = await ownerToken()
  const listens: ListenExchange[] = []
  const client = new Client(
    { name: 'listen-timeout-test', version: '1.0.0' },
    {
      ...(options.modern && { versionNegotiation: { mode: { pin: MODERN } } }),
      ...(options.listChanged === true && {
        listChanged: {
          tools: { onChanged: () => undefined },
        },
      }),
    }
  )
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const isListen =
        typeof init?.body === 'string' &&
        init.body.includes('"subscriptions/listen"')
      const response = await handler(request)
      if (!isListen) return response
      const exchange = await drain(response)
      listens.push(exchange)
      return new Response(exchange.body, {
        status: response.status,
        headers: response.headers,
      })
    },
  })
  await client.connect(transport)
  return { client, listens }
}

/** A server with every change-notification capability the SDK can advertise. */
function serverWithEveryCapability(): McpServer {
  const server = new McpServer(
    { name: 'every-capability', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true } } }
  )
  server.registerTool(
    'echo',
    { description: 'Echo', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  )
  server.registerPrompt('greet', { description: 'Greet' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
  }))
  server.registerResource(
    'profile',
    'plan://profile',
    { mimeType: 'application/json' },
    async () => ({ contents: [{ uri: 'plan://profile', text: '{}' }] })
  )
  return server
}

describe('hosted MCP route and subscriptions/listen (FR-23, BUI-1944)', () => {
  it('ends a subscriptions/listen stream within 5 s instead of holding it', async () => {
    const { client, listens } = await connect(POST, { modern: true })
    const subscription = await client.listen(EVERY_CHANGE)

    expect(subscription.honoredFilter).toEqual({})
    expect(listens).toHaveLength(1)
    expect(listens[0]?.ended).toBe(true)
    expect(listens[0]?.elapsedMs).toBeLessThan(LISTEN_DEADLINE_MS)
    expect(listens[0]?.body).toContain('"resultType":"complete"')
    await client.close()
  }, 15_000)

  it('does not advertise tool change notifications on a modern connection', async () => {
    const { client, listens } = await connect(POST, {
      modern: true,
      listChanged: true,
    })

    expect(client.getServerCapabilities()?.tools).toBeDefined()
    expect(client.getServerCapabilities()?.tools?.listChanged).not.toBe(true)
    // A client that asks for list-changed delivery opens no listen stream.
    expect(client.autoOpenedSubscription).toBeUndefined()
    expect(listens).toHaveLength(0)
    await client.close()
  })

  it('still lists and calls the plan tools on a modern connection', async () => {
    const { client } = await connect(POST, { modern: true })

    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)
    expect(names).toContain('build_plan')
    expect(names).toContain('analyze_plan')
    const result = await client.callTool({
      name: 'build_plan',
      arguments: { intake: {} },
    })
    expect(result.isError).toBe(true)
    await client.close()
  })

  it('still initializes, lists tools and advertises no change notifications on a 2025-era connection', async () => {
    const { client } = await connect(POST, { modern: false })

    expect(client.getServerVersion()?.name).toBe('retire-runway')
    expect(client.getServerCapabilities()?.tools?.listChanged).not.toBe(true)
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toContain('build_plan')
    await client.close()
  })

  it('advertises no prompt, resource or subscribe notifications either', async () => {
    vi.resetModules()
    vi.doMock('@/mcp/server', () => ({
      createPlanServer: serverWithEveryCapability,
    }))
    const route = await import('@/app/api/mcp/route')
    const { client, listens } = await connect(route.POST, { modern: true })

    const capabilities = client.getServerCapabilities()
    expect(capabilities?.tools?.listChanged).not.toBe(true)
    expect(capabilities?.prompts?.listChanged).not.toBe(true)
    expect(capabilities?.resources?.listChanged).not.toBe(true)
    expect(capabilities?.resources?.subscribe).not.toBe(true)
    // The capabilities themselves stay advertised, so the client can use them.
    expect(capabilities?.prompts).toBeDefined()
    expect(capabilities?.resources).toBeDefined()
    const { resources } = await client.listResources()
    expect(resources.map(resource => resource.uri)).toEqual(['plan://profile'])

    const subscription = await client.listen(EVERY_CHANGE)
    expect(subscription.honoredFilter).toEqual({})
    expect(listens[0]?.ended).toBe(true)
    expect(listens[0]?.elapsedMs).toBeLessThan(LISTEN_DEADLINE_MS)
    await client.close()
  }, 15_000)
})
