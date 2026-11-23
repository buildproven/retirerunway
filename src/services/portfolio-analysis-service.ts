import type { Portfolio, UserProfile } from '@/engine/types'
import type { RuleOf55Result } from '@/engine/rule-of-55'
import { analyzeRuleOf55 } from '@/engine/rule-of-55'

export function getRuleOf55Analysis(
  portfolio: Portfolio,
  profile: UserProfile
): RuleOf55Result {
  return analyzeRuleOf55(portfolio, profile)
}
