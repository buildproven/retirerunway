import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { logger } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'

const TIMESTAMP_TOLERANCE_SECONDS = 300
const LEASE_TTL_SECONDS = 30

interface StripeEvent {
  id: string
  type: string
  data: { object: Record<string, unknown> }
}

type AdminClient = ReturnType<typeof createAdminClient>

function validateTimestamp(timestamp: string): boolean {
  const timestampNum = Number.parseInt(timestamp, 10)
  if (Number.isNaN(timestampNum)) return false
  return (
    Math.abs(Math.floor(Date.now() / 1000) - timestampNum) <=
    TIMESTAMP_TOLERANCE_SECONDS
  )
}

function verifyStripeSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const parts = signature.split(',')
  const timestampPart = parts.find(part => part.startsWith('t='))
  const sigPart = parts.find(part => part.startsWith('v1='))
  if (!timestampPart || !sigPart) return false

  const timestamp = timestampPart.slice(2)
  const expectedSig = sigPart.slice(3)
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex')
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmac, 'hex'),
      Buffer.from(expectedSig, 'hex')
    )
  } catch {
    return false
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function metadataValue(object: Record<string, unknown>): string | undefined {
  const metadata = object.metadata
  if (!metadata || typeof metadata !== 'object') return undefined
  return stringValue((metadata as Record<string, unknown>).userId)
}

function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    return stringValue((value as Record<string, unknown>).id)
  }
  return undefined
}

function stripeTimestamp(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value * 1000).toISOString()
}

function scalarRpcResult(value: unknown): boolean {
  if (value === true) return true
  return Array.isArray(value) && value.length > 0
}

async function claimEvent(
  admin: AdminClient,
  event: StripeEvent
): Promise<boolean> {
  const { data, error } = await admin.rpc('claim_stripe_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_payload: event,
  })
  if (error) throw error
  return scalarRpcResult(data)
}

async function acquireLease(
  admin: AdminClient,
  leaseKey: string,
  leaseToken: string
): Promise<boolean> {
  const { data, error } = await admin.rpc('acquire_stripe_sync_lease', {
    p_lease_key: leaseKey,
    p_lease_token: leaseToken,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  })
  if (error) throw error
  return scalarRpcResult(data)
}

async function releaseLease(
  admin: AdminClient,
  leaseKey: string,
  leaseToken: string
): Promise<void> {
  const { error } = await admin.rpc('release_stripe_sync_lease', {
    p_lease_key: leaseKey,
    p_lease_token: leaseToken,
  })
  if (error) logger.warn('Failed to release Stripe sync lease', { leaseKey })
}

async function fetchCurrentSubscription(
  subscriptionId: string,
  stripeSecretKey: string
): Promise<Record<string, unknown> | null> {
  const response = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { headers: { Authorization: `Bearer ${stripeSecretKey}` } }
  )
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Stripe subscription refresh failed')
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object') {
    throw new Error('Stripe subscription refresh returned an invalid object')
  }
  return value as Record<string, unknown>
}

async function existingUserId(
  admin: AdminClient,
  subscriptionId: string,
  customerId: string | undefined
): Promise<string | undefined> {
  const bySubscription = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle()
  if (bySubscription.error) throw bySubscription.error
  const subscriptionUser = stringValue(
    (bySubscription.data as { user_id?: unknown } | null)?.user_id
  )
  if (subscriptionUser) return subscriptionUser
  if (!customerId) return undefined
  const byCustomer = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .not('user_id', 'is', null)
    .limit(1)
  if (byCustomer.error) throw byCustomer.error
  return stringValue(
    (byCustomer.data?.[0] as { user_id?: unknown } | undefined)?.user_id
  )
}

async function applySnapshot(
  admin: AdminClient,
  event: StripeEvent,
  subscription: Record<string, unknown>,
  userId: string | undefined,
  leaseKey: string,
  leaseToken: string
): Promise<boolean> {
  const subscriptionId = stringValue(subscription.id)
  const customerId = stripeObjectId(subscription.customer)
  if (!subscriptionId || !customerId) {
    throw new Error('Stripe subscription is missing identifiers')
  }
  const status =
    event.type === 'customer.subscription.deleted'
      ? 'canceled'
      : ['active', 'trialing', 'past_due', 'unpaid', 'canceled'].includes(
            stringValue(subscription.status) ?? ''
          )
        ? stringValue(subscription.status)!
        : 'pending'
  const items = subscription.items
  const firstItem =
    items &&
    typeof items === 'object' &&
    Array.isArray((items as Record<string, unknown>).data)
      ? ((items as Record<string, unknown>).data as unknown[])[0]
      : undefined
  const price =
    firstItem && typeof firstItem === 'object'
      ? (firstItem as Record<string, unknown>).price
      : undefined
  const priceId =
    price && typeof price === 'object'
      ? stringValue((price as Record<string, unknown>).id)
      : undefined
  const { data, error } = await admin.rpc('apply_stripe_subscription_event', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_payload: event,
    p_stripe_subscription_id: subscriptionId,
    p_user_id: userId ?? null,
    p_stripe_customer_id: customerId,
    p_status: status,
    p_price_id: priceId ?? null,
    p_current_period_start: stripeTimestamp(subscription.current_period_start),
    p_current_period_end: stripeTimestamp(subscription.current_period_end),
    p_cancel_at_period_end: subscription.cancel_at_period_end === true,
    p_metadata: subscription.metadata ?? {},
    p_lease_key: leaseKey,
    p_lease_token: leaseToken,
  })
  if (error) throw error
  return scalarRpcResult(data)
}

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  if (!webhookSecret || !stripeSecretKey) {
    return NextResponse.json(
      { error: 'Stripe webhooks not configured' },
      { status: 503 }
    )
  }

  try {
    const body = await req.text()
    const signature = req.headers.get('stripe-signature')
    if (!signature)
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

    const timestampPart = signature
      .split(',')
      .find(part => part.startsWith('t='))
    if (!timestampPart) {
      return NextResponse.json(
        { error: 'Missing timestamp in signature' },
        { status: 400 }
      )
    }
    const timestamp = timestampPart.slice(2)
    if (!validateTimestamp(timestamp)) {
      return NextResponse.json(
        { error: 'Request timestamp too old' },
        { status: 400 }
      )
    }
    if (!verifyStripeSignature(body, signature, webhookSecret)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
    }

    let event: StripeEvent
    try {
      event = JSON.parse(body) as StripeEvent
    } catch (error) {
      logger.error('JSON parse error', error)
      return NextResponse.json(
        { error: 'Invalid webhook payload' },
        { status: 400 }
      )
    }
    if (!event?.id || !event?.type || !event?.data?.object) {
      return NextResponse.json(
        { error: 'Invalid webhook payload structure' },
        { status: 400 }
      )
    }

    // Preserve the existing free rollout until the migration and service-role
    // credentials are deliberately enabled. No paid entitlement is granted.
    if (process.env.SUBSCRIPTIONS_ENABLED !== 'true') {
      return NextResponse.json({ received: true })
    }
    if (
      process.env.SUBSCRIPTIONS_READY !== 'true' ||
      !process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      return NextResponse.json(
        { error: 'Subscription persistence is not ready' },
        { status: 503 }
      )
    }

    const admin = createAdminClient()
    const object = event.data.object
    if (event.type === 'checkout.session.completed') {
      const subscriptionId = stripeObjectId(object.subscription)
      const customerId = stripeObjectId(object.customer)
      if (!subscriptionId || !customerId) {
        return NextResponse.json({ received: true, pending: true })
      }
      const userId = metadataValue(object)
      const leaseKey = userId ? `user:${userId}` : `customer:${customerId}`
      const leaseToken = crypto.randomUUID()
      if (!(await acquireLease(admin, leaseKey, leaseToken))) {
        logger.warn('Stripe checkout update busy; retry delivery', {
          eventId: event.id,
          leaseKey,
        })
        return NextResponse.json(
          { error: 'Subscription update is busy; retry delivery' },
          { status: 503 }
        )
      }
      try {
        // Checkout completion is not itself a subscription snapshot. Fetch the
        // current Stripe object while holding the lease so a lost lifecycle
        // event cannot leave an already-paid customer stuck at pending.
        const current = await fetchCurrentSubscription(
          subscriptionId,
          stripeSecretKey
        )
        const authoritative = current ?? {
          id: subscriptionId,
          customer: customerId,
          status: 'pending',
          metadata: object.metadata ?? {},
        }
        const authoritativeUserId = metadataValue(authoritative)
        if (authoritativeUserId && userId && authoritativeUserId !== userId) {
          throw new Error('Stripe subscription owner metadata changed')
        }
        await applySnapshot(
          admin,
          event,
          {
            ...authoritative,
            id: subscriptionId,
            customer: stripeObjectId(authoritative.customer) ?? customerId,
          },
          authoritativeUserId ?? userId,
          leaseKey,
          leaseToken
        )
      } finally {
        await releaseLease(admin, leaseKey, leaseToken)
      }
      return NextResponse.json({ received: true })
    }

    if (event.type.startsWith('customer.subscription.')) {
      const subscriptionId = stringValue(object.id)
      if (!subscriptionId)
        return NextResponse.json({ received: true, pending: true })
      const customerId = stripeObjectId(object.customer)
      const userId =
        metadataValue(object) ??
        (await existingUserId(admin, subscriptionId, customerId))
      const resolvedCustomerId = customerId
      if (!resolvedCustomerId) {
        return NextResponse.json({ received: true, pending: true })
      }
      const leaseKey = userId
        ? `user:${userId}`
        : `customer:${resolvedCustomerId}`
      const leaseToken = crypto.randomUUID()
      if (!(await acquireLease(admin, leaseKey, leaseToken))) {
        logger.warn('Stripe subscription update busy; retry delivery', {
          eventId: event.id,
          leaseKey,
        })
        return NextResponse.json(
          { error: 'Subscription update is busy; retry delivery' },
          { status: 503 }
        )
      }
      try {
        // The lease covers the refresh as well as the write. A second delivery
        // cannot fetch and later commit an older Stripe snapshot.
        const current =
          event.type === 'customer.subscription.deleted'
            ? null
            : await fetchCurrentSubscription(subscriptionId, stripeSecretKey)
        const authoritative = current ?? object
        const authoritativeUserId = metadataValue(authoritative)
        if (authoritativeUserId && userId && authoritativeUserId !== userId) {
          throw new Error('Stripe subscription owner metadata changed')
        }
        await applySnapshot(
          admin,
          event,
          {
            ...authoritative,
            id: subscriptionId,
            customer: resolvedCustomerId,
          },
          authoritativeUserId ?? userId,
          leaseKey,
          leaseToken
        )
      } finally {
        await releaseLease(admin, leaseKey, leaseToken)
      }
      return NextResponse.json({ received: true })
    }

    await claimEvent(admin, event)
    return NextResponse.json({ received: true })
  } catch (error) {
    logger.error('Webhook error', error)
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    )
  }
}
