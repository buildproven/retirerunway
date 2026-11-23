import { Resend } from 'resend'
import { WelcomeEmail } from '@/emails/welcome'
import { FirstStepsEmail } from '@/emails/first-steps'
import { createElement } from 'react'
import { logger } from '@/lib/logger'

let resendClient: Resend | null = null

function getResendClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    return null
  }
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY)
  }
  return resendClient
}

export type OnboardingEmailType = 'welcome' | 'first-steps'

interface SendOnboardingEmailParams {
  to: string
  type: OnboardingEmailType
}

interface EmailResult {
  success: boolean
  id?: string
  error?: string
}

export async function sendOnboardingEmail({
  to,
  type,
}: SendOnboardingEmailParams): Promise<EmailResult> {
  const resend = getResendClient()
  if (!resend) {
    logger.warn('RESEND_API_KEY not configured, skipping email send')
    return { success: false, error: 'Email service not configured' }
  }

  const emailConfig = getEmailConfig(type, to)

  try {
    const { data, error } = await resend.emails.send({
      from: 'RetireRunway <hello@retirerunway.app>',
      to: [to],
      subject: emailConfig.subject,
      react: emailConfig.component,
    })

    if (error) {
      logger.error('Resend error', undefined, { error: error.message })
      return { success: false, error: error.message }
    }

    return { success: true, id: data?.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('Email send failed', err instanceof Error ? err : undefined)
    return { success: false, error: message }
  }
}

function getEmailConfig(type: OnboardingEmailType, userEmail: string) {
  switch (type) {
    case 'welcome':
      return {
        subject:
          'Welcome to RetireRunway - Your retirement planning journey starts here',
        component: createElement(WelcomeEmail, { userEmail }),
      }
    case 'first-steps':
      return {
        subject: 'Your first steps with RetireRunway',
        component: createElement(FirstStepsEmail, { userEmail }),
      }
    default:
      throw new Error(`Unknown email type: ${type}`)
  }
}
