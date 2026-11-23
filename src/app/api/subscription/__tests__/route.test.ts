import { afterEach, describe, expect, it, vi } from 'vitest'

const getUser = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}))

import { GET } from '../route'

describe('GET /api/subscription', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('rejects an unauthenticated request', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } })

    const response = await GET(new Request('http://localhost/api/subscription'))

    expect(response.status).toBe(401)
  })

  it('returns the local free summary for an authenticated user', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } })

    const response = await GET(new Request('http://localhost/api/subscription'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ tier: 'free' })
  })
})
