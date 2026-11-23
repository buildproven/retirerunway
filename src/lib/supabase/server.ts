import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const SUPABASE_CONFIGURATION_ERROR = 'SUPABASE_CONFIGURATION_ERROR' as const

export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    const error = new Error('Supabase server configuration is missing')
    Object.assign(error, { code: SUPABASE_CONFIGURATION_ERROR })
    throw error
  }

  const cookieStore = await cookies()

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          // Server Component — ignore write failures
        }
      },
    },
  })
}
