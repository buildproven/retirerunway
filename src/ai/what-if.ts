import type { UserProfile } from '@/engine/types'
import type { Provider } from '@/ai/byok-adapter'

export interface WhatIfOverrides {
  targetRetirementAge?: number
  annualExpenses?: number
  socialSecurityAge?: number
  socialSecurityMonthly?: number
  pensionMonthly?: number
  otherIncomeMonthly?: number
}

export interface WhatIfRequest {
  question: string
  currentProfile: UserProfile
  provider: Provider
  apiKey: string
}

export interface WhatIfResponse {
  overrides: WhatIfOverrides
  explanation: string
}

export function buildWhatIfPrompt(
  question: string,
  profile: UserProfile
): string {
  return `You are a parameter extraction engine for a retirement planning tool. The user asks a "what if" question and you must extract the specific numeric changes to their retirement profile.

**Current Profile:**
- Current age: ${profile.currentAge}
- Target retirement age: ${profile.targetRetirementAge}
- Annual expenses: $${profile.annualExpenses.toLocaleString()}
- Social Security: ${profile.socialSecurityMonthly ? `$${profile.socialSecurityMonthly}/mo starting age ${profile.socialSecurityAge}` : 'not set'}
- Pension: ${profile.pensionMonthly ? `$${profile.pensionMonthly}/mo` : 'not set'}
- Other income: ${profile.otherIncomeMonthly ? `$${profile.otherIncomeMonthly}/mo` : 'not set'}

**User Question:** "${question}"

Respond with ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "overrides": {
    // Only include fields that the question changes. Use null for unchanged fields.
    "targetRetirementAge": <number or null>,
    "annualExpenses": <number or null>,
    "socialSecurityAge": <number or null>,
    "socialSecurityMonthly": <number or null>,
    "pensionMonthly": <number or null>,
    "otherIncomeMonthly": <number or null>
  },
  "explanation": "<one sentence describing what changed, e.g. 'Retirement age moved from 60 to 57'>"
}`
}
