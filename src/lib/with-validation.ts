/**
 * Higher-order function to wrap API route handlers with Zod input validation
 */

import { type ZodSchema, ZodError } from 'zod'
import { NextResponse } from 'next/server'

type RouteHandler<T extends Request = Request> = (
  request: T,
  ...args: unknown[]
) => Promise<Response>

/**
 * Wrap an API route handler with input validation using Zod
 *
 * @param handler - The route handler function
 * @param schema - Zod schema to validate the request body against
 * @returns Wrapped handler with validation
 *
 * @example
 * ```ts
 * export const POST = withValidation(
 *   async (request: Request) => {
 *     const body = await request.json()
 *     // body is now validated
 *     return Response.json({ success: true })
 *   },
 *   MyRequestSchema
 * )
 * ```
 */
export function withValidation<T extends Request = Request>(
  handler: RouteHandler<T>,
  schema: ZodSchema
): RouteHandler<T> {
  return async (request: T, ...args: unknown[]) => {
    try {
      // Parse and validate request body
      const body = await request.json()
      const validated = schema.parse(body)

      // Attach validated data to request for handler to use
      // This avoids double-parsing JSON in the handler
      Object.defineProperty(request, 'validatedBody', {
        value: validated,
        writable: false,
        enumerable: true,
      })

      return await handler(request, ...args)
    } catch (error) {
      if (error instanceof ZodError) {
        // Format validation errors for client
        const errors = error.issues.map(err => ({
          path: err.path.join('.'),
          message: err.message,
          code: err.code,
        }))

        return NextResponse.json(
          {
            error: 'Validation failed',
            details: errors,
          },
          { status: 400 }
        )
      }

      // Handle JSON parsing errors
      if (error instanceof SyntaxError) {
        return NextResponse.json(
          {
            error: 'Invalid JSON in request body',
          },
          { status: 400 }
        )
      }

      // Re-throw unexpected errors
      throw error
    }
  }
}

/**
 * Compose multiple higher-order functions (validation, rate limiting, etc.)
 *
 * @example
 * ```ts
 * export const POST = compose(
 *   withRateLimit('ai'),
 *   withValidation(MySchema)
 * )(async (request: Request) => {
 *   // Handler implementation
 * })
 * ```
 */
export function compose<T extends Request = Request>(
  ...wrappers: Array<(handler: RouteHandler<T>) => RouteHandler<T>>
): (handler: RouteHandler<T>) => RouteHandler<T> {
  return (handler: RouteHandler<T>) => {
    return wrappers.reduceRight((wrapped, wrapper) => wrapper(wrapped), handler)
  }
}
