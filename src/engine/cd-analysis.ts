import type { CD, CDBreakAnalysis } from './types'

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA)
  const b = new Date(dateB)
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24))
}

function monthsBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA)
  const b = new Date(dateB)
  return (
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
  )
}

export function calculateAccruedInterest(cd: CD, asOfDate: string): number {
  const totalDays = daysBetween(cd.purchaseDate, cd.maturityDate)
  const elapsedDays = daysBetween(cd.purchaseDate, asOfDate)
  if (totalDays <= 0 || elapsedDays <= 0) return 0

  const totalInterest = cd.principal * cd.apy * (cd.termMonths / 12)
  const fraction = Math.min(elapsedDays / totalDays, 1)
  return Math.round(fraction * totalInterest * 100) / 100
}

export function calculatePenaltyAmount(cd: CD): number {
  const dailyRate = cd.apy / 365
  return (
    Math.round(
      cd.principal * dailyRate * cd.earlyWithdrawalPenaltyMonths * 30 * 100
    ) / 100
  )
}

export function calculateBreakEvenDate(cd: CD, asOfDate: string): string {
  const penalty = calculatePenaltyAmount(cd)
  const dailyInterest = (cd.principal * cd.apy) / 365

  if (dailyInterest <= 0) return cd.maturityDate

  const daysToRecover = Math.ceil(penalty / dailyInterest)
  const breakEven = new Date(asOfDate)
  breakEven.setDate(breakEven.getDate() + daysToRecover)

  const maturity = new Date(cd.maturityDate)
  if (breakEven > maturity) return cd.maturityDate

  return breakEven.toISOString().split('T')[0]
}

export function analyzeCDBreak(cd: CD, asOfDate: string): CDBreakAnalysis {
  const accruedInterest = calculateAccruedInterest(cd, asOfDate)
  const penaltyAmount = calculatePenaltyAmount(cd)
  const netProceeds = cd.principal + accruedInterest - penaltyAmount
  const breakEvenDate = calculateBreakEvenDate(cd, asOfDate)

  const monthsRemaining = monthsBetween(asOfDate, cd.maturityDate)
  const penaltyExceedsAccrued = penaltyAmount > accruedInterest

  let recommendation: 'break' | 'hold'
  let rationale: string

  if (monthsRemaining <= 1) {
    recommendation = 'hold'
    rationale = 'CD matures within 1 month — hold to avoid unnecessary penalty.'
  } else if (monthsRemaining <= cd.earlyWithdrawalPenaltyMonths) {
    recommendation = 'hold'
    rationale = `Only ${monthsRemaining} months remaining, less than the ${cd.earlyWithdrawalPenaltyMonths}-month penalty period.`
  } else if (penaltyExceedsAccrued) {
    recommendation = 'hold'
    rationale = `Penalty ($${penaltyAmount.toFixed(2)}) exceeds accrued interest ($${accruedInterest.toFixed(2)}) — you would lose principal.`
  } else {
    recommendation = 'break'
    rationale = `Net proceeds $${netProceeds.toFixed(2)} after $${penaltyAmount.toFixed(2)} penalty. Break-even by ${breakEvenDate}.`
  }

  return {
    cdId: cd.id,
    penaltyAmount,
    penaltyMonths: cd.earlyWithdrawalPenaltyMonths,
    accruedInterest,
    netProceeds,
    breakEvenDate,
    recommendation,
    rationale,
  }
}

export function analyzeAllCDs(cds: CD[], asOfDate: string): CDBreakAnalysis[] {
  return cds.map(cd => analyzeCDBreak(cd, asOfDate))
}
