import type {
  ScenarioResult,
  TradePlan,
  CashLadder,
  Portfolio,
  UserProfile,
} from '@/engine/types'
import type { RiskScoreBreakdown } from '@/engine/risk-scoring'

export interface NarrationContext {
  portfolio: Portfolio
  userProfile: UserProfile
  scenarios: ScenarioResult[]
  riskScore: RiskScoreBreakdown
  tradePlan: TradePlan
  ladderPlan: CashLadder
}

function summarizePortfolio(portfolio: Portfolio): string {
  const totalValue = portfolio.accounts.reduce((sum, a) => {
    const holdings = a.holdings.reduce((s, h) => s + h.currentValue, 0)
    const cds = a.cds.reduce((s, c) => s + c.principal, 0)
    return sum + holdings + cds + a.cashBalance
  }, 0)

  return `Portfolio: ${portfolio.accounts.length} accounts, $${totalValue.toLocaleString()} total value`
}

function summarizeScenarios(scenarios: ScenarioResult[]): string {
  return scenarios
    .map(s => {
      const final = s.projections[s.projections.length - 1]
      return `${s.scenarioType}: ${s.runwayYears}yr runway, ${s.depletionAge ? `depletes at age ${s.depletionAge}` : 'never depletes'}, final balance $${(final?.endBalance ?? 0).toLocaleString()}`
    })
    .join('\n')
}

function summarizeTradePlan(tradePlan: TradePlan): string {
  if (tradePlan.trades.length === 0) return 'No trades recommended.'
  return `${tradePlan.trades.length} trades: $${tradePlan.totalProceeds.toLocaleString()} proceeds, $${tradePlan.totalTaxImpact.toLocaleString()} estimated tax impact. Target cash: $${tradePlan.targetCashPosition.toLocaleString()}.`
}

function summarizeLadder(ladder: CashLadder): string {
  if (ladder.rungs.length === 0) return 'No ladder plan generated.'
  return `${ladder.yearsOfExpensesCovered.toFixed(1)} years covered, $${ladder.totalFunded.toLocaleString()} funded, $${ladder.annualExpenseTarget.toLocaleString()}/yr target.`
}

export function buildNarrationPrompt(ctx: NarrationContext): string {
  return `You are a retirement planning analyst. The user has uploaded their portfolio and run scenario projections through a deterministic engine. Your job is to narrate and explain the results in plain language.

**Important rules:**
- You are explaining pre-computed results, NOT doing any calculations
- Be specific — reference actual numbers from the data
- Be balanced — highlight both strengths and risks
- Keep it actionable — what should the user consider?
- Write 3-5 concise paragraphs
- Do not give specific investment advice or recommendations to buy/sell specific securities
- Include a brief disclaimer at the end

**User Profile:**
Age: ${ctx.userProfile.currentAge}, Target retirement: ${ctx.userProfile.targetRetirementAge}
Annual expenses: $${ctx.userProfile.annualExpenses.toLocaleString()}
${ctx.userProfile.socialSecurityMonthly ? `Social Security: $${ctx.userProfile.socialSecurityMonthly}/mo starting age ${ctx.userProfile.socialSecurityAge}` : 'No Social Security entered'}
${ctx.userProfile.pensionMonthly ? `Pension: $${ctx.userProfile.pensionMonthly}/mo` : ''}

**${summarizePortfolio(ctx.portfolio)}**

**Risk Score:** ${ctx.riskScore.score}/10 (${ctx.riskScore.label})
${ctx.riskScore.description}

**Scenario Results:**
${summarizeScenarios(ctx.scenarios)}

**Trade Plan:** ${summarizeTradePlan(ctx.tradePlan)}

**Cash Ladder:** ${summarizeLadder(ctx.ladderPlan)}

Write a clear, helpful narrative summary of these results for someone planning their retirement.`
}
