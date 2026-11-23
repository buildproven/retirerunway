// ---------------------------------------------------------------------------
// RetireRunway – Deterministic Roth Conversion Optimizer
// Finds optimal annual Roth conversion amounts to minimize lifetime tax.
// All calculations are deterministic — no AI.
// ---------------------------------------------------------------------------

import type { Portfolio, UserProfile, AccountType } from './types'
import {
  calculateOrdinaryTax,
  getStandardDeduction,
  type FilingStatus,
} from './tax-brackets'
import { ROTH_CONVERSION_DEFAULTS } from './config'

export interface RothConversionYear {
  year: number
  age: number
  conversionAmount: number
  taxOnConversion: number
  marginalRate: number
  traditionalBalanceAfter: number
  rothBalanceAfter: number
  cumulativeConverted: number
  cumulativeTaxPaid: number
}

export interface RothConversionPlan {
  years: RothConversionYear[]
  totalConverted: number
  totalTaxPaid: number
  averageTaxRate: number
  traditionalBalanceStart: number
  rothBalanceStart: number
  traditionalBalanceEnd: number
  rothBalanceEnd: number
  projectedTaxSavings: number
  recommendation: string
}

interface RothConversionConfig {
  filingStatus: FilingStatus
  conversionWindowYears: number // Number of years to spread conversions
  targetBracketRate: number // Max marginal rate willing to pay on conversions
  expectedGrowthRate: number // Pre-tax growth assumption
  expectedRetirementRate: number // Expected tax rate in retirement
  stateTaxRate: number
}

const DEFAULT_CONFIG: RothConversionConfig = {
  filingStatus: 'single',
  conversionWindowYears: 10,
  targetBracketRate: ROTH_CONVERSION_DEFAULTS.TARGET_BRACKET_RATE,
  expectedGrowthRate: ROTH_CONVERSION_DEFAULTS.EXPECTED_GROWTH_RATE,
  expectedRetirementRate: ROTH_CONVERSION_DEFAULTS.EXPECTED_RETIREMENT_RATE,
  stateTaxRate: 0,
}

/**
 * The part each account type plays in a Roth conversion. An NQDC plan holds
 * pre-tax money but cannot be converted to Roth, so it is excluded.
 */
const CONVERSION_ROLE: Readonly<
  Record<AccountType, 'source' | 'roth' | 'excluded'>
> = {
  traditional_ira: 'source',
  rollover_ira: 'source',
  '401k': 'source',
  '403b': 'source',
  '457b': 'source',
  roth_ira: 'roth',
  roth_401k: 'roth',
  brokerage: 'excluded',
  nqdc: 'excluded',
  hsa: 'excluded',
}

function getPreTaxBalance(portfolio: Portfolio): number {
  let balance = 0

  for (const account of portfolio.accounts) {
    if (CONVERSION_ROLE[account.accountType] === 'source') {
      balance += account.cashBalance
      for (const holding of account.holdings) {
        balance += holding.currentValue
      }
      for (const cd of account.cds) {
        balance += cd.principal
      }
    }
  }
  return balance
}

function getRothBalance(portfolio: Portfolio): number {
  let balance = 0
  for (const account of portfolio.accounts) {
    if (CONVERSION_ROLE[account.accountType] === 'roth') {
      balance += account.cashBalance
      for (const holding of account.holdings) {
        balance += holding.currentValue
      }
      for (const cd of account.cds) {
        balance += cd.principal
      }
    }
  }
  return balance
}

/**
 * Finds the maximum conversion amount that keeps the marginal rate at or below
 * the target rate, given existing ordinary income.
 */
function findOptimalConversion(
  existingIncome: number,
  filingStatus: FilingStatus,
  targetRate: number
): number {
  const deduction = getStandardDeduction(filingStatus)
  const taxableExisting = Math.max(0, existingIncome - deduction)

  // Binary search for the max conversion that stays within targetRate
  let low = 0
  let high = 2_000_000
  let bestConversion = 0

  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2
    const totalTaxable = taxableExisting + mid
    const result = calculateOrdinaryTax(totalTaxable, filingStatus)

    if (result.marginalRate <= targetRate) {
      bestConversion = mid
      low = mid
    } else {
      high = mid
    }
  }

  return Math.round(bestConversion)
}

export function optimizeRothConversion(
  portfolio: Portfolio,
  profile: UserProfile,
  config?: Partial<RothConversionConfig>
): RothConversionPlan {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  if (profile.stateTaxRate !== undefined) {
    cfg.stateTaxRate = profile.stateTaxRate
  }

  const traditionalStart = getPreTaxBalance(portfolio)
  const rothStart = getRothBalance(portfolio)
  const yearsToRetirement = profile.targetRetirementAge - profile.currentAge

  // Determine the conversion window (years before retirement or RMD age 73)
  const yearsToRMD = Math.max(0, 73 - profile.currentAge)
  const windowYears = Math.min(
    cfg.conversionWindowYears,
    yearsToRetirement > 0 ? yearsToRetirement : yearsToRMD
  )

  if (traditionalStart <= 0 || windowYears <= 0) {
    return {
      years: [],
      totalConverted: 0,
      totalTaxPaid: 0,
      averageTaxRate: 0,
      traditionalBalanceStart: traditionalStart,
      rothBalanceStart: rothStart,
      traditionalBalanceEnd: traditionalStart,
      rothBalanceEnd: rothStart,
      projectedTaxSavings: 0,
      recommendation:
        traditionalStart <= 0
          ? 'No pre-tax balances to convert.'
          : 'No conversion window available before retirement.',
    }
  }

  // Estimate existing ordinary income (pension, SS, part-time work)
  let existingIncome = 0
  if (
    profile.socialSecurityMonthly &&
    profile.socialSecurityAge &&
    profile.currentAge >= profile.socialSecurityAge
  ) {
    existingIncome +=
      profile.socialSecurityMonthly *
      12 *
      ROTH_CONVERSION_DEFAULTS.SS_TAXABLE_PORTION
  }
  if (profile.pensionMonthly) {
    existingIncome += profile.pensionMonthly * 12
  }
  if (profile.otherIncomeMonthly) {
    existingIncome += profile.otherIncomeMonthly * 12
  }

  const years: RothConversionYear[] = []
  let tradBalance = traditionalStart
  let rothBalance = rothStart
  let cumulativeConverted = 0
  let cumulativeTaxPaid = 0

  for (let i = 0; i < windowYears; i++) {
    const age = profile.currentAge + i + 1
    const year = i + 1

    // Find optimal conversion for this year
    const optimalConversion = findOptimalConversion(
      existingIncome,
      cfg.filingStatus,
      cfg.targetBracketRate
    )

    // Don't convert more than the remaining traditional balance
    const conversionAmount = Math.min(optimalConversion, tradBalance)

    if (conversionAmount <= 0) break

    // Calculate tax on the conversion
    const deduction = getStandardDeduction(cfg.filingStatus)
    const taxableWithConversion =
      Math.max(0, existingIncome - deduction) + conversionAmount
    const taxableWithout = Math.max(0, existingIncome - deduction)

    const taxWith = calculateOrdinaryTax(
      taxableWithConversion,
      cfg.filingStatus
    )
    const taxWithout = calculateOrdinaryTax(taxableWithout, cfg.filingStatus)

    const federalTax = taxWith.total - taxWithout.total
    const stateTax = conversionAmount * cfg.stateTaxRate
    const totalTax = Math.round((federalTax + stateTax) * 100) / 100

    // Update balances (apply growth, then conversion)
    tradBalance = tradBalance * (1 + cfg.expectedGrowthRate) - conversionAmount
    rothBalance = rothBalance * (1 + cfg.expectedGrowthRate) + conversionAmount

    cumulativeConverted += conversionAmount
    cumulativeTaxPaid += totalTax

    years.push({
      year,
      age,
      conversionAmount: Math.round(conversionAmount * 100) / 100,
      taxOnConversion: totalTax,
      marginalRate: taxWith.marginalRate,
      traditionalBalanceAfter: Math.round(tradBalance * 100) / 100,
      rothBalanceAfter: Math.round(rothBalance * 100) / 100,
      cumulativeConverted: Math.round(cumulativeConverted * 100) / 100,
      cumulativeTaxPaid: Math.round(cumulativeTaxPaid * 100) / 100,
    })
  }

  // Estimate tax savings: tax paid on conversions now vs. tax on withdrawals later
  const taxIfWithdrawnLater =
    cumulativeConverted * cfg.expectedRetirementRate +
    cumulativeConverted * cfg.stateTaxRate
  const projectedTaxSavings =
    Math.round(Math.max(0, taxIfWithdrawnLater - cumulativeTaxPaid) * 100) / 100

  const averageTaxRate =
    cumulativeConverted > 0 ? cumulativeTaxPaid / cumulativeConverted : 0

  let recommendation: string
  if (cumulativeConverted === 0) {
    recommendation =
      'Current income levels leave no room for tax-efficient conversions.'
  } else if (projectedTaxSavings > 10000) {
    recommendation = `Converting ${formatDollars(cumulativeConverted)} over ${years.length} years could save ~${formatDollars(projectedTaxSavings)} in lifetime taxes at an average ${(averageTaxRate * 100).toFixed(1)}% rate.`
  } else if (projectedTaxSavings > 0) {
    recommendation = `Modest tax savings of ~${formatDollars(projectedTaxSavings)} possible. Conversions at ${(averageTaxRate * 100).toFixed(1)}% average rate may be worthwhile for tax diversification.`
  } else {
    recommendation =
      'Conversions at current rates would not provide clear tax savings. Consider if tax-free growth in Roth accounts is still valuable for your situation.'
  }

  return {
    years,
    totalConverted: Math.round(cumulativeConverted * 100) / 100,
    totalTaxPaid: Math.round(cumulativeTaxPaid * 100) / 100,
    averageTaxRate: Math.round(averageTaxRate * 10000) / 10000,
    traditionalBalanceStart: traditionalStart,
    rothBalanceStart: rothStart,
    traditionalBalanceEnd: Math.round(tradBalance * 100) / 100,
    rothBalanceEnd: Math.round(rothBalance * 100) / 100,
    projectedTaxSavings,
    recommendation,
  }
}

function formatDollars(n: number): string {
  return '$' + Math.round(n).toLocaleString()
}
