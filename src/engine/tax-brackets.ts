// ---------------------------------------------------------------------------
// RetireRunway – Deterministic Tax Bracket Modeling
// 2026 federal income tax brackets + capital gains rates.
// All calculations are deterministic — no AI.
// ---------------------------------------------------------------------------

import type { UserProfile, Portfolio, AccountType } from './types'

export const FILING_STATUSES = [
  'single',
  'married_filing_jointly',
  'head_of_household',
] as const

export type FilingStatus = (typeof FILING_STATUSES)[number]

export interface TaxBracket {
  min: number
  max: number // Infinity for top bracket
  rate: number
}

export interface TaxBracketResult {
  filingStatus: FilingStatus
  ordinaryIncome: number
  capitalGainsIncome: number
  ordinaryTax: number
  capitalGainsTax: number
  totalTax: number
  effectiveRate: number
  marginalRate: number
  stateTax: number
  brackets: TaxBracketBreakdown[]
}

export interface TaxBracketBreakdown {
  rate: number
  taxableInThisBracket: number
  taxInThisBracket: number
}

export interface WithdrawalTaxEstimate {
  accountId: string
  accountType: AccountType
  withdrawalAmount: number
  taxableAmount: number
  estimatedTax: number
  effectiveRate: number
}

// 2026 Federal Income Tax Brackets (projected, indexed for inflation)
const FEDERAL_BRACKETS: Record<FilingStatus, TaxBracket[]> = {
  single: [
    { min: 0, max: 11925, rate: 0.1 },
    { min: 11925, max: 48475, rate: 0.12 },
    { min: 48475, max: 103350, rate: 0.22 },
    { min: 103350, max: 197300, rate: 0.24 },
    { min: 197300, max: 250525, rate: 0.32 },
    { min: 250525, max: 626350, rate: 0.35 },
    { min: 626350, max: Infinity, rate: 0.37 },
  ],
  married_filing_jointly: [
    { min: 0, max: 23850, rate: 0.1 },
    { min: 23850, max: 96950, rate: 0.12 },
    { min: 96950, max: 206700, rate: 0.22 },
    { min: 206700, max: 394600, rate: 0.24 },
    { min: 394600, max: 501050, rate: 0.32 },
    { min: 501050, max: 751600, rate: 0.35 },
    { min: 751600, max: Infinity, rate: 0.37 },
  ],
  head_of_household: [
    { min: 0, max: 17000, rate: 0.1 },
    { min: 17000, max: 64850, rate: 0.12 },
    { min: 64850, max: 103350, rate: 0.22 },
    { min: 103350, max: 197300, rate: 0.24 },
    { min: 197300, max: 250500, rate: 0.32 },
    { min: 250500, max: 626350, rate: 0.35 },
    { min: 626350, max: Infinity, rate: 0.37 },
  ],
}

// Long-term capital gains rates (2026 thresholds)
const LTCG_BRACKETS: Record<FilingStatus, TaxBracket[]> = {
  single: [
    { min: 0, max: 48350, rate: 0.0 },
    { min: 48350, max: 533400, rate: 0.15 },
    { min: 533400, max: Infinity, rate: 0.2 },
  ],
  married_filing_jointly: [
    { min: 0, max: 96700, rate: 0.0 },
    { min: 96700, max: 600050, rate: 0.15 },
    { min: 600050, max: Infinity, rate: 0.2 },
  ],
  head_of_household: [
    { min: 0, max: 64750, rate: 0.0 },
    { min: 64750, max: 566700, rate: 0.15 },
    { min: 566700, max: Infinity, rate: 0.2 },
  ],
}

// Standard deductions (2026 projected)
const STANDARD_DEDUCTION: Record<FilingStatus, number> = {
  single: 15700,
  married_filing_jointly: 31400,
  head_of_household: 23550,
}

export function calculateOrdinaryTax(
  taxableIncome: number,
  filingStatus: FilingStatus
): { total: number; brackets: TaxBracketBreakdown[]; marginalRate: number } {
  const brackets = FEDERAL_BRACKETS[filingStatus]
  const breakdowns: TaxBracketBreakdown[] = []
  let total = 0
  let marginalRate = brackets[0].rate

  for (const bracket of brackets) {
    if (taxableIncome <= bracket.min) break

    const taxableInBracket = Math.min(taxableIncome, bracket.max) - bracket.min
    const taxInBracket = taxableInBracket * bracket.rate
    total += taxInBracket
    marginalRate = bracket.rate

    breakdowns.push({
      rate: bracket.rate,
      taxableInThisBracket: Math.round(taxableInBracket * 100) / 100,
      taxInThisBracket: Math.round(taxInBracket * 100) / 100,
    })
  }

  return {
    total: Math.round(total * 100) / 100,
    brackets: breakdowns,
    marginalRate,
  }
}

export function calculateCapitalGainsTax(
  capitalGains: number,
  ordinaryIncome: number,
  filingStatus: FilingStatus
): number {
  if (capitalGains <= 0) return 0

  const brackets = LTCG_BRACKETS[filingStatus]
  // Capital gains stack on top of ordinary income for bracket placement
  const baseIncome = ordinaryIncome
  let tax = 0
  let gainsRemaining = capitalGains

  for (const bracket of brackets) {
    if (gainsRemaining <= 0) break

    const bracketStart = Math.max(0, bracket.min - baseIncome)
    const bracketEnd =
      bracket.max === Infinity
        ? Infinity
        : Math.max(0, bracket.max - baseIncome)
    const spaceInBracket = bracketEnd - bracketStart

    if (spaceInBracket <= 0) continue

    const gainsInBracket = Math.min(gainsRemaining, spaceInBracket)
    tax += gainsInBracket * bracket.rate
    gainsRemaining -= gainsInBracket
  }

  return Math.round(tax * 100) / 100
}

export function calculateTaxBreakdown(
  ordinaryIncome: number,
  capitalGains: number,
  filingStatus: FilingStatus,
  stateTaxRate: number = 0
): TaxBracketResult {
  const deduction = STANDARD_DEDUCTION[filingStatus]
  const taxableOrdinary = Math.max(0, ordinaryIncome - deduction)

  const ordinary = calculateOrdinaryTax(taxableOrdinary, filingStatus)
  const capitalGainsTax = calculateCapitalGainsTax(
    capitalGains,
    taxableOrdinary,
    filingStatus
  )

  const stateTax =
    Math.round((ordinaryIncome + capitalGains) * stateTaxRate * 100) / 100
  const totalTax = ordinary.total + capitalGainsTax + stateTax
  const totalIncome = ordinaryIncome + capitalGains
  const effectiveRate = totalIncome > 0 ? totalTax / totalIncome : 0

  return {
    filingStatus,
    ordinaryIncome,
    capitalGainsIncome: capitalGains,
    ordinaryTax: ordinary.total,
    capitalGainsTax,
    totalTax: Math.round(totalTax * 100) / 100,
    effectiveRate: Math.round(effectiveRate * 10000) / 10000,
    marginalRate: ordinary.marginalRate,
    stateTax,
    brackets: ordinary.brackets,
  }
}

export function estimateWithdrawalTax(
  portfolio: Portfolio,
  profile: UserProfile,
  annualWithdrawal: number,
  _filingStatus: FilingStatus = 'single'
): WithdrawalTaxEstimate[] {
  const estimates: WithdrawalTaxEstimate[] = []
  const stateTaxRate = profile.stateTaxRate ?? 0

  // Distribute withdrawal proportionally across accounts
  let totalValue = 0
  for (const account of portfolio.accounts) {
    totalValue +=
      account.cashBalance +
      account.holdings.reduce((s, h) => s + h.currentValue, 0) +
      account.cds.reduce((s, c) => s + c.principal, 0)
  }

  if (totalValue === 0) return estimates

  for (const account of portfolio.accounts) {
    const accountValue =
      account.cashBalance +
      account.holdings.reduce((s, h) => s + h.currentValue, 0) +
      account.cds.reduce((s, c) => s + c.principal, 0)

    const proportion = accountValue / totalValue
    const withdrawal = annualWithdrawal * proportion

    let taxableAmount: number
    let effectiveRate: number

    switch (account.accountType) {
      case 'roth_ira':
      case 'roth_401k':
        // Qualified Roth distributions are tax-free
        taxableAmount = 0
        effectiveRate = 0
        break

      case 'traditional_ira':
      case 'rollover_ira':
      case '401k':
      case '403b':
      case '457b':
      case 'nqdc':
        // Pre-tax: entire withdrawal is ordinary income. No early-withdrawal
        // penalty applies to a 457(b) or an NQDC distribution.
        taxableAmount = withdrawal
        effectiveRate = (profile.federalTaxBracket ?? 0.22) + stateTaxRate
        break

      case 'hsa':
        // Qualified medical expenses tax-free; otherwise ordinary income + 20% penalty if under 65
        taxableAmount = 0 // Assume qualified
        effectiveRate = 0
        break

      case 'brokerage':
        // Taxable: only gains are taxed (estimate ~50% of value is gains)
        taxableAmount = withdrawal * 0.5
        effectiveRate = 0.15 + stateTaxRate // Approx LTCG rate
        break

      default: {
        const unhandled: never = account.accountType
        throw new Error(
          `No tax treatment for account type ${String(unhandled)}`
        )
      }
    }

    estimates.push({
      accountId: account.id,
      accountType: account.accountType,
      withdrawalAmount: Math.round(withdrawal * 100) / 100,
      taxableAmount: Math.round(taxableAmount * 100) / 100,
      estimatedTax: Math.round(taxableAmount * effectiveRate * 100) / 100,
      effectiveRate: Math.round(effectiveRate * 10000) / 10000,
    })
  }

  return estimates
}

export function getStandardDeduction(filingStatus: FilingStatus): number {
  return STANDARD_DEDUCTION[filingStatus]
}

export function getFederalBrackets(filingStatus: FilingStatus): TaxBracket[] {
  return FEDERAL_BRACKETS[filingStatus].map(b => ({ ...b }))
}
