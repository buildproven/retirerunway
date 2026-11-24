// ---------------------------------------------------------------------------
// RetireRunway – Core Financial Domain Types
// All financial calculations use these types and must be deterministic.
//
// Unit conventions:
//   - Rates are decimals: 0.07 = 7%, 0.045 = 4.5%
//   - Tax rates are decimals: 0.22 = 22% bracket
//   - Currency values are USD numbers (no cents rounding at type level)
//   - Dates are ISO 8601 strings: "2026-01-30"
// ---------------------------------------------------------------------------

// --- Enums & Literals ---

/**
 * Every account type, the one source for the type and the input schemas.
 * `nqdc` is a non-qualified deferred compensation plan: pre-tax money whose
 * every distribution is ordinary income; it cannot be rolled over or
 * Roth-converted and the Rule of 55 does not apply to it.
 */
export const ACCOUNT_TYPES = [
  'brokerage',
  'traditional_ira',
  'roth_ira',
  'rollover_ira',
  '401k',
  'roth_401k',
  '403b',
  '457b',
  'nqdc',
  'hsa',
] as const

export type AccountType = (typeof ACCOUNT_TYPES)[number]

export type AssetClass =
  | 'us_equity'
  | 'intl_equity'
  | 'emerging_equity'
  | 'us_bond'
  | 'intl_bond'
  | 'tips'
  | 'money_market'
  | 'cd'
  | 'reit'
  | 'commodity'
  | 'crypto'
  | 'cash'
  | 'other'

export type ScenarioType =
  | 'bull'
  | 'base'
  | 'early_bear'
  | 'prolonged_bear'
  | 'custom'

export type RiskLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

export type TradeAction = 'sell' | 'buy'

export type CDTermMonths = 3 | 6 | 9 | 12 | 18 | 24 | 36 | 48 | 60

// --- Core Domain ---

export interface Holding {
  id: string
  symbol: string
  name: string
  assetClass: AssetClass
  shares: number
  costBasis: number
  currentPrice: number
  currentValue: number
}

export interface CD {
  id: string
  institution: string
  principal: number
  apy: number
  termMonths: CDTermMonths
  maturityDate: string // ISO date
  purchaseDate: string // ISO date
  earlyWithdrawalPenaltyMonths: number
}

export interface Account {
  id: string
  name: string
  institution: string
  accountType: AccountType
  holdings: Holding[]
  cds: CD[]
  cashBalance: number
}

export interface Portfolio {
  id: string
  name: string
  accounts: Account[]
  asOfDate: string // ISO date
}

// --- Derived / Computed (returned by engine, not stored) ---

export interface PortfolioSummary {
  totalValue: number
  totalCash: number
  totalCDs: number
  totalEquity: number
  totalBonds: number
  allocationByAssetClass: Record<AssetClass, number>
  allocationByAccountType: Record<AccountType, number>
}

export interface HoldingWithWeight extends Holding {
  weightInAccount: number
  weightInPortfolio: number
  unrealizedGainLoss: number
}

// --- Scenario Engine ---

export interface ScenarioParameters {
  type: ScenarioType
  label: string
  equityReturnRate: number
  bondReturnRate: number
  inflationRate: number
  durationYears: number
  drawdownPercent: number
}

export interface ProjectionYear {
  year: number
  age: number
  startBalance: number
  growth: number
  withdrawal: number
  endBalance: number
  inflationAdjustedWithdrawal: number
  cumulativeWithdrawals: number
  /**
   * Added to the portfolio this year before withdrawals: annualContributions
   * before retirement plus any homeSale net proceeds. Present only when not 0.
   */
  cashInflow?: number
}

export interface ScenarioResult {
  scenarioType: ScenarioType
  parameters: ScenarioParameters
  projections: ProjectionYear[]
  runwayYears: number
  depletionAge: number | null // null = money never runs out
  sequenceOfReturnsRisk: RiskLevel
}

// --- Trade Plan ---

export interface Trade {
  holdingId: string
  accountId: string
  action: TradeAction
  shares: number
  estimatedValue: number
  estimatedTaxImpact: number
  priority: number
  rationale: string
}

export interface TradePlan {
  trades: Trade[]
  totalProceeds: number
  totalTaxImpact: number
  targetCashPosition: number
}

// --- CD Logic ---

export interface CDBreakAnalysis {
  cdId: string
  penaltyAmount: number
  penaltyMonths: number
  accruedInterest: number
  netProceeds: number
  breakEvenDate: string // ISO date — when holding beats breaking
  recommendation: 'break' | 'hold'
  rationale: string
}

// --- Cash Ladder ---

export interface LadderRung {
  year: number
  source: 'cash' | 'cd' | 'bond' | 'sell_equity'
  amount: number
  maturityDate?: string // for CDs
  cdId?: string
}

export interface CashLadder {
  rungs: LadderRung[]
  totalFunded: number
  yearsOfExpensesCovered: number
  annualExpenseTarget: number
}

// --- User Input / Config ---

/** The owner's goals for the plan (REQ-MCP-68). */
export interface PlanGoals {
  /** Chance the money lasts at long-run returns. Default 0.85. */
  successRate?: number
  /** Chance at the 10-year forecast returns. Default 0.75. */
  forecastSuccessRate?: number
  /** The latest retirement age to consider. Default 70. */
  latestAge?: number
  /** Days between plan reviews. Default 30. */
  reviewEveryDays?: number
}

export interface UserProfile {
  currentAge: number
  targetRetirementAge: number
  annualExpenses: number
  socialSecurityAge?: number
  socialSecurityMonthly?: number
  pensionMonthly?: number
  otherIncomeMonthly?: number
  /** Age this income begins. Defaults to targetRetirementAge when omitted. */
  otherIncomeStartAge?: number
  /** Age this income ends (inclusive). Unbounded when omitted. */
  otherIncomeEndAge?: number
  stateTaxRate?: number
  federalTaxBracket?: number
  /**
   * Whether Social Security grows with inflation in the projections (a COLA).
   * Defaults to true: SSA estimates are in today's dollars. Set false for a
   * benefit entered in future dollars.
   */
  socialSecurityCola?: boolean
  /**
   * Average tax rate on portfolio withdrawals (0–0.6). The projections
   * withdraw need / (1 − rate), so annualExpenses is after-tax spending.
   * Without it annualExpenses is read as the gross withdrawal.
   */
  withdrawalTaxRate?: number
  /**
   * Amount added to the portfolio each projection year before
   * targetRetirementAge (all retirement and taxable savings, employer match
   * included). Fixed in dollars, not grown with inflation.
   */
  annualContributions?: number
  /**
   * Spending that changes with age, in today's dollars. From each phase's
   * startAge its annualExpenses replaces the profile annualExpenses (it
   * includes the mortgage monthlyPayment while that is paid, as annualExpenses
   * does). Ages before the first phase use annualExpenses. Phases are in
   * increasing startAge order.
   */
  spendingPhases?: SpendingPhase[]
  /** The user's home. Its equity counts toward net worth; only a homeSale spends it. */
  home?: Home
  /** The mortgage on the home. */
  mortgage?: Mortgage
  /** A planned sale (or downsize) of the home. */
  homeSale?: HomeSale
  // ---- Read by the v2 retirement projection (project_retirement) only ----
  /** The spouse: age and own Social Security benefit (today's dollars). */
  spouse?: SpouseInfo
  /** Last age the projection covers. Defaults to 95. */
  planningAge?: number
  /** Federal filing status. Defaults to married_filing_jointly with a spouse, else single. */
  filingStatus?: 'single' | 'married_filing_jointly' | 'head_of_household'
  /**
   * The state does not tax retirement-plan withdrawals, pensions or Social
   * Security (Illinois, for one). stateTaxRate then applies only to NQDC
   * payouts, other income and capital gains.
   */
  stateExemptsRetirementIncome?: boolean
  /**
   * Household health insurance each year from targetRetirementAge until 65,
   * in today's dollars (half while only a younger spouse is under 65). Leave
   * it out of spendingPhases so it is not counted twice.
   */
  preMedicareHealthcare?: number
  /**
   * Age leaving the employer whose 401(k)/403(b)/457(b) is drawn. At 55 or
   * later the Rule of 55 lets that plan pay out without the 10% penalty.
   * Defaults to targetRetirementAge.
   */
  separationAge?: number
  /** When the NQDC balance pays out: equal shares over `years` from `startAge`. */
  nqdcPayout?: NqdcPayout
  /**
   * Buy Marketplace (ACA) coverage before 65 and claim the premium tax
   * credit. preMedicareHealthcare is then the unsubsidized benchmark silver
   * premium, and the credit is figured each year from projected MAGI.
   */
  acaPremiumTaxCredit?: boolean
  /** Tax household size for the poverty line. Defaults to 2 with a spouse, else 1. */
  householdSize?: number
  /**
   * The owner's own portfolio rules, read by plan_check (REQ-MCP-47): target
   * stock share, drift band, cash buffer, sell schedule and accounts never to
   * sell from. The projections ignore it.
   */
  /**
   * What the owner is aiming for (REQ-MCP-68): the success rates a retirement
   * age must reach (default the GO thresholds), the latest age worth
   * considering, and how often the plan is reviewed.
   */
  goals?: PlanGoals
  /**
   * Stock share by age (REQ-MCP-71): points joined by straight lines, held
   * flat before the first and after the last. Absent: the snapshot's share
   * every year.
   */
  glidePath?: GlidePoint[]
  /** Which accounts pay spending first (REQ-MCP-70). Default taxableFirst. */
  withdrawalOrder?: WithdrawalOrder
  /** Card and other short-term debt to clear, today's dollars (REQ-MCP-72). */
  consumerDebt?: number
  planRules?: PlanRules
  /**
   * A survivor scenario (REQ-MCP-48): one spouse dies at deathAge (the
   * owner's age). From the next year the survivor files single, keeps the
   * larger of their own Social Security and the survivor benefit, pays
   * healthcare and IRMAA for one, and spends spendingShare (default 0.75)
   * of the couple's spending beyond the mortgage payment. Needs a spouse.
   */
  survivor?: SurvivorScenario
  /**
   * Near-term market assumptions (REQ-MCP-51): mean stock, bond and
   * inflation rates for the first `years` (default 10), then the engine's
   * long-run means. preset 'forecast' uses the 10-year valuation-based
   * forecasts in MARKET_FORECAST. Volatility is unchanged.
   */
  marketAssumptions?: MarketAssumptions
  /**
   * A gap in pay before retirement (REQ-MCP-52): the job ends at startAge,
   * months without pay follow (household spending and healthcare come from
   * savings, no contributions), then savings resume at
   * newAnnualContributions until targetRetirementAge.
   */
  incomeGap?: IncomeGap
  /**
   * A cut to Social Security from a calendar year (REQ-MCP-59): every
   * benefit (own, spousal, survivor) is multiplied by 1 - share from
   * startYear. Defaults follow the 2026 Trustees Report (SOCIAL_SECURITY_CUT_2026).
   */
  socialSecurityCut?: SocialSecurityCut
  /**
   * One-off after-tax money that arrives at an age (REQ-MCP-60), such as a
   * foreign pension paid out, an inheritance or a business sale. Each amount
   * is in today's dollars and lands in the taxable account as basis.
   */
  lumpSums?: LumpSum[]
}

export interface LumpSum {
  /** A label, such as 'Foreign pension'. */
  name: string
  /** The owner's age when the money arrives. */
  age: number
  /** After-tax amount in today's dollars. */
  amount: number
}

export interface SocialSecurityCut {
  /** Share of scheduled benefits cut, 0-0.5 (default 0.22: 78% payable). */
  share?: number
  /** First calendar year of the cut (default 2033). */
  startYear?: number
}

export interface MarketAssumptions {
  /** 'forecast': the 10-year valuation-based forecasts; 'long_run': the engine's means. */
  preset?: 'forecast' | 'long_run'
  /** Mean nominal stock return a year, overriding the preset. */
  equityMean?: number
  /** Mean nominal bond return a year, overriding the preset. */
  bondMean?: number
  /** Mean inflation a year, overriding the preset. */
  inflationMean?: number
  /** Years from today these means apply before the long-run means (default 10). */
  years?: number
}

export interface IncomeGap {
  /** The owner's age when the job ends. */
  startAge: number
  /** Months without pay (0-120). */
  months: number
  /** After-tax severance in today's dollars, added to taxable savings at startAge. */
  severance?: number
  /** Yearly savings once re-employed (default annualContributions). */
  newAnnualContributions?: number
  /** Household spending a month during the gap, today's dollars (default annualExpenses / 12). */
  monthlySpending?: number
  /** Health insurance a month during the gap (COBRA or Marketplace), today's dollars (default preMedicareHealthcare / 12). */
  healthcareMonthly?: number
}

export interface SurvivorScenario {
  /** Who dies: the owner (self) or the spouse. */
  deceased: 'self' | 'spouse'
  /** The owner's age in the year of death. */
  deathAge: number
  /** The survivor's spending as a share of the couple's, beyond the mortgage payment. Default 0.75. */
  spendingShare?: number
  /** Life insurance paid tax-free the year after the death, today's dollars (REQ-MCP-55). */
  lifeInsurance?: number
  /** The survivor's age to start the survivor benefit (60-67), overriding the default choice (REQ-MCP-48). */
  survivorClaimAge?: number
}

/** One planned sale in the owner's schedule, in dollars. */
export interface ScheduledSale {
  /** Short label, such as "VOO chunk 1". */
  id: string
  /** The date the sale is planned for (YYYY-MM-DD). */
  dueDate: string
  /** Ticker to sell. */
  symbol: string
  amount: number
  /** Account type to sell in, such as 401k. Any eligible account when left out. */
  accountType?: AccountType
  /** True once the owner has placed the sale. */
  done?: boolean
}

/** One point of a stock-share glide path (REQ-MCP-71). */
export interface GlidePoint {
  age: number
  /** Share of the portfolio in stocks at this age, 0–1. */
  equityShare: number
}

/**
 * Order the accounts pay spending in (REQ-MCP-70), always after RMDs and the
 * NQDC payout and before any penalised early withdrawal:
 * - taxableFirst: taxable, then pre-tax (401(k) when open, IRA from 60), then Roth.
 * - preTaxFirst: pre-tax, then taxable, then Roth.
 * - proportional: from every open account at once, in proportion to balances.
 */
export type WithdrawalOrder = 'taxableFirst' | 'preTaxFirst' | 'proportional'

/** The owner's portfolio rules that plan_check measures the snapshot against. */
export interface PlanRules {
  /** Target share of the portfolio in stocks (us, intl, emerging equity), 0–1. */
  targetEquityShare: number
  /** How far the stock share may drift above or below target before acting, 0–1. Default 0.05. */
  driftBand?: number
  /**
   * Minimum liquid cash, in years of retirement spending. Default 1. Only
   * taxable accounts and outsideCash count: cash inside a 401(k) or IRA is
   * not liquid (REQ-MCP-62).
   */
  minCashBufferYears?: number
  /** Liquid cash not in the snapshot, such as bank savings, in today's dollars (REQ-MCP-62). */
  outsideCash?: number
  /** Account types never to sell from, such as brokerage. */
  protectedAccountTypes?: AccountType[]
  sellSchedule?: ScheduledSale[]
  /** Tickers that count toward the cash buffer, such as short Treasury ladder ETFs. */
  bufferSymbols?: string[]
  /** One-off actions that are not stock sales, such as a fund switch (REQ-MCP-61). */
  tasks?: PlanTask[]
  /** The age the liquid cash buffer is needed from (REQ-MCP-65); before it plan_check only measures it. */
  bufferStartAge?: number
  /** A CD or Treasury ladder to build in one account type (REQ-MCP-63). */
  cdLadder?: CdLadderRule
}

/** A ladder of CDs or Treasuries, one rung maturing each year (REQ-MCP-63). */
export interface CdLadderRule {
  /** The account type the rungs are bought in, such as 401k for a BrokerageLink window. */
  accountType: AccountType
  /** Part of the account's name, such as BrokerageLink, when several accounts share the type. Default: the one holding the most ladder money. */
  accountName?: string
  /** The first and last calendar year a rung matures. */
  firstYear: number
  lastYear: number
  /**
   * Ladder size in today's dollars, counting what already sits in it. Default:
   * the rungs already held, holdings that mature into it, idle cash in the
   * account type, and the sell schedule's proceeds there.
   */
  total?: number
  /** Most to place with one bank in one rung before splitting it. Default $250,000 (the FDIC limit). */
  maxPerIssuer?: number
}

/** A current yield the owner or the agent read from the broker (REQ-MCP-63). */
export interface RateQuote {
  kind: 'cd' | 'treasury'
  /** Term in whole years, 1 to 10. */
  termYears: number
  /** Annual yield as a fraction, such as 0.048. */
  apy: number
  /** False for a callable CD; callable CDs are never used. */
  callProtected?: boolean
  /** Where the quote came from, such as "Fidelity new-issue CDs, highest yield". */
  source: string
  /** The date of the quote (YYYY-MM-DD). */
  quotedOn: string
}

export interface PlanTask {
  /** Short label, such as "nqdc-fund-switch". */
  id: string
  /** The date the action is due (YYYY-MM-DD). */
  dueDate: string
  /** What to do, in one line, such as "Switch the NQDC high-yield fund to the stable value option". */
  action: string
  /** True once the owner has done it. */
  done?: boolean
}

export interface SpouseInfo {
  currentAge: number
  socialSecurityAge?: number
  /** Monthly benefit in today's dollars from socialSecurityAge. */
  socialSecurityMonthly?: number
}

export interface NqdcPayout {
  startAge: number
  years: number
  /** True when the election pays from separation (leaving the job), not startAge (REQ-MCP-57). */
  onSeparation?: boolean
}

export interface SpendingPhase {
  /** First age (inclusive) this spending applies to. */
  startAge: number
  /** Annual spending from startAge, in today's dollars. */
  annualExpenses: number
}

/**
 * A planned sale of the home in the projection year at `age`. All amounts are
 * in today's dollars and are not grown with inflation. The net proceeds
 * (salePrice less selling costs, the mortgage balance then owed and the
 * replacement home cost) are added to the portfolio that year, the mortgage
 * payment stops from that age, and annualHousingCostChange applies from that
 * age.
 */
export interface HomeSale {
  /** Age in the projection year of the sale. */
  age: number
  /** Sale price. Defaults to home.estimatedValue. */
  salePrice?: number
  /** Selling costs as a fraction of salePrice. Defaults to 0.06. */
  sellingCostRate?: number
  /** Cash paid for the next home (0 when renting). Defaults to 0. */
  replacementHomeCost?: number
  /**
   * Change to annual spending from the sale age, in today's dollars: negative
   * for lower property tax and insurance, positive for rent. Defaults to 0.
   */
  annualHousingCostChange?: number
}

export interface Home {
  estimatedValue: number
  /** Low end of the estimated value range. */
  low?: number
  /** High end of the estimated value range. */
  high?: number
}

export interface Mortgage {
  balance: number
  /** ISO date (YYYY-MM-DD) the balance was read. */
  asOfDate: string
  /** Annual interest rate as a fraction (0.065 = 6.5%). */
  rate?: number
  /** Principal and interest paid each month, included in annualExpenses. */
  monthlyPayment?: number
  /** ISO date (YYYY-MM-DD) of the last payment. */
  payoffDate?: string
}

// --- Import / CSV ---

export type BrokerageFormat = 'fidelity' | 'schwab' | 'vanguard' | 'generic'

export interface ImportResult {
  accounts: Account[]
  format: BrokerageFormat
  warnings: string[]
  rowsImported: number
  rowsSkipped: number
}
