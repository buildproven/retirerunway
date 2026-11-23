import type { Portfolio, UserProfile } from '@/engine/types'
import {
  calculateSequenceRisk,
  type RiskScoreBreakdown,
} from '@/engine/risk-scoring'

export function getSequenceOfReturnsRisk(
  portfolio: Portfolio,
  profile: UserProfile
): RiskScoreBreakdown {
  return calculateSequenceRisk(portfolio, profile)
}
