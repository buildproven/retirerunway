'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { usePortfolioStore } from '@/store/portfolio-store'
import { useAuthStore } from '@/store/auth-store'
import {
  savePortfolio,
  loadPortfolios,
  deletePortfolio,
} from '@/lib/supabase/portfolio-service'
import type { SavedPortfolio } from '@/lib/supabase/portfolio-service'

async function fetchSavedList(): Promise<SavedPortfolio[]> {
  try {
    return await loadPortfolios()
  } catch (err) {
    console.error('Unexpected error loading portfolios:', err)
    return []
  }
}

interface PortfolioPersistenceProps {
  onLoadPortfolio: () => void
}

export function PortfolioPersistence({
  onLoadPortfolio,
}: PortfolioPersistenceProps) {
  const user = useAuthStore(s => s.user)
  const portfolio = usePortfolioStore(s => s.portfolio)
  const userProfile = usePortfolioStore(s => s.userProfile)
  const setPortfolio = usePortfolioStore(s => s.setPortfolio)
  const setUserProfile = usePortfolioStore(s => s.setUserProfile)

  const [saved, setSaved] = useState<SavedPortfolio[]>([])
  const [saving, setSaving] = useState(false)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const userId = user?.id ?? null
  const activeUserId = useRef(userId)

  // Loading is derived: true until the list for the current user has arrived.
  const loading = userId !== null && loadedFor !== userId

  useEffect(() => {
    activeUserId.current = userId
    if (!userId) return
    let cancelled = false
    fetchSavedList().then(list => {
      if (cancelled) return
      setSaved(list)
      setLoadedFor(userId)
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  const refreshSaved = useCallback(async () => {
    const requestedFor = activeUserId.current
    const list = await fetchSavedList()
    // Drop the result if the user changed while the request was in flight.
    if (activeUserId.current === requestedFor) setSaved(list)
  }, [])

  const handleSave = useCallback(async () => {
    if (!portfolio) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await savePortfolio(portfolio, userProfile)
      if (result) {
        setMessage('Portfolio saved.')
        await refreshSaved()
      } else {
        setMessage('Failed to save.')
      }
    } catch (err) {
      console.error('Unexpected error saving portfolio:', err)
      setMessage('Failed to save.')
    } finally {
      setSaving(false)
    }
  }, [portfolio, userProfile, refreshSaved])

  const handleLoad = useCallback(
    (item: SavedPortfolio) => {
      setPortfolio(item.portfolio_data)
      if (item.user_profile) {
        setUserProfile(item.user_profile)
      }
      setMessage(`Loaded "${item.name}".`)
      onLoadPortfolio()
    },
    [setPortfolio, setUserProfile, onLoadPortfolio]
  )

  const handleDelete = useCallback(async (id: string) => {
    try {
      const ok = await deletePortfolio(id)
      if (ok) {
        setSaved(prev => prev.filter(p => p.id !== id))
      }
    } catch (err) {
      console.error('Unexpected error deleting portfolio:', err)
    }
  }, [])

  if (!user) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Saved Portfolios
          {portfolio && (
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save Current'}
            </Button>
          )}
        </CardTitle>
        <CardDescription>
          Your portfolios are saved to your account
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {message && (
          <p className="text-sm text-green-600 dark:text-green-400">
            {message}
          </p>
        )}

        {loading && <p className="text-muted-foreground text-sm">Loading...</p>}

        {!loading && saved.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No saved portfolios yet.
          </p>
        )}

        {saved.map(item => (
          <div
            key={item.id}
            className="flex items-center justify-between rounded-md border px-3 py-2"
          >
            <div>
              <p className="text-sm font-medium">{item.name}</p>
              <p className="text-muted-foreground text-xs">
                {new Date(item.updated_at).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleLoad(item)}
              >
                Load
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(item.id)}
                className="text-destructive hover:text-destructive"
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
