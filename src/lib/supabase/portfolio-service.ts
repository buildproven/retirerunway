import type { Portfolio, UserProfile } from '@/engine/types'
import { createClient } from './client'
import { logger } from '@/lib/logger'

export interface SavedPortfolio {
  id: string
  user_id: string
  name: string
  portfolio_data: Portfolio
  user_profile: UserProfile | null
  created_at: string
  updated_at: string
}

export async function savePortfolio(
  portfolio: Portfolio,
  userProfile: UserProfile | null
): Promise<SavedPortfolio | null> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  const { data, error } = await supabase
    .from('portfolios')
    .upsert(
      {
        id: portfolio.id,
        user_id: user.id,
        name: portfolio.name,
        portfolio_data: portfolio,
        user_profile: userProfile,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
    .select()
    .single()

  if (error) {
    logger.error('Failed to save portfolio', undefined, {
      error: error.message,
    })
    return null
  }

  return data as SavedPortfolio
}

export async function loadPortfolios(): Promise<SavedPortfolio[]> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return []

  const { data, error } = await supabase
    .from('portfolios')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })

  if (error) {
    logger.error('Failed to load portfolios', undefined, {
      error: error.message,
    })
    return []
  }

  return (data ?? []) as SavedPortfolio[]
}

export async function deletePortfolio(id: string): Promise<boolean> {
  const supabase = createClient()

  const { error } = await supabase.from('portfolios').delete().eq('id', id)

  if (error) {
    logger.error('Failed to delete portfolio', undefined, {
      error: error.message,
    })
    return false
  }

  return true
}
