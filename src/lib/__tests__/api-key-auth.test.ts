import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { authenticateApiKey } from '../api-key-auth'

vi.mock('../logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

function request(authorization?: string): NextRequest {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'authorization' ? (authorization ?? null) : null,
    },
  } as unknown as NextRequest
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  delete process.env.API_ACCESS_KEYS
  delete process.env.ALLOW_UNAUTHENTICATED_API
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('authenticateApiKey', () => {
  describe('when API_ACCESS_KEYS is not configured', () => {
    it('fails closed with 503 rather than allowing access', () => {
      const result = authenticateApiKey(request('Bearer anything'))
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ status: 503 })
    })

    it('fails closed even when no token is presented', () => {
      expect(authenticateApiKey(request()).ok).toBe(false)
    })

    it('treats an empty / whitespace-only value as unconfigured', () => {
      process.env.API_ACCESS_KEYS = '  , ,'
      const result = authenticateApiKey(request('Bearer anything'))
      expect(result).toMatchObject({ ok: false, status: 503 })
    })

    it('allows access only with an explicit non-production dev opt-in', () => {
      process.env.ALLOW_UNAUTHENTICATED_API = 'true'
      vi.stubEnv('NODE_ENV', 'development')
      expect(authenticateApiKey(request()).ok).toBe(true)
      vi.unstubAllEnvs()
    })

    it('ignores the dev opt-in in production', () => {
      process.env.ALLOW_UNAUTHENTICATED_API = 'true'
      vi.stubEnv('NODE_ENV', 'production')
      const result = authenticateApiKey(request('Bearer anything'))
      expect(result).toMatchObject({ ok: false, status: 503 })
      vi.unstubAllEnvs()
    })
  })

  describe('when API_ACCESS_KEYS is configured', () => {
    beforeEach(() => {
      process.env.API_ACCESS_KEYS = 'key-one,key-two'
    })

    it('accepts a configured key', () => {
      expect(authenticateApiKey(request('Bearer key-one')).ok).toBe(true)
      expect(authenticateApiKey(request('Bearer key-two')).ok).toBe(true)
    })

    it('rejects an unknown key with 401', () => {
      const result = authenticateApiKey(request('Bearer wrong-key'))
      expect(result).toMatchObject({ ok: false, status: 401 })
    })

    it('rejects a missing Authorization header with 401', () => {
      expect(authenticateApiKey(request())).toMatchObject({
        ok: false,
        status: 401,
      })
    })

    it('rejects a non-Bearer scheme', () => {
      expect(authenticateApiKey(request('Basic key-one')).ok).toBe(false)
    })

    it('rejects a key that is only a prefix of a valid key', () => {
      expect(authenticateApiKey(request('Bearer key-o')).ok).toBe(false)
    })

    it('tolerates surrounding whitespace in configuration and header', () => {
      process.env.API_ACCESS_KEYS = ' key-one , key-two '
      expect(authenticateApiKey(request('Bearer  key-one  ')).ok).toBe(true)
    })
  })
})
