import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  checkRateLimit,
  getRequestIdentifier,
  createRateLimitResponse,
  addRateLimitHeaders,
  clearRateLimits,
  stopCleanup,
  RATE_LIMIT_CONFIGS,
} from '../rate-limiter'

describe('rate-limiter', () => {
  beforeEach(() => {
    clearRateLimits()
  })

  afterEach(() => {
    clearRateLimits()
  })

  describe('checkRateLimit', () => {
    it('allows requests within limit', () => {
      const config = { maxRequests: 5, windowMs: 60000 }
      const identifier = 'test-user'

      for (let i = 0; i < 5; i++) {
        const result = checkRateLimit(identifier, config)
        expect(result.allowed).toBe(true)
        expect(result.remaining).toBe(4 - i)
      }
    })

    it('blocks requests exceeding limit', () => {
      const config = { maxRequests: 3, windowMs: 60000 }
      const identifier = 'test-user'

      // Make 3 requests (should all be allowed)
      for (let i = 0; i < 3; i++) {
        const result = checkRateLimit(identifier, config)
        expect(result.allowed).toBe(true)
      }

      // 4th request should be blocked
      const blocked = checkRateLimit(identifier, config)
      expect(blocked.allowed).toBe(false)
      expect(blocked.remaining).toBe(0)
      expect(blocked.resetAt).toBeGreaterThan(Date.now())
    })

    it('uses sliding window (allows requests after time passes)', async () => {
      const config = { maxRequests: 2, windowMs: 100 }
      const identifier = 'test-user'

      // Make 2 requests
      checkRateLimit(identifier, config)
      checkRateLimit(identifier, config)

      // 3rd request should be blocked
      expect(checkRateLimit(identifier, config).allowed).toBe(false)

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 150))

      // Should be allowed again
      const result = checkRateLimit(identifier, config)
      expect(result.allowed).toBe(true)
    })

    it('isolates different identifiers', () => {
      const config = { maxRequests: 2, windowMs: 60000 }

      // User 1 makes 2 requests
      checkRateLimit('user-1', config)
      checkRateLimit('user-1', config)

      // User 1 should be blocked
      expect(checkRateLimit('user-1', config).allowed).toBe(false)

      // User 2 should still be allowed
      expect(checkRateLimit('user-2', config).allowed).toBe(true)
    })

    it('calculates correct resetAt timestamp', () => {
      const config = { maxRequests: 1, windowMs: 60000 }
      const identifier = 'test-user'

      const before = Date.now()
      const result = checkRateLimit(identifier, config)
      const after = Date.now()

      expect(result.resetAt).toBeGreaterThanOrEqual(before + config.windowMs)
      expect(result.resetAt).toBeLessThanOrEqual(after + config.windowMs + 10) // Allow 10ms tolerance
    })
  })

  describe('getRequestIdentifier', () => {
    it('extracts IP from x-forwarded-for header', () => {
      const request = new Request('http://localhost', {
        headers: {
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
        },
      })

      expect(getRequestIdentifier(request)).toBe('192.168.1.1')
    })

    it('extracts IP from x-real-ip header', () => {
      const request = new Request('http://localhost', {
        headers: {
          'x-real-ip': '192.168.1.2',
        },
      })

      expect(getRequestIdentifier(request)).toBe('192.168.1.2')
    })

    it('extracts IP from cf-connecting-ip header (CloudFlare)', () => {
      const request = new Request('http://localhost', {
        headers: {
          'cf-connecting-ip': '192.168.1.3',
        },
      })

      expect(getRequestIdentifier(request)).toBe('192.168.1.3')
    })

    it('prioritizes x-forwarded-for over other headers', () => {
      const request = new Request('http://localhost', {
        headers: {
          'x-forwarded-for': '192.168.1.1',
          'x-real-ip': '192.168.1.2',
          'cf-connecting-ip': '192.168.1.3',
        },
      })

      expect(getRequestIdentifier(request)).toBe('192.168.1.1')
    })

    it('falls back to unknown when no IP headers present', () => {
      const request = new Request('http://localhost')
      expect(getRequestIdentifier(request)).toBe('unknown')
    })
  })

  describe('createRateLimitResponse', () => {
    it('creates 429 response with correct structure', async () => {
      const resetAt = Date.now() + 60000
      const response = createRateLimitResponse(resetAt)

      expect(response.status).toBe(429)
      expect(response.headers.get('Content-Type')).toBe('application/json')

      const body = (await response.json()) as {
        error: string
        message: string
        retryAfter: number
      }
      expect(body.error).toBe('Too many requests')
      expect(body.retryAfter).toBeGreaterThan(0)
    })

    it('sets Retry-After header', () => {
      const resetAt = Date.now() + 30000
      const response = createRateLimitResponse(resetAt)

      const retryAfter = response.headers.get('Retry-After')
      expect(retryAfter).toBeTruthy()
      expect(parseInt(retryAfter ?? '0')).toBeGreaterThan(0)
    })

    it('sets X-RateLimit-Reset header', () => {
      const resetAt = Date.now() + 60000
      const response = createRateLimitResponse(resetAt)

      const resetHeader = response.headers.get('X-RateLimit-Reset')
      expect(resetHeader).toBeTruthy()
      expect(new Date(resetHeader ?? '').getTime()).toBeCloseTo(resetAt, -2)
    })
  })

  describe('addRateLimitHeaders', () => {
    it('adds rate limit headers to response', () => {
      const original = new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
      const resetAt = Date.now() + 60000
      const remaining = 42

      const enhanced = addRateLimitHeaders(original, remaining, resetAt)

      expect(enhanced.status).toBe(200)
      expect(enhanced.headers.get('Content-Type')).toBe('application/json')
      expect(enhanced.headers.get('X-RateLimit-Remaining')).toBe('42')
      expect(enhanced.headers.get('X-RateLimit-Reset')).toBeTruthy()
    })

    it('preserves original response body', async () => {
      const original = new Response(JSON.stringify({ data: 'test' }))
      const enhanced = addRateLimitHeaders(original, 10, Date.now() + 60000)

      const body = (await enhanced.json()) as { data: string }
      expect(body.data).toBe('test')
    })
  })

  describe('RATE_LIMIT_CONFIGS', () => {
    it('has different limits for different route types', () => {
      expect(RATE_LIMIT_CONFIGS.ai.maxRequests).toBeLessThan(
        RATE_LIMIT_CONFIGS.api.maxRequests
      )
      expect(RATE_LIMIT_CONFIGS.payment.maxRequests).toBeLessThan(
        RATE_LIMIT_CONFIGS.api.maxRequests
      )
    })

    it('all configs have required properties', () => {
      const types: Array<keyof typeof RATE_LIMIT_CONFIGS> = [
        'ai',
        'api',
        'payment',
      ]

      types.forEach(type => {
        expect(RATE_LIMIT_CONFIGS[type].maxRequests).toBeGreaterThan(0)
        expect(RATE_LIMIT_CONFIGS[type].windowMs).toBeGreaterThan(0)
      })
    })
  })

  describe('clearRateLimits', () => {
    it('clears all rate limit records', () => {
      const config = { maxRequests: 1, windowMs: 60000 }

      // Make requests to populate store
      checkRateLimit('user-1', config)
      checkRateLimit('user-2', config)

      // Both should be at limit
      expect(checkRateLimit('user-1', config).allowed).toBe(false)
      expect(checkRateLimit('user-2', config).allowed).toBe(false)

      // Clear and verify
      clearRateLimits()
      expect(checkRateLimit('user-1', config).allowed).toBe(true)
      expect(checkRateLimit('user-2', config).allowed).toBe(true)
    })
  })

  describe('stopCleanup', () => {
    it('stops cleanup interval without throwing', () => {
      expect(() => stopCleanup()).not.toThrow()
    })
  })
})
