// ---------------------------------------------------------------------------
// RetireRunway – Deterministic Portfolio Alerts Engine
// Detects allocation drift, concentration risk, spending anomalies, etc.
// All calculations are deterministic — no AI.
// ---------------------------------------------------------------------------

import type { Portfolio, UserProfile, AssetClass } from './types'
import {
  calculatePortfolioValue,
  calculateEquityFraction,
  calculateLiquidCash,
} from './portfolio-math'
import { ALERT_THRESHOLDS } from './config'

export type AlertSeverity = 'info' | 'warning' | 'critical'
export type AlertCategory =
  | 'allocation_drift'
  | 'concentration'
  | 'cash_buffer'
  | 'withdrawal_rate'
  | 'cd_maturity'

export interface Alert {
  id: string
  category: AlertCategory
  severity: AlertSeverity
  title: string
  message: string
  metric?: number // the measured value
  threshold?: number // the threshold that triggered the alert
}

export interface AlertConfig {
  equityDriftThreshold: number // e.g., 0.10 = trigger if equity allocation drifts >10% from target
  concentrationThreshold: number // single holding % of portfolio
  cashBufferMinYears: number // minimum years of expenses in cash/CDs
  withdrawalRateMax: number // max safe withdrawal rate
  cdMaturityWindowDays: number // alert when CD matures within N days
  targetEquityAllocation: number // target equity %
}

const DEFAULT_CONFIG: AlertConfig = {
  equityDriftThreshold: ALERT_THRESHOLDS.EQUITY_DRIFT,
  concentrationThreshold: ALERT_THRESHOLDS.CONCENTRATION_WARNING,
  cashBufferMinYears: ALERT_THRESHOLDS.CASH_BUFFER_MIN_YEARS,
  withdrawalRateMax: ALERT_THRESHOLDS.WITHDRAWAL_RATE_MAX,
  cdMaturityWindowDays: ALERT_THRESHOLDS.CD_MATURITY_WINDOW_DAYS,
  targetEquityAllocation: ALERT_THRESHOLDS.TARGET_EQUITY_ALLOCATION,
}

function checkAllocationDrift(
  portfolio: Portfolio,
  totalValue: number,
  config: AlertConfig
): Alert[] {
  const alerts: Alert[] = []
  const equityPct = calculateEquityFraction(portfolio, totalValue)
  const drift = Math.abs(equityPct - config.targetEquityAllocation)

  if (drift > config.equityDriftThreshold) {
    const direction =
      equityPct > config.targetEquityAllocation ? 'above' : 'below'
    alerts.push({
      id: 'drift-equity',
      category: 'allocation_drift',
      severity:
        drift > config.equityDriftThreshold * 2 ? 'critical' : 'warning',
      title: `Equity allocation drifted ${direction} target`,
      message: `Current equity allocation is ${(equityPct * 100).toFixed(1)}%, which is ${(drift * 100).toFixed(1)}% ${direction} your ${(config.targetEquityAllocation * 100).toFixed(0)}% target. Consider rebalancing.`,
      metric: equityPct,
      threshold: config.targetEquityAllocation,
    })
  }

  return alerts
}

function checkConcentration(
  portfolio: Portfolio,
  totalValue: number,
  config: AlertConfig
): Alert[] {
  const alerts: Alert[] = []
  if (totalValue === 0) return alerts

  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      const pct = holding.currentValue / totalValue
      if (pct > config.concentrationThreshold) {
        alerts.push({
          id: `concentration-${holding.id}`,
          category: 'concentration',
          severity:
            pct > ALERT_THRESHOLDS.CONCENTRATION_CRITICAL
              ? 'critical'
              : 'warning',
          title: `${holding.symbol} is ${(pct * 100).toFixed(1)}% of portfolio`,
          message: `${holding.name} (${holding.symbol}) represents ${(pct * 100).toFixed(1)}% of your total portfolio. Consider diversifying to reduce single-security risk.`,
          metric: pct,
          threshold: config.concentrationThreshold,
        })
      }
    }
  }

  return alerts
}

function checkCashBuffer(
  portfolio: Portfolio,
  profile: UserProfile,
  config: AlertConfig
): Alert[] {
  const alerts: Alert[] = []
  // REQ-MCP-62: liquid cash only (taxable accounts plus planRules.outsideCash).
  const cashAndCDs =
    calculateLiquidCash(portfolio) +
    Math.max(0, profile.planRules?.outsideCash ?? 0)
  const bufferYears =
    profile.annualExpenses > 0 ? cashAndCDs / profile.annualExpenses : Infinity

  if (bufferYears < config.cashBufferMinYears) {
    alerts.push({
      id: 'cash-buffer',
      category: 'cash_buffer',
      severity:
        bufferYears < ALERT_THRESHOLDS.CASH_BUFFER_CRITICAL
          ? 'critical'
          : 'warning',
      title: 'Cash buffer below target',
      message: `You have ${bufferYears.toFixed(1)} years of expenses in liquid cash and CDs outside retirement accounts, below the ${config.cashBufferMinYears} year minimum. Cash inside a 401(k) or IRA does not count.`,
      metric: bufferYears,
      threshold: config.cashBufferMinYears,
    })
  }

  return alerts
}

function checkWithdrawalRate(
  portfolio: Portfolio,
  profile: UserProfile,
  totalValue: number,
  config: AlertConfig
): Alert[] {
  const alerts: Alert[] = []
  if (totalValue === 0) return alerts

  const withdrawalRate = profile.annualExpenses / totalValue

  if (withdrawalRate > config.withdrawalRateMax) {
    alerts.push({
      id: 'withdrawal-rate',
      category: 'withdrawal_rate',
      severity:
        withdrawalRate > config.withdrawalRateMax * 1.5
          ? 'critical'
          : 'warning',
      title: 'Withdrawal rate exceeds safe threshold',
      message: `Your implied withdrawal rate is ${(withdrawalRate * 100).toFixed(1)}%, above the ${(config.withdrawalRateMax * 100).toFixed(0)}% threshold. This may increase portfolio depletion risk.`,
      metric: withdrawalRate,
      threshold: config.withdrawalRateMax,
    })
  }

  return alerts
}

function checkCDMaturities(
  portfolio: Portfolio,
  config: AlertConfig,
  now: Date
): Alert[] {
  const alerts: Alert[] = []

  for (const account of portfolio.accounts) {
    for (const cd of account.cds) {
      const maturity = new Date(cd.maturityDate)
      const daysUntilMaturity = Math.round(
        (maturity.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      )

      if (
        daysUntilMaturity <= config.cdMaturityWindowDays &&
        daysUntilMaturity >= 0
      ) {
        alerts.push({
          id: `cd-maturity-${cd.id}`,
          category: 'cd_maturity',
          severity: daysUntilMaturity <= 30 ? 'warning' : 'info',
          title: `CD maturing in ${daysUntilMaturity} days`,
          message: `${cd.institution} CD ($${cd.principal.toLocaleString()}, ${cd.apy * 100}% APY) matures on ${cd.maturityDate}. Plan your reinvestment strategy.`,
          metric: daysUntilMaturity,
          threshold: config.cdMaturityWindowDays,
        })
      }
    }
  }

  return alerts
}

// True only for a real YYYY-MM-DD calendar date. `new Date()` rolls an
// impossible day over (2026-02-30 becomes March 2), so the parsed date must
// format back to the same string.
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

// Parses the as-of date once so every CD is measured from the same instant.
// Without an as-of date the system clock is the reference, so the result is
// reproducible only when the caller passes one (NFR-01).
function resolveAsOf(asOfDate: string | undefined): Date {
  if (asOfDate === undefined) return new Date()
  if (!isCalendarDate(asOfDate)) {
    throw new RangeError(`Invalid alerts as-of date: ${asOfDate}`)
  }
  return new Date(asOfDate)
}

export function generateAlerts(
  portfolio: Portfolio,
  profile: UserProfile,
  config?: Partial<AlertConfig>,
  asOfDate?: string
): Alert[] {
  // REQ-MCP-53: the owner's saved planRules set the equity target, drift
  // band and cash buffer unless the caller passes its own.
  const rules = profile.planRules
  const cfg = {
    ...DEFAULT_CONFIG,
    ...(rules === undefined
      ? {}
      : {
          targetEquityAllocation: rules.targetEquityShare,
          ...(rules.driftBand === undefined
            ? {}
            : { equityDriftThreshold: rules.driftBand }),
          ...(rules.minCashBufferYears === undefined
            ? {}
            : { cashBufferMinYears: rules.minCashBufferYears }),
        }),
    ...config,
  }
  const asOf = resolveAsOf(asOfDate)
  const totalValue = calculatePortfolioValue(portfolio)

  const alerts: Alert[] = [
    ...checkAllocationDrift(portfolio, totalValue, cfg),
    ...checkConcentration(portfolio, totalValue, cfg),
    ...checkCashBuffer(portfolio, profile, cfg),
    ...checkWithdrawalRate(portfolio, profile, totalValue, cfg),
    ...checkCDMaturities(portfolio, cfg, asOf),
  ]

  // Sort: critical first, then warning, then info
  const severityOrder: Record<AlertSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  }
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  return alerts
}

export function getAssetClassAllocation(
  portfolio: Portfolio
): Record<AssetClass, number> {
  const totalValue = calculatePortfolioValue(portfolio)
  if (totalValue === 0) return {} as Record<AssetClass, number>

  const allocation = {} as Record<AssetClass, number>
  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      allocation[holding.assetClass] =
        (allocation[holding.assetClass] ?? 0) +
        holding.currentValue / totalValue
    }
  }
  return allocation
}
