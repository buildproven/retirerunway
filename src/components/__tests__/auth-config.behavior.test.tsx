import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthCard } from '../auth-card'
import { AuthListener } from '../auth-listener'
import { SyncStatusIndicator } from '../sync-status-indicator'
import { useAuthStore } from '@/store/auth-store'
import { useSubscriptionStore } from '@/store/subscription-store'
import type { SyncStatus } from '@/hooks/use-portfolio-persistence'

const authClient = vi.hoisted(() => ({
  configured: false,
  isConfigured: vi.fn(() => authClient.configured),
  create: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: authClient.create,
  isSupabaseBrowserConfigured: authClient.isConfigured,
}))

const baseIndicatorProps: {
  status: SyncStatus
  lastSyncedAt: Date | null
  error: string | null
  isLoading: boolean
} = {
  status: 'offline',
  lastSyncedAt: null,
  error: null,
  isLoading: false,
}

describe('browser auth configuration behavior', () => {
  beforeEach(() => {
    authClient.configured = false
    authClient.create.mockReset()
    useAuthStore.setState({ user: null, loading: true })
    useSubscriptionStore.getState().reset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the app local-only when Supabase is not configured', async () => {
    render(<AuthListener />)

    await waitFor(() => {
      expect(useAuthStore.getState().loading).toBe(false)
    })

    expect(authClient.create).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('does not render interactive auth controls without configuration', () => {
    render(<AuthCard />)

    expect(screen.getByText('Local-only mode')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign In' })).toBeNull()
  })

  it('shows local-only sync state instead of an auth invitation', () => {
    render(<SyncStatusIndicator {...baseIndicatorProps} />)

    expect(screen.getByText('Local only')).toBeInTheDocument()
    expect(screen.queryByText('Sign in to sync')).toBeNull()
  })

  it('invites configured signed-out users to sign in', () => {
    authClient.configured = true

    render(<SyncStatusIndicator {...baseIndicatorProps} />)

    expect(screen.getByText('Sign in to sync')).toBeInTheDocument()
    expect(screen.queryByText('Local only')).toBeNull()
  })

  it.each(['syncing', 'synced', 'error'] as SyncStatus[])(
    'does not show stale cloud state to signed-out users when status is %s',
    status => {
      authClient.configured = true

      render(<SyncStatusIndicator {...baseIndicatorProps} status={status} />)

      expect(screen.getByText('Sign in to sync')).toBeInTheDocument()
      expect(screen.queryByText('Saving...')).toBeNull()
      expect(screen.queryByText(/Saved/)).toBeNull()
    }
  )

  it('shows saved state for a configured authenticated user', () => {
    authClient.configured = true
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com' } as never,
      loading: false,
    })

    render(
      <SyncStatusIndicator
        {...baseIndicatorProps}
        status="synced"
        lastSyncedAt={new Date()}
      />
    )

    expect(screen.getByText(/Saved/)).toBeInTheDocument()
  })

  it('shows authenticated offline state as locally saved and unsynced', () => {
    authClient.configured = true
    useAuthStore.setState({
      user: { id: 'user-1', email: 'user@example.com' } as never,
      loading: false,
    })

    render(<SyncStatusIndicator {...baseIndicatorProps} />)

    expect(
      screen.getByText('Offline — saved locally, not synced')
    ).toBeInTheDocument()
  })

  it('retains Supabase auth initialization when configured', async () => {
    authClient.configured = true
    const unsubscribe = vi.fn()
    const getUser = vi.fn().mockResolvedValue({ data: { user: null } })
    const onAuthStateChange = vi.fn().mockReturnValue({
      data: { subscription: { unsubscribe } },
    })
    authClient.create.mockReturnValue({
      auth: { getUser, onAuthStateChange },
    })

    const { unmount } = render(<AuthListener />)

    await waitFor(() => {
      expect(getUser).toHaveBeenCalledTimes(1)
    })
    expect(onAuthStateChange).toHaveBeenCalledTimes(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
