// OAuth 2.1 authorization server for the hosted MCP endpoint (REQ-MCP-27..32,
// BUI-1857). Claude's OAuth client signs the owner in here; sign-in is
// delegated to GitHub, and only the GitHub login in OWNER_GITHUB_LOGIN gets a
// token. The resource server (src/mcp/http-auth.ts) verifies the JWT access
// tokens this module signs, using the key set served at /oauth/jwks.
//
// The server keeps no database. The client ID (DCR), the sign-in state, the
// authorization code and the refresh token are each a JWT signed with
// RETIRE_RUNWAY_OAUTH_SIGNING_KEY under its own `typ` and `aud`, so one kind
// never passes for another and none passes for an access token. The one state
// is a GrantStore that records which codes and refresh tokens were spent; it
// lives in the owner's private data repo so every server instance shares it.
import {
  SignJWT,
  calculateJwkThumbprint,
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose'
import {
  APP_ID_ENV,
  APP_KEY_ENV,
  GitHubAppTokenError,
  createAppTokenSource,
  type TokenSource,
} from './github-app-token'
import {
  fetchPinned,
  pinOf,
  ssrfProtection,
  type DnsResolver,
  type PinnedAddress,
} from '@/lib/ssrf-protection'
import { MCP_PATH, readIssuer, type Checked } from './http-auth'

export const OWNER_LOGIN_ENV = 'OWNER_GITHUB_LOGIN'
export const GITHUB_CLIENT_ID_ENV = 'RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_ID'
export const GITHUB_CLIENT_SECRET_ENV =
  'RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_SECRET'
export const SIGNING_KEY_ENV = 'RETIRE_RUNWAY_OAUTH_SIGNING_KEY'

export const AUTHORIZE_PATH = '/oauth/authorize'
export const TOKEN_PATH = '/oauth/token'
export const REGISTER_PATH = '/oauth/register'
export const JWKS_PATH = '/oauth/jwks'
export const GITHUB_CALLBACK_PATH = '/oauth/github/callback'

export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'

const ACCESS_TOKEN_SECONDS = 60 * 60
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60
const CODE_SECONDS = 60
const STATE_SECONDS = 10 * 60
// Every endpoint must answer Claude within 10 seconds; each outbound call
// (GitHub, a client metadata document) gets half of that.
const OUTBOUND_TIMEOUT_MS = 4_000
const DOCUMENT_LIMIT = 16 * 1024
const MAX_REDIRECT_URIS = 5
const SCOPE = 'mcp'
const NONCE_COOKIE = 'rr_oauth_nonce'

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'

// One `typ` and `aud` per kind of signed value (RFC 8725 explicit typing).
const KIND = {
  client: { typ: 'rr-client+jwt', aud: 'urn:retire-runway:client' },
  state: { typ: 'rr-state+jwt', aud: 'urn:retire-runway:state' },
  code: { typ: 'rr-code+jwt', aud: 'urn:retire-runway:code' },
  refresh: { typ: 'rr-refresh+jwt', aud: 'urn:retire-runway:refresh' },
} as const
type Kind = keyof typeof KIND

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/

type Env = Readonly<Record<string, string | undefined>>

/**
 * Records spent codes and refresh tokens and revoked token families, shared
 * by every server instance. `claim` resolves true on the first claim of an ID
 * only; it rejects when the record cannot be read or written.
 */
export interface GrantStore {
  claim(id: string, expiresAt: number): Promise<boolean>
  has(id: string): Promise<boolean>
}

/**
 * Process-local grant store for an explicitly constructed server. This keeps
 * the dependency-injected factory self-contained for tests and non-hosted
 * embeddings. The hosted route singleton uses the shared GitHub store below.
 */
export function createMemoryGrantStore(
  now: () => number = () => Date.now()
): GrantStore {
  const spent = new Map<string, number>()
  const prune = (): void => {
    const current = now() / 1000
    for (const [id, expiresAt] of spent) {
      if (expiresAt <= current) spent.delete(id)
    }
  }
  return {
    async has(id) {
      prune()
      return spent.has(id)
    },
    async claim(id, expiresAt) {
      prune()
      if (spent.has(id)) return false
      spent.set(id, expiresAt)
      return true
    },
  }
}

export const DATA_REPO_ENV = 'RETIRE_RUNWAY_DATA_REPO'
export const DATA_PATH_ENV = 'RETIRE_RUNWAY_DATA_PATH'
/** The spent-grant record, in the owner's data folder. */
export const GRANTS_FILE = 'oauth-grants.json'
const LEDGER_ATTEMPTS = 4
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

export class GrantStoreError extends Error {
  override readonly name = 'GrantStoreError'

  /**
   * True when the message is a setup step for the owner (the GitHub App is
   * not installed, or its settings are wrong), not a GitHub or repo failure.
   */
  readonly ownerAction: boolean

  constructor(message: string, ownerAction = false) {
    super(message)
    this.ownerAction = ownerAction
  }
}

interface LedgerFile {
  readonly spent: Record<string, number>
  readonly sha?: string
}

/**
 * The spent-grant record as one JSON file in the owner's private data repo
 * (the repo the git store uses), read and written through the GitHub contents
 * API with the GitHub App installation token the git store uses. Server instances run in parallel and are recycled, so the record is
 * shared, not in memory. A write sends the sha it read, and GitHub refuses it
 * with a conflict when the file changed since; the claim then reads again,
 * so two instances never both claim one ID. Entries past their expiry are
 * dropped on each write.
 */
export function createGitHubGrantStore(options: {
  readonly repo: string
  readonly path: string
  readonly tokens: TokenSource
  readonly fetch: FetchFn
  /** Milliseconds since the epoch. */
  readonly now: () => number
}): GrantStore {
  const segments = [
    ...options.path.split('/').filter(part => part !== ''),
    GRANTS_FILE,
  ]
  const url = `https://api.github.com/repos/${options.repo}/contents/${segments.map(encodeURIComponent).join('/')}`
  const where = `${options.repo}/${segments.join('/')}`
  async function call(init: RequestInit): Promise<Response> {
    let token: string
    try {
      token = await options.tokens.token()
    } catch (error) {
      if (!(error instanceof GitHubAppTokenError)) throw error
      // A missing install or a wrong app key is the owner's to fix; GitHub
      // being down or answering oddly is not.
      throw new GrantStoreError(
        error.message,
        error.field === DATA_REPO_ENV || error.field === APP_KEY_ENV
      )
    }
    let response: Response
    try {
      response = await options.fetch(url, {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'retire-runway-oauth',
        },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      })
    } catch {
      throw new GrantStoreError(`could not reach GitHub for ${where}`)
    }
    // A revoked token is not reused: the next request mints a new one.
    if (response.status === 401) options.tokens.forget(token)
    return response
  }

  async function read(): Promise<LedgerFile> {
    const response = await call({ method: 'GET' })
    if (response.status === 404) return { spent: {} }
    if (!response.ok) {
      throw new GrantStoreError(
        `GitHub returned ${response.status} for ${where}`
      )
    }
    const body: unknown = await response.json()
    if (
      !isRecord(body) ||
      typeof body.sha !== 'string' ||
      typeof body.content !== 'string' ||
      body.encoding === 'none'
    ) {
      throw new GrantStoreError(`${where} is not a readable file`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
    } catch {
      throw new GrantStoreError(`${where} is not JSON`)
    }
    const spent = isRecord(parsed) ? parsed.spent : undefined
    if (!isRecord(spent)) {
      throw new GrantStoreError(`${where} has no spent record`)
    }
    const valid: Record<string, number> = {}
    for (const [id, expiresAt] of Object.entries(spent)) {
      if (typeof expiresAt !== 'number') {
        throw new GrantStoreError(`${where} holds an entry with no expiry`)
      }
      valid[id] = expiresAt
    }
    return { spent: valid, sha: body.sha }
  }

  const live = (ledger: LedgerFile, id: string): boolean => {
    const expiresAt = ledger.spent[id]
    return expiresAt !== undefined && expiresAt > options.now() / 1000
  }

  return {
    async has(id) {
      return live(await read(), id)
    },
    async claim(id, expiresAt) {
      for (let attempt = 1; attempt <= LEDGER_ATTEMPTS; attempt += 1) {
        const ledger = await read()
        if (live(ledger, id)) return false
        const now = options.now() / 1000
        const spent = Object.fromEntries(
          Object.entries(ledger.spent).filter(([, at]) => at > now)
        )
        spent[id] = expiresAt
        const content = `${JSON.stringify({ spent }, null, 2)}\n`
        const response = await call({
          method: 'PUT',
          body: JSON.stringify({
            message: `data: oauth ${GRANTS_FILE}`,
            content: Buffer.from(content, 'utf8').toString('base64'),
            ...(ledger.sha === undefined ? {} : { sha: ledger.sha }),
          }),
        })
        if (response.ok) return true
        // 409: the file or branch moved; 422: the file appeared since the read.
        if (response.status !== 409 && response.status !== 422) {
          throw new GrantStoreError(
            `GitHub returned ${response.status} writing ${where}`
          )
        }
      }
      throw new GrantStoreError(
        `${where} kept changing during ${LEDGER_ATTEMPTS} attempts to write it`
      )
    },
  }
}

type FetchFn = (
  input: string,
  init: RequestInit,
  pin?: PinnedAddress
) => Promise<Response>

export interface OAuthDeps {
  readonly env: Env
  readonly fetch: FetchFn
  /**
   * The DNS lookups of the SSRF check on a client metadata document URL; by
   * default the real resolver (`dns.promises`).
   */
  readonly resolver?: DnsResolver
  /** Milliseconds since the epoch. */
  readonly now: () => number
  /** The spent-grant record; by default the GitHub one from the env. */
  readonly store?: GrantStore
  readonly randomId: () => string
}

// ---------------------------------------------------------------- responses

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
} as const

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...CORS, 'cache-control': 'no-store', ...extra },
  })
}

function oauthError(
  error: string,
  description: string,
  status = 400
): Response {
  return json({ error, error_description: description }, status)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function errorPage(
  status: number,
  title: string,
  message: string,
  headers: Headers = new Headers()
): Response {
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.set('cache-control', 'no-store')
  headers.set('content-security-policy', "default-src 'none'")
  headers.set('x-content-type-options', 'nosniff')
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
  return new Response(body, { status, headers })
}

function redirect(
  location: string,
  headers: Headers = new Headers()
): Response {
  headers.set('location', location)
  headers.set('cache-control', 'no-store')
  return new Response(null, { status: 302, headers })
}

function configProblem(missing: readonly string[], detail = ''): Response {
  return Response.json(
    {
      error: 'server_error',
      error_description: `MCP OAuth configuration: ${[
        missing.length > 0 ? `missing ${missing.join(', ')}` : '',
        detail,
      ]
        .filter(part => part !== '')
        .join('; ')}`,
      missing,
    },
    { status: 500 }
  )
}

// ----------------------------------------------------------------- settings

function readSettings<const N extends string>(
  env: Env,
  names: readonly N[]
): Checked<Record<N, string>> {
  const values = {} as Record<N, string>
  const missing: string[] = []
  for (const name of names) {
    const value = (env[name] ?? '').trim()
    if (value === '') missing.push(name)
    else values[name] = value
  }
  if (missing.length > 0) return { ok: false, response: configProblem(missing) }
  return { ok: true, value: values }
}

interface Signer {
  readonly kid: string
  readonly privateKey: CryptoKey
  readonly publicKey: CryptoKey
  readonly publicJwk: JWK
}

const signers = new Map<string, Signer>()

async function loadSigner(text: string): Promise<Signer | string> {
  const cached = signers.get(text)
  if (cached) return cached
  let jwk: JWK
  try {
    jwk = JSON.parse(text) as JWK
  } catch {
    return `${SIGNING_KEY_ENV} is not JSON`
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
    return `${SIGNING_KEY_ENV} must be a private ES256 (EC P-256) JWK`
  }
  const publicJwk: JWK = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  }
  const kid = await calculateJwkThumbprint(publicJwk)
  publicJwk.kid = kid
  publicJwk.alg = 'ES256'
  publicJwk.use = 'sig'
  const privateKey = await importJWK({ ...jwk, alg: 'ES256' }, 'ES256')
  const publicKey = await importJWK(publicJwk, 'ES256')
  if (privateKey instanceof Uint8Array || publicKey instanceof Uint8Array) {
    return `${SIGNING_KEY_ENV} must be an asymmetric key`
  }
  const signer: Signer = { kid, privateKey, publicKey, publicJwk }
  signers.set(text, signer)
  return signer
}

async function readSigner(env: Env): Promise<Checked<Signer>> {
  const read = readSettings(env, [SIGNING_KEY_ENV])
  if (!read.ok) return read
  try {
    const signer = await loadSigner(read.value[SIGNING_KEY_ENV])
    if (typeof signer === 'string') {
      return { ok: false, response: configProblem([], signer) }
    }
    return { ok: true, value: signer }
  } catch {
    return {
      ok: false,
      response: configProblem([], `${SIGNING_KEY_ENV} is not a usable key`),
    }
  }
}

interface Context {
  readonly issuer: string
  readonly signer: Signer
}

async function readContext(env: Env): Promise<Checked<Context>> {
  const issuer = readIssuer(env)
  if (!issuer.ok) return issuer
  const signer = await readSigner(env)
  if (!signer.ok) return signer
  return {
    ok: true,
    value: { issuer: issuer.value.replace(/\/+$/, ''), signer: signer.value },
  }
}

function mcpUrlOf(issuer: string): string {
  return `${new URL(issuer).origin}${MCP_PATH}`
}

// ----------------------------------------------------------- signed values

interface Claims extends JWTPayload {
  [name: string]: unknown
}

async function signValue(
  deps: OAuthDeps,
  ctx: Context,
  kind: Kind,
  claims: Claims,
  lifetimeSeconds?: number
): Promise<string> {
  const now = Math.floor(deps.now() / 1000)
  const jwt = new SignJWT(claims)
    .setProtectedHeader({
      alg: 'ES256',
      kid: ctx.signer.kid,
      typ: KIND[kind].typ,
    })
    .setIssuer(ctx.issuer)
    .setAudience(KIND[kind].aud)
    .setIssuedAt(now)
    .setJti(deps.randomId())
  if (lifetimeSeconds !== undefined)
    jwt.setExpirationTime(now + lifetimeSeconds)
  return jwt.sign(ctx.signer.privateKey)
}

/** The claims of a value signed here for `kind`, else undefined. */
async function openValue(
  deps: OAuthDeps,
  ctx: Context,
  kind: Kind,
  token: string
): Promise<Claims | undefined> {
  try {
    const { payload } = await jwtVerify(token, ctx.signer.publicKey, {
      issuer: ctx.issuer,
      audience: KIND[kind].aud,
      typ: KIND[kind].typ,
      algorithms: ['ES256'],
      currentDate: new Date(deps.now()),
    })
    return payload
  } catch {
    return undefined
  }
}

function text(claims: Claims, name: string): string | undefined {
  const value = claims[name]
  return typeof value === 'string' ? value : undefined
}

// --------------------------------------------------------------- redirects

/**
 * The redirects Claude's OAuth client uses: its hosted callback, and a
 * loopback callback on any port (Claude Code, Claude Desktop).
 */
export function isAllowedRedirect(value: string): boolean {
  return value === CLAUDE_REDIRECT_URI || isLoopbackRedirect(value)
}

/**
 * A canonical `http` loopback callback (`localhost` or `127.0.0.1`, path
 * `/callback`), with or without a port.
 */
function isLoopbackRedirect(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
    url.pathname === '/callback' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    url.href === value
  )
}

/**
 * The one check that an authorize request's redirect matches a registered
 * one. The hosted callback must match exactly; a loopback callback matches a
 * registered loopback callback on the same host whatever the port of either,
 * as RFC 8252 §7.3 requires (Claude Code registers `http://localhost/callback`
 * and signs in on a random port).
 */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return isAllowedRedirect(requested)
  return (
    isLoopbackRedirect(registered) &&
    isLoopbackRedirect(requested) &&
    new URL(registered).hostname === new URL(requested).hostname
  )
}

function redirectList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (value.length > MAX_REDIRECT_URIS) return undefined
  const list: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !isAllowedRedirect(item)) return undefined
    list.push(item)
  }
  return list
}

// ----------------------------------------------------------------- helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a body up to `limit` characters; undefined when it is longer. */
async function readLimited(
  source: Request | Response,
  limit: number
): Promise<string | undefined> {
  const declared = Number(source.headers.get('content-length') ?? '0')
  if (declared > limit) return undefined
  const body = await source.text()
  return body.length > limit ? undefined : body
}

/** Query or form parameters; undefined when one name is given twice. */
function singleParams(
  params: URLSearchParams
): Map<string, string> | undefined {
  const map = new Map<string, string>()
  for (const [name, value] of params) {
    if (map.has(name)) return undefined
    map.set(name, value)
  }
  return map
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64url')
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  )
  return bytesToBase64Url(digest)
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

function nonceCookie(value: string, maxAge: number, issuer: string): string {
  const secure = issuer.startsWith('https:') ? '; Secure' : ''
  return `${NONCE_COOKIE}=${value}; Max-Age=${maxAge}; Path=${GITHUB_CALLBACK_PATH}; HttpOnly; SameSite=Lax${secure}`
}

// A client metadata document URL must be https with a path, and must not name
// the host directly, so a client ID cannot point the server at a local or
// internal address.
function isDocumentUrl(value: string): boolean {
  if (!value.startsWith('https://') || !URL.canParse(value)) return false
  const url = new URL(value)
  const host = url.hostname
  return (
    url.pathname !== '/' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    host.includes('.') &&
    !host.startsWith('[') &&
    !/^[0-9.]+$/.test(host) &&
    !/(^|\.)(localhost|local|internal|localdomain)$/.test(host)
  )
}

// ------------------------------------------------------------------ server

export interface OAuthServer {
  metadata(request: Request): Response
  jwks(request: Request): Promise<Response>
  register(request: Request): Promise<Response>
  authorize(request: Request): Promise<Response>
  githubCallback(request: Request): Promise<Response>
  token(request: Request): Promise<Response>
  preflight(): Response
}

type ClientResult =
  | { readonly ok: true; readonly redirectUris: readonly string[] }
  | { readonly ok: false; readonly description: string }

function buildOAuthServer(
  overrides: Partial<OAuthDeps>,
  requireSharedStore: boolean
): OAuthServer {
  const now = overrides.now ?? (() => Date.now())
  const deps: OAuthDeps = {
    env: overrides.env ?? process.env,
    fetch:
      overrides.fetch ??
      ((input, init, pin) =>
        pin === undefined
          ? fetch(input, init)
          : fetchPinned(input, pin, {
              headers: init.headers,
              signal: init.signal,
              // One byte over the limit, so readLimited reports the size.
              maxBytes: DOCUMENT_LIMIT + 1,
            })),
    ...(overrides.resolver === undefined
      ? {}
      : { resolver: overrides.resolver }),
    now,
    ...(overrides.store !== undefined
      ? { store: overrides.store }
      : requireSharedStore
        ? {}
        : { store: createMemoryGrantStore(now) }),
    randomId: overrides.randomId ?? (() => crypto.randomUUID()),
  }

  async function resolveClient(
    ctx: Context,
    clientId: string
  ): Promise<ClientResult> {
    if (clientId.startsWith('https://')) return fetchClientDocument(clientId)
    const claims = await openValue(deps, ctx, 'client', clientId)
    const redirectUris = claims ? redirectList(claims.redirect_uris) : undefined
    if (!redirectUris) {
      return { ok: false, description: 'client_id is not a registered client' }
    }
    return { ok: true, redirectUris }
  }

  async function fetchClientDocument(clientId: string): Promise<ClientResult> {
    const bad = (description: string): ClientResult => ({
      ok: false,
      description: `client metadata document: ${description}`,
    })
    if (!isDocumentUrl(clientId))
      return bad('the client_id URL is not accepted')
    let body: string | undefined
    try {
      // The host must resolve, and only to public addresses (REQ-MCP-28).
      const signal = AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
      const safe = await ssrfProtection.validateUrl(
        clientId,
        signal,
        deps.resolver
      )
      if (!safe.allowed || safe.ip === undefined)
        return bad(`the client_id URL is refused: ${safe.error}`)
      // Connect to the checked address, so DNS rebinding cannot swap it.
      const response = await deps.fetch(
        clientId,
        {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal,
        },
        pinOf(safe.ip)
      )
      if (!response.ok) return bad(`the fetch answered ${response.status}`)
      body = await readLimited(response, DOCUMENT_LIMIT)
    } catch {
      return bad('could not be fetched')
    }
    if (body === undefined) return bad('is too large')
    let document: unknown
    try {
      document = JSON.parse(body)
    } catch {
      return bad('is not JSON')
    }
    if (!isRecord(document)) return bad('is not a JSON object')
    if (document.client_id !== clientId)
      return bad('client_id does not match its URL')
    const method = document.token_endpoint_auth_method
    if (method !== undefined && method !== 'none') {
      return bad('token_endpoint_auth_method must be none')
    }
    const redirectUris = redirectList(document.redirect_uris)
    if (!redirectUris) {
      return bad(
        `redirect_uris must list up to ${MAX_REDIRECT_URIS} allowed redirects`
      )
    }
    return { ok: true, redirectUris }
  }

  // REQ-MCP-27
  function metadata(): Response {
    const issuer = readIssuer(deps.env)
    if (!issuer.ok) return issuer.response
    const base = issuer.value.replace(/\/+$/, '')
    return json({
      issuer: base,
      authorization_endpoint: `${base}${AUTHORIZE_PATH}`,
      token_endpoint: `${base}${TOKEN_PATH}`,
      registration_endpoint: `${base}${REGISTER_PATH}`,
      jwks_uri: `${base}${JWKS_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      scopes_supported: [SCOPE],
    })
  }

  async function jwks(): Promise<Response> {
    const signer = await readSigner(deps.env)
    if (!signer.ok) return signer.response
    return json({ keys: [signer.value.publicJwk] })
  }

  // REQ-MCP-28 (dynamic client registration)
  async function register(request: Request): Promise<Response> {
    const ctx = await readContext(deps.env)
    if (!ctx.ok) return ctx.response
    const invalid = (description: string): Response =>
      oauthError('invalid_client_metadata', description)
    const raw = await readLimited(request, DOCUMENT_LIMIT)
    let body: unknown
    try {
      body = raw === undefined ? undefined : JSON.parse(raw)
    } catch {
      body = undefined
    }
    if (!isRecord(body)) return invalid('the body must be a JSON object')
    const redirectUris = redirectList(body.redirect_uris)
    if (!redirectUris) {
      return oauthError(
        'invalid_redirect_uri',
        `redirect_uris must list up to ${MAX_REDIRECT_URIS} of https://claude.ai/api/mcp/auth_callback, http://localhost:<port>/callback or http://127.0.0.1:<port>/callback`
      )
    }
    const method = body.token_endpoint_auth_method
    if (method !== undefined && method !== 'none') {
      return invalid('token_endpoint_auth_method must be none')
    }
    const clientName =
      typeof body.client_name === 'string'
        ? body.client_name.slice(0, 100)
        : undefined
    const clientId = await signValue(deps, ctx.value, 'client', {
      redirect_uris: redirectUris,
    })
    return json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(deps.now() / 1000),
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(clientName === undefined ? {} : { client_name: clientName }),
      },
      201
    )
  }

  // Starts sign-in: validates the client and the request, then sends the
  // owner to GitHub with the request sealed in `state`.
  async function authorize(request: Request): Promise<Response> {
    const ctx = await readContext(deps.env)
    if (!ctx.ok) return ctx.response
    const settings = readSettings(deps.env, [
      GITHUB_CLIENT_ID_ENV,
      GITHUB_CLIENT_SECRET_ENV,
      OWNER_LOGIN_ENV,
    ])
    if (!settings.ok) return settings.response

    const params = singleParams(new URL(request.url).searchParams)
    if (!params) {
      return errorPage(
        400,
        'Sign-in request refused',
        'A parameter was repeated.'
      )
    }
    const clientId = params.get('client_id') ?? ''
    const redirectUri = params.get('redirect_uri') ?? ''
    const client =
      clientId === '' ? undefined : await resolveClient(ctx.value, clientId)
    if (client === undefined || !client.ok) {
      return errorPage(
        400,
        'Sign-in request refused',
        client === undefined
          ? 'The request names no client.'
          : client.description
      )
    }
    if (
      !client.redirectUris.some(registered =>
        redirectMatches(registered, redirectUri)
      )
    ) {
      return errorPage(
        400,
        'Sign-in request refused',
        'redirect_uri is not one of the client redirects.'
      )
    }

    // The redirect is trusted from here: errors go back to the client.
    const clientState = params.get('state')
    const back = (error: string, description: string): Response => {
      const target = new URL(redirectUri)
      target.searchParams.set('error', error)
      target.searchParams.set('error_description', description)
      if (clientState !== undefined)
        target.searchParams.set('state', clientState)
      return redirect(target.href)
    }
    if (params.get('response_type') !== 'code') {
      return back('unsupported_response_type', 'response_type must be code')
    }
    const challenge = params.get('code_challenge') ?? ''
    if (
      params.get('code_challenge_method') !== 'S256' ||
      !CHALLENGE_PATTERN.test(challenge)
    ) {
      return back(
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required'
      )
    }
    if ((clientState ?? '').length > 512) {
      return back('invalid_request', 'state is too long')
    }
    const resource = params.get('resource')
    if (
      resource !== undefined &&
      resource.replace(/\/+$/, '') !== mcpUrlOf(ctx.value.issuer)
    ) {
      return back('invalid_target', 'resource is not this MCP server')
    }

    // Binds the sign-in to this browser: a state that came from another
    // browser fails at the callback (login CSRF).
    const nonce = deps.randomId()
    const state = await signValue(
      deps,
      ctx.value,
      'state',
      {
        cid: clientId,
        ru: redirectUri,
        cc: challenge,
        n: nonce,
        ...(clientState === undefined ? {} : { cs: clientState }),
      },
      STATE_SECONDS
    )
    const target = new URL(GITHUB_AUTHORIZE_URL)
    target.searchParams.set('client_id', settings.value[GITHUB_CLIENT_ID_ENV])
    target.searchParams.set(
      'redirect_uri',
      `${ctx.value.issuer}${GITHUB_CALLBACK_PATH}`
    )
    target.searchParams.set('state', state)
    target.searchParams.set('allow_signup', 'false')
    const headers = new Headers()
    headers.append(
      'set-cookie',
      nonceCookie(nonce, STATE_SECONDS, ctx.value.issuer)
    )
    return redirect(target.href, headers)
  }

  async function githubLogin(
    ctx: Context,
    settings: Record<
      typeof GITHUB_CLIENT_ID_ENV | typeof GITHUB_CLIENT_SECRET_ENV,
      string
    >,
    code: string
  ): Promise<string | undefined> {
    const exchange = await deps.fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: settings[GITHUB_CLIENT_ID_ENV],
        client_secret: settings[GITHUB_CLIENT_SECRET_ENV],
        code,
        redirect_uri: `${ctx.issuer}${GITHUB_CALLBACK_PATH}`,
      }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    })
    if (!exchange.ok) return undefined
    const granted: unknown = await exchange.json()
    const accessToken = isRecord(granted) ? granted.access_token : undefined
    if (typeof accessToken !== 'string' || accessToken === '') return undefined
    const user = await deps.fetch(GITHUB_USER_URL, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'retire-runway-oauth',
      },
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    })
    if (!user.ok) return undefined
    const profile: unknown = await user.json()
    const login = isRecord(profile) ? profile.login : undefined
    return typeof login === 'string' && login !== '' ? login : undefined
  }

  // REQ-MCP-30: finishes sign-in. Only the owner's GitHub login gets a code.
  async function githubCallback(request: Request): Promise<Response> {
    const ctx = await readContext(deps.env)
    if (!ctx.ok) return ctx.response
    const settings = readSettings(deps.env, [
      GITHUB_CLIENT_ID_ENV,
      GITHUB_CLIENT_SECRET_ENV,
      OWNER_LOGIN_ENV,
    ])
    if (!settings.ok) return settings.response

    const headers = new Headers()
    headers.append('set-cookie', nonceCookie('', 0, ctx.value.issuer))
    const refuse = (status: number, message: string): Response =>
      errorPage(status, 'Sign-in refused', message, headers)

    const params = singleParams(new URL(request.url).searchParams)
    const code = params?.get('code')
    const sealed = params?.get('state')
    if (!params || sealed === undefined) {
      return refuse(400, 'The sign-in response is incomplete.')
    }
    const state = await openValue(deps, ctx.value, 'state', sealed)
    const cookie = readCookie(request, NONCE_COOKIE)
    if (!state || cookie === undefined || cookie !== text(state, 'n')) {
      return refuse(
        400,
        'The sign-in did not start in this browser. Start again from Claude.'
      )
    }
    if (params.has('error') || code === undefined || code === '') {
      return refuse(400, 'GitHub did not complete the sign-in.')
    }

    let login: string | undefined
    try {
      login = await githubLogin(ctx.value, settings.value, code)
    } catch {
      login = undefined
    }
    if (login === undefined) {
      return refuse(502, 'GitHub could not confirm who you are. Try again.')
    }
    const owner = settings.value[OWNER_LOGIN_ENV]
    if (login.toLowerCase() !== owner.toLowerCase()) {
      return refuse(
        403,
        'This server serves only its owner. Sign in with the owner GitHub account.'
      )
    }

    const clientId = text(state, 'cid')
    const redirectUri = text(state, 'ru')
    const challenge = text(state, 'cc')
    if (
      !clientId ||
      !redirectUri ||
      !challenge ||
      !isAllowedRedirect(redirectUri)
    ) {
      return refuse(400, 'The sign-in request is not valid.')
    }
    const authCode = await signValue(
      deps,
      ctx.value,
      'code',
      { sub: owner, cid: clientId, ru: redirectUri, cc: challenge },
      CODE_SECONDS
    )
    const target = new URL(redirectUri)
    target.searchParams.set('code', authCode)
    const clientState = text(state, 'cs')
    if (clientState !== undefined) target.searchParams.set('state', clientState)
    return redirect(target.href, headers)
  }

  async function issueTokens(
    ctx: Context,
    owner: string,
    clientId: string,
    family: string
  ): Promise<Response> {
    const accessToken = await signAccessToken(ctx, owner, clientId)
    const refreshToken = await signValue(
      deps,
      ctx,
      'refresh',
      { sub: owner, cid: clientId, fid: family },
      REFRESH_TOKEN_SECONDS
    )
    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: SCOPE,
    })
  }

  async function signAccessToken(
    ctx: Context,
    owner: string,
    clientId: string
  ): Promise<string> {
    const now = Math.floor(deps.now() / 1000)
    return new SignJWT({ client_id: clientId, scope: SCOPE })
      .setProtectedHeader({ alg: 'ES256', kid: ctx.signer.kid, typ: 'at+jwt' })
      .setIssuer(ctx.issuer)
      .setSubject(owner)
      .setAudience(mcpUrlOf(ctx.issuer))
      .setIssuedAt(now)
      .setExpirationTime(now + ACCESS_TOKEN_SECONDS)
      .setJti(deps.randomId())
      .sign(ctx.signer.privateKey)
  }

  async function token(request: Request): Promise<Response> {
    const ctx = await readContext(deps.env)
    if (!ctx.ok) return ctx.response
    const settings = readSettings(deps.env, [OWNER_LOGIN_ENV])
    if (!settings.ok) return settings.response
    const owner = settings.value[OWNER_LOGIN_ENV]
    const store = readGrantStore()
    if (!store.ok) return store.response

    const contentType = request.headers.get('content-type') ?? ''
    if (
      !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')
    ) {
      return oauthError(
        'invalid_request',
        'the token request must be application/x-www-form-urlencoded'
      )
    }
    const raw = await readLimited(request, DOCUMENT_LIMIT)
    const params =
      raw === undefined ? undefined : singleParams(new URLSearchParams(raw))
    if (!params) {
      return oauthError(
        'invalid_request',
        'the token request is malformed or repeats a parameter'
      )
    }
    const clientId = params.get('client_id') ?? ''
    if (clientId === '')
      return oauthError('invalid_request', 'client_id is required')
    try {
      return await grant(ctx.value, store.value, owner, clientId, params)
    } catch (error) {
      if (!(error instanceof GrantStoreError)) throw error
      // Without the spent-grant record a reuse cannot be told apart from a
      // first use, so no token is issued. The detail names the owner's
      // private data repo, so it goes to the server log, not the caller;
      // only a setup step the owner must take is in the reply.
      console.error(`RetireRunway OAuth: ${error.message}`)
      return oauthError(
        'temporarily_unavailable',
        error.ownerAction
          ? `the spent-grant record is unavailable: ${error.message}`
          : 'the spent-grant record is unavailable; try again later',
        503
      )
    }
  }

  function readGrantStore(): Checked<GrantStore> {
    if (deps.store !== undefined) return { ok: true, value: deps.store }
    const read = readSettings(deps.env, [
      DATA_REPO_ENV,
      DATA_PATH_ENV,
      APP_ID_ENV,
      APP_KEY_ENV,
    ])
    if (!read.ok) return read
    const repo = read.value[DATA_REPO_ENV]
    const path = read.value[DATA_PATH_ENV]
    const [, name] = repo.split('/')
    if (!REPO_PATTERN.test(repo) || name === '.' || name === '..') {
      return {
        ok: false,
        response: configProblem([], `${DATA_REPO_ENV} must be owner/repo`),
      }
    }
    if (path.split('/').some(part => part === '.' || part === '..')) {
      return {
        ok: false,
        response: configProblem([], `${DATA_PATH_ENV} must not hold . or ..`),
      }
    }
    return {
      ok: true,
      value: createGitHubGrantStore({
        repo,
        path,
        tokens: createAppTokenSource({
          appId: read.value[APP_ID_ENV],
          privateKey: read.value[APP_KEY_ENV],
          repo,
          fetch: deps.fetch,
          now: deps.now,
        }),
        fetch: deps.fetch,
        now: deps.now,
      }),
    }
  }

  async function grant(
    ctx: Context,
    store: GrantStore,
    owner: string,
    clientId: string,
    params: Map<string, string>
  ): Promise<Response> {
    const grantError = (description: string): Response =>
      oauthError('invalid_grant', description)

    const grantType = params.get('grant_type')
    if (grantType === 'authorization_code') {
      // REQ-MCP-29, REQ-MCP-32
      const codeToken = params.get('code') ?? ''
      const verifier = params.get('code_verifier') ?? ''
      const redirectUri = params.get('redirect_uri') ?? ''
      if (codeToken === '' || verifier === '' || redirectUri === '') {
        return oauthError(
          'invalid_request',
          'code, code_verifier and redirect_uri are required'
        )
      }
      const claims = await openValue(deps, ctx, 'code', codeToken)
      if (!claims)
        return grantError('the authorization code is invalid or expired')
      if (
        text(claims, 'cid') !== clientId ||
        text(claims, 'ru') !== redirectUri
      ) {
        return grantError(
          'the authorization code was issued for another client or redirect'
        )
      }
      // Spend the code before checking the verifier, so a stolen code allows
      // one guess, not many.
      if (!(await store.claim(`code:${claims.jti ?? ''}`, claims.exp ?? 0))) {
        return grantError('the authorization code was already used')
      }
      if (
        !VERIFIER_PATTERN.test(verifier) ||
        (await pkceChallenge(verifier)) !== text(claims, 'cc')
      ) {
        return grantError('the PKCE code_verifier does not match')
      }
      const subject = text(claims, 'sub') ?? ''
      if (subject.toLowerCase() !== owner.toLowerCase()) {
        return grantError('the authorization code is not for the owner')
      }
      return issueTokens(ctx, owner, clientId, deps.randomId())
    }

    if (grantType === 'refresh_token') {
      // REQ-MCP-31
      const refreshToken = params.get('refresh_token') ?? ''
      if (refreshToken === '') {
        return oauthError('invalid_request', 'refresh_token is required')
      }
      const claims = await openValue(deps, ctx, 'refresh', refreshToken)
      if (!claims) return grantError('the refresh token is invalid or expired')
      if (text(claims, 'cid') !== clientId) {
        return grantError('the refresh token was issued for another client')
      }
      const family = text(claims, 'fid') ?? ''
      const expiresAt = claims.exp ?? 0
      const revoked = `family:${family}`
      if (await store.has(revoked)) {
        return grantError('the refresh token was revoked')
      }
      if (!(await store.claim(`refresh:${claims.jti ?? ''}`, expiresAt))) {
        // A spent token came back: whoever holds the newer token in this
        // family may be a thief or the owner, so end the whole family. The
        // newest token in it was issued no later than now, so the revocation
        // lasts one full refresh lifetime from now, past that token's expiry.
        await store.claim(
          revoked,
          Math.floor(deps.now() / 1000) + REFRESH_TOKEN_SECONDS
        )
        return grantError('the refresh token was already used')
      }
      if ((text(claims, 'sub') ?? '').toLowerCase() !== owner.toLowerCase()) {
        return grantError('the refresh token is not for the owner')
      }
      return issueTokens(ctx, owner, clientId, family)
    }

    return oauthError(
      'unsupported_grant_type',
      'grant_type must be authorization_code or refresh_token'
    )
  }

  return {
    metadata,
    jwks,
    register,
    authorize,
    githubCallback,
    token,
    preflight: () => new Response(null, { status: 204, headers: CORS }),
  }
}

/**
 * Creates a self-contained authorization server. An injected store is used
 * when supplied; otherwise spent grants are kept in this server instance.
 */
export function createOAuthServer(
  overrides: Partial<OAuthDeps> = {}
): OAuthServer {
  return buildOAuthServer(overrides, false)
}

/**
 * Creates the hosted authorization server. Without an injected store it
 * requires the shared GitHub grant-store settings and fails closed.
 */
export function createHostedOAuthServer(
  overrides: Partial<OAuthDeps> = {}
): OAuthServer {
  return buildOAuthServer(overrides, true)
}

/**
 * The server the routes use. Production is multi-instance and therefore
 * requires the shared GitHub record. Local development and route tests are
 * one process, so they use the self-contained store unless one is injected.
 */
export const oauthServer =
  process.env.NODE_ENV === 'production'
    ? createHostedOAuthServer()
    : createOAuthServer()
