import { afterEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'

import { POST } from '../route'

const originalApiAccessKeys = process.env.API_ACCESS_KEYS

describe('POST /api/v1/analyze', () => {
  afterEach(() => {
    if (originalApiAccessKeys === undefined) {
      delete process.env.API_ACCESS_KEYS
    } else {
      process.env.API_ACCESS_KEYS = originalApiAccessKeys
    }
  })

  it('rejects a request without an API key', async () => {
    process.env.API_ACCESS_KEYS = 'configured-test-key'
    const response = await POST(
      new NextRequest('http://localhost/api/v1/analyze', {
        method: 'POST',
        body: JSON.stringify({
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
        }),
      })
    )

    expect(response.status).toBe(401)
  })
})
