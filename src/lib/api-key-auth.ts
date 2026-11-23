import type { NextRequest } from 'next/server'
import { logger } from './logger'

// ---------------------------------------------------------------------------
// Bearer-token auth for the public /api/v1/* routes.
//
// FAILS CLOSED. When API_ACCESS_KEYS is unset the route rejects every request
// rather than serving the engine unauthenticated. A deploy that forgets the env
// var must break loudly, not silently become public — see CLAUDE.md, "Failures
// must be visible and actionable. Avoid silent fallbacks."
//
// For local development set ALLOW_UNAUTHENTICATED_API=true to opt in explicitly.
// That opt-in is ignored in production so it can never be the reason a live
// deployment is open.
// ---------------------------------------------------------------------------

export type ApiKeyAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string }

function parseConfiguredKeys(): string[] {
  return (process.env.API_ACCESS_KEYS ?? '')
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0)
}

/**
 * Constant-time-ish comparison to avoid leaking key length/prefix via timing.
 * Not a substitute for a real HMAC scheme, but strictly better than `includes`.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

export function authenticateApiKey(req: NextRequest): ApiKeyAuthResult {
  const configuredKeys = parseConfiguredKeys()

  if (configuredKeys.length === 0) {
    const devOptIn =
      process.env.ALLOW_UNAUTHENTICATED_API === 'true' &&
      process.env.NODE_ENV !== 'production'

    if (devOptIn) return { ok: true }

    logger.error(
      'API_ACCESS_KEYS is not configured; rejecting request to a public v1 route. ' +
        'Set API_ACCESS_KEYS, or set ALLOW_UNAUTHENTICATED_API=true for local development.'
    )
    return {
      ok: false,
      status: 503,
      error: 'API access is not configured on this server.',
    }
  }

  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      ok: false,
      status: 401,
      error: 'Unauthorized. Provide a valid Bearer token.',
    }
  }

  const presented = authHeader.slice(7).trim()
  const matches = configuredKeys.some(key => timingSafeEquals(key, presented))

  return matches
    ? { ok: true }
    : {
        ok: false,
        status: 401,
        error: 'Unauthorized. Provide a valid Bearer token.',
      }
}
