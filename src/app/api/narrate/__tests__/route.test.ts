import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
}))

vi.mock('ai', () => ({
  streamText: mocks.streamText,
}))

vi.mock('@/ai/byok-adapter', () => ({
  createModel: vi.fn(() => ({})),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
  })),
}))

vi.mock('@/lib/subscription-access', () => ({
  requireProAccess: vi.fn(async () =>
    Response.json(
      { error: 'Subscription service is not configured' },
      { status: 503 }
    )
  ),
}))

import { POST } from '../route'
import { createClient } from '@/lib/supabase/server'

function makeRequest() {
  return new NextRequest('http://localhost/api/narrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: { profile: {}, projection: {} },
      provider: 'openai',
      apiKey: 'test-api-key',
    }),
  })
}

function makeAuthenticatedRequest() {
  return new NextRequest('http://localhost/api/narrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      context: {
        portfolio: {
          id: 'portfolio-1',
          name: 'Test portfolio',
          asOfDate: '2026-01-01',
          accounts: [
            {
              id: 'account-1',
              name: 'Brokerage',
              institution: 'Test bank',
              accountType: 'brokerage',
              holdings: [],
              cds: [],
              cashBalance: 0,
            },
          ],
        },
        userProfile: {
          currentAge: 55,
          targetRetirementAge: 65,
          annualExpenses: 60000,
        },
        scenarios: [],
        riskScore: {},
        tradePlan: {},
        ladderPlan: {},
      },
      provider: 'openai',
      apiKey: 'test-api-key',
    }),
  })
}

describe('POST /api/narrate', () => {
  it('returns 401 before the paid gate when authentication is absent', async () => {
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      },
    } as never)

    const response = await POST(makeRequest())

    expect(response.status).toBe(401)
    expect(mocks.streamText).not.toHaveBeenCalled()
  })

  it('checks the paid gate after authentication succeeds', async () => {
    const response = await POST(makeAuthenticatedRequest())

    expect(response.status).toBe(503)
    expect(mocks.streamText).not.toHaveBeenCalled()
  })
})
