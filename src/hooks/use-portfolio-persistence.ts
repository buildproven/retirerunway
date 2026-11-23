'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import { useAuthStore } from '@/store/auth-store'
import { usePortfolioStore } from '@/store/portfolio-store'
import { savePortfolio, loadPortfolios } from '@/lib/supabase/portfolio-service'
import type { Portfolio, UserProfile } from '@/engine/types'

const LOCAL_STORAGE_KEY = 'retirerunway_portfolio'
const LOCAL_STORAGE_PROFILE_KEY = 'retirerunway_userprofile'
const DEBOUNCE_MS = 2000

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline'

interface SyncState {
  syncStatus: SyncStatus
  lastSyncedAt: Date | null
  error: string | null
  isLoading: boolean
}

let syncState: SyncState = {
  syncStatus: 'idle',
  lastSyncedAt: null,
  error: null,
  isLoading: false,
}

const listeners = new Set<() => void>()

function notifyListeners() {
  listeners.forEach(listener => listener())
}

function setSyncState(update: Partial<SyncState>) {
  syncState = { ...syncState, ...update }
  notifyListeners()
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function getSnapshot() {
  return syncState
}

function getServerSnapshot() {
  return syncState
}

function saveToLocalStorage(
  portfolio: Portfolio | null,
  userProfile: UserProfile | null
) {
  if (typeof window === 'undefined') return

  if (portfolio) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(portfolio))
  } else {
    localStorage.removeItem(LOCAL_STORAGE_KEY)
  }

  if (userProfile) {
    localStorage.setItem(LOCAL_STORAGE_PROFILE_KEY, JSON.stringify(userProfile))
  } else {
    localStorage.removeItem(LOCAL_STORAGE_PROFILE_KEY)
  }
}

function loadFromLocalStorage(): {
  portfolio: Portfolio | null
  userProfile: UserProfile | null
} {
  if (typeof window === 'undefined')
    return { portfolio: null, userProfile: null }

  try {
    const portfolioStr = localStorage.getItem(LOCAL_STORAGE_KEY)
    const profileStr = localStorage.getItem(LOCAL_STORAGE_PROFILE_KEY)

    return {
      portfolio: portfolioStr ? JSON.parse(portfolioStr) : null,
      userProfile: profileStr ? JSON.parse(profileStr) : null,
    }
  } catch {
    return { portfolio: null, userProfile: null }
  }
}

export function usePortfolioPersistence() {
  const user = useAuthStore(s => s.user)
  const authLoading = useAuthStore(s => s.loading)
  const portfolio = usePortfolioStore(s => s.portfolio)
  const userProfile = usePortfolioStore(s => s.userProfile)
  const setPortfolio = usePortfolioStore(s => s.setPortfolio)
  const setUserProfile = usePortfolioStore(s => s.setUserProfile)

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const initialLoadDoneRef = useRef(false)
  const previousUserRef = useRef<string | null>(null)

  const status: SyncStatus = useMemo(() => {
    if (!user && !authLoading) return 'offline'
    return state.syncStatus
  }, [user, authLoading, state.syncStatus])

  const saveToSupabase = useCallback(
    async (p: Portfolio, up: UserProfile | null) => {
      if (!user) return false

      setSyncState({ syncStatus: 'syncing', error: null })

      try {
        const result = await savePortfolio(p, up)
        if (result) {
          lastSavedRef.current = JSON.stringify({
            portfolio: p,
            userProfile: up,
          })
          setSyncState({
            syncStatus: 'synced',
            lastSyncedAt: new Date(),
            error: null,
          })
          return true
        } else {
          setSyncState({
            syncStatus: 'error',
            error: 'Failed to save portfolio',
          })
          return false
        }
      } catch (err) {
        console.error('Error saving to Supabase:', err)
        setSyncState({
          syncStatus: 'error',
          error: 'Failed to save portfolio',
        })
        return false
      }
    },
    [user]
  )

  const loadFromSupabase = useCallback(async (): Promise<boolean> => {
    if (!user) return false

    setSyncState({ isLoading: true, error: null })

    try {
      const portfolios = await loadPortfolios()

      if (portfolios.length > 0) {
        const latest = portfolios[0]
        setPortfolio(latest.portfolio_data)
        if (latest.user_profile) {
          setUserProfile(latest.user_profile)
        }
        lastSavedRef.current = JSON.stringify({
          portfolio: latest.portfolio_data,
          userProfile: latest.user_profile,
        })
        setSyncState({
          isLoading: false,
          syncStatus: 'synced',
          lastSyncedAt: new Date(latest.updated_at),
        })
        return true
      }

      setSyncState({ isLoading: false, syncStatus: 'idle' })
      return false
    } catch (err) {
      console.error('Error loading from Supabase:', err)
      setSyncState({
        isLoading: false,
        syncStatus: 'error',
        error: 'Failed to load portfolio',
      })
      return false
    }
  }, [user, setPortfolio, setUserProfile])

  useEffect(() => {
    if (authLoading || initialLoadDoneRef.current) return

    const loadInitialData = async () => {
      initialLoadDoneRef.current = true

      if (user) {
        const loaded = await loadFromSupabase()

        if (!loaded) {
          const local = loadFromLocalStorage()
          if (local.portfolio) {
            setPortfolio(local.portfolio)
            if (local.userProfile) {
              setUserProfile(local.userProfile)
            }
            await saveToSupabase(local.portfolio, local.userProfile)
          }
        }
      } else {
        const local = loadFromLocalStorage()
        if (local.portfolio) {
          setPortfolio(local.portfolio)
          if (local.userProfile) {
            setUserProfile(local.userProfile)
          }
        }
      }
    }

    loadInitialData()
  }, [
    user,
    authLoading,
    loadFromSupabase,
    saveToSupabase,
    setPortfolio,
    setUserProfile,
  ])

  useEffect(() => {
    if (!portfolio || authLoading) return

    saveToLocalStorage(portfolio, userProfile)

    if (!user) return

    const currentData = JSON.stringify({ portfolio, userProfile })
    if (currentData === lastSavedRef.current) return

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    setSyncState({ syncStatus: 'syncing' })

    debounceTimerRef.current = setTimeout(() => {
      saveToSupabase(portfolio, userProfile)
    }, DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [portfolio, userProfile, user, authLoading, saveToSupabase])

  useEffect(() => {
    if (authLoading) return

    const currentUserId = user?.id ?? null
    const prevUserId = previousUserRef.current

    if (currentUserId !== prevUserId) {
      previousUserRef.current = currentUserId

      if (currentUserId && initialLoadDoneRef.current) {
        loadFromSupabase()
      }
    }
  }, [user, authLoading, loadFromSupabase])

  const forceSync = useCallback(async () => {
    if (!user || !portfolio) return false
    return saveToSupabase(portfolio, userProfile)
  }, [user, portfolio, userProfile, saveToSupabase])

  return {
    status,
    lastSyncedAt: state.lastSyncedAt,
    error: state.error,
    isLoading: state.isLoading,
    forceSync,
  }
}
