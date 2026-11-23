// Token check for the hosted MCP entry (REQ-MCP-22..26, BUI-1856). The entry
// is an OAuth 2.0 resource server: it accepts only a JWT access token that the
// configured issuer signed (keys from its JWKS URL), issued for this server's
// MCP URL (`aud`, RFC 8707), unexpired, and whose subject is the owner. It
// never issues tokens; sign-in belongs to the authorization server.
import type { AuthInfo } from '@modelcontextprotocol/server'
import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import type { JWTPayload } from 'jose'

export const ISSUER_ENV = 'RETIRE_RUNWAY_OAUTH_ISSUER'
export const JWKS_URL_ENV = 'RETIRE_RUNWAY_OAUTH_JWKS_URL'
export const OWNER_SUBJECT_ENV = 'RETIRE_RUNWAY_OWNER_SUBJECT'

const AUTH_ENV = [ISSUER_ENV, JWKS_URL_ENV, OWNER_SUBJECT_ENV] as const
type AuthEnvName = (typeof AUTH_ENV)[number]

/** Path of the MCP endpoint, the protected resource. */
export const MCP_PATH = '/api/mcp'
/** Path of the RFC 9728 protected resource metadata document. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource'

// Asymmetric algorithms only: a symmetric (HS*) token would need a shared
// secret, and allowing one invites algorithm-confusion attacks.
const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA', 'Ed25519']

type Env = Readonly<Record<string, string | undefined>>

export interface AuthConfig {
  /** Issuer identifier, compared exactly with the token `iss`. */
  readonly issuer: string
  readonly jwksUrl: URL
  /** The one token subject (`sub`) the server serves. */
  readonly ownerSubject: string
}

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response }

/** The MCP URL and metadata URL of the deployment that serves `request`. */
export function resourceUrls(request: Request): {
  readonly mcpUrl: string
  readonly metadataUrl: string
} {
  const { origin } = new URL(request.url)
  return {
    mcpUrl: `${origin}${MCP_PATH}`,
    metadataUrl: `${origin}${RESOURCE_METADATA_PATH}`,
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  )
}

/** An https URL, or http on a loopback host for local development. */
function secureUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url
  return undefined
}

function configError(
  missing: readonly string[],
  invalid: readonly string[]
): Response {
  const parts = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : '',
    invalid.length > 0 ? `not an https URL: ${invalid.join(', ')}` : '',
  ].filter(part => part !== '')
  return Response.json(
    {
      error: 'server_error',
      error_description: `MCP OAuth configuration: ${parts.join('; ')}`,
      missing,
      invalid,
    },
    { status: 500 }
  )
}

/**
 * Reads `names` from `env`. Answers a 500 naming each variable that is unset
 * or blank, and each URL variable that is not a secure URL.
 */
function readEnv(
  env: Env,
  names: readonly AuthEnvName[]
): Checked<Partial<Record<AuthEnvName, string>>> {
  const values: Partial<Record<AuthEnvName, string>> = {}
  const missing: string[] = []
  const invalid: string[] = []
  for (const name of names) {
    const value = (env[name] ?? '').trim()
    if (value === '') missing.push(name)
    else if (name !== OWNER_SUBJECT_ENV && secureUrl(value) === undefined)
      invalid.push(name)
    else values[name] = value
  }
  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, response: configError(missing, invalid) }
  }
  return { ok: true, value: values }
}

/**
 * The issuer without trailing slashes: the form the authorization server
 * (src/mcp/oauth-server.ts) signs as `iss` and publishes, so `https://x/` and
 * `https://x` name one issuer and a trailing slash in the setting does not
 * reject every token.
 */
function normalIssuer(value: string): string {
  return value.replace(/\/+$/, '')
}

/** The configured issuer, for the metadata document. */
export function readIssuer(env: Env = process.env): Checked<string> {
  const read = readEnv(env, [ISSUER_ENV])
  if (!read.ok) return read
  return { ok: true, value: normalIssuer(read.value[ISSUER_ENV] ?? '') }
}

/** Everything the token check needs, or a 500 naming what is wrong. */
export function readAuthConfig(env: Env = process.env): Checked<AuthConfig> {
  const read = readEnv(env, AUTH_ENV)
  if (!read.ok) return read
  return {
    ok: true,
    value: {
      issuer: normalIssuer(read.value[ISSUER_ENV] ?? ''),
      jwksUrl: new URL(read.value[JWKS_URL_ENV] ?? ''),
      ownerSubject: read.value[OWNER_SUBJECT_ENV] ?? '',
    },
  }
}

// One remote key set per JWKS URL, so keys are fetched once and cached
// across requests (jose refetches on an unknown key ID).
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function keySet(url: URL): ReturnType<typeof createRemoteJWKSet> {
  const existing = keySets.get(url.href)
  if (existing) return existing
  const created = createRemoteJWKSet(url)
  keySets.set(url.href, created)
  return created
}

/** The 401 that starts sign-in (RFC 9728 §5.1). */
function challenge(metadataUrl: string): Response {
  return Response.json(
    {
      error: 'invalid_token',
      error_description: 'a valid bearer access token is required',
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}"`,
      },
    }
  )
}

// jose errors that mean the token itself is bad. Any other failure (the key
// set cannot be fetched or parsed) is the server's problem, not the caller's.
const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
]

function isTokenError(error: unknown): boolean {
  return TOKEN_ERRORS.some(type => error instanceof type)
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)[ ]*$/i.exec(header)
  return match?.[1]
}

function authInfo(
  token: string,
  payload: JWTPayload,
  mcpUrl: string
): AuthInfo {
  const scope = typeof payload.scope === 'string' ? payload.scope : ''
  const clientId =
    typeof payload.client_id === 'string'
      ? payload.client_id
      : typeof payload.azp === 'string'
        ? payload.azp
        : ''
  return {
    token,
    clientId,
    scopes: scope.split(' ').filter(item => item !== ''),
    expiresAt: payload.exp,
    resource: new URL(mcpUrl),
    extra: { subject: payload.sub },
  }
}

/**
 * Checks the request's bearer token. Resolves to the token's AuthInfo for the
 * owner, else to the response to send: 500 (configuration), 401 (no valid
 * token, with the metadata challenge), 403 (another subject) or 502 (the
 * issuer's keys could not be loaded).
 */
export async function authorizeMcpRequest(
  request: Request,
  env: Env = process.env
): Promise<Checked<AuthInfo>> {
  const config = readAuthConfig(env)
  if (!config.ok) return config
  const { issuer, jwksUrl, ownerSubject } = config.value
  const { mcpUrl, metadataUrl } = resourceUrls(request)

  const token = bearerToken(request)
  if (token === undefined) {
    return { ok: false, response: challenge(metadataUrl) }
  }

  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(token, keySet(jwksUrl), {
      issuer,
      audience: mcpUrl,
      algorithms: ALGORITHMS,
      requiredClaims: ['sub', 'exp'],
    }))
  } catch (error) {
    if (isTokenError(error)) {
      return { ok: false, response: challenge(metadataUrl) }
    }
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      response: Response.json(
        {
          error: 'server_error',
          error_description: `could not load the issuer signing keys from ${jwksUrl.href}: ${detail}`,
        },
        { status: 502 }
      ),
    }
  }

  if (payload.sub !== ownerSubject) {
    return {
      ok: false,
      response: Response.json(
        {
          error: 'access_denied',
          error_description:
            'this server serves only its owner: sign in with the owner account',
        },
        { status: 403 }
      ),
    }
  }
  return { ok: true, value: authInfo(token, payload, mcpUrl) }
}
