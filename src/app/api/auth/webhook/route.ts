import { NextRequest, NextResponse } from 'next/server'
import { sendOnboardingEmail } from '@/lib/email'
import { createHmac } from 'crypto'
import { logger } from '@/lib/logger'

interface SupabaseAuthWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  schema: string
  record: {
    id: string
    email: string
    email_confirmed_at?: string | null
    created_at: string
    [key: string]: unknown
  }
  old_record?: {
    id: string
    email_confirmed_at?: string | null
    [key: string]: unknown
  }
}

function isValidPayload(body: unknown): body is SupabaseAuthWebhookPayload {
  if (!body || typeof body !== 'object') return false
  const payload = body as Record<string, unknown>
  return (
    typeof payload.type === 'string' &&
    typeof payload.table === 'string' &&
    typeof payload.record === 'object' &&
    payload.record !== null &&
    typeof (payload.record as Record<string, unknown>).email === 'string'
  )
}

function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) {
    return false
  }

  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  return signature === expectedSignature
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-supabase-signature')
  const webhookSecret = process.env.SUPABASE_WEBHOOK_SECRET

  if (!webhookSecret) {
    logger.error('SUPABASE_WEBHOOK_SECRET is not configured')
    return NextResponse.json(
      { error: 'Webhook is not configured' },
      { status: 503 }
    )
  }

  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    logger.error('Invalid webhook signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!isValidPayload(body)) {
    return NextResponse.json(
      { error: 'Invalid payload structure' },
      { status: 400 }
    )
  }

  const { type, record, old_record } = body
  const email = record.email

  if (type === 'INSERT' && record.email_confirmed_at) {
    logger.info('New confirmed user', { email })
    const result = await sendOnboardingEmail({ to: email, type: 'welcome' })
    if (!result.success) {
      logger.error('Failed to send welcome email', undefined, {
        email,
        error: result.error,
      })
    }
  }

  if (
    type === 'UPDATE' &&
    record.email_confirmed_at &&
    !old_record?.email_confirmed_at
  ) {
    logger.info('User confirmed email', { email })
    const result = await sendOnboardingEmail({ to: email, type: 'welcome' })
    if (!result.success) {
      logger.error('Failed to send welcome email', undefined, {
        email,
        error: result.error,
      })
    }
  }

  return NextResponse.json({ success: true })
}
