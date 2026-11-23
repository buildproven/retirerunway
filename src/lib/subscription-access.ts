import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export type SubscriptionAccess =
  | { readonly status: 'rollout-off'; readonly allowed: true }
  | { readonly status: 'pro'; readonly allowed: true }
  | { readonly status: 'free'; readonly allowed: false }
  | { readonly status: 'configuration-error'; readonly allowed: false }
  | { readonly status: 'service-error'; readonly allowed: false }

export interface SubscriptionSummary {
  readonly tier: 'free' | 'pro'
  readonly stripeCustomerId: string | null
  readonly stripeSubscriptionId: string | null
  readonly currentPeriodEnd: string | null
}

function subscriptionsRolloutEnabled(): boolean {
  return process.env.SUBSCRIPTIONS_ENABLED === 'true'
}

function allowedPriceIds(): string[] {
  const configured = process.env.STRIPE_ALLOWED_PRICE_IDS
  if (configured) {
    return configured
      .split(',')
      .map(value => value.trim())
      .filter(value => value.length > 0)
  }
  const proPrice = process.env.STRIPE_PRO_PRICE_ID
  return proPrice ? [proPrice] : []
}

export function isAllowedPriceId(priceId: string): boolean {
  return allowedPriceIds().includes(priceId)
}

export async function getSubscriptionAccess(
  userId: string,
  now: Date = new Date()
): Promise<SubscriptionAccess> {
  if (!subscriptionsRolloutEnabled()) {
    return { status: 'rollout-off', allowed: true }
  }
  const priceIds = allowedPriceIds()
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return { status: 'configuration-error', allowed: false }
  }
  if (priceIds.length === 0) {
    return { status: 'configuration-error', allowed: false }
  }

  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .in('price_id', priceIds)
      .gt('current_period_end', now.toISOString())
      .not('current_period_end', 'is', null)
      .limit(1)

    if (error) return { status: 'service-error', allowed: false }
    return data && data.length > 0
      ? { status: 'pro', allowed: true }
      : { status: 'free', allowed: false }
  } catch {
    return { status: 'service-error', allowed: false }
  }
}

export async function getSubscriptionSummary(
  userId: string,
  now: Date = new Date()
): Promise<{ access: SubscriptionAccess; summary?: SubscriptionSummary }> {
  if (!subscriptionsRolloutEnabled()) {
    return {
      access: { status: 'rollout-off', allowed: true },
      summary: {
        tier: 'free',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
      },
    }
  }
  const priceIds = allowedPriceIds()
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    priceIds.length === 0
  ) {
    return { access: { status: 'configuration-error', allowed: false } }
  }
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id, stripe_subscription_id, current_period_end')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
      .in('price_id', priceIds)
      .gt('current_period_end', now.toISOString())
      .not('current_period_end', 'is', null)
      .order('current_period_end', { ascending: false })
      .limit(1)
    if (error) return { access: { status: 'service-error', allowed: false } }
    const row = data?.[0] as
      | {
          stripe_customer_id: string
          stripe_subscription_id: string
          current_period_end: string
        }
      | undefined
    if (!row) {
      return {
        access: { status: 'free', allowed: false },
        summary: {
          tier: 'free',
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          currentPeriodEnd: null,
        },
      }
    }
    return {
      access: { status: 'pro', allowed: true },
      summary: {
        tier: 'pro',
        stripeCustomerId: row.stripe_customer_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        currentPeriodEnd: row.current_period_end,
      },
    }
  } catch {
    return { access: { status: 'service-error', allowed: false } }
  }
}

/** Return a response when the paid gate rejects a request, otherwise null. */
export async function requireProAccess(
  userId: string,
  now?: Date
): Promise<Response | null> {
  const access = await getSubscriptionAccess(userId, now)
  if (access.allowed) return null
  if (access.status === 'free') {
    return NextResponse.json(
      { error: 'Pro subscription required' },
      { status: 403 }
    )
  }
  return NextResponse.json(
    { error: 'Subscription service is not configured' },
    { status: 503 }
  )
}
