/**
 * Higher-order function to wrap API route handlers with rate limiting
 */

import {
  checkRateLimit,
  getRequestIdentifier,
  createRateLimitResponse,
  addRateLimitHeaders,
  RATE_LIMIT_CONFIGS,
  type RateLimitType,
} from './rate-limiter'

type RouteHandler<T extends Request = Request> = (
  request: T,
  ...args: unknown[]
) => Promise<Response>

/**
 * Wrap an API route handler with rate limiting
 *
 * @param handler - The route handler function
 * @param limitType - Type of rate limit to apply
 * @returns Wrapped handler with rate limiting
 *
 * @example
 * ```ts
 * export const POST = withRateLimit(
 *   async (request: Request) => {
 *     // Your handler logic
 *     return Response.json({ success: true })
 *   },
 *   'ai'
 * )
 * ```
 */
export function withRateLimit<T extends Request = Request>(
  handler: RouteHandler<T>,
  limitType: RateLimitType = 'api'
): RouteHandler<T> {
  return async (request: T, ...args: unknown[]) => {
    const identifier = getRequestIdentifier(request)
    const config = RATE_LIMIT_CONFIGS[limitType]

    // Check rate limit
    const { allowed, remaining, resetAt } = checkRateLimit(identifier, config)

    // If rate limited, return 429 response
    if (!allowed) {
      return createRateLimitResponse(resetAt)
    }

    // Execute the handler
    const response = await handler(request, ...args)

    // Add rate limit headers to successful response
    return addRateLimitHeaders(response, remaining, resetAt)
  }
}
