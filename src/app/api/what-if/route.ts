import { generateText } from 'ai'
import { buildWhatIfPrompt } from '@/ai/what-if'
import { createModel } from '@/ai/byok-adapter'
import type { Provider } from '@/ai/byok-adapter'
import type {
  WhatIfRequest,
  WhatIfResponse,
  WhatIfOverrides,
} from '@/ai/what-if'
import { withRateLimit } from '@/lib/with-rate-limit'
import { withValidation, compose } from '@/lib/with-validation'
import { getAuthenticatedUserId, withAuth } from '@/lib/with-auth'
import {
  UserProfileSchema,
  WhatIfModelResponseSchema,
  WhatIfRequestSchema,
} from '@/lib/validation-schemas'
import { requireProAccess } from '@/lib/subscription-access'

interface WhatIfApiRequest extends WhatIfRequest {
  provider: Provider
  apiKey: string
}

async function handlePOST(request: Request & { validatedBody?: unknown }) {
  const userId = getAuthenticatedUserId(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const gateResponse = await requireProAccess(userId)
  if (gateResponse) return gateResponse
  const body = request.validatedBody as WhatIfApiRequest
  const { question, currentProfile, provider, apiKey } = body

  const prompt = buildWhatIfPrompt(question, currentProfile)
  const llmModel = createModel(provider, apiKey)

  const result = await generateText({
    model: llmModel,
    prompt,
    maxOutputTokens: 300,
  })

  const parsed = parseWhatIfResponse(result.text, currentProfile)
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 422 })
  }

  return Response.json(parsed.response)
}

type ParsedWhatIfResponse =
  | { ok: true; response: WhatIfResponse }
  | { ok: false; error: string }

function parseWhatIfResponse(
  text: string,
  currentProfile: WhatIfRequest['currentProfile']
): ParsedWhatIfResponse {
  const cleaned = text
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim()

  let rawResponse: unknown
  try {
    rawResponse = JSON.parse(cleaned)
  } catch {
    return {
      ok: false,
      error:
        'The generated what-if change was not valid JSON and was not applied. Please rephrase your question.',
    }
  }

  const parsedResponse = WhatIfModelResponseSchema.safeParse(rawResponse)
  if (!parsedResponse.success) {
    return {
      ok: false,
      error:
        'The generated what-if change had invalid values and was not applied. Please rephrase your question.',
    }
  }

  const overrides: WhatIfOverrides = parsedResponse.data.overrides
  const mergedProfile = UserProfileSchema.safeParse({
    ...currentProfile,
    ...overrides,
  })
  if (!mergedProfile.success) {
    return {
      ok: false,
      error:
        'The generated what-if change was inconsistent with your profile and was not applied. Please rephrase your question.',
    }
  }

  return {
    ok: true,
    response: {
      overrides,
      explanation:
        parsedResponse.data.explanation ?? 'Parameter changes extracted.',
    },
  }
}

export const POST = compose(
  withAuth,
  handler => withRateLimit(handler, 'ai'),
  handler => withValidation(handler, WhatIfRequestSchema)
)(handlePOST)
