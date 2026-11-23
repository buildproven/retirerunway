import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getAuthenticatedUserId,
  withAuth,
  type AuthenticatedRequest,
} from '../with-auth'
import type { User } from '@supabase/supabase-js'

// Mock Supabase client
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

describe('withAuth', () => {
  const mockUser: User = {
    id: 'user-123',
    email: 'test@example.com',
    aud: 'authenticated',
    role: 'authenticated',
    created_at: '2024-01-01T00:00:00Z',
    app_metadata: {},
    user_metadata: {},
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads a valid attached id and fails closed for malformed requests', () => {
    const authenticated = new Request('http://localhost')
    Object.defineProperty(authenticated, 'user', { value: { id: 'user-123' } })
    expect(getAuthenticatedUserId(authenticated)).toBe('user-123')
    expect(
      getAuthenticatedUserId(new Request('http://localhost'))
    ).toBeUndefined()

    const malformed = new Request('http://localhost')
    Object.defineProperty(malformed, 'user', { value: { id: '' } })
    expect(getAuthenticatedUserId(malformed)).toBeUndefined()
  })

  it('allows authenticated requests', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: mockUser },
          error: null,
        }),
      },
    } as never)

    const handler = async (request: Request) => {
      const authRequest = request as AuthenticatedRequest
      return new Response(
        JSON.stringify({ userId: authRequest.user.id, success: true }),
        { status: 200 }
      )
    }

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    const response = await wrappedHandler(request)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { userId: string; success: boolean }
    expect(body.userId).toBe('user-123')
    expect(body.success).toBe(true)
  })

  it('attaches user to request object', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: mockUser },
          error: null,
        }),
      },
    } as never)

    let capturedUser: User | undefined

    const handler = async (request: Request) => {
      const authRequest = request as AuthenticatedRequest
      capturedUser = authRequest.user
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    await wrappedHandler(request)

    expect(capturedUser).toBeDefined()
    expect(capturedUser?.id).toBe('user-123')
    expect(capturedUser?.email).toBe('test@example.com')
  })

  it('returns 401 when user is not authenticated', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
    } as never)

    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    const response = await wrappedHandler(request)
    expect(response.status).toBe(401)

    const body = (await response.json()) as { error: string; message: string }
    expect(body.error).toBe('Unauthorized')
    expect(body.message).toBe('Authentication required')
  })

  it('returns 401 when authentication error occurs', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: { message: 'Invalid token', name: 'AuthError', status: 401 },
        }),
      },
    } as never)

    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    const response = await wrappedHandler(request)
    expect(response.status).toBe(401)

    const body = (await response.json()) as { error: string; details: string }
    expect(body.error).toBe('Authentication failed')
    expect(body.details).toBe('Invalid token')
  })

  it('returns 503 when Supabase server configuration is missing', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    const error = Object.assign(
      new Error('Supabase server configuration is missing'),
      { code: 'SUPABASE_CONFIGURATION_ERROR' }
    )
    vi.mocked(createClient).mockRejectedValueOnce(error)

    const wrappedHandler = withAuth(async () => new Response('unexpected'))
    const response = await wrappedHandler(new Request('http://localhost'))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Authentication service is not configured',
    })
  })

  it('propagates errors from createClient', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockRejectedValue(new Error('Database error'))

    const handler = async () => {
      return new Response(JSON.stringify({ success: true }))
    }

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    await expect(wrappedHandler(request)).rejects.toThrow('Database error')
  })

  it('handler is not called when authentication fails', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
    } as never)

    const handler = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true })))

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    await wrappedHandler(request)

    expect(handler).not.toHaveBeenCalled()
  })

  it('passes through handler errors', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: mockUser },
          error: null,
        }),
      },
    } as never)

    const handler = async () => {
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
      })
    }

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    const response = await wrappedHandler(request)
    expect(response.status).toBe(500)

    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('Internal error')
  })

  it('passes through handler exceptions', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: mockUser },
          error: null,
        }),
      },
    } as never)

    const handler = async () => {
      throw new Error('Handler crashed')
    }

    const wrappedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    await expect(wrappedHandler(request)).rejects.toThrow('Handler crashed')
  })

  it('works with multiple authenticated users', async () => {
    const { createClient } = await import('@/lib/supabase/server')

    const user1: User = {
      ...mockUser,
      id: 'user-1',
      email: 'user1@example.com',
    }
    const user2: User = {
      ...mockUser,
      id: 'user-2',
      email: 'user2@example.com',
    }

    const handler = async (request: Request) => {
      const authRequest = request as AuthenticatedRequest
      return new Response(
        JSON.stringify({
          userId: authRequest.user.id,
          email: authRequest.user.email,
        })
      )
    }

    const wrappedHandler = withAuth(handler)

    // First user request
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: user1 },
          error: null,
        }),
      },
    } as never)

    const request1 = new Request('http://localhost')
    const response1 = await wrappedHandler(request1)
    const body1 = (await response1.json()) as {
      userId: string
      email: string
    }

    expect(body1.userId).toBe('user-1')
    expect(body1.email).toBe('user1@example.com')

    // Second user request
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: user2 },
          error: null,
        }),
      },
    } as never)

    const request2 = new Request('http://localhost')
    const response2 = await wrappedHandler(request2)
    const body2 = (await response2.json()) as {
      userId: string
      email: string
    }

    expect(body2.userId).toBe('user-2')
    expect(body2.email).toBe('user2@example.com')
  })

  it('works with compose function from withValidation', async () => {
    const { createClient } = await import('@/lib/supabase/server')
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: mockUser },
          error: null,
        }),
      },
    } as never)

    const handler = async (request: Request) => {
      const authRequest = request as AuthenticatedRequest
      return new Response(JSON.stringify({ userId: authRequest.user.id }))
    }

    const composedHandler = withAuth(handler)
    const request = new Request('http://localhost')

    const response = await composedHandler(request)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { userId: string }
    expect(body.userId).toBe('user-123')
  })
})
