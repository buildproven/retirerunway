import { streamText } from 'ai'
import { buildNarrationPrompt } from '@/ai/narration'
import { createModel } from '@/ai/byok-adapter'
import type { Provider } from '@/ai/byok-adapter'
import type { NarrationContext } from '@/ai/narration'
import { withRateLimit } from '@/lib/with-rate-limit'
import { withValidation, compose } from '@/lib/with-validation'
import { getAuthenticatedUserId, withAuth } from '@/lib/with-auth'
import { NarrateRequestSchema } from '@/lib/validation-schemas'
import { requireProAccess } from '@/lib/subscription-access'

interface NarrateRequest {
  context: NarrationContext
  provider: Provider
  apiKey: string
  model?: string
}

async function handlePOST(request: Request & { validatedBody?: unknown }) {
  const userId = getAuthenticatedUserId(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const gateResponse = await requireProAccess(userId)
  if (gateResponse) return gateResponse
  const body = request.validatedBody as NarrateRequest
  const { context, provider, apiKey, model } = body

  const prompt = buildNarrationPrompt(context)
  const llmModel = createModel(provider, apiKey, model)

  const result = streamText({
    model: llmModel,
    prompt,
    maxOutputTokens: 1000,
  })

  return result.toTextStreamResponse()
}

export const POST = compose(
  withAuth,
  handler => withRateLimit(handler, 'ai'),
  handler => withValidation(handler, NarrateRequestSchema)
)(handlePOST)
