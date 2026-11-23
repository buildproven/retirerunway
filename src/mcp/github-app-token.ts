// Installation access tokens for the GitHub App that reads and writes the
// owner's data repo (REQ-STORE-APP-1..5, BUI-1917). The flow is GitHub's
// "Generating an installation access token for a GitHub App":
//
//   1. sign an RS256 JWT with the app's private key (iss = the app ID or
//      client ID, iat 60 s in the past, exp at most 10 minutes ahead);
//   2. GET /repos/{owner}/{repo}/installation with that JWT for the
//      installation ID on the data repo (404: the app is not installed there);
//   3. POST /app/installations/{id}/access_tokens with `repositories` narrowed
//      to the data repo; GitHub answers 201 with `token` and `expires_at`
//      (one hour).
//
// A token is reused while more than 5 minutes of it are left, then a new one
// is minted. The cache is per process and keyed by app, repo and key, so the
// git store and the spent-grant record share one token. The token is used as
// GitHub returns it: its length and format are not checked, since GitHub may
// change them (the `ghs_APPID_JWT` format). Error text never holds the JWT,
// the token or the key.
import { createHash, createPrivateKey } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { SignJWT } from 'jose'

export const APP_ID_ENV = 'RETIRE_RUNWAY_GITHUB_APP_ID'
export const APP_KEY_ENV = 'RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY'
const REPO_ENV = 'RETIRE_RUNWAY_DATA_REPO'

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
/** A cached token is reused only while more than this is left of it. */
export const REUSE_MARGIN_MS = 5 * 60 * 1000
// GitHub refuses an app JWT whose exp is over 10 minutes ahead and advises an
// iat 60 seconds in the past against clock drift.
const JWT_BACKDATE_SECONDS = 60
const JWT_AHEAD_SECONDS = 9 * 60
const TIMEOUT_MS = 10_000
const DETAIL_LIMIT = 200

/** A token failure, with the setting the owner should check. */
export class GitHubAppTokenError extends Error {
  override readonly name = 'GitHubAppTokenError'

  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
  }
}

/** Tokens for one repo. */
export interface TokenSource {
  /** A token for the data repo, cached or newly minted. */
  token(): Promise<string>
  /** Drops `token` from the cache after GitHub refused it (a 401). */
  forget(token: string): void
}

/** The part of a fetch Response read here. A Response satisfies it. */
interface FetchReply {
  readonly status?: number
  readonly ok?: boolean
  readonly text?: () => Promise<string>
  readonly json?: () => Promise<unknown>
}

type AppFetch = (input: string, init: RequestInit) => Promise<FetchReply>

interface Minted {
  readonly token: string
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

interface Entry {
  readonly pending: Promise<Minted>
  minted?: Minted
}

/** Minted tokens, keyed by app, repo and key. */
export type TokenCache = Map<string, Entry>

const processCache: TokenCache = new Map()

export interface AppTokenOptions {
  /** The app ID or client ID, the JWT issuer. */
  readonly appId: string
  /** The app's private key, PEM (PKCS#1 or PKCS#8); `\n` escapes allowed. */
  readonly privateKey: string
  /** `owner/repo` of the data repo, the only repo the token may reach. */
  readonly repo: string
  readonly fetch?: AppFetch
  /** Milliseconds since the epoch. */
  readonly now?: () => number
  /** By default one cache for the process. */
  readonly cache?: TokenCache
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The key as PEM; an env value often holds `\n` escapes for its newlines. */
function pemText(text: string): string {
  const trimmed = text.trim()
  return trimmed.includes('\n') ? trimmed : trimmed.replace(/\\n/g, '\n')
}

function loadKey(text: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey(pemText(text))
  } catch {
    throw new GitHubAppTokenError(
      APP_KEY_ENV,
      `${APP_KEY_ENV} is not a PEM private key; paste the .pem file the GitHub App settings page generated`
    )
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new GitHubAppTokenError(
      APP_KEY_ENV,
      `${APP_KEY_ENV} must be the GitHub App's RSA private key, got a ${key.asymmetricKeyType ?? 'non-asymmetric'} key`
    )
  }
  return key
}

async function readBody(reply: FetchReply): Promise<unknown> {
  if (typeof reply.text === 'function') {
    const text = await reply.text()
    if (text === '') return undefined
    try {
      return JSON.parse(text)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return text
    }
  }
  if (typeof reply.json === 'function') return reply.json()
  return undefined
}

function statusOf(reply: FetchReply): number {
  if (typeof reply.status === 'number') return reply.status
  return reply.ok === true ? 200 : 500
}

function detail(body: unknown): string {
  const message =
    isRecord(body) && typeof body.message === 'string'
      ? body.message
      : typeof body === 'string'
        ? body
        : ''
  const flat = message.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return ` (${flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT)}…` : flat})`
}

/** The source of installation tokens for `options.repo`. */
export function createAppTokenSource(options: AppTokenOptions): TokenSource {
  const { appId, privateKey, repo } = options
  const fetchImpl: AppFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const now = options.now ?? (() => Date.now())
  const cache = options.cache ?? processCache
  const key = createHash('sha256')
    .update(`${appId}\0${repo}\0${privateKey}`)
    .digest('hex')
  const [, repoName] = repo.split('/')
  let signingKey: KeyObject | undefined

  const notInstalled = (): GitHubAppTokenError =>
    new GitHubAppTokenError(
      REPO_ENV,
      `the GitHub App ${appId} is not installed on ${repo}: install the app on ${repo} (the app's settings page → Install App, or Settings → Applications → Installed GitHub Apps → Configure → Repository access → add ${repo}), then call again`
    )

  async function appJwt(): Promise<string> {
    signingKey ??= loadKey(privateKey)
    const seconds = Math.floor(now() / 1000)
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(appId)
      .setIssuedAt(seconds - JWT_BACKDATE_SECONDS)
      .setExpirationTime(seconds + JWT_AHEAD_SECONDS)
      .sign(signingKey)
  }

  async function call(
    method: 'GET' | 'POST',
    url: string,
    jwt: string,
    body?: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }> {
    try {
      const reply = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'retire-runway-mcp',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      return { status: statusOf(reply), body: await readBody(reply) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new GitHubAppTokenError(
        APP_ID_ENV,
        `could not reach GitHub to get a token for ${repo} (${reason.split(jwt).join('[redacted]')})`
      )
    }
  }

  function refused(status: number, step: string, body: unknown): never {
    if (status === 401) {
      throw new GitHubAppTokenError(
        APP_KEY_ENV,
        `GitHub refused the app JWT (401) ${step}; check that ${APP_ID_ENV} and ${APP_KEY_ENV} belong to one GitHub App and that the server clock is right`
      )
    }
    throw new GitHubAppTokenError(
      APP_ID_ENV,
      `GitHub returned ${status} ${step}${detail(body)}`
    )
  }

  async function mint(): Promise<Minted> {
    const jwt = await appJwt()
    const installation = await call(
      'GET',
      `${API}/repos/${repo}/installation`,
      jwt
    )
    if (installation.status === 404) throw notInstalled()
    if (installation.status < 200 || installation.status >= 300) {
      refused(
        installation.status,
        `looking up the app installation on ${repo}`,
        installation.body
      )
    }
    const id = isRecord(installation.body) ? installation.body.id : undefined
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new GitHubAppTokenError(
        APP_ID_ENV,
        `GitHub answered the installation lookup on ${repo} with no installation ID`
      )
    }
    const issued = await call(
      'POST',
      `${API}/app/installations/${id}/access_tokens`,
      jwt,
      { repositories: [repoName] }
    )
    if (issued.status === 404) throw notInstalled()
    if (issued.status < 200 || issued.status >= 300) {
      refused(issued.status, `creating a token for ${repo}`, issued.body)
    }
    const token = isRecord(issued.body) ? issued.body.token : undefined
    const expires = isRecord(issued.body) ? issued.body.expires_at : undefined
    const expiresAt = typeof expires === 'string' ? Date.parse(expires) : NaN
    if (typeof token !== 'string' || token === '' || Number.isNaN(expiresAt)) {
      throw new GitHubAppTokenError(
        APP_ID_ENV,
        `GitHub answered the token request for ${repo} with no token or expiry`
      )
    }
    return { token, expiresAt }
  }

  /** Starts one mint that callers share; a failed one leaves the cache. */
  function start(): Entry {
    const entry: Entry = {
      pending: mint().then(minted => {
        entry.minted = minted
        return minted
      }),
    }
    cache.set(key, entry)
    entry.pending.then(
      () => undefined,
      () => {
        if (cache.get(key) === entry) cache.delete(key)
      }
    )
    return entry
  }

  return {
    async token() {
      const cached = cache.get(key)
      if (cached !== undefined) {
        const minted = await cached.pending
        if (minted.expiresAt - now() > REUSE_MARGIN_MS) return minted.token
        if (cache.get(key) === cached) cache.delete(key)
      }
      // Another caller may have started a new mint meanwhile; share it.
      const entry = cache.get(key) ?? start()
      return (await entry.pending).token
    },
    forget(token) {
      const entry = cache.get(key)
      if (entry?.minted?.token === token) cache.delete(key)
    },
  }
}
