import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  limit: vi.fn(),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}))

import { getSubscriptionAccess, requireProAccess } from '../subscription-access'

function configureQuery(data: unknown[] | null, error: unknown = null) {
  const chain = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    gt: vi.fn(),
    not: vi.fn(),
    order: vi.fn(),
    limit: mocks.limit,
  }
  chain.from.mockReturnValue(chain)
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  chain.in.mockReturnValue(chain)
  chain.gt.mockReturnValue(chain)
  chain.not.mockReturnValue(chain)
  chain.order.mockReturnValue(chain)
  mocks.createAdminClient.mockReturnValue(chain)
  mocks.limit.mockResolvedValue({ data, error })
}

describe('subscription access', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    mocks.createAdminClient.mockReset()
    mocks.limit.mockReset()
  })

  it('keeps the current free behavior while rollout is off', async () => {
    vi.stubEnv('SUBSCRIPTIONS_ENABLED', 'false')

    await expect(getSubscriptionAccess('user-1')).resolves.toEqual({
      status: 'rollout-off',
      allowed: true,
    })
    expect(mocks.createAdminClient).not.toHaveBeenCalled()
  })

  it('fails closed when rollout configuration is incomplete', async () => {
    vi.stubEnv('SUBSCRIPTIONS_ENABLED', 'true')

    await expect(getSubscriptionAccess('user-1')).resolves.toEqual({
      status: 'configuration-error',
      allowed: false,
    })
    const response = await requireProAccess('user-1')
    expect(response?.status).toBe(503)
  })

  it('allows only a current allowlisted subscription', async () => {
    vi.stubEnv('SUBSCRIPTIONS_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test')
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_pro')
    configureQuery([{ stripe_subscription_id: 'sub-1' }])

    await expect(
      getSubscriptionAccess('user-1', new Date('2026-08-11T00:00:00Z'))
    ).resolves.toEqual({ status: 'pro', allowed: true })

    configureQuery([])
    const response = await requireProAccess('user-1')
    expect(response?.status).toBe(403)
  })

  it('returns a server-owned summary for client hydration', async () => {
    vi.stubEnv('SUBSCRIPTIONS_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test')
    vi.stubEnv('STRIPE_PRO_PRICE_ID', 'price_pro')
    configureQuery([
      {
        stripe_customer_id: 'cus-1',
        stripe_subscription_id: 'sub-1',
        current_period_end: '2026-12-31T00:00:00.000Z',
      },
    ])

    const { getSubscriptionSummary } = await import('../subscription-access')
    await expect(getSubscriptionSummary('user-1')).resolves.toEqual({
      access: { status: 'pro', allowed: true },
      summary: {
        tier: 'pro',
        stripeCustomerId: 'cus-1',
        stripeSubscriptionId: 'sub-1',
        currentPeriodEnd: '2026-12-31T00:00:00.000Z',
      },
    })
  })
})
