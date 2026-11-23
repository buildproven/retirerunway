import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { withRateLimit } from '../with-rate-limit'
import { clearRateLimits } from '../rate-limiter'

describe('withRateLimit', () => {
  beforeEach(() => {
    clearRateLimits()
  })

  afterEach(() => {
    clearRateLimits()
  })

  it('allows requests within rate limit', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    const wrappedHandler = withRateLimit(handler, 'api')
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    const response = await wrappedHandler(request)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { success: boolean }
    expect(body.success).toBe(true)
  })

  it('adds rate limit headers to successful response', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withRateLimit(handler, 'api')
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    const response = await wrappedHandler(request)

    expect(response.headers.get('X-RateLimit-Remaining')).toBeTruthy()
    expect(response.headers.get('X-RateLimit-Reset')).toBeTruthy()
  })

  it('returns 429 when rate limit exceeded', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withRateLimit(handler, 'payment') // 10 requests/min
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    // Make 10 requests (should all succeed)
    for (let i = 0; i < 10; i++) {
      const response = await wrappedHandler(request)
      expect(response.status).toBe(200)
    }

    // 11th request should be rate limited
    const blockedResponse = await wrappedHandler(request)
    expect(blockedResponse.status).toBe(429)

    const body = (await blockedResponse.json()) as { error: string }
    expect(body.error).toBe('Too many requests')
  })

  it('includes retry-after header in rate limit response', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withRateLimit(handler, 'payment')
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    // Exhaust rate limit
    for (let i = 0; i < 10; i++) {
      await wrappedHandler(request)
    }

    const blockedResponse = await wrappedHandler(request)
    expect(blockedResponse.headers.get('Retry-After')).toBeTruthy()
    expect(blockedResponse.headers.get('X-RateLimit-Reset')).toBeTruthy()
  })

  it('uses different limits for different route types', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const aiHandler = withRateLimit(handler, 'ai') // 20 requests/min
    const apiHandler = withRateLimit(handler, 'api') // 100 requests/min

    const aiRequest = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })
    const apiRequest = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.2' },
    })

    // Make 20 AI requests (should exhaust AI limit)
    for (let i = 0; i < 20; i++) {
      const response = await aiHandler(aiRequest)
      expect(response.status).toBe(200)
    }

    // 21st AI request should be blocked
    const blockedAi = await aiHandler(aiRequest)
    expect(blockedAi.status).toBe(429)

    // API requests from different IP should still work (higher limit)
    const apiResponse = await apiHandler(apiRequest)
    expect(apiResponse.status).toBe(200)
  })

  it('isolates rate limits by IP address', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withRateLimit(handler, 'payment')

    const request1 = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })
    const request2 = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.2' },
    })

    // Exhaust limit for first IP
    for (let i = 0; i < 10; i++) {
      await wrappedHandler(request1)
    }

    // First IP should be blocked
    const blocked = await wrappedHandler(request1)
    expect(blocked.status).toBe(429)

    // Second IP should still be allowed
    const allowed = await wrappedHandler(request2)
    expect(allowed.status).toBe(200)
  })

  it('passes through handler errors', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
      })
    }

    const wrappedHandler = withRateLimit(handler, 'api')
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    const response = await wrappedHandler(request)
    expect(response.status).toBe(500)

    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('Internal error')
  })

  it('handles handler that throws exception', async () => {
    const handler = async () => {
      throw new Error('Handler crashed')
    }

    const wrappedHandler = withRateLimit(handler, 'api')
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    await expect(wrappedHandler(request)).rejects.toThrow('Handler crashed')
  })

  it('decrements remaining counter correctly', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withRateLimit(handler, 'payment') // 10 requests
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    // First request
    const response1 = await wrappedHandler(request)
    expect(response1.headers.get('X-RateLimit-Remaining')).toBe('9')

    // Second request
    const response2 = await wrappedHandler(request)
    expect(response2.headers.get('X-RateLimit-Remaining')).toBe('8')

    // Third request
    const response3 = await wrappedHandler(request)
    expect(response3.headers.get('X-RateLimit-Remaining')).toBe('7')
  })

  it('uses api limit by default', async () => {
    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withRateLimit(handler) // No type specified
    const request = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    })

    const response = await wrappedHandler(request)
    expect(response.status).toBe(200)
    expect(response.headers.get('X-RateLimit-Remaining')).toBeTruthy()
  })
})
