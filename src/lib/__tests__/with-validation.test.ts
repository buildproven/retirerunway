import { describe, it, expect, vi } from 'vitest'
import { withValidation } from '../with-validation'
import { z } from 'zod'

const TestSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
  email: z.string().email().optional(),
})

describe('withValidation', () => {
  it('should validate valid input and pass to handler', async () => {
    const validBody = { name: 'Alice', age: 30, email: 'alice@example.com' }
    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, TestSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalled()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstCall = handler.mock.calls[0] as any
    if (firstCall && firstCall[0]) {
      const handlerRequest = firstCall[0] as Request & {
        validatedBody?: unknown
      }
      expect(handlerRequest.validatedBody).toEqual(validBody)
    }
  })

  it('should return 400 for invalid input with detailed errors', async () => {
    const invalidBody = { name: '', age: -5 }
    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, TestSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(invalidBody),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()

    const json = await response.json()
    expect(json).toHaveProperty('error', 'Validation failed')
    expect(json).toHaveProperty('details')
    expect(Array.isArray(json.details)).toBe(true)
    expect(json.details.length).toBeGreaterThan(0)

    const errors = json.details as Array<{
      path: string
      message: string
      code: string
    }>
    expect(errors.some(e => e.path === 'name')).toBe(true)
    expect(errors.some(e => e.path === 'age')).toBe(true)
  })

  it('should return 400 for malformed JSON', async () => {
    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, TestSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: 'not valid json {',
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()

    const json = await response.json()
    expect(json).toHaveProperty('error', 'Invalid JSON in request body')
  })

  it('should validate missing required fields', async () => {
    const incompleteBody = { name: 'Bob' }
    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, TestSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(incompleteBody),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(400)

    const json = await response.json()
    expect(json.error).toBe('Validation failed')
    const errors = json.details as Array<{ path: string }>
    expect(errors.some(e => e.path === 'age')).toBe(true)
  })

  it('should validate type mismatches', async () => {
    const wrongTypeBody = { name: 'Charlie', age: 'thirty' }
    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, TestSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(wrongTypeBody),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(400)

    const json = await response.json()
    const errors = json.details as Array<{ path: string; message: string }>
    const ageError = errors.find(e => e.path === 'age')
    expect(ageError).toBeDefined()
    expect(ageError?.message).toContain('number')
  })

  it('should accept optional fields when omitted', async () => {
    const bodyWithoutOptional = { name: 'Dave', age: 25 }
    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, TestSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(bodyWithoutOptional),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalled()
  })

  it('should validate email format for optional email field', async () => {
    const invalidEmailBody = { name: 'Eve', age: 28, email: 'not-an-email' }
    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, TestSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(invalidEmailBody),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(400)

    const json = await response.json()
    const errors = json.details as Array<{ path: string }>
    expect(errors.some(e => e.path === 'email')).toBe(true)
  })

  it('should handle nested schema validation', async () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string().min(1),
        profile: z.object({
          age: z.number().positive(),
        }),
      }),
    })

    const validNested = {
      user: {
        name: 'Frank',
        profile: { age: 35 },
      },
    }

    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, NestedSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(validNested),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalled()
  })

  it('should provide nested path in error details', async () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string().min(1),
        profile: z.object({
          age: z.number().positive(),
        }),
      }),
    })

    const invalidNested = {
      user: {
        name: 'Greg',
        profile: { age: -10 },
      },
    }

    const handler = vi.fn(async () => Response.json({ success: true }))
    const wrapped = withValidation(handler, NestedSchema)

    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify(invalidNested),
      headers: { 'Content-Type': 'application/json' },
    })

    const response = await wrapped(request)
    expect(response.status).toBe(400)

    const json = await response.json()
    const errors = json.details as Array<{ path: string }>
    expect(errors.some(e => e.path === 'user.profile.age')).toBe(true)
  })
})
