/**
 * Higher-order function to wrap API route handlers with authentication
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { User } from '@supabase/supabase-js'

type RouteHandler<T extends Request = Request> = (
  request: T,
  ...args: unknown[]
) => Promise<Response>

export interface AuthenticatedRequest extends Request {
  user: User
}

function isSupabaseConfigurationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SUPABASE_CONFIGURATION_ERROR'
  )
}

/**
 * Read the user id attached by withAuth without trusting an unchecked cast at
 * a downstream route boundary. Every paid route should fail closed if a
 * wrapper is reordered or a request is constructed outside the normal stack.
 */
export function getAuthenticatedUserId(request: Request): string | undefined {
  const candidate = (request as Request & { user?: unknown }).user
  if (!candidate || typeof candidate !== 'object') return undefined
  const id = (candidate as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Wrap an API route handler with authentication check
 *
 * @param handler - The route handler function
 * @returns Wrapped handler with authentication
 *
 * @example
 * ```ts
 * export const POST = withAuth(
 *   async (request: AuthenticatedRequest) => {
 *     const { user } = request
 *     // user is guaranteed to exist here
 *     return Response.json({ userId: user.id })
 *   }
 * )
 * ```
 */
export function withAuth<T extends Request = Request>(
  handler: RouteHandler<T>
): RouteHandler<T> {
  return async (request: T, ...args: unknown[]) => {
    let supabase: Awaited<ReturnType<typeof createClient>>
    try {
      supabase = await createClient()
    } catch (error) {
      if (isSupabaseConfigurationError(error)) {
        return NextResponse.json(
          { error: 'Authentication service is not configured' },
          { status: 503 }
        )
      }
      throw error
    }
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()

    // Check for authentication errors
    if (error) {
      return NextResponse.json(
        {
          error: 'Authentication failed',
          details: error.message,
        },
        { status: 401 }
      )
    }

    // Check if user exists
    if (!user) {
      return NextResponse.json(
        {
          error: 'Unauthorized',
          message: 'Authentication required',
        },
        { status: 401 }
      )
    }

    // Attach user to request for handler to use
    Object.defineProperty(request, 'user', {
      value: user,
      writable: false,
      enumerable: true,
    })

    // Execute handler - let exceptions propagate
    return await handler(request, ...args)
  }
}
