import type { Portfolio, UserProfile, RiskLevel } from './types'
import { calculatePortfolioTotals } from './portfolio-math'
import {
  EQUITY_ALLOCATION_THRESHOLDS,
  WITHDRAWAL_RATE_THRESHOLDS,
  CASH_BUFFER_THRESHOLDS,
  CONCENTRATION_THRESHOLDS,
} from './config'

interface RiskFactors {
  equityAllocation: number
  withdrawalRate: number
  yearsToRetirement: number
  cashBufferYears: number
  concentrationPenalty: number
}

export interface RiskScoreBreakdown {
  score: RiskLevel
  factors: RiskFactors
  label: string
  description: string
}

function scoreEquityAllocation(equityPct: number): number {
  if (equityPct >= EQUITY_ALLOCATION_THRESHOLDS.VERY_HIGH) return 10
  if (equityPct >= EQUITY_ALLOCATION_THRESHOLDS.HIGH) return 8
  if (equityPct >= EQUITY_ALLOCATION_THRESHOLDS.ELEVATED) return 7
  if (equityPct >= EQUITY_ALLOCATION_THRESHOLDS.MODERATE) return 5
  if (equityPct >= EQUITY_ALLOCATION_THRESHOLDS.BALANCED) return 4
  if (equityPct >= EQUITY_ALLOCATION_THRESHOLDS.CONSERVATIVE) return 3
  if (equityPct >= EQUITY_ALLOCATION_THRESHOLDS.VERY_CONSERVATIVE) return 2
  return 1
}

function scoreWithdrawalRate(rate: number): number {
  if (rate >= WITHDRAWAL_RATE_THRESHOLDS.VERY_HIGH) return 10
  if (rate >= WITHDRAWAL_RATE_THRESHOLDS.HIGH) return 8
  if (rate >= WITHDRAWAL_RATE_THRESHOLDS.ELEVATED) return 7
  if (rate >= WITHDRAWAL_RATE_THRESHOLDS.MODERATE) return 5
  if (rate >= WITHDRAWAL_RATE_THRESHOLDS.SAFE) return 4
  if (rate >= WITHDRAWAL_RATE_THRESHOLDS.CONSERVATIVE) return 3
  if (rate >= WITHDRAWAL_RATE_THRESHOLDS.VERY_CONSERVATIVE) return 2
  return 1
}

function scoreYearsToRetirement(years: number): number {
  if (years <= 0) return 8
  if (years <= 2) return 7
  if (years <= 5) return 5
  if (years <= 10) return 3
  return 1
}

function scoreCashBuffer(years: number): number {
  if (years >= CASH_BUFFER_THRESHOLDS.EXCELLENT) return 1
  if (years >= CASH_BUFFER_THRESHOLDS.GOOD) return 2
  if (years >= CASH_BUFFER_THRESHOLDS.ADEQUATE) return 4
  if (years >= CASH_BUFFER_THRESHOLDS.LOW) return 6
  return 9
}

function scoreConcentration(portfolio: Portfolio, totalValue: number): number {
  if (totalValue === 0) return 1
  let maxSingleHoldingPct = 0
  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      const pct = holding.currentValue / totalValue
      if (pct > maxSingleHoldingPct) maxSingleHoldingPct = pct
    }
  }
  if (maxSingleHoldingPct >= CONCENTRATION_THRESHOLDS.CRITICAL) return 9
  if (maxSingleHoldingPct >= CONCENTRATION_THRESHOLDS.HIGH) return 6
  if (maxSingleHoldingPct >= CONCENTRATION_THRESHOLDS.ELEVATED) return 4
  if (maxSingleHoldingPct >= CONCENTRATION_THRESHOLDS.MODERATE) return 2
  return 1
}

function riskLabel(score: RiskLevel): string {
  if (score <= 3) return 'Low'
  if (score <= 6) return 'Moderate'
  if (score <= 8) return 'High'
  return 'Very High'
}

function riskDescription(score: RiskLevel, factors: RiskFactors): string {
  const parts: string[] = []
  if (factors.equityAllocation > EQUITY_ALLOCATION_THRESHOLDS.ELEVATED)
    parts.push('high equity concentration')
  if (factors.withdrawalRate > WITHDRAWAL_RATE_THRESHOLDS.ELEVATED)
    parts.push('elevated withdrawal rate')
  if (factors.yearsToRetirement <= 2) parts.push('near or in retirement')
  if (factors.cashBufferYears < CASH_BUFFER_THRESHOLDS.ADEQUATE)
    parts.push('limited cash buffer')
  if (factors.concentrationPenalty > 5) parts.push('concentrated holdings')

  if (parts.length === 0)
    return 'Portfolio shows low sequence-of-returns vulnerability.'

  return `Risk driven by: ${parts.join(', ')}.`
}

export function calculateSequenceRisk(
  portfolio: Portfolio,
  userProfile: UserProfile
): RiskScoreBreakdown {
  const summary = calculatePortfolioTotals(portfolio)
  const totalValue = summary.totalValue

  const equityAllocation = totalValue > 0 ? summary.totalEquity / totalValue : 0
  const withdrawalRate =
    totalValue > 0 ? userProfile.annualExpenses / totalValue : 0
  const yearsToRetirement =
    userProfile.targetRetirementAge - userProfile.currentAge
  const cashAndCDs = summary.totalCash + summary.totalCDs
  const cashBufferYears =
    userProfile.annualExpenses > 0 ? cashAndCDs / userProfile.annualExpenses : 0

  const equityScore = scoreEquityAllocation(equityAllocation)
  const withdrawalScore = scoreWithdrawalRate(withdrawalRate)
  const retirementScore = scoreYearsToRetirement(yearsToRetirement)
  const bufferScore = scoreCashBuffer(cashBufferYears)
  const concentrationScore = scoreConcentration(portfolio, totalValue)

  const weights = {
    equity: 0.3,
    withdrawal: 0.25,
    retirement: 0.2,
    buffer: 0.15,
    concentration: 0.1,
  }

  const rawScore =
    equityScore * weights.equity +
    withdrawalScore * weights.withdrawal +
    retirementScore * weights.retirement +
    bufferScore * weights.buffer +
    concentrationScore * weights.concentration

  const score = Math.max(1, Math.min(10, Math.round(rawScore))) as RiskLevel

  const factors: RiskFactors = {
    equityAllocation,
    withdrawalRate,
    yearsToRetirement,
    cashBufferYears,
    concentrationPenalty: concentrationScore,
  }

  return {
    score,
    factors,
    label: riskLabel(score),
    description: riskDescription(score, factors),
  }
}
