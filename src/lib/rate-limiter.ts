/**
 * In-memory rate limiter using sliding window algorithm
 *
 * IMPORTANT: This is an in-memory solution suitable for single-instance deployments.
 * For multi-instance production deployments, use a distributed solution like Upstash Redis.
 */

interface RateLimitConfig {
  /**
   * Maximum number of requests allowed within the window
   */
  maxRequests: number
  /**
   * Time window in milliseconds
   */
  windowMs: number
}

interface RequestRecord {
  timestamps: number[]
}

/**
 * Rate limiter configurations for different route types
 */
export const RATE_LIMIT_CONFIGS = {
  /**
   * AI routes (streaming, narration, what-if)
   * Lower limit due to higher cost per request
   */
  ai: {
    maxRequests: 20,
    windowMs: 60 * 1000, // 1 minute
  },
  /**
   * API routes (CRUD operations, data fetching)
   * Higher limit for normal operations
   */
  api: {
    maxRequests: 100,
    windowMs: 60 * 1000, // 1 minute
  },
  /**
   * Payment routes (Stripe, Plaid)
   * Moderate limit to prevent abuse
   */
  payment: {
    maxRequests: 10,
    windowMs: 60 * 1000, // 1 minute
  },
} as const

export type RateLimitType = keyof typeof RATE_LIMIT_CONFIGS

/**
 * In-memory store for request records
 * Maps identifier (IP or user ID) to their request history
 */
const requestStore = new Map<string, RequestRecord>()

/**
 * Cleanup old entries every 10 minutes to prevent memory leaks
 */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

let cleanupInterval: NodeJS.Timeout | null = null

function startCleanup() {
  if (cleanupInterval) return

  cleanupInterval = setInterval(() => {
    const now = Date.now()
    const maxAge = Math.max(
      ...Object.values(RATE_LIMIT_CONFIGS).map(c => c.windowMs)
    )

    for (const [key, record] of requestStore.entries()) {
      // Remove timestamps older than the maximum window
      record.timestamps = record.timestamps.filter(ts => now - ts < maxAge * 2)

      // Remove entry if no recent requests
      if (record.timestamps.length === 0) {
        requestStore.delete(key)
      }
    }
  }, CLEANUP_INTERVAL_MS)

  // Prevent the interval from keeping the process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref()
  }
}

// Start cleanup on module load
startCleanup()

/**
 * Check if a request should be rate limited
 *
 * @param identifier - Unique identifier (IP address, user ID, etc.)
 * @param config - Rate limit configuration
 * @returns Object with allowed status and metadata
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): {
  allowed: boolean
  remaining: number
  resetAt: number
} {
  const now = Date.now()
  const windowStart = now - config.windowMs

  // Get or create record for this identifier
  let record = requestStore.get(identifier)
  if (!record) {
    record = { timestamps: [] }
    requestStore.set(identifier, record)
  }

  // Remove timestamps outside the current window (sliding window)
  record.timestamps = record.timestamps.filter(ts => ts > windowStart)

  // Calculate remaining requests
  const currentCount = record.timestamps.length
  const remaining = Math.max(0, config.maxRequests - currentCount)

  // Check if limit exceeded
  if (currentCount >= config.maxRequests) {
    // Find when the oldest request in window will expire
    const oldestInWindow = Math.min(...record.timestamps)
    const resetAt = oldestInWindow + config.windowMs

    return {
      allowed: false,
      remaining: 0,
      resetAt,
    }
  }

  // Add current timestamp and allow request
  record.timestamps.push(now)

  return {
    allowed: true,
    remaining: remaining - 1, // Account for current request
    resetAt: now + config.windowMs,
  }
}

/**
 * Get identifier from request (IP address or forwarded IP)
 *
 * @param request - Next.js Request object
 * @returns Identifier string
 */
export function getRequestIdentifier(request: Request): string {
  // Try to get IP from various headers (Vercel, CloudFlare, etc.)
  const forwardedFor = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')
  const cfConnectingIp = request.headers.get('cf-connecting-ip')

  // Use first IP in x-forwarded-for chain
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim()
  }

  if (realIp) {
    return realIp
  }

  if (cfConnectingIp) {
    return cfConnectingIp
  }

  // Fallback to 'unknown' if no IP found (shouldn't happen in production)
  return 'unknown'
}

/**
 * Create rate limit response with appropriate headers
 *
 * @param resetAt - Timestamp when rate limit resets
 * @returns Response object with 429 status
 */
export function createRateLimitResponse(resetAt: number): Response {
  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000)

  return new Response(
    JSON.stringify({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Reset': new Date(resetAt).toISOString(),
      },
    }
  )
}

/**
 * Add rate limit headers to a successful response
 *
 * @param response - Response object to add headers to
 * @param remaining - Number of requests remaining
 * @param resetAt - Timestamp when rate limit resets
 * @returns Response with added headers
 */
export function addRateLimitHeaders(
  response: Response,
  remaining: number,
  resetAt: number
): Response {
  const headers = new Headers(response.headers)
  headers.set('X-RateLimit-Remaining', String(remaining))
  headers.set('X-RateLimit-Reset', new Date(resetAt).toISOString())

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Clear all rate limit records (useful for testing)
 */
export function clearRateLimits(): void {
  requestStore.clear()
}

/**
 * Stop the cleanup interval (useful for testing)
 */
export function stopCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}
