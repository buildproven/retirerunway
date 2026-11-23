import { NextRequest, NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/with-rate-limit'
import { withValidation, compose } from '@/lib/with-validation'
import { withAuth, type AuthenticatedRequest } from '@/lib/with-auth'
import { StripeCheckoutRequestSchema } from '@/lib/validation-schemas'
import { logger } from '@/lib/logger'
import { isAllowedPriceId } from '@/lib/subscription-access'

// Stripe checkout session creation
// Requires STRIPE_SECRET_KEY and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY env vars

async function handlePOST(req: NextRequest & { validatedBody?: unknown }) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  const priceId = process.env.STRIPE_PRO_PRICE_ID
  if (
    !stripeSecretKey ||
    !priceId ||
    process.env.SUBSCRIPTIONS_READY !== 'true' ||
    process.env.SUBSCRIPTIONS_ENABLED !== 'true' ||
    !isAllowedPriceId(priceId)
  ) {
    return NextResponse.json(
      { error: 'Stripe checkout is not ready' },
      { status: 503 }
    )
  }

  try {
    const userId = (req as unknown as AuthenticatedRequest).user.id

    // Create Stripe Checkout Session via API
    const params = new URLSearchParams()
    params.append('mode', 'subscription')
    params.append('payment_method_types[0]', 'card')
    params.append('line_items[0][price]', priceId)
    params.append('line_items[0][quantity]', '1')
    params.append('success_url', `${req.nextUrl.origin}/?subscription=success`)
    params.append('cancel_url', `${req.nextUrl.origin}/?subscription=cancelled`)
    params.append('client_reference_id', userId)
    params.append('metadata[userId]', userId)
    params.append('subscription_data[metadata][userId]', userId)

    const response = await fetch(
      'https://api.stripe.com/v1/checkout/sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      logger.error('Stripe checkout error', undefined, { error: errorText })
      return NextResponse.json(
        { error: 'Failed to create checkout session' },
        { status: 500 }
      )
    }

    const session = (await response.json()) as { url: string; id: string }
    return NextResponse.json({ url: session.url, sessionId: session.id })
  } catch (error) {
    logger.error('Checkout error', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export const POST = compose(
  withAuth,
  handler => withRateLimit(handler, 'payment'),
  handler => withValidation(handler, StripeCheckoutRequestSchema)
)(handlePOST)
