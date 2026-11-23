import { NextRequest, NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/with-rate-limit'
import { withValidation, compose } from '@/lib/with-validation'
import { withAuth } from '@/lib/with-auth'
import { PlaidExchangeTokenRequestSchema } from '@/lib/validation-schemas'

// Exchanges a Plaid public token for an access token and fetches investment holdings.
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
    const body = req.validatedBody as { publicToken: string }
    const { publicToken } = body

    const plaidHost =
      plaidEnv === 'production'
        ? 'https://production.plaid.com'
        : plaidEnv === 'development'
          ? 'https://development.plaid.com'
          : 'https://sandbox.plaid.com'

    // Exchange public token for access token
    const exchangeResponse = await fetch(
      `${plaidHost}/item/public_token/exchange`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          secret,
          public_token: publicToken,
        }),
      }
    )

    if (!exchangeResponse.ok) {
      const error = await exchangeResponse.text()
      console.error('Plaid token exchange error:', error)
      return NextResponse.json(
        { error: 'Failed to exchange token' },
        { status: 500 }
      )
    }

    const exchangeData = (await exchangeResponse.json()) as {
      access_token: string
      item_id: string
    }

    // Fetch investment holdings
    const holdingsResponse = await fetch(
      `${plaidHost}/investments/holdings/get`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          secret,
          access_token: exchangeData.access_token,
        }),
      }
    )

    if (!holdingsResponse.ok) {
      const error = await holdingsResponse.text()
      console.error('Plaid holdings error:', error)
      return NextResponse.json(
        { error: 'Failed to fetch holdings' },
        { status: 500 }
      )
    }

    const holdingsData = (await holdingsResponse.json()) as {
      accounts: PlaidAccount[]
      holdings: PlaidHolding[]
      securities: PlaidSecurity[]
    }

    return NextResponse.json({
      accounts: holdingsData.accounts,
      holdings: holdingsData.holdings,
      securities: holdingsData.securities,
      itemId: exchangeData.item_id,
    })
  } catch (error) {
    console.error('Plaid exchange error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export const POST = compose(
  withAuth,
  handler => withRateLimit(handler, 'payment'),
  handler => withValidation(handler, PlaidExchangeTokenRequestSchema)
)(handlePOST)

// Plaid response types (subset)
interface PlaidAccount {
  account_id: string
  name: string
  type: string
  subtype: string | null
  balances: {
    current: number | null
    available: number | null
  }
}

interface PlaidHolding {
  account_id: string
  security_id: string
  quantity: number
  cost_basis: number | null
  institution_value: number | null
}

interface PlaidSecurity {
  security_id: string
  ticker_symbol: string | null
  name: string | null
  type: string | null
  close_price: number | null
}
