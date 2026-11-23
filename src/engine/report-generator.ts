import type {
  Portfolio,
  UserProfile,
  ScenarioResult,
  TradePlan,
  CashLadder,
} from './types'
import type { RiskScoreBreakdown } from './risk-scoring'

export interface ReportData {
  /** Stable report timestamp supplied by the caller; never read the wall clock here. */
  generatedAt?: string
  portfolio: Portfolio
  userProfile: UserProfile
  scenarios: ScenarioResult[]
  riskScore: RiskScoreBreakdown
  tradePlan: TradePlan
  ladderPlan: CashLadder
}

function fmt(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function generateMarkdownReport(data: ReportData): string {
  const {
    portfolio,
    userProfile,
    scenarios,
    riskScore,
    tradePlan,
    ladderPlan,
  } = data

  const totalValue = portfolio.accounts.reduce((sum, a) => {
    const holdings = a.holdings.reduce((s, h) => s + h.currentValue, 0)
    const cds = a.cds.reduce((s, c) => s + c.principal, 0)
    return sum + holdings + cds + a.cashBalance
  }, 0)

  const lines: string[] = []

  lines.push('# RetireRunway — Portfolio Analysis Report')
  lines.push('')
  lines.push(`**Generated:** ${data.generatedAt ?? portfolio.asOfDate}`)
  lines.push(`**Portfolio:** ${portfolio.name}`)
  lines.push(`**As of:** ${portfolio.asOfDate}`)
  lines.push('')

  // Profile summary
  lines.push('## Profile')
  lines.push('')
  lines.push(`| Field | Value |`)
  lines.push(`| --- | --- |`)
  lines.push(`| Current Age | ${userProfile.currentAge} |`)
  lines.push(`| Target Retirement Age | ${userProfile.targetRetirementAge} |`)
  lines.push(`| Annual Expenses | ${fmt(userProfile.annualExpenses)} |`)
  lines.push(
    `| Federal Tax Bracket | ${pct(userProfile.federalTaxBracket ?? 0.22)} |`
  )
  if (userProfile.socialSecurityMonthly) {
    lines.push(
      `| Social Security | ${fmt(userProfile.socialSecurityMonthly)}/mo starting age ${userProfile.socialSecurityAge ?? 67} |`
    )
  }
  if (userProfile.pensionMonthly) {
    lines.push(`| Pension | ${fmt(userProfile.pensionMonthly)}/mo |`)
  }
  lines.push('')

  // Portfolio summary
  lines.push('## Portfolio Summary')
  lines.push('')
  lines.push(`**Total Value:** ${fmt(totalValue)}`)
  lines.push(`**Accounts:** ${portfolio.accounts.length}`)
  lines.push('')

  for (const account of portfolio.accounts) {
    const accTotal =
      account.holdings.reduce((s, h) => s + h.currentValue, 0) +
      account.cds.reduce((s, c) => s + c.principal, 0) +
      account.cashBalance

    lines.push(
      `### ${account.name} (${account.accountType.replace(/_/g, ' ')}) — ${fmt(accTotal)}`
    )
    lines.push('')

    if (account.holdings.length > 0) {
      lines.push('| Symbol | Name | Asset Class | Value |')
      lines.push('| --- | --- | --- | ---: |')
      for (const h of account.holdings) {
        lines.push(
          `| ${h.symbol} | ${h.name} | ${h.assetClass.replace(/_/g, ' ')} | ${fmt(h.currentValue)} |`
        )
      }
      lines.push('')
    }

    if (account.cashBalance > 0) {
      lines.push(`**Cash:** ${fmt(account.cashBalance)}`)
      lines.push('')
    }
  }

  // Risk score
  lines.push('## Sequence-of-Returns Risk')
  lines.push('')
  lines.push(`**Score:** ${riskScore.score}/10 (${riskScore.label})`)
  lines.push('')
  lines.push(riskScore.description)
  lines.push('')

  // Scenario results
  lines.push('## Scenario Projections')
  lines.push('')
  lines.push('| Scenario | Runway (Years) | Depletion Age | Final Balance |')
  lines.push('| --- | ---: | ---: | ---: |')

  const labelMap: Record<string, string> = {
    bull: 'Bull Market',
    base: 'Base Case',
    early_bear: 'Early Bear',
    prolonged_bear: 'Prolonged Bear',
  }

  for (const s of scenarios) {
    const final = s.projections[s.projections.length - 1]
    lines.push(
      `| ${labelMap[s.scenarioType] ?? s.scenarioType} | ${s.runwayYears} | ${s.depletionAge ?? '—'} | ${fmt(final?.endBalance ?? 0)} |`
    )
  }
  lines.push('')

  // Trade plan
  if (tradePlan.trades.length > 0) {
    lines.push('## De-Risk Trade Plan')
    lines.push('')
    lines.push(`**Target Cash Position:** ${fmt(tradePlan.targetCashPosition)}`)
    lines.push('')
    lines.push('| # | Value | Tax Impact | Rationale |')
    lines.push('| ---: | ---: | ---: | --- |')

    for (const t of tradePlan.trades) {
      lines.push(
        `| ${t.priority} | ${fmt(t.estimatedValue)} | ${fmt(t.estimatedTaxImpact)} | ${t.rationale} |`
      )
    }
    lines.push('')
    lines.push(
      `**Total Proceeds:** ${fmt(tradePlan.totalProceeds)} · **Tax Impact:** ${fmt(tradePlan.totalTaxImpact)}`
    )
    lines.push('')
  }

  // Ladder plan
  if (ladderPlan.rungs.length > 0) {
    lines.push('## Cash Ladder Plan')
    lines.push('')
    lines.push(
      `**Coverage:** ${ladderPlan.yearsOfExpensesCovered.toFixed(1)} years · **Target:** ${fmt(ladderPlan.annualExpenseTarget)}/yr`
    )
    lines.push('')
    lines.push('| Year | Source | Amount |')
    lines.push('| ---: | --- | ---: |')

    for (const r of ladderPlan.rungs) {
      lines.push(
        `| ${r.year} | ${r.source.replace(/_/g, ' ')} | ${fmt(r.amount)} |`
      )
    }
    lines.push('')
    lines.push(`**Total Funded:** ${fmt(ladderPlan.totalFunded)}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    '*This report is for informational purposes only and does not constitute financial advice. Past performance does not guarantee future results.*'
  )
  lines.push('')

  return lines.join('\n')
}
