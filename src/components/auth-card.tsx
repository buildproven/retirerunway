'use client'

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createClient,
  isSupabaseBrowserConfigured,
} from '@/lib/supabase/client'
import { useAuthStore } from '@/store/auth-store'

type AuthMode = 'signin' | 'signup'

export function AuthCard() {
  const authConfigured = isSupabaseBrowserConfigured()
  const user = useAuthStore(s => s.user)
  const setUser = useAuthStore(s => s.setUser)
  const [mode, setMode] = useState<AuthMode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const handleAuth = useCallback(async () => {
    if (!isSupabaseBrowserConfigured()) return

    setLoading(true)
    setError(null)
    setMessage(null)

    const supabase = createClient()

    if (mode === 'signup') {
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      })
      if (signUpError) {
        setError(signUpError.message)
      } else {
        setMessage('Check your email for a confirmation link.')
      }
    } else {
      const { data, error: signInError } =
        await supabase.auth.signInWithPassword({
          email,
          password,
        })
      if (signInError) {
        setError(signInError.message)
      } else {
        setUser(data.user)
      }
    }

    setLoading(false)
  }, [mode, email, password, setUser])

  const handleSignOut = useCallback(async () => {
    if (!isSupabaseBrowserConfigured()) return

    const supabase = createClient()
    await supabase.auth.signOut()
    setUser(null)
  }, [setUser])

  if (!authConfigured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Local-only mode</CardTitle>
          <CardDescription>
            Account sync is not configured. Your analysis remains available in
            this browser.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (user) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Signed in as </span>
            <span className="font-medium">{user.email}</span>
          </div>
          <Button variant="outline" size="sm" onClick={handleSignOut}>
            Sign Out
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {mode === 'signin' ? 'Sign In' : 'Create Account'}
        </CardTitle>
        <CardDescription>
          {mode === 'signin'
            ? 'Sign in to save and load your portfolios'
            : 'Create an account to save your analysis'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="auth-email">Email</Label>
          <Input
            id="auth-email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="auth-password">Password</Label>
          <Input
            id="auth-password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Min 6 characters"
          />
        </div>

        {error && <p className="text-destructive text-sm">{error}</p>}
        {message && (
          <p className="text-sm text-green-600 dark:text-green-400">
            {message}
          </p>
        )}

        <Button
          className="w-full"
          onClick={handleAuth}
          disabled={loading || !email || !password}
        >
          {loading
            ? 'Loading...'
            : mode === 'signin'
              ? 'Sign In'
              : 'Create Account'}
        </Button>

        <p className="text-muted-foreground text-center text-xs">
          {mode === 'signin' ? (
            <>
              No account?{' '}
              <button
                className="text-primary underline"
                onClick={() => {
                  setMode('signup')
                  setError(null)
                  setMessage(null)
                }}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                className="text-primary underline"
                onClick={() => {
                  setMode('signin')
                  setError(null)
                  setMessage(null)
                }}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  )
}
