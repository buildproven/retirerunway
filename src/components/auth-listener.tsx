'use client'

import { useEffect, useRef } from 'react'
import {
  createClient,
  isSupabaseBrowserConfigured,
} from '@/lib/supabase/client'
import { useAuthStore } from '@/store/auth-store'
import { useSubscriptionStore } from '@/store/subscription-store'
import type { AuthChangeEvent, User } from '@supabase/supabase-js'

const WELCOME_EMAIL_SENT_KEY = 'retirerunway_welcome_email_sent'

async function sendWelcomeEmail(email: string) {
  try {
    const response = await fetch('/api/email/send-onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, type: 'welcome' }),
    })
    if (!response.ok) {
      console.warn(
        '[auth] Failed to send welcome email:',
        await response.text()
      )
    }
  } catch (err) {
    console.warn('[auth] Error sending welcome email:', err)
  }
}

function shouldSendWelcomeEmail(user: User): boolean {
  if (!user.email) return false
  const sentEmails = localStorage.getItem(WELCOME_EMAIL_SENT_KEY)
  if (sentEmails) {
    const emails = JSON.parse(sentEmails) as string[]
    if (emails.includes(user.email)) return false
  }
  return true
}

function markWelcomeEmailSent(email: string) {
  const sentEmails = localStorage.getItem(WELCOME_EMAIL_SENT_KEY)
  const emails = sentEmails ? (JSON.parse(sentEmails) as string[]) : []
  if (!emails.includes(email)) {
    emails.push(email)
    localStorage.setItem(WELCOME_EMAIL_SENT_KEY, JSON.stringify(emails))
  }
}

let subscriptionHydrationGeneration = 0

function resetSubscriptionHydration() {
  subscriptionHydrationGeneration += 1
  useSubscriptionStore.getState().reset()
}

async function hydrateSubscription(userId: string) {
  const generation = ++subscriptionHydrationGeneration
  try {
    const response = await fetch('/api/subscription')
    const summary: unknown = response.ok ? await response.json() : null
    if (
      generation !== subscriptionHydrationGeneration ||
      useAuthStore.getState().user?.id !== userId
    ) {
      return
    }
    if (!summary || typeof summary !== 'object') {
      useSubscriptionStore.getState().reset()
      return
    }
    const value = summary as Record<string, unknown>
    if (value.tier !== 'free' && value.tier !== 'pro') {
      useSubscriptionStore.getState().reset()
      return
    }
    useSubscriptionStore.getState().hydrate({
      tier: value.tier,
      stripeCustomerId:
        typeof value.stripeCustomerId === 'string'
          ? value.stripeCustomerId
          : null,
      stripeSubscriptionId:
        typeof value.stripeSubscriptionId === 'string'
          ? value.stripeSubscriptionId
          : null,
      currentPeriodEnd:
        typeof value.currentPeriodEnd === 'string'
          ? value.currentPeriodEnd
          : null,
    })
  } catch {
    if (
      generation === subscriptionHydrationGeneration &&
      useAuthStore.getState().user?.id === userId
    ) {
      useSubscriptionStore.getState().reset()
    }
  }
}

export function AuthListener() {
  const setUser = useAuthStore(s => s.setUser)
  const initialCheckDone = useRef(false)

  useEffect(() => {
    if (!isSupabaseBrowserConfigured()) {
      setUser(null)
      resetSubscriptionHydration()
      initialCheckDone.current = true
      return
    }

    const supabase = createClient()

    supabase.auth
      .getUser()
      .then(({ data: { user } }) => {
        setUser(user)
        if (user) void hydrateSubscription(user.id)
        else resetSubscriptionHydration()
        initialCheckDone.current = true
      })
      .catch(() => {
        setUser(null)
        resetSubscriptionHydration()
        initialCheckDone.current = true
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session) => {
      const user = session?.user ?? null
      setUser(user)
      if (user) void hydrateSubscription(user.id)
      else resetSubscriptionHydration()

      if (
        initialCheckDone.current &&
        event === 'SIGNED_IN' &&
        user?.email &&
        shouldSendWelcomeEmail(user)
      ) {
        markWelcomeEmailSent(user.email)
        sendWelcomeEmail(user.email)
      }
    })

    return () => {
      subscription.unsubscribe()
      resetSubscriptionHydration()
    }
  }, [setUser])

  return null
}
