import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../route'

const originalApiAccessKeys = process.env.API_ACCESS_KEYS

function makeRequest(filingStatus: string) {
  return new NextRequest('http://localhost/api/v1/tax', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-api-key',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      filingStatus,
      ordinaryIncome: 80000,
      includeRothOptimizer: false,
    }),
  })
}

describe('POST /api/v1/tax', () => {
  beforeEach(() => {
    process.env.API_ACCESS_KEYS = 'test-api-key'
  })

  afterEach(() => {
    if (originalApiAccessKeys === undefined) {
      delete process.env.API_ACCESS_KEYS
    } else {
      process.env.API_ACCESS_KEYS = originalApiAccessKeys
    }
  })

  it.each(['single', 'married_filing_jointly', 'head_of_household'])(
    'returns a breakdown for supported status %s',
    async filingStatus => {
      const response = await POST(makeRequest(filingStatus))

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        taxBreakdown: { filingStatus },
      })
    }
  )

  it('returns a validation error for an unsupported status', async () => {
    const response = await POST(makeRequest('married'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'Validation failed',
      details: expect.arrayContaining([
        expect.objectContaining({ path: 'filingStatus' }),
      ]),
    })
  })
})
