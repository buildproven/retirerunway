import type {
  Portfolio,
  UserProfile,
  TradePlan,
  CashLadder,
} from '@/engine/types'
import {
  generateTradePlan,
  generateMinimalTradePlan,
} from '@/engine/trade-plan'
import { generateLadderPlan } from '@/engine/ladder-plan'
import { generateMarkdownReport } from '@/engine/report-generator'
import type { ScenarioResult } from '@/engine/types'
import type { RiskScoreBreakdown } from '@/engine/risk-scoring'

interface TradePlanConfig {
  targetCashPosition?: number
  maxTrades?: number
  tradeIncrement?: number
  taxRate?: number
}

interface TradePlanAnalysis {
  standardPlan: TradePlan
  minimalPlan: TradePlan
  ladder: CashLadder
}

export function generateTradePlans(
  portfolio: Portfolio,
  profile: UserProfile,
  config?: TradePlanConfig
): TradePlanAnalysis {
  const standardPlan = generateTradePlan(portfolio, profile, config)
  const minimalPlan = generateMinimalTradePlan(portfolio, profile, config)
  const ladder = generateLadderPlan(portfolio, profile)

  return {
    standardPlan,
    minimalPlan,
    ladder,
  }
}

interface ReportContext {
  generatedAt?: string
  portfolio: Portfolio
  userProfile: UserProfile
  scenarios: ScenarioResult[]
  riskScore: RiskScoreBreakdown
  tradePlan: TradePlan
  ladderPlan: CashLadder
}

export function generateReport(context: ReportContext): string {
  return generateMarkdownReport(context)
}
