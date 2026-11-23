import { NextRequest, NextResponse } from 'next/server'
import type { Portfolio, UserProfile } from '@/engine/types'
import { runAllScenarios } from '@/engine/scenarios'
import { calculateSequenceRisk } from '@/engine/risk-scoring'
import {
  generateTradePlan,
  generateMinimalTradePlan,
} from '@/engine/trade-plan'
import { generateLadderPlan } from '@/engine/ladder-plan'
import { runMonteCarlo } from '@/engine/monte-carlo'
import { analyzeRuleOf55 } from '@/engine/rule-of-55'
import { generateAlerts, isCalendarDate } from '@/engine/alerts'
import { withRateLimit } from '@/lib/with-rate-limit'
import { withValidation } from '@/lib/with-validation'
import { AnalyzeRequestSchema } from '@/lib/validation-schemas'
import { logger } from '@/lib/logger'
import { authenticateApiKey } from '@/lib/api-key-auth'

// POST /api/v1/analyze
// Full portfolio analysis endpoint.
// Accepts a portfolio and user profile, returns all engine outputs.

interface AnalyzeRequest {
  portfolio: Portfolio
  userProfile: UserProfile
  options?: {
    includeMonteCarlo?: boolean
    includeAlerts?: boolean
    tradeMode?: 'standard' | 'minimal'
  }
}

async function handlePOST(req: NextRequest & { validatedBody?: unknown }) {
  const auth = authenticateApiKey(req)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const body = req.validatedBody as AnalyzeRequest
    const { portfolio, userProfile, options } = body

    // The schema checks only the YYYY-MM-DD shape; an impossible date such as
    // 2026-13-45 is a client error, not an engine failure.
    if (!isCalendarDate(portfolio.asOfDate)) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: [
            {
              path: 'portfolio.asOfDate',
              message: 'Must be a real calendar date (YYYY-MM-DD)',
              code: 'invalid_date',
            },
          ],
        },
        { status: 400 }
      )
    }

    const scenarios = runAllScenarios(portfolio, userProfile)
    const riskScore = calculateSequenceRisk(portfolio, userProfile)
    const tradePlan =
      options?.tradeMode === 'standard'
        ? generateTradePlan(portfolio, userProfile)
        : generateMinimalTradePlan(portfolio, userProfile)
    const ladderPlan = generateLadderPlan(portfolio, userProfile)
    const ruleOf55 = analyzeRuleOf55(portfolio, userProfile)

    const result: Record<string, unknown> = {
      scenarios,
      riskScore,
      tradePlan,
      ladderPlan,
      ruleOf55,
    }

    if (options?.includeMonteCarlo !== false) {
      result.monteCarlo = runMonteCarlo(portfolio, userProfile)
    }

    if (options?.includeAlerts !== false) {
      // One as-of date for the whole request: the portfolio snapshot date, so
      // the same body always yields the same alerts (NFR-01).
      result.alerts = generateAlerts(
        portfolio,
        userProfile,
        undefined,
        portfolio.asOfDate
      )
    }

    return NextResponse.json(result)
  } catch (error) {
    logger.error('API analyze error', error)
    return NextResponse.json(
      { error: 'Analysis failed. Check your input data.' },
      { status: 500 }
    )
  }
}

export const POST = withRateLimit(
  withValidation(handlePOST, AnalyzeRequestSchema),
  'api'
)
