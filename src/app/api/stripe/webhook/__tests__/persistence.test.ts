import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}))

import { POST } from '../route'

function signedRequest(body: string, secret: string): NextRequest {
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  return new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
  })
}

describe('Stripe webhook persistence boundary', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    mocks.rpc.mockReset()
    mocks.rpc.mockImplementation((name: string) => {
      if (name === 'acquire_stripe_sync_lease')
        return { data: true, error: null }
      if (name === 'apply_stripe_subscription_event')
        return { data: true, error: null }
      if (name === 'release_stripe_sync_lease')
        return { data: null, error: null }
      return { data: true, error: null }
    })
    mocks.createAdminClient.mockReturnValue({
      rpc: mocks.rpc,
      from: vi.fn(),
    })
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test')
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test')
    vi.stubEnv('SUBSCRIPTIONS_ENABLED', 'true')
    vi.stubEnv('SUBSCRIPTIONS_READY', 'true')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test')
  })

  it('refreshes Stripe state and applies an idempotent snapshot under a lease', async () => {
    const stripeFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'sub_123',
          customer: 'cus_123',
          status: 'active',
          metadata: { userId: 'user_123' },
          current_period_start: 1_754_000_000,
          current_period_end: 1_757_000_000,
          items: { data: [{ price: { id: 'price_pro' } }] },
        }),
        { status: 200 }
      )
    )
    const body = JSON.stringify({
      id: 'evt_123',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_123',
          customer: 'cus_123',
          status: 'active',
          metadata: { userId: 'user_123' },
        },
      },
    })

    const response = await POST(signedRequest(body, 'whsec_test'))

    expect(response.status).toBe(200)
    expect(stripeFetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/subscriptions/sub_123',
      expect.objectContaining({ headers: { Authorization: 'Bearer sk_test' } })
    )
    expect(mocks.rpc).toHaveBeenCalledWith(
      'apply_stripe_subscription_event',
      expect.objectContaining({
        p_event_id: 'evt_123',
        p_user_id: 'user_123',
        p_lease_key: 'user:user_123',
      })
    )
    expect(mocks.rpc).toHaveBeenCalledWith(
      'release_stripe_sync_lease',
      expect.objectContaining({ p_lease_key: 'user:user_123' })
    )
    stripeFetch.mockRestore()
  })

  it('refreshes checkout completion so a paid user is not left pending', async () => {
    const stripeFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'sub_123',
          customer: 'cus_123',
          status: 'active',
          metadata: { userId: 'user_123' },
          current_period_start: 1_754_000_000,
          current_period_end: 1_757_000_000,
          items: { data: [{ price: { id: 'price_pro' } }] },
        }),
        { status: 200 }
      )
    )
    const body = JSON.stringify({
      id: 'evt_checkout_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          subscription: 'sub_123',
          customer: 'cus_123',
          metadata: { userId: 'user_123' },
        },
      },
    })

    const response = await POST(signedRequest(body, 'whsec_test'))

    expect(response.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith(
      'apply_stripe_subscription_event',
      expect.objectContaining({
        p_event_type: 'checkout.session.completed',
        p_status: 'active',
        p_current_period_end: '2025-09-04T15:33:20.000Z',
        p_price_id: 'price_pro',
      })
    )
    stripeFetch.mockRestore()
  })
})
