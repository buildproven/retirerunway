import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendOnboardingEmail, OnboardingEmailType } from '@/lib/email'
import { logger } from '@/lib/logger'

interface SendOnboardingRequest {
  email: string
  type: OnboardingEmailType
}

function isValidRequest(body: unknown): body is SendOnboardingRequest {
  if (!body || typeof body !== 'object') return false
  const req = body as Record<string, unknown>
  return (
    typeof req.email === 'string' &&
    req.email.includes('@') &&
    (req.type === 'welcome' || req.type === 'first-steps')
  )
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (!isValidRequest(body)) {
      return NextResponse.json(
        {
          error:
            'Invalid request: email and type (welcome|first-steps) required',
        },
        { status: 400 }
      )
    }

    if (body.email !== user.email) {
      return NextResponse.json(
        { error: 'Can only send emails to your own address' },
        { status: 403 }
      )
    }

    const result = await sendOnboardingEmail({
      to: body.email,
      type: body.type,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    return NextResponse.json({ success: true, id: result.id })
  } catch (err) {
    logger.error(
      'Email send onboarding error',
      err instanceof Error ? err : undefined
    )
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
