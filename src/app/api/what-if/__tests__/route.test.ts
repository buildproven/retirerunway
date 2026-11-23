import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}))

vi.mock('ai', () => ({
  generateText: mocks.generateText,
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

import { POST } from '../route'
import { createClient } from '@/lib/supabase/server'

function makeRequest() {
  return new NextRequest('http://localhost/api/what-if', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: 'What if I retire at 60?',
      currentProfile: {
        currentAge: 55,
        targetRetirementAge: 65,
        annualExpenses: 60000,
      },
      provider: 'openai',
      apiKey: 'test-api-key',
    }),
  })
}

describe('POST /api/what-if', () => {
  it('returns 401 before the paid gate when authentication is absent', async () => {
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      },
    } as never)

    const response = await POST(makeRequest())

    expect(response.status).toBe(401)
  })

  it('returns valid constrained overrides', async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: JSON.stringify({
        overrides: { targetRetirementAge: 60, annualExpenses: 55000 },
        explanation: 'Retire five years earlier with lower expenses.',
      }),
    })

    const response = await POST(makeRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      overrides: { targetRetirementAge: 60, annualExpenses: 55000 },
      explanation: 'Retire five years earlier with lower expenses.',
    })
  })

  it('rejects malformed model JSON without applying overrides', async () => {
    mocks.generateText.mockResolvedValueOnce({ text: '{not valid JSON' })

    const response = await POST(makeRequest())

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not valid JSON'),
    })
  })

  it('rejects invalid parsed model values without applying overrides', async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: JSON.stringify({
        overrides: { targetRetirementAge: 54, annualExpenses: -1 },
      }),
    })

    const response = await POST(makeRequest())

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('invalid values'),
    })
  })

  it('rejects an override that creates an invalid age ordering', async () => {
    mocks.generateText.mockResolvedValueOnce({
      text: JSON.stringify({ overrides: { targetRetirementAge: 50 } }),
    })

    const response = await POST(makeRequest())

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('inconsistent with your profile'),
    })
  })
})
