import { NextResponse } from 'next/server'
import { withAuth, type AuthenticatedRequest } from '@/lib/with-auth'
import { getSubscriptionSummary } from '@/lib/subscription-access'

async function handleGET(request: Request): Promise<Response> {
  const result = await getSubscriptionSummary(
    (request as AuthenticatedRequest).user.id
  )
  if (!result.summary) {
    return NextResponse.json(
      { error: 'Subscription service is not configured' },
      { status: 503 }
    )
  }
  return NextResponse.json(result.summary)
}

export const GET = withAuth(handleGET)
