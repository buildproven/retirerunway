'use client'

import { createContext, useContext, type ReactNode } from 'react'
import {
  usePortfolioPersistence,
  type SyncStatus,
} from '@/hooks/use-portfolio-persistence'

interface PortfolioPersistenceContextValue {
  status: SyncStatus
  lastSyncedAt: Date | null
  error: string | null
  isLoading: boolean
  forceSync: () => Promise<boolean>
}

const PortfolioPersistenceContext =
  createContext<PortfolioPersistenceContextValue | null>(null)

export function PortfolioPersistenceProvider({
  children,
}: {
  children: ReactNode
}) {
  const persistence = usePortfolioPersistence()

  return (
    <PortfolioPersistenceContext.Provider value={persistence}>
      {children}
    </PortfolioPersistenceContext.Provider>
  )
}

export function usePersistenceContext() {
  const context = useContext(PortfolioPersistenceContext)
  if (!context) {
    throw new Error(
      'usePersistenceContext must be used within PortfolioPersistenceProvider'
    )
  }
  return context
}
