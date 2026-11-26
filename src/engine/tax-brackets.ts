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

// 2027 federal income tax brackets, standard deductions and capital gains
// thresholds: IRS Rev. Proc. 2026-35 (2027 inflation adjustments, Nov 5,
// 2026; IR-2026-133). The projection's first year is 2027 and it holds these
// in today's dollars. The year and source are registered in law-tables.ts
// (REQ-MCP-84) so the briefing flags them when the next year's are out.
export const FEDERAL_TAX_YEAR = 2027

const FEDERAL_BRACKETS: Record<FilingStatus, TaxBracket[]> = {
  single: [
    { min: 0, max: 12800, rate: 0.1 },
    { min: 12800, max: 52025, rate: 0.12 },
    { min: 52025, max: 109125, rate: 0.22 },
    { min: 109125, max: 208325, rate: 0.24 },
    { min: 208325, max: 264550, rate: 0.32 },
    { min: 264550, max: 661375, rate: 0.35 },
    { min: 661375, max: Infinity, rate: 0.37 },
  ],
  married_filing_jointly: [
    { min: 0, max: 25600, rate: 0.1 },
    { min: 25600, max: 104050, rate: 0.12 },
    { min: 104050, max: 218250, rate: 0.22 },
    { min: 218250, max: 416650, rate: 0.24 },
    { min: 416650, max: 529100, rate: 0.32 },
    { min: 529100, max: 793650, rate: 0.35 },
    { min: 793650, max: Infinity, rate: 0.37 },
  ],
  head_of_household: [
    { min: 0, max: 18250, rate: 0.1 },
    { min: 18250, max: 69650, rate: 0.12 },
    { min: 69650, max: 109100, rate: 0.22 },
    { min: 109100, max: 208300, rate: 0.24 },
    { min: 208300, max: 264550, rate: 0.32 },
    { min: 264550, max: 661350, rate: 0.35 },
    { min: 661350, max: Infinity, rate: 0.37 },
  ],
}

// Long-term capital gains rates (2027 thresholds, Rev. Proc. 2026-35 §3.03)
const LTCG_BRACKETS: Record<FilingStatus, TaxBracket[]> = {
  single: [
    { min: 0, max: 51050, rate: 0.0 },
    { min: 51050, max: 563200, rate: 0.15 },
    { min: 563200, max: Infinity, rate: 0.2 },
  ],
  married_filing_jointly: [
    { min: 0, max: 102100, rate: 0.0 },
    { min: 102100, max: 633600, rate: 0.15 },
    { min: 633600, max: Infinity, rate: 0.2 },
  ],
  head_of_household: [
    { min: 0, max: 68350, rate: 0.0 },
    { min: 68350, max: 598400, rate: 0.15 },
    { min: 598400, max: Infinity, rate: 0.2 },
  ],
}

// Standard deductions (2027, Rev. Proc. 2026-35 §3.15)
const STANDARD_DEDUCTION: Record<FilingStatus, number> = {
  single: 16600,
  married_filing_jointly: 33200,
  head_of_household: 24925,
}

/**
 * REQ-MCP-84: the extra standard deduction for each person 65 or older
 * (2027, Rev. Proc. 2026-35): $1,700 when married, $2,100 when unmarried.
 */
export const AGED_ADDITIONAL_DEDUCTION: Record<FilingStatus, number> = {
  single: 2100,
  married_filing_jointly: 1700,
  head_of_household: 2100,
}

/**
 * REQ-MCP-84: the senior deduction (OBBBA §70103), tax years 2025-2028:
 * $6,000 per person 65 or older, less 6% of MAGI above $75,000 ($150,000
 * joint). Not indexed. Returns the nominal deduction.
 */
export const SENIOR_DEDUCTION = {
  perPerson: 6000,
  firstYear: 2025,
  lastYear: 2028,
  phaseOutRate: 0.06,
  threshold: { single: 75000, joint: 150000 },
} as const

export function seniorDeduction(
  taxYear: number,
  seniors: number,
  magi: number,
  filingStatus: FilingStatus
): number {
  if (
    seniors <= 0 ||
    taxYear < SENIOR_DEDUCTION.firstYear ||
    taxYear > SENIOR_DEDUCTION.lastYear
  )
    return 0
  const threshold =
    filingStatus === 'married_filing_jointly'
      ? SENIOR_DEDUCTION.threshold.joint
      : SENIOR_DEDUCTION.threshold.single
  // The phase-out applies to each person's $6,000.
  const each = Math.max(
    0,
    SENIOR_DEDUCTION.perPerson -
      SENIOR_DEDUCTION.phaseOutRate * Math.max(0, magi - threshold)
  )
  return each * seniors
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
