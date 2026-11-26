// ---------------------------------------------------------------------------
// RetireRunway – Shared Portfolio Math Utilities
// Single source of truth for portfolio calculations used across the engine.
// All functions are pure and deterministic.
// ---------------------------------------------------------------------------

import { reverseMortgagePlan } from './reverse-mortgage'
import type {
  AccountType,
  Portfolio,
  UserProfile,
  AssetClass,
  PortfolioSummary,
} from './types'

/**
 * Computes the total value of a portfolio including all holdings, CDs, and cash.
 */
export function calculatePortfolioValue(portfolio: Portfolio): number {
  let total = 0
  for (const account of portfolio.accounts) {
    total += account.cashBalance
    for (const holding of account.holdings) {
      total += holding.currentValue
    }
    for (const cd of account.cds) {
      total += cd.principal
    }
  }
  return total
}

/**
 * Computes the fraction of portfolio value held in equities.
 * Includes us_equity, intl_equity, emerging_equity and reit (REQ-MCP-78).
 */
export function calculateEquityFraction(
  portfolio: Portfolio,
  totalValue: number
): number {
  if (totalValue === 0) return 0
  let equity = 0
  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      if (
        holding.assetClass === 'us_equity' ||
        holding.assetClass === 'intl_equity' ||
        holding.assetClass === 'emerging_equity' ||
        // REQ-MCP-78: REITs are stocks; gold and other alternatives are not bonds either.
        holding.assetClass === 'reit'
      ) {
        equity += holding.currentValue
      }
    }
  }
  return equity / totalValue
}

/**
 * REQ-MCP-62: only a taxable (brokerage) account is liquid. Cash inside a
 * 401(k), IRA, Roth, HSA or deferred comp plan is taxed or penalised on the
 * way out (or both), so it never counts as a cash buffer.
 */
export function isLiquidAccount(accountType: AccountType): boolean {
  return accountType === 'brokerage'
}

/**
 * Cash, money market and CDs in liquid (taxable) accounts only (REQ-MCP-62).
 */
export function calculateLiquidCash(portfolio: Portfolio): number {
  return calculateCashAndCDs({
    ...portfolio,
    accounts: portfolio.accounts.filter(account =>
      isLiquidAccount(account.accountType)
    ),
  })
}

/**
 * Computes total cash and CDs in a portfolio, including money market holdings.
 */
export function calculateCashAndCDs(portfolio: Portfolio): number {
  let cash = 0
  for (const account of portfolio.accounts) {
    cash += account.cashBalance
    for (const cd of account.cds) {
      cash += cd.principal
    }
    for (const holding of account.holdings) {
      if (
        holding.assetClass === 'cash' ||
        holding.assetClass === 'money_market'
      ) {
        cash += holding.currentValue
      }
    }
  }
  return cash
}

/**
 * Computes annual other income (pension, Social Security, etc.) for a profile at a given age.
 */
export function calculateOtherIncome(
  profile: UserProfile,
  age: number,
  inflationMultiplier = 1
): number {
  let income = 0
  if (profile.pensionMonthly && age >= profile.targetRetirementAge) {
    income += profile.pensionMonthly * 12
  }
  if (
    profile.socialSecurityMonthly &&
    profile.socialSecurityAge &&
    age >= profile.socialSecurityAge
  ) {
    // SSA estimates are in today's dollars and benefits get a yearly COLA,
    // so the benefit grows with the projection's inflation unless the
    // profile opts out (socialSecurityCola: false). Pension and other income
    // stay fixed in dollars.
    const cola = profile.socialSecurityCola === false ? 1 : inflationMultiplier
    income += profile.socialSecurityMonthly * 12 * cola
  }
  if (profile.otherIncomeMonthly) {
    // Gated like every other stream. Previously this paid out at EVERY age —
    // including pre-retirement, and forever — which silently overstated any
    // plan that used it. Defaults preserve "starts at retirement, never ends"
    // when the optional bounds are absent.
    const startAge = profile.otherIncomeStartAge ?? profile.targetRetirementAge
    const endAge = profile.otherIncomeEndAge ?? Infinity
    if (age >= startAge && age <= endAge) {
      income += profile.otherIncomeMonthly * 12
    }
  }
  return income
}

/**
 * Computes a comprehensive portfolio summary with totals and allocations.
 */
export function calculatePortfolioTotals(
  portfolio: Portfolio
): PortfolioSummary {
  const allocationByAssetClass = {} as Record<AssetClass, number>
  const allocationByAccountType = {} as Record<string, number>
  let totalValue = 0
  let totalCash = 0
  let totalCDs = 0
  let totalEquity = 0
  let totalBonds = 0

  for (const account of portfolio.accounts) {
    totalCash += account.cashBalance

    for (const holding of account.holdings) {
      totalValue += holding.currentValue
      const ac = holding.assetClass
      allocationByAssetClass[ac] =
        (allocationByAssetClass[ac] ?? 0) + holding.currentValue

      if (
        ac === 'us_equity' ||
        ac === 'intl_equity' ||
        ac === 'emerging_equity'
      ) {
        totalEquity += holding.currentValue
      } else if (ac === 'us_bond' || ac === 'intl_bond' || ac === 'tips') {
        totalBonds += holding.currentValue
      } else if (ac === 'cash' || ac === 'money_market') {
        // Cash equivalents: brokers such as Fidelity list the core position
        // (SPAXX/FDRXX) as a fund row instead of a cashBalance.
        totalCash += holding.currentValue
      }
    }

    for (const cd of account.cds) {
      totalCDs += cd.principal
      totalValue += cd.principal
    }

    totalValue += account.cashBalance
    const at = account.accountType
    const accountTotal =
      account.holdings.reduce((s, h) => s + h.currentValue, 0) +
      account.cds.reduce((s, c) => s + c.principal, 0) +
      account.cashBalance
    allocationByAccountType[at] =
      (allocationByAccountType[at] ?? 0) + accountTotal
  }

  return {
    totalValue,
    totalCash,
    totalCDs,
    totalEquity,
    totalBonds,
    allocationByAssetClass,
    allocationByAccountType: allocationByAccountType as Record<string, number>,
  }
}

function calendarYear(isoDate: string, field: string): number {
  // Only the year places the payoff, so YYYY, YYYY-MM, YYYY-MM-DD and a full
  // ISO timestamp all work.
  const match = /^(\d{4})(?:-\d{2}(?:-\d{2}(?:T.*)?)?)?$/.exec(isoDate)
  if (match === null) {
    throw new RangeError(
      `${field} must be an ISO date (YYYY-MM-DD) to place the mortgage payoff, got "${isoDate}"`
    )
  }
  return Number(match[1])
}

/**
 * The age at which the saved mortgage payment stops: currentAge plus the
 * years from the portfolio's as-of year to the payoff year. Undefined when
 * the mortgage names no monthlyPayment or no payoffDate.
 */
export function mortgagePayoffAge(
  profile: UserProfile,
  asOfDate: string
): number | undefined {
  const mortgage = profile.mortgage
  if (
    mortgage?.monthlyPayment === undefined ||
    mortgage.payoffDate === undefined
  ) {
    return undefined
  }
  return (
    profile.currentAge +
    calendarYear(mortgage.payoffDate, 'mortgage.payoffDate') -
    calendarYear(asOfDate, 'portfolio.asOfDate')
  )
}

/**
 * The portfolio withdrawal that leaves `need` after tax: need / (1 −
 * withdrawalTaxRate). With no withdrawalTaxRate the withdrawal is the need
 * (annualExpenses is then read as the gross withdrawal).
 */
export function grossWithdrawal(profile: UserProfile, need: number): number {
  const rate = profile.withdrawalTaxRate ?? 0
  return rate > 0 && rate < 1 ? need / (1 - rate) : need
}

/** Default selling costs for a homeSale, as a fraction of the sale price. */
export const DEFAULT_SELLING_COST_RATE = 0.06

/**
 * The spending at `age` in today's dollars before any mortgage or home sale
 * adjustment: the annualExpenses of the last spending phase whose startAge is
 * at or below `age`, else the profile annualExpenses.
 */
export function baseExpensesAt(profile: UserProfile, age: number): number {
  let expenses = profile.annualExpenses
  for (const phase of profile.spendingPhases ?? []) {
    if (age >= phase.startAge) expenses = phase.annualExpenses
  }
  return expenses
}

/**
 * The age from which the mortgage monthlyPayment stops: the payoff age, or the
 * homeSale age when that comes first. Undefined when the mortgage names no
 * monthlyPayment, or neither a payoffDate nor a homeSale ends it.
 */
export function mortgagePaymentEndAge(
  profile: UserProfile,
  asOfDate: string
): number | undefined {
  if (profile.mortgage?.monthlyPayment === undefined) return undefined
  const payoffAge = mortgagePayoffAge(profile, asOfDate)
  // REQ-MCP-86: a reverse mortgage pays the mortgage off when it opens.
  const hecm = reverseMortgagePlan(profile, asOfDate)
  const hecmAge = hecm?.opens === true ? hecm.openAge : undefined
  const ends = [payoffAge, profile.homeSale?.age, hecmAge].filter(
    (a): a is number => a !== undefined
  )
  return ends.length === 0 ? undefined : Math.min(...ends)
}

function calendarMonth(isoDate: string): number {
  const match = /^\d{4}-(\d{2})/.exec(isoDate)
  return match === null ? 1 : Number(match[1])
}

/**
 * The mortgage balance owed on 1 January of `year`, amortized monthly from the
 * mortgage balance at its asOfDate with its rate and monthlyPayment. Without a
 * monthlyPayment the balance is held (no paydown is assumed); after the payoff
 * year it is 0. Never negative.
 */
export function mortgageBalanceAtYearStart(
  profile: UserProfile,
  year: number
): number {
  const mortgage = profile.mortgage
  if (mortgage === undefined) return 0
  if (
    mortgage.payoffDate !== undefined &&
    year > calendarYear(mortgage.payoffDate, 'mortgage.payoffDate')
  ) {
    return 0
  }
  const months =
    (year - calendarYear(mortgage.asOfDate, 'mortgage.asOfDate')) * 12 +
    (1 - calendarMonth(mortgage.asOfDate))
  const payment = mortgage.monthlyPayment
  if (months <= 0 || payment === undefined) return mortgage.balance
  const monthlyRate = (mortgage.rate ?? 0) / 12
  if (monthlyRate === 0) {
    return Math.max(0, mortgage.balance - payment * months)
  }
  const growth = Math.pow(1 + monthlyRate, months)
  return Math.max(
    0,
    mortgage.balance * growth - (payment * (growth - 1)) / monthlyRate
  )
}

/**
 * The month (YYYY-MM) the mortgage's monthlyPayment pays off its balance at
 * its rate, amortized monthly from its asOfDate. Undefined without a
 * monthlyPayment, or when the payment does not cover the monthly interest.
 */
export function impliedMortgagePayoffMonth(
  profile: UserProfile
): string | undefined {
  const mortgage = profile.mortgage
  const payment = mortgage?.monthlyPayment
  if (mortgage === undefined || payment === undefined || payment <= 0) {
    return undefined
  }
  const monthlyRate = (mortgage.rate ?? 0) / 12
  let months: number
  if (monthlyRate === 0) {
    months = Math.ceil(mortgage.balance / payment)
  } else {
    const interest = mortgage.balance * monthlyRate
    if (payment <= interest) return undefined
    months = Math.ceil(
      -Math.log(1 - interest / payment) / Math.log(1 + monthlyRate)
    )
  }
  // The first payment after asOfDate is in the following month.
  const startIndex =
    calendarYear(mortgage.asOfDate, 'mortgage.asOfDate') * 12 +
    (calendarMonth(mortgage.asOfDate) - 1)
  const lastIndex = startIndex + months
  const year = Math.floor(lastIndex / 12)
  const month = (lastIndex % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * A warning when the mortgage payoffDate year is more than one year away from
 * the payoff its balance, rate and monthlyPayment imply, else undefined. The
 * projections use payoffDate to stop the payment, so a mistyped date moves
 * spending by 12 × monthlyPayment a year.
 */
export function mortgagePayoffWarning(
  profile: UserProfile
): string | undefined {
  const stated = profile.mortgage?.payoffDate
  const implied = impliedMortgagePayoffMonth(profile)
  if (stated === undefined || implied === undefined) return undefined
  const statedYear = calendarYear(stated, 'mortgage.payoffDate')
  const impliedYear = Number(implied.slice(0, 4))
  if (Math.abs(statedYear - impliedYear) <= 1) return undefined
  return `mortgage.payoffDate ${stated} does not match the payoff the balance, rate and monthlyPayment imply (${implied}); the projections stop the payment at payoffDate, so check it`
}

export interface HomeSaleResult {
  readonly age: number
  readonly year: number
  readonly salePrice: number
  readonly sellingCosts: number
  readonly mortgageBalancePaid: number
  readonly replacementHomeCost: number
  /** Added to the portfolio in the sale year; negative when the sale costs cash. */
  readonly netProceeds: number
  readonly annualHousingCostChange: number
}

/**
 * The engine's figures for the profile homeSale, or undefined without one.
 * The sale is placed on 1 January of the calendar year of its age (the
 * portfolio as-of year plus the years from currentAge), when the amortized
 * mortgage balance is paid off from the proceeds.
 */
export function homeSaleAt(
  profile: UserProfile,
  asOfDate: string
): HomeSaleResult | undefined {
  const sale = profile.homeSale
  if (sale === undefined) return undefined
  const year =
    calendarYear(asOfDate, 'portfolio.asOfDate') +
    (sale.age - profile.currentAge)
  const salePrice = sale.salePrice ?? profile.home?.estimatedValue ?? 0
  const sellingCosts =
    salePrice * (sale.sellingCostRate ?? DEFAULT_SELLING_COST_RATE)
  const mortgageBalancePaid = mortgageBalanceAtYearStart(profile, year)
  const replacementHomeCost = sale.replacementHomeCost ?? 0
  const round = (value: number): number => Math.round(value * 100) / 100
  return {
    age: sale.age,
    year,
    salePrice: round(salePrice),
    sellingCosts: round(sellingCosts),
    mortgageBalancePaid: round(mortgageBalancePaid),
    replacementHomeCost: round(replacementHomeCost),
    netProceeds: round(
      salePrice - sellingCosts - mortgageBalancePaid - replacementHomeCost
    ),
    annualHousingCostChange: sale.annualHousingCostChange ?? 0,
  }
}

/**
 * The amount added to the portfolio in the projection year at `age` before
 * withdrawals: annualContributions before targetRetirementAge, plus the
 * homeSale net proceeds in the sale year. 0 when the profile has neither.
 */
export function cashInflowAt(
  profile: UserProfile,
  age: number,
  asOfDate: string
): number {
  let inflow =
    age < profile.targetRetirementAge ? (profile.annualContributions ?? 0) : 0
  if (profile.homeSale !== undefined && age === profile.homeSale.age) {
    inflow += homeSaleAt(profile, asOfDate)?.netProceeds ?? 0
  }
  return inflow
}

/**
 * The expenses for one projection year at `age`. The base spending is the
 * spending phase for that age, else annualExpenses; it includes the mortgage
 * monthlyPayment, which is fixed in dollars: the rest of the spending grows
 * with the year's inflation multiplier, and 12 × monthlyPayment is added
 * unchanged until the payment stops (payoff or home sale). From a homeSale
 * age its annualHousingCostChange (today's dollars) is added, grown with
 * inflation. Never negative. With none of these the result is
 * annualExpenses × inflationMultiplier.
 */
export function annualExpensesAt(
  profile: UserProfile,
  age: number,
  inflationMultiplier: number,
  asOfDate: string
): number {
  const base = baseExpensesAt(profile, age)
  const sale = profile.homeSale
  const housingChange =
    sale !== undefined && age >= sale.age
      ? (sale.annualHousingCostChange ?? 0) * inflationMultiplier
      : 0
  const endAge = mortgagePaymentEndAge(profile, asOfDate)
  if (endAge === undefined) {
    return Math.max(0, base * inflationMultiplier + housingChange)
  }
  const payment = 12 * (profile.mortgage?.monthlyPayment ?? 0)
  const other = Math.max(0, base - payment)
  return Math.max(
    0,
    other * inflationMultiplier + (age < endAge ? payment : 0) + housingChange
  )
}
