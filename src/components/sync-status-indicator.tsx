'use client'

import { useAuthStore } from '@/store/auth-store'
import { isSupabaseBrowserConfigured } from '@/lib/supabase/client'
import type { SyncStatus } from '@/hooks/use-portfolio-persistence'

interface SyncStatusIndicatorProps {
  status: SyncStatus
  lastSyncedAt: Date | null
  error: string | null
  isLoading: boolean
  onRetry?: () => void
}

function formatLastSynced(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)

  if (diffSecs < 10) return 'just now'
  if (diffSecs < 60) return `${diffSecs}s ago`
  if (diffMins < 60) return `${diffMins}m ago`

  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function SyncStatusIndicator({
  status,
  lastSyncedAt,
  error,
  isLoading,
  onRetry,
}: SyncStatusIndicatorProps) {
  const user = useAuthStore(s => s.user)
  const authConfigured = isSupabaseBrowserConfigured()

  if (!authConfigured) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CloudOffIcon />
        <span>Local only</span>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CloudOffIcon />
        <span>Sign in to sync</span>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoadingSpinner />
        <span>Loading...</span>
      </div>
    )
  }

  if (status === 'offline') {
    return (
      <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
        <CloudOffIcon />
        <span>Offline — saved locally, not synced</span>
      </div>
    )
  }

  if (status === 'syncing') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoadingSpinner />
        <span>Saving...</span>
      </div>
    )
  }

  if (status === 'synced' && lastSyncedAt) {
    return (
      <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
        <CheckIcon />
        <span>Saved {formatLastSynced(lastSyncedAt)}</span>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive">
        <ErrorIcon />
        <span>{error || 'Sync failed'}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="ml-1 underline hover:no-underline"
          >
            Retry
          </button>
        )}
      </div>
    )
  }

  return null
}

function LoadingSpinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
      />
    </svg>
  )
}

function CloudOffIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 3l18 18M10.5 6.5a5.5 5.5 0 017.778 7.778M6 10a5.002 5.002 0 00-1 9.9M6 10a5 5 0 01.34-1.8"
      />
    </svg>
  )
}
