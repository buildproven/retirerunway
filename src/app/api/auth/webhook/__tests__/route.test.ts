import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/email', () => ({ sendOnboardingEmail: vi.fn() }))

import { POST } from '../route'
import { sendOnboardingEmail } from '@/lib/email'

describe('POST /api/auth/webhook', () => {
  beforeEach(() => vi.mocked(sendOnboardingEmail).mockReset())
  afterEach(() => vi.unstubAllEnvs())

  it('fails closed when the webhook secret is not configured', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/auth/webhook', {
        method: 'POST',
        body: '{}',
      })
    )

    expect(response.status).toBe(503)
    expect(sendOnboardingEmail).not.toHaveBeenCalled()
  })

  it('rejects a request without the configured signature', async () => {
    vi.stubEnv('SUPABASE_WEBHOOK_SECRET', 'webhook-secret')
    const response = await POST(
      new NextRequest('http://localhost/api/auth/webhook', {
        method: 'POST',
        body: '{}',
      })
    )

    expect(response.status).toBe(401)
  })

  it('rejects a request with an invalid signature', async () => {
    vi.stubEnv('SUPABASE_WEBHOOK_SECRET', 'webhook-secret')
    const response = await POST(
      new NextRequest('http://localhost/api/auth/webhook', {
        method: 'POST',
        body: '{}',
        headers: { 'x-supabase-signature': 'invalid-signature' },
      })
    )

    expect(response.status).toBe(401)
    expect(sendOnboardingEmail).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON after signature verification', async () => {
    const secret = 'webhook-secret'
    const body = '{'
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')
    vi.stubEnv('SUPABASE_WEBHOOK_SECRET', secret)

    const response = await POST(
      new NextRequest('http://localhost/api/auth/webhook', {
        method: 'POST',
        body,
        headers: { 'x-supabase-signature': signature },
      })
    )

    expect(response.status).toBe(400)
    expect(sendOnboardingEmail).not.toHaveBeenCalled()
  })

  it('accepts a valid signature and sends onboarding email for a confirmed user', async () => {
    const secret = 'webhook-secret'
    const body = JSON.stringify({
      type: 'INSERT',
      table: 'users',
      schema: 'auth',
      record: {
        id: 'user-1',
        email: 'user@example.com',
        email_confirmed_at: '2026-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    })
    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex')
    vi.stubEnv('SUPABASE_WEBHOOK_SECRET', secret)
    vi.mocked(sendOnboardingEmail).mockResolvedValueOnce({
      success: true,
      id: 'email-1',
    })

    const response = await POST(
      new NextRequest('http://localhost/api/auth/webhook', {
        method: 'POST',
        body,
        headers: { 'x-supabase-signature': signature },
      })
    )

    expect(response.status).toBe(200)
    expect(sendOnboardingEmail).toHaveBeenCalledWith({
      to: 'user@example.com',
      type: 'welcome',
    })
  })
})
