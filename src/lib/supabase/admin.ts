import { createClient as createSupabaseClient } from '@supabase/supabase-js'

/**
 * The service-role client is server-only. Keep this module out of client
 * bundles; its key bypasses RLS and must never be exposed to a browser.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase service-role configuration is missing')
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
