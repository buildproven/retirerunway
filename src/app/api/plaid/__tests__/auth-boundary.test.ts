import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getUser = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}))

import { POST as createLinkToken } from '../create-link-token/route'
import { POST as exchangeToken } from '../exchange-token/route'

function request(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    body: '{}',
  })
}

function authorizedRequest(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(
      path.includes('exchange-token') ? { publicToken: 'public-token' } : {}
    ),
  })
}

describe('Plaid API auth boundaries', () => {
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    ['/api/plaid/create-link-token', createLinkToken],
    ['/api/plaid/exchange-token', exchangeToken],
  ])('rejects an unauthenticated request to %s', async (path, handler) => {
    getUser.mockResolvedValueOnce({ data: { user: null } })

    const response = await handler(request(path))

    expect(response.status).toBe(401)
  })

  it.each([
    ['/api/plaid/create-link-token', createLinkToken],
    ['/api/plaid/exchange-token', exchangeToken],
  ])(
    'fails closed when Plaid is not configured for %s',
    async (path, handler) => {
      getUser.mockResolvedValueOnce({ data: { user: { id: 'user-1' } } })

      const response = await handler(authorizedRequest(path))

      expect(response.status).toBe(503)
    }
  )
})
