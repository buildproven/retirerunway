import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}))

import { POST } from '../route'

describe('POST /api/stripe/checkout', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'authenticated-user' } },
      error: null,
    })
  })

  it('binds the configured price and authenticated user to Stripe metadata', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test')
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_pro')
    vi.stubEnv('SUBSCRIPTIONS_READY', 'true')
    vi.stubEnv('SUBSCRIPTIONS_ENABLED', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'cs_test', url: 'https://checkout' }), {
        status: 200,
      })
    )

    const request = new NextRequest('http://localhost/api/stripe/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const response = await POST(request)

    expect(response.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0] ?? []
    const body = String(init?.body)
    expect(body).toContain('line_items%5B0%5D%5Bprice%5D=price_pro')
    expect(body).toContain('metadata%5BuserId%5D=authenticated-user')
    expect(body).toContain(
      'subscription_data%5Bmetadata%5D%5BuserId%5D=authenticated-user'
    )
    expect(body).not.toContain('price_attacker')
    fetchMock.mockRestore()
  })

  it('fails closed until persistence readiness is explicitly enabled', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test')
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_pro')

    const response = await POST(
      new NextRequest('http://localhost/api/stripe/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    )

    expect(response.status).toBe(503)
  })
})
