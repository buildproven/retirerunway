import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getUser = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}))
vi.mock('@/lib/email', () => ({ sendOnboardingEmail: vi.fn() }))

import { POST } from '../route'

describe('POST /api/email/send-onboarding', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('rejects an unauthenticated request', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } })
    const response = await POST(
      new NextRequest('http://localhost/api/email/send-onboarding', {
        method: 'POST',
        body: '{}',
      })
    )

    expect(response.status).toBe(401)
  })

  it('validates the request after authentication succeeds', async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: 'user-1', email: 'user@example.com' } },
    })
    const response = await POST(
      new NextRequest('http://localhost/api/email/send-onboarding', {
        method: 'POST',
        body: JSON.stringify({ email: 'other@example.com', type: 'welcome' }),
      })
    )

    expect(response.status).toBe(403)
  })
})
