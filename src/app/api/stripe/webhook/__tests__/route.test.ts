import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from '../route'
import { NextRequest } from 'next/server'
import crypto from 'crypto'

describe('Stripe Webhook Route', () => {
  const mockWebhookSecret = 'whsec_test_secret'
  const mockStripeSecretKey = 'sk_test_secret'

  beforeEach(() => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', mockWebhookSecret)
    vi.stubEnv('STRIPE_SECRET_KEY', mockStripeSecretKey)
  })

  function createSignature(payload: string, secret: string): string {
    const timestamp = Math.floor(Date.now() / 1000)
    const signedPayload = `${timestamp}.${payload}`
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex')
    return `t=${timestamp},v1=${hmac}`
  }

  function createMockRequest(body: string, signature?: string): NextRequest {
    const req = new NextRequest('http://localhost:3000/api/stripe/webhook', {
      method: 'POST',
      body,
      headers: signature
        ? {
            'stripe-signature': signature,
          }
        : {},
    })
    return req
  }

  describe('Configuration', () => {
    it('should return 503 if STRIPE_WEBHOOK_SECRET is missing', async () => {
      vi.stubEnv('STRIPE_WEBHOOK_SECRET', '')
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      const req = createMockRequest(body)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(503)
      expect(data.error).toBe('Stripe webhooks not configured')
    })

    it('should return 503 if STRIPE_SECRET_KEY is missing', async () => {
      vi.stubEnv('STRIPE_SECRET_KEY', '')
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      const req = createMockRequest(body)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(503)
      expect(data.error).toBe('Stripe webhooks not configured')
    })
  })

  describe('Timestamp Validation', () => {
    it('should return 400 if timestamp is missing from signature', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      const req = createMockRequest(body, 'v1=somesignature')

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Missing timestamp in signature')
    })

    it('should return 400 if timestamp is older than 5 minutes', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      // Create timestamp from 10 minutes ago (600 seconds)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600
      const signedPayload = `${oldTimestamp}.${body}`
      const hmac = crypto
        .createHmac('sha256', mockWebhookSecret)
        .update(signedPayload)
        .digest('hex')
      const signature = `t=${oldTimestamp},v1=${hmac}`
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Request timestamp too old')
    })

    it('should return 400 if timestamp is from the future (beyond tolerance)', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      // Create timestamp 10 minutes in the future
      const futureTimestamp = Math.floor(Date.now() / 1000) + 600
      const signedPayload = `${futureTimestamp}.${body}`
      const hmac = crypto
        .createHmac('sha256', mockWebhookSecret)
        .update(signedPayload)
        .digest('hex')
      const signature = `t=${futureTimestamp},v1=${hmac}`
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Request timestamp too old')
    })

    it('should accept timestamp within 5 minute tolerance', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { userId: 'user_123' },
            subscription: 'sub_123',
            customer: 'cus_123',
          },
        },
      })
      // Create timestamp 4 minutes ago (within tolerance)
      const recentTimestamp = Math.floor(Date.now() / 1000) - 240
      const signedPayload = `${recentTimestamp}.${body}`
      const hmac = crypto
        .createHmac('sha256', mockWebhookSecret)
        .update(signedPayload)
        .digest('hex')
      const signature = `t=${recentTimestamp},v1=${hmac}`
      const req = createMockRequest(body, signature)

      const response = await POST(req)

      expect(response.status).toBe(200)
    })

    it('should reject timestamp with non-numeric value', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      const signature = 't=notanumber,v1=somesignature'
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Request timestamp too old')
    })
  })

  describe('Signature Validation', () => {
    it('should return 400 if stripe-signature header is missing', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      const req = createMockRequest(body)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Missing signature')
    })

    it('should return 400 if signature is invalid', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'test',
        data: { object: {} },
      })
      const req = createMockRequest(body, 't=123,v1=invalidsignature')

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Request timestamp too old')
    })

    it('should accept valid signature', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { userId: 'user_123' },
            subscription: 'sub_123',
            customer: 'cus_123',
          },
        },
      })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)

      expect(response.status).toBe(200)
    })
  })

  describe('JSON Parse Error Handling', () => {
    it('should return 400 for malformed JSON', async () => {
      const malformedBody = '{ "id": "evt_123", invalid json }'
      const signature = createSignature(malformedBody, mockWebhookSecret)
      const req = createMockRequest(malformedBody, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid webhook payload')
    })

    it('should return 400 for incomplete JSON', async () => {
      const incompleteBody = '{ "id": "evt_123"'
      const signature = createSignature(incompleteBody, mockWebhookSecret)
      const req = createMockRequest(incompleteBody, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid webhook payload')
    })

    it('should return 400 for non-JSON body', async () => {
      const nonJsonBody = 'plain text body'
      const signature = createSignature(nonJsonBody, mockWebhookSecret)
      const req = createMockRequest(nonJsonBody, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid webhook payload')
    })
  })

  describe('Type Guard Validation', () => {
    it('should return 400 if event.id is missing', async () => {
      const body = JSON.stringify({ type: 'test', data: { object: {} } })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid webhook payload structure')
    })

    it('should return 400 if event.type is missing', async () => {
      const body = JSON.stringify({ id: 'evt_123', data: { object: {} } })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid webhook payload structure')
    })

    it('should return 400 if event.data is missing', async () => {
      const body = JSON.stringify({ id: 'evt_123', type: 'test' })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid webhook payload structure')
    })

    it('should return 400 if event.data.object is missing', async () => {
      const body = JSON.stringify({ id: 'evt_123', type: 'test', data: {} })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Invalid webhook payload structure')
    })
  })

  describe('Event Processing', () => {
    it('should handle checkout.session.completed event', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { userId: 'user_123' },
            subscription: 'sub_123',
            customer: 'cus_123',
          },
        },
      })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.received).toBe(true)
    })

    it('should handle customer.subscription.updated event', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_123',
            status: 'active',
          },
        },
      })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.received).toBe(true)
    })

    it('should handle customer.subscription.deleted event', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_123',
          },
        },
      })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.received).toBe(true)
    })

    it('should handle invoice.payment_failed event', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'invoice.payment_failed',
        data: {
          object: {
            subscription: 'sub_123',
            customer: 'cus_123',
            attempt_count: 1,
          },
        },
      })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.received).toBe(true)
    })

    it('should handle unrecognized event types gracefully', async () => {
      const body = JSON.stringify({
        id: 'evt_123',
        type: 'unrecognized.event.type',
        data: {
          object: {
            some: 'data',
          },
        },
      })
      const signature = createSignature(body, mockWebhookSecret)
      const req = createMockRequest(body, signature)

      const response = await POST(req)
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.received).toBe(true)
    })
  })
})
