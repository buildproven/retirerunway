import { NextRequest, NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/with-rate-limit'
import { withValidation, compose } from '@/lib/with-validation'
import { withAuth } from '@/lib/with-auth'
import { PlaidCreateLinkTokenRequestSchema } from '@/lib/validation-schemas'

// Creates a Plaid Link token for the client-side Plaid Link flow.
// Requires PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV env vars.

async function handlePOST(req: NextRequest & { validatedBody?: unknown }) {
  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  const plaidEnv = process.env.PLAID_ENV ?? 'sandbox'

  if (!clientId || !secret) {
    return NextResponse.json(
      { error: 'Plaid is not configured' },
      { status: 503 }
    )
  }

  try {
    const body = req.validatedBody as { userId?: string }
    const userId = body.userId ?? 'anonymous'

    const plaidHost =
      plaidEnv === 'production'
        ? 'https://production.plaid.com'
        : plaidEnv === 'development'
          ? 'https://development.plaid.com'
          : 'https://sandbox.plaid.com'

    const response = await fetch(`${plaidHost}/link/token/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        secret,
        client_name: 'RetireRunway',
        country_codes: ['US'],
        language: 'en',
        user: { client_user_id: userId },
        products: ['investments'],
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('Plaid link token error:', error)
      return NextResponse.json(
        { error: 'Failed to create link token' },
        { status: 500 }
      )
    }

    const data = (await response.json()) as {
      link_token: string
      expiration: string
    }
    return NextResponse.json({
      linkToken: data.link_token,
      expiration: data.expiration,
    })
  } catch (error) {
    console.error('Plaid link token error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export const POST = compose(
  withAuth,
  handler => withRateLimit(handler, 'payment'),
  handler => withValidation(handler, PlaidCreateLinkTokenRequestSchema)
)(handlePOST)
