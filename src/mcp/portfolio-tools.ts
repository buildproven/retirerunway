// Portfolio MCP tools over the deterministic portfolio engine (REQ-MCP-5..8).
// The engine computes every number; this layer validates input, calls the
// engine as the /api/v1 routes do, and stamps each result with provenance.
// import_positions can save a snapshot, and a tool called without
// `portfolio` or `profile` uses the saved ones (REQ-MCP-13, REQ-MCP-14).
import type { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { generateAlerts, isCalendarDate } from '../engine/alerts'
import { analyzeAllCDs } from '../engine/cd-analysis'
import { parsePortfolioCSV } from '../engine/csv-parser'
import { generateLadderPlan } from '../engine/ladder-plan'
import { calculateSequenceRisk } from '../engine/risk-scoring'
import { optimizeRothConversion } from '../engine/roth-conversion'
import { analyzeRuleOf55 } from '../engine/rule-of-55'
import { runAllScenarios } from '../engine/scenarios'
import { calculateTaxBreakdown } from '../engine/tax-brackets'
import { generateTradePlan } from '../engine/trade-plan'
import { runMonteCarlo } from '../engine/monte-carlo'
import { applyScenario, compareScenarios } from '../engine/scenario-comparison'
import {
  ClaimingError,
  DEFAULT_CLAIM_AGES,
  exploreClaimingAges,
} from '../engine/claiming-explorer'
import { backtestHistory } from '../engine/historical-backtest'
import { explainChange } from '../engine/change-explainer'
import { VERDICT_THRESHOLDS, planVerdict } from '../engine/plan-verdict'
import { POLICY_DEFAULTS, proposePlanPolicy } from '../engine/plan-policy'
import { REVIEW_DEFAULTS, reviewPlan } from '../engine/plan-review'
import {
  TIMING_DEFAULTS,
  earliestRetirement,
  rankLevers,
} from '../engine/retirement-timing'
import {
  PLAN_CHECK_DEFAULTS,
  PlanCheckError,
  checkPlan,
  type PlanCheckResult,
} from '../engine/plan-check'
import {
  GUARDRAIL_DEFAULTS,
  spendingGuardrails,
} from '../engine/spending-guardrails'
import {
  DEFAULT_CONVERSION_STRATEGIES,
  exploreRothConversions,
} from '../engine/roth-conversion-explorer'
import type { NamedStrategy } from '../engine/roth-conversion-explorer'
import { getFederalBrackets } from '../engine/tax-brackets'
import {
  ACA_SUBSIDY_CLIFF,
  CLIFF_MARGIN,
  EARLY_WITHDRAWAL_PENALTY,
  PENALTY_FREE_AGE,
  RMD_START_AGE,
  RULE_OF_55_AGE,
  filingStatusOf,
  projectRetirement,
  projectionCharts,
  projectionWarnings,
} from '../engine/retirement-projection'
import { MONTE_CARLO_DEFAULTS } from '../engine/config'
import {
  calculatePortfolioValue,
  homeSaleAt,
  impliedMortgagePayoffMonth,
  mortgagePaymentEndAge,
  mortgagePayoffAge,
  mortgagePayoffWarning,
} from '../engine/portfolio-math'
import type { Account, Portfolio, UserProfile } from '../engine/types'
import {
  AnalyzeRequestSchema,
  TaxRequestSchema,
} from '../lib/validation-schemas'
import {
  contentHashId,
  stamp,
} from '../../skills/retire-runway/scripts/provenance'
import { jsonResult } from './result'
import { openDataStore } from './git-store'
import { UserStoreError, snapshotPortfolio } from './user-store'
import {
  importPositionsInput,
  compareScenariosInput,
  planCheckInput,
  exploreClaimingAgesInput,
  historicalBacktestInput,
  planVerdictInput,
  proposePlanRulesInput,
  earliestRetirementInput,
  rankLeversInput,
  reviewPlanInput,
  explainChangeInput,
  portfolioAnalysisInput,
  projectRetirementInput,
  spendingGuardrailsInput,
  exploreRothConversionsInput,
  taxStrategyInput,
  tradePlanInput,
} from './schemas'

export const NO_AS_OF_DATE_WARNING = 'no as-of date: pass asOfDate'

export type AsOfDateSource = 'input' | 'csv' | 'none'

export interface FieldError {
  readonly field: string
  readonly message: string
}

export function errorResult(errors: readonly FieldError[]): CallToolResult {
  return { ...jsonResult({ ok: false, errors }), isError: true }
}

/** Runs a store operation and turns a UserStoreError into a field error. */
export async function fromStore<T>(
  operation: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: FieldError }> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (!(error instanceof UserStoreError)) throw error
    return { ok: false, error: { field: error.field, message: error.message } }
  }
}

/** The saved files a portfolio tool used, named in its provenance stamp. */
interface SavedData {
  profile?: { file: string; updatedAt: string }
  portfolio?: { file: string; asOfDate: string }
}

type ResolvedInputs =
  | {
      readonly ok: true
      readonly portfolio: Portfolio
      readonly profile: UserProfile
      readonly savedData?: SavedData
    }
  | { readonly ok: false; readonly errors: FieldError[] }

const NO_PROFILE_MESSAGE =
  'no profile passed and none saved: call save_profile first, or pass profile'
const NO_PORTFOLIO_MESSAGE =
  'no portfolio passed and no snapshot saved: call import_positions with asOfDate and save: true first, or pass portfolio'

/**
 * The portfolio and profile for a portfolio tool: each argument as passed,
 * else the saved profile and the newest saved snapshot (REQ-MCP-14).
 */
/** REQ-MCP-53: the v2 projection's headline, for the v1 tools to point to. */
function v2Summary(portfolio: Portfolio, profile: UserProfile, seed: number) {
  const projection = projectRetirement(portfolio, profile, { seed })
  return {
    model: 'project_retirement (v2)',
    successRate: projection.monteCarlo.successRate,
    depletionAgeOnFailingPaths: projection.monteCarlo.depletionAge,
    planningAge: projection.planningAge,
    note: 'monteCarlo above is the older v1 model (a flat withdrawal tax rate, one pooled portfolio); quote this v2 success rate, or run project_retirement for the detail',
  }
}

async function resolveInputs(
  tool: string,
  args: {
    portfolio?: Portfolio
    profile?: UserProfile
  }
): Promise<ResolvedInputs> {
  if (args.portfolio !== undefined && args.profile !== undefined) {
    return { ok: true, portfolio: args.portfolio, profile: args.profile }
  }
  const opened = await fromStore(async () => openDataStore(tool))
  if (!opened.ok) return { ok: false, errors: [opened.error] }
  const store = opened.value
  const errors: FieldError[] = []
  const savedData: SavedData = {}

  let profile = args.profile
  if (profile === undefined) {
    const read = await fromStore(() => store.readProfile())
    if (!read.ok) errors.push(read.error)
    else if (read.value === undefined)
      errors.push({ field: 'profile', message: NO_PROFILE_MESSAGE })
    else {
      profile = read.value.profile
      savedData.profile = {
        file: read.value.file,
        updatedAt: read.value.updatedAt,
      }
    }
  }

  let portfolio = args.portfolio
  if (portfolio === undefined) {
    const read = await fromStore(() => store.newestSnapshot())
    if (!read.ok) errors.push(read.error)
    else if (read.value === undefined)
      errors.push({ field: 'portfolio', message: NO_PORTFOLIO_MESSAGE })
    else {
      portfolio = read.value.portfolio
      savedData.portfolio = {
        file: read.value.file,
        asOfDate: read.value.asOfDate,
      }
    }
  }

  if (errors.length > 0 || portfolio === undefined || profile === undefined) {
    return { ok: false, errors }
  }
  return { ok: true, portfolio, profile, savedData }
}

export interface NetWorth {
  readonly investableValue: number
  readonly homeValue: number
  readonly homeValueLow?: number
  readonly homeValueHigh?: number
  readonly mortgageBalance: number
  readonly homeEquity: number
  readonly netWorth: number
}

/**
 * Net worth for a profile with a home: the investable value plus the home
 * value less the mortgage balance. The home equity is reported here only;
 * the projections never spend it.
 */
function netWorthOf(
  portfolio: Portfolio,
  profile: UserProfile
): { netWorth?: NetWorth } {
  const home = profile.home
  if (home === undefined) return {}
  const investableValue = calculatePortfolioValue(portfolio)
  const mortgageBalance = profile.mortgage?.balance ?? 0
  const homeEquity = home.estimatedValue - mortgageBalance
  return {
    netWorth: {
      investableValue,
      homeValue: home.estimatedValue,
      ...(home.low === undefined ? {} : { homeValueLow: home.low }),
      ...(home.high === undefined ? {} : { homeValueHigh: home.high }),
      mortgageBalance,
      homeEquity,
      netWorth: investableValue + homeEquity,
    },
  }
}

/**
 * The stamp assumptions entries for the home, the mortgage payoff, a planned
 * home sale, pre-retirement contributions and spending phases.
 */
function homeAssumptions(
  portfolio: Portfolio,
  profile: UserProfile
): Record<string, unknown> {
  const payoffAge = mortgagePayoffAge(profile, portfolio.asOfDate)
  const mortgage = profile.mortgage
  const homeSale = homeSaleAt(profile, portfolio.asOfDate)
  const paymentEndAge = mortgagePaymentEndAge(profile, portfolio.asOfDate)
  return {
    ...(profile.home === undefined && homeSale === undefined
      ? {}
      : { homeEquitySpendable: homeSale !== undefined }),
    ...(payoffAge === undefined ||
    mortgage?.monthlyPayment === undefined ||
    mortgage.payoffDate === undefined
      ? {}
      : {
          mortgagePayoff: {
            payoffDate: mortgage.payoffDate,
            payoffAge,
            annualPaymentDropped: 12 * mortgage.monthlyPayment,
            ...(impliedMortgagePayoffMonth(profile) === undefined
              ? {}
              : { impliedPayoffMonth: impliedMortgagePayoffMonth(profile) }),
            ...(paymentEndAge === undefined || paymentEndAge === payoffAge
              ? {}
              : { paymentEndsAtHomeSaleAge: paymentEndAge }),
          },
        }),
    ...(homeSale === undefined ? {} : { homeSale }),
    ...(profile.annualContributions === undefined
      ? {}
      : {
          contributions: {
            annualAmount: profile.annualContributions,
            untilAge: profile.targetRetirementAge,
            inflationAdjusted: false,
          },
        }),
    ...(profile.socialSecurityMonthly === undefined
      ? {}
      : { socialSecurityCola: profile.socialSecurityCola !== false }),
    ...(profile.withdrawalTaxRate === undefined
      ? {}
      : { withdrawalTaxRate: profile.withdrawalTaxRate }),
    ...(profile.spendingPhases === undefined ||
    profile.spendingPhases.length === 0
      ? {}
      : { spendingPhases: profile.spendingPhases }),
  }
}

/** The stamp assumptions entry naming the saved files a call used. */
function savedAssumption(savedData: SavedData | undefined): {
  savedData?: SavedData
} {
  return savedData === undefined ? {} : { savedData }
}

// Brokerage exports name the export date on a metadata line, for example
// Fidelity's `Date downloaded 01/15/2026 10:30 AM ET` footer or a
// `Positions ... as of 04:01 PM ET, 2026-02-27` header.
const EXPORT_DATE_LINE = /\b(date downloaded|as of)\b/i
const US_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/
const ISO_DATE = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/
// Fidelity's footer: `Date downloaded Nov-02-2026 8:47 a.m ET`.
const MONTH_NAME_DATE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s](\d{1,2}),?[-\s](\d{4})\b/i
const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]

function pad(value: string): string {
  return value.padStart(2, '0')
}

function dateOnLine(line: string): string | undefined {
  const iso = ISO_DATE.exec(line)
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`
  const us = US_DATE.exec(line)
  if (us) return `${us[3]}-${pad(us[1])}-${pad(us[2])}`
  const named = MONTH_NAME_DATE.exec(line)
  if (named) {
    const month = MONTHS.indexOf(named[1].toLowerCase()) + 1
    return `${named[3]}-${pad(String(month))}-${pad(named[2])}`
  }
  return undefined
}

/**
 * The export date a brokerage CSV states on its first dated export-date line,
 * as YYYY-MM-DD, or undefined when there is none or it names no real date.
 */
export function findCsvExportDate(csv: string): string | undefined {
  // Fidelity's disclaimer says "as of the date it was exported" above the
  // dated footer, so the first export-date line with a date is used.
  for (const line of csv.split(/\r?\n/)) {
    if (!EXPORT_DATE_LINE.test(line)) continue
    const date = dateOnLine(line)
    if (date !== undefined) return isCalendarDate(date) ? date : undefined
  }
  return undefined
}

interface ImportedPortfolio {
  readonly id: string
  readonly name: string
  readonly accounts: readonly Account[]
  readonly asOfDate?: string
}

/**
 * Applies the /api/v1 value rules for a portfolio request and a real as-of
 * date, and returns field-level errors with the MCP argument names.
 */
function portfolioErrors(
  schema: typeof AnalyzeRequestSchema | typeof TaxRequestSchema,
  request: Record<string, unknown>,
  portfolio: Portfolio
): FieldError[] {
  const errors: FieldError[] = []
  const parsed = schema.safeParse(request)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String)
      if (path[0] === 'userProfile') path[0] = 'profile'
      errors.push({ field: path.join('.'), message: issue.message })
    }
  }
  const dateShapeRejected = errors.some(
    error => error.field === 'portfolio.asOfDate'
  )
  if (!dateShapeRejected && !isCalendarDate(portfolio.asOfDate)) {
    errors.push({
      field: 'portfolio.asOfDate',
      message: 'Must be a real calendar date (YYYY-MM-DD)',
    })
  }
  return errors
}

export function registerPortfolioTools(server: McpServer): void {
  server.registerTool(
    'import_positions',
    {
      title: 'Import brokerage positions',
      description:
        'Parse a Fidelity, Schwab, Vanguard or generic positions CSV into a portfolio. Pass the CSV text and, when known, asOfDate (YYYY-MM-DD). Without asOfDate the export date in the CSV is used; when there is none the portfolio has no as-of date and a warning asks for one. With save: true the portfolio (as-of date required, account numbers removed) is also stored locally as the snapshot for that date.',
      inputSchema: importPositionsInput,
    },
    async args => {
      if (args.asOfDate !== undefined && !isCalendarDate(args.asOfDate)) {
        return errorResult([
          {
            field: 'asOfDate',
            message: 'Must be a real calendar date (YYYY-MM-DD)',
          },
        ])
      }
      const parsed = parsePortfolioCSV(args.csv)
      const csvDate =
        args.asOfDate === undefined ? findCsvExportDate(args.csv) : undefined
      const asOfDate = args.asOfDate ?? csvDate
      const asOfDateSource: AsOfDateSource =
        args.asOfDate !== undefined
          ? 'input'
          : csvDate !== undefined
            ? 'csv'
            : 'none'
      // The ID comes from the CSV content, so the same file gives the same
      // portfolio ID on every import.
      const portfolio: ImportedPortfolio = {
        id: contentHashId('loaded', args.csv),
        name: 'Loaded Portfolio',
        accounts: parsed.accounts,
        ...(asOfDate === undefined ? {} : { asOfDate }),
      }
      let saved:
        | { file: string; asOfDate: string; totalValue: number }
        | undefined
      if (args.save === true) {
        if (asOfDate === undefined) {
          return errorResult([
            {
              field: 'asOfDate',
              message:
                'save: true needs an as-of date and the CSV states none: pass asOfDate',
            },
          ])
        }
        if (parsed.accounts.length === 0) {
          return errorResult([
            {
              field: 'csv',
              message:
                'no accounts were parsed from the CSV, so nothing was saved',
            },
          ])
        }
        // A snapshot worth $0 means no value column was read; saving it
        // would make every later analysis run on nothing.
        const snapshot = snapshotPortfolio(portfolio, asOfDate)
        if (calculatePortfolioValue(snapshot) <= 0) {
          return errorResult([
            {
              field: 'csv',
              message: `the parsed positions total $0, so nothing was saved; check that the CSV has a value column (${parsed.warnings.join('; ') || 'no parser warnings'})`,
            },
          ])
        }
        const written = await fromStore(async () =>
          openDataStore('import_positions').saveSnapshot(snapshot)
        )
        if (!written.ok) return errorResult([written.error])
        saved = {
          file: written.value.file,
          asOfDate: written.value.asOfDate,
          totalValue: calculatePortfolioValue(written.value.portfolio),
        }
      }
      const output = {
        portfolio,
        format: parsed.format,
        warnings:
          asOfDate === undefined
            ? [...parsed.warnings, NO_AS_OF_DATE_WARNING]
            : parsed.warnings,
        rowsImported: parsed.rowsImported,
        rowsSkipped: parsed.rowsSkipped,
        ...(saved === undefined ? {} : { saved }),
      }
      return jsonResult({
        ...output,
        provenance: stamp('import_positions', args, output, {
          assumptions: { format: parsed.format, asOfDateSource },
        }),
      })
    }
  )

  server.registerTool(
    'portfolio_analysis',
    {
      title: 'Analyze portfolio',
      description:
        'Run the deterministic portfolio engine on a portfolio (from import_positions, with an as-of date) and a profile. Without portfolio or profile it uses the newest saved snapshot or the saved profile. Returns the net worth (investable value plus home value less mortgage balance) when the profile has a home, the sequence-risk score, the four market scenarios, the cash ladder plan, alerts and the CD break analysis and, unless includeMonteCarlo is false, a seeded Monte Carlo result (seed defaults to 42), as /api/v1/analyze computes them. Home equity is spent only through a profile homeSale: its net proceeds (sale price less selling costs, the amortized mortgage balance and the replacement home cost, in assumptions.homeSale) join the portfolio that year, the mortgage payment stops and annualHousingCostChange applies from that age. A mortgage with monthlyPayment and payoffDate lowers annual expenses by 12 × monthlyPayment from the payoff year; warnings names a payoffDate more than a year from the payoff the balance, rate and payment imply. annualContributions are added each year before targetRetirementAge, and spendingPhases replace annualExpenses from each startAge. Social Security grows with inflation (a COLA) unless socialSecurityCola is false; withdrawalTaxRate grosses withdrawals up by 1 / (1 − rate). The alerts use the saved planRules (target stock share, drift band, cash buffer) when present. monteCarlo is the older v1 model; projection gives the v2 success rate (project_retirement), which is the one to quote.',
      inputSchema: portfolioAnalysisInput,
    },
    async args => {
      const inputs = await resolveInputs('portfolio_analysis', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const includeMonteCarlo = args.includeMonteCarlo !== false
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const errors = portfolioErrors(
        AnalyzeRequestSchema,
        { portfolio, userProfile: profile },
        portfolio
      )
      if (errors.length > 0) return errorResult(errors)
      const payoffWarning = mortgagePayoffWarning(profile)
      const output = {
        ...(payoffWarning === undefined ? {} : { warnings: [payoffWarning] }),
        ...netWorthOf(portfolio, profile),
        riskScore: calculateSequenceRisk(portfolio, profile),
        scenarios: runAllScenarios(portfolio, profile),
        ladderPlan: generateLadderPlan(portfolio, profile),
        // One as-of date for the whole call, as /api/v1/analyze does, so the
        // same input always gives the same alerts (NFR-01).
        alerts: generateAlerts(
          portfolio,
          profile,
          undefined,
          portfolio.asOfDate
        ),
        cdAnalysis: analyzeAllCDs(
          portfolio.accounts.flatMap(account => account.cds),
          portfolio.asOfDate
        ),
        ...(includeMonteCarlo
          ? { monteCarlo: runMonteCarlo(portfolio, profile, { seed }) }
          : {}),
        // REQ-MCP-53: the v2 answer beside the v1 one, so the app gives one number.
        ...(includeMonteCarlo
          ? { projection: v2Summary(portfolio, profile, seed) }
          : {}),
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'portfolio_analysis',
          { ...args, portfolio, profile },
          output,
          {
            ...(includeMonteCarlo ? { seed } : {}),
            assumptions: {
              asOfDate: portfolio.asOfDate,
              includeMonteCarlo,
              ...homeAssumptions(portfolio, profile),
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  server.registerTool(
    'tax_strategy',
    {
      title: 'Tax strategy',
      description:
        'Return the Roth conversion schedule, the Rule of 55 analysis and the federal and state tax breakdown for a portfolio and profile (the newest saved snapshot or the saved profile when left out). filingStatus defaults to single, ordinaryIncome to the profile annual expenses and capitalGains to 0, as /api/v1/tax does.',
      inputSchema: taxStrategyInput,
    },
    async args => {
      const inputs = await resolveInputs('tax_strategy', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const errors = portfolioErrors(
        TaxRequestSchema,
        {
          portfolio,
          userProfile: profile,
          filingStatus: args.filingStatus,
          ordinaryIncome: args.ordinaryIncome,
          capitalGains: args.capitalGains,
        },
        portfolio
      )
      if (errors.length > 0) return errorResult(errors)
      const filingStatus = args.filingStatus ?? 'single'
      const ordinaryIncome = args.ordinaryIncome ?? profile.annualExpenses
      const capitalGains = args.capitalGains ?? 0
      const stateTaxRate = profile.stateTaxRate ?? 0
      const output = {
        rothConversion: optimizeRothConversion(portfolio, profile, {
          filingStatus,
        }),
        ruleOf55: analyzeRuleOf55(portfolio, profile),
        taxBreakdown: calculateTaxBreakdown(
          ordinaryIncome,
          capitalGains,
          filingStatus,
          stateTaxRate
        ),
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'tax_strategy',
          { ...args, portfolio, profile },
          output,
          {
            assumptions: {
              filingStatus,
              ordinaryIncome,
              capitalGains,
              stateTaxRate,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  server.registerTool(
    'trade_plan',
    {
      title: 'Trade plan',
      description:
        'Return the trades that raise the target cash position for a portfolio and profile (the newest saved snapshot or the saved profile when left out), each with its reason, its estimated value and its estimated tax impact. Never sells from the account types the saved planRules protect. For rebalancing to your own target and sell schedule, use plan_check.',
      inputSchema: tradePlanInput,
    },
    async args => {
      const inputs = await resolveInputs('trade_plan', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const errors = portfolioErrors(
        AnalyzeRequestSchema,
        { portfolio, userProfile: profile },
        portfolio
      )
      if (errors.length > 0) return errorResult(errors)
      const tradePlan = generateTradePlan(portfolio, profile)
      const output = { tradePlan }
      return jsonResult({
        ...output,
        provenance: stamp(
          'trade_plan',
          { ...args, portfolio, profile },
          output,
          {
            assumptions: {
              targetCashPosition: tradePlan.targetCashPosition,
              federalTaxBracket: profile.federalTaxBracket ?? 0.22,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  server.registerTool(
    'project_retirement',
    {
      title: 'Project retirement (v2)',
      description:
        "The v2 retirement projection, to planningAge (default 95), for a portfolio and profile (the newest saved snapshot or the saved profile when left out). It keeps each account type apart (taxable, 401(k)/403(b)/457(b), IRA, Roth/HSA, NQDC) and withdraws taxable first, then pre-tax, then Roth. It applies the 10% penalty before 59½ (the Rule of 55 opens the employer plan from separationAge 55+; a 457(b) pays without it from separationAge at any age), RMDs from 75 and the NQDC nqdcPayout schedule. Tax comes from the federal brackets for filingStatus, with Social Security taxed by the IRS formula, plus stateTaxRate (retirement income exempt when stateExemptsRetirementIncome). It counts both spouses' Social Security (spouse) and preMedicareHealthcare until 65. Returns warnings, a summary (success rate, the age money runs out on failing paths, balance at retirement, first-year withdrawal rate, lifetime tax), three charts ready to draw (charts.balanceByAge, charts.incomeAndSpendingByAge, charts.accountsByAge: x is age, one value per age per series), and the projection with a year-by-year table. Every figure is in today's dollars. Seeded (default 42). portfolio_analysis is unchanged.",
      inputSchema: projectRetirementInput,
    },
    async args => {
      const inputs = await resolveInputs('project_retirement', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const errors = portfolioErrors(
        AnalyzeRequestSchema,
        { portfolio, userProfile: profile },
        portfolio
      )
      if (errors.length > 0) return errorResult(errors)
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const projection = projectRetirement(portfolio, profile, { seed })
      const payoffWarning = mortgagePayoffWarning(profile)
      const warnings = [
        ...(payoffWarning === undefined ? [] : [payoffWarning]),
        ...projectionWarnings(portfolio, profile),
      ]
      const expected = projection.expectedPath
      const output = {
        warnings,
        summary: {
          successRate: projection.monteCarlo.successRate,
          planningAge: projection.planningAge,
          depletionAgeOnFailingPaths: projection.monteCarlo.depletionAge,
          balanceAtRetirement: expected.balanceAtRetirement,
          firstRetirementYear: expected.firstRetirementYear,
          lifetimeTax: expected.lifetimeTax,
          lifetimePenalty: expected.lifetimePenalty,
          expectedPathDepletionAge: expected.depletionAge,
        },
        charts: projectionCharts(projection),
        projection,
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'project_retirement',
          { ...args, portfolio, profile },
          output,
          {
            seed,
            assumptions: {
              asOfDate: portfolio.asOfDate,
              modelVersion: projection.modelVersion,
              dollars:
                "today's dollars (nominal values divided by cumulative inflation)",
              returns: {
                equityMean: MONTE_CARLO_DEFAULTS.EQUITY_MEAN,
                equityStdDev: MONTE_CARLO_DEFAULTS.EQUITY_STD_DEV,
                bondMean: MONTE_CARLO_DEFAULTS.BOND_MEAN,
                bondStdDev: MONTE_CARLO_DEFAULTS.BOND_STD_DEV,
                inflationMean: MONTE_CARLO_DEFAULTS.INFLATION_MEAN,
                inflationStdDev: MONTE_CARLO_DEFAULTS.INFLATION_STD_DEV,
                sameBlendedReturnForEveryAccount: true,
              },
              withdrawalOrder: [
                'RMDs and NQDC payouts (forced)',
                'taxable',
                `401(k)/403(b)/457(b) from ${PENALTY_FREE_AGE}, or from separationAge when ${RULE_OF_55_AGE}+; 457(b) from separationAge at any age`,
                `IRA, then Roth/HSA, from ${PENALTY_FREE_AGE}`,
                `earlier: the same with a ${EARLY_WITHDRAWAL_PENALTY * 100}% penalty`,
              ],
              filingStatus: projection.filingStatus,
              taxBracketsIndexedToInflation: true,
              socialSecurityTaxation:
                'IRS provisional-income formula; thresholds not indexed',
              rmdStartAge: RMD_START_AGE,
              acaPremiumTaxCredit:
                profile.acaPremiumTaxCredit === true
                  ? `2027 applicable percentages (Rev. Proc. 2026-26), 2026 poverty line, no credit above ${ACA_SUBSIDY_CLIFF * 100}%; preMedicareHealthcare is the benchmark silver premium; MAGI counts all Social Security and taxable-account gains, not home-sale proceeds`
                  : 'not modelled (preMedicareHealthcare paid in full)',
              bothSpousesLiveToPlanningAge: profile.survivor === undefined,
              noRothConversions: true,
              ...homeAssumptions(portfolio, profile),
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  server.registerTool(
    'compare_retirement_scenarios',
    {
      title: 'Compare retirement scenarios (v2)',
      description:
        "Run project_retirement for the current plan (the saved profile, or profile) and up to four named what-ifs on the same portfolio and seed, side by side. Each scenario has a name, changes (profile fields that replace the current plan's; nested objects such as homeSale replace whole) and optional remove (top-level fields to drop, such as homeSale). Use it for questions like keep the house vs downsize vs side income, retire at 58 vs 60 vs 62, or with and without the ACA credit. Returns warnings for the current plan, each scenario's success rate, where failing paths run out, median balance at key ages, balance at retirement, first-year withdrawal rate, lifetime tax, ACA credit and Medicare IRMAA, and three charts (charts.successRates, charts.medianBalanceByAge, charts.poorMarketBalanceByAge). Every figure is in today's dollars, to the current plan's planningAge.",
      inputSchema: compareScenariosInput,
    },
    async args => {
      const inputs = await resolveInputs('compare_retirement_scenarios', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const baseErrors = portfolioErrors(
        AnalyzeRequestSchema,
        { portfolio, userProfile: profile },
        portfolio
      )
      if (baseErrors.length > 0) return errorResult(baseErrors)
      const scenarios = args.scenarios.map(scenario => ({
        name: scenario.name,
        changes: scenario.changes as Partial<UserProfile>,
        remove: scenario.remove as (keyof UserProfile)[] | undefined,
      }))
      const names = new Set<string>()
      for (const [index, scenario] of scenarios.entries()) {
        if (names.has(scenario.name) || scenario.name === 'Current plan') {
          return errorResult([
            {
              field: `scenarios[${index}].name`,
              message: `scenario names must be unique and not "Current plan": "${scenario.name}"`,
            },
          ])
        }
        names.add(scenario.name)
        const merged = applyScenario(profile, scenario)
        const errors = portfolioErrors(
          AnalyzeRequestSchema,
          { portfolio, userProfile: merged },
          portfolio
        ).map(error => ({
          field: `scenarios[${index}] (${scenario.name}): ${error.field}`,
          message: error.message,
        }))
        if (errors.length > 0) return errorResult(errors)
      }
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const comparison = compareScenarios(portfolio, profile, scenarios, {
        seed,
      })
      const payoffWarning = mortgagePayoffWarning(profile)
      const output = {
        warnings: [
          ...(payoffWarning === undefined ? [] : [payoffWarning]),
          ...projectionWarnings(portfolio, profile),
        ],
        planningAge: comparison.planningAge,
        scenarios: comparison.scenarios.map(
          ({ profile: _profile, ...rest }) => rest
        ),
        charts: comparison.charts,
        profiles: comparison.scenarios.map(scenario => ({
          name: scenario.name,
          profile: scenario.profile,
        })),
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'compare_retirement_scenarios',
          { ...args, portfolio, profile },
          output,
          {
            seed,
            assumptions: {
              asOfDate: portfolio.asOfDate,
              model: 'project_retirement',
              dollars: "today's dollars",
              samePortfolioSeedAndPlanningAgeForEveryScenario: true,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  server.registerTool(
    'spending_guardrails',
    {
      title: 'Spending guardrails (v2)',
      description:
        "How much the plan can spend, in dollars, and when to change it. Runs project_retirement on the saved profile and newest snapshot (or profile/portfolio) and finds: canSpend, the monthly spending (first retirement year, today's dollars, without the mortgage payment; healthcare and IRMAA come on top) that gives targetSuccess (default 0.85); the lower guardrail, the total portfolio value at which the chance of success falls to lowerSuccess (default 0.70), where spending is cut by adjustment (default 10%); and the upper guardrail, the value at which it reaches upperSuccess (default 0.99), where spending is raised by adjustment. Each guardrail gives the new monthly spending and the chance of success before and after. Spending phases scale together; the mortgage payment stays as it is. Levels are for today: run it again monthly or after a big market move. Seeded (default 42); takes a few seconds.",
      inputSchema: spendingGuardrailsInput,
    },
    async args => {
      const inputs = await resolveInputs('spending_guardrails', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const errors = portfolioErrors(
        AnalyzeRequestSchema,
        { portfolio, userProfile: profile },
        portfolio
      )
      if (errors.length > 0) return errorResult(errors)
      const target = args.targetSuccess ?? GUARDRAIL_DEFAULTS.targetSuccess
      const lowerSuccess = args.lowerSuccess ?? GUARDRAIL_DEFAULTS.lowerSuccess
      const upperSuccess = args.upperSuccess ?? GUARDRAIL_DEFAULTS.upperSuccess
      if (!(lowerSuccess < target && target < upperSuccess)) {
        return errorResult([
          {
            field: 'targetSuccess',
            message: `lowerSuccess (${lowerSuccess}) < targetSuccess (${target}) < upperSuccess (${upperSuccess}) is required`,
          },
        ])
      }
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const guardrails = spendingGuardrails(portfolio, profile, {
        seed,
        targetSuccess: target,
        lowerSuccess,
        upperSuccess,
        adjustment: args.adjustment,
      })
      const payoffWarning = mortgagePayoffWarning(profile)
      const output = {
        warnings: [
          ...(payoffWarning === undefined ? [] : [payoffWarning]),
          ...projectionWarnings(portfolio, profile),
        ],
        guardrails,
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'spending_guardrails',
          { ...args, portfolio, profile },
          output,
          {
            seed,
            assumptions: {
              asOfDate: portfolio.asOfDate,
              model: 'project_retirement',
              dollars: "today's dollars",
              method:
                'risk-based guardrails: bisection on spending, then on total portfolio value, same seed for every run',
              spendingScaled:
                'annualExpenses and every spending phase, less the mortgage payment',
              portfolioScaled: 'every balance and its cost basis together',
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  server.registerTool(
    'explore_roth_conversions',
    {
      title: 'Explore Roth conversions (v2)',
      description:
        "Compare Roth conversion strategies on the v2 model, same portfolio, profile and seed: no conversions, fill the 12% bracket, fill the 22% bracket, stay up to the first IRMAA threshold, and stay under the ACA 400% line while anyone is under 65 then up to the first IRMAA threshold (or your own list via strategies: kind none | fillBracket with rate | irmaaTier with tier 0-4 | acaThenIrmaa). Conversions run each retired year to conversionEndAge (default 74), from the IRA first, then the employer plan; their tax is paid from the portfolio, and IRMAA follows two years later. Returns, per strategy: success rate, median balance at the planning age, end balances split pre-tax / Roth / taxable, lifetime tax, IRMAA, ACA credit and amount converted, and each year's conversion with its IRMAA tier; the best strategy (highest success, then median balance, then lowest tax + IRMAA); and three charts (charts.successRates, charts.lifetimeCosts, charts.conversionsByAge). Every figure is in today's dollars.",
      inputSchema: exploreRothConversionsInput,
    },
    async args => {
      const inputs = await resolveInputs('explore_roth_conversions', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const errors = portfolioErrors(
        AnalyzeRequestSchema,
        { portfolio, userProfile: profile },
        portfolio
      )
      if (errors.length > 0) return errorResult(errors)
      const filingStatus = filingStatusOf(profile)
      const rates = getFederalBrackets(filingStatus).map(b => b.rate)
      const strategies: NamedStrategy[] = []
      for (const [index, s] of (args.strategies ?? []).entries()) {
        const field = `strategies[${index}]`
        if (s.kind === 'fillBracket') {
          if (
            s.rate === undefined ||
            !rates.some(r => Math.abs(r - (s.rate ?? 0)) < 1e-9) ||
            s.rate === Math.max(...rates)
          ) {
            return errorResult([
              {
                field: `${field}.rate`,
                message: `fillBracket needs the rate of a bracket below the top one: ${rates.slice(0, -1).join(', ')}`,
              },
            ])
          }
          strategies.push({
            name: s.name,
            strategy: { kind: 'fillBracket', rate: s.rate },
          })
        } else if (s.kind === 'irmaaTier') {
          if (s.tier === undefined) {
            return errorResult([
              {
                field: `${field}.tier`,
                message: 'irmaaTier needs tier 0-4 (0 = no surcharge)',
              },
            ])
          }
          strategies.push({
            name: s.name,
            strategy: { kind: 'irmaaTier', tier: s.tier },
          })
        } else {
          strategies.push({ name: s.name, strategy: { kind: s.kind } })
        }
      }
      if (new Set(strategies.map(s => s.name)).size !== strategies.length) {
        return errorResult([
          { field: 'strategies', message: 'strategy names must be unique' },
        ])
      }
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const exploration = exploreRothConversions(
        portfolio,
        profile,
        strategies.length > 0 ? strategies : DEFAULT_CONVERSION_STRATEGIES,
        { seed, conversionEndAge: args.conversionEndAge }
      )
      const payoffWarning = mortgagePayoffWarning(profile)
      const output = {
        warnings: [
          ...(payoffWarning === undefined ? [] : [payoffWarning]),
          ...projectionWarnings(portfolio, profile),
        ],
        ...exploration,
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'explore_roth_conversions',
          { ...args, portfolio, profile },
          output,
          {
            seed,
            assumptions: {
              asOfDate: portfolio.asOfDate,
              model: 'project_retirement',
              dollars: "today's dollars",
              conversionSource: 'IRA first, then the employer plan',
              conversionTaxPaidFrom:
                'the portfolio, by the usual withdrawal order',
              cliffMargin: `conversions stop $${CLIFF_MARGIN} below an IRMAA or ACA cliff`,
              irmaa: 'CMS 2026 table, two-year lookback',
              samePortfolioSeedAndPlanningAgeForEveryStrategy: true,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-47: the snapshot against the owner's own rules.
  server.registerTool(
    'plan_check',
    {
      title: 'Plan check',
      description:
        "Measure the newest saved snapshot (or portfolio) against the owner's own rules on asOfDate (pass today's date; defaults to the snapshot date): target stock share, drift band (default 5 points), cash buffer in years of retirement spending (default 1; liquid cash only: taxable accounts plus outsideCash, never cash inside a 401(k) or IRA), sell schedule and account types never to sell from. Rules come from rules or the saved profile's planRules (save them with save_profile). Returns status (on_plan, on_schedule or action_needed), a one-line headline, the measures before and after the recommended trades, each scheduled sale's status (done, overdue, due_today, upcoming), and ranked recommendations, each with its action line, the trades by account with estimated tax, and the reason. Nothing is traded: the owner reviews and places every order. With planRules.cdLadder (accountType, firstYear, lastYear, optional total) it also returns cdLadder: one rung per maturity year, what each already holds (CDs, CD holdings with a maturity date, iShares iBonds Treasury ETFs), and how much of the cash ready now to buy in each, earliest short rung first, in $1,000 units. Pass rateQuotes (kind cd or treasury, termYears, apy, callProtected, source, quotedOn) read from the broker's current new-issue CD and Treasury yields; each rung gets the highest call-protected quote for its term. Also returns the engine's return assumptions, to compare with analyst outlooks.",
      inputSchema: planCheckInput,
    },
    async args => {
      const inputs = await resolveInputs('plan_check', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const rules = args.rules ?? profile.planRules
      if (rules === undefined) {
        return errorResult([
          {
            field: 'rules',
            message:
              'no planRules saved: add planRules to the profile with save_profile, or pass rules',
          },
        ])
      }
      const asOfDate = args.asOfDate ?? portfolio.asOfDate
      let result: PlanCheckResult
      try {
        result = checkPlan(
          portfolio,
          profile,
          rules,
          asOfDate,
          args.rateQuotes ?? []
        )
      } catch (error) {
        if (!(error instanceof PlanCheckError)) throw error
        return errorResult([{ field: error.field, message: error.message }])
      }
      const output = {
        ...result,
        engineAssumptions: {
          equityMean: MONTE_CARLO_DEFAULTS.EQUITY_MEAN,
          equityStdDev: MONTE_CARLO_DEFAULTS.EQUITY_STD_DEV,
          bondMean: MONTE_CARLO_DEFAULTS.BOND_MEAN,
          inflationMean: MONTE_CARLO_DEFAULTS.INFLATION_MEAN,
        },
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'plan_check',
          { ...args, portfolio, profile, rules, asOfDate },
          output,
          {
            assumptions: {
              asOfDate,
              snapshotDate: portfolio.asOfDate,
              rulesFrom:
                args.rules === undefined ? 'saved profile planRules' : 'input',
              stocks: 'us_equity, intl_equity and emerging_equity holdings',
              cashBuffer:
                'cash balances, cash and money market holdings, CDs and bufferSymbols, in years of spending at targetRetirementAge',
              salesFrom:
                'accounts outside protectedAccountTypes, tax-advantaged before taxable, larger lots first',
              taxableGainRate:
                profile.federalTaxBracket ??
                PLAN_CHECK_DEFAULTS.taxableGainRate,
              nothingTraded: true,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-49: Social Security claiming ages for both spouses.
  server.registerTool(
    'explore_claiming_ages',
    {
      title: 'Social Security claiming sweep',
      description:
        "Sweep Social Security claiming ages (62 to 70, whole years; default 62, 65, 67, 68 and 70 for each spouse, at most 45 pairs) through project_retirement on the same portfolio and seed. The saved benefits are quoted at the saved claiming ages; each candidate age moves them by the SSA rules (30% less at 62, 8% a year more to 70, full retirement age 67). Pass survivor ({ deceased: 'self' or 'spouse', deathAge }) to also run every pair with that death, since a later claim by the higher earner raises the survivor benefit for life. Returns each pair's monthly benefits, success rate, survivor success rate, median balance at the planning age and lifetime Social Security, the current pair, best (highest success, then survivor success, then median balance), best versus current, and charts.successBySelfAge.",
      inputSchema: exploreClaimingAgesInput,
    },
    async args => {
      const inputs = await resolveInputs('explore_claiming_ages', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      let exploration: ReturnType<typeof exploreClaimingAges>
      try {
        exploration = exploreClaimingAges(portfolio, profile, {
          seed,
          ...(args.selfAges === undefined ? {} : { selfAges: args.selfAges }),
          ...(args.spouseAges === undefined
            ? {}
            : { spouseAges: args.spouseAges }),
          ...(args.survivor === undefined ? {} : { survivor: args.survivor }),
        })
      } catch (error) {
        if (!(error instanceof ClaimingError)) throw error
        return errorResult([{ field: error.field, message: error.message }])
      }
      const payoffWarning = mortgagePayoffWarning(profile)
      const output = {
        warnings: [
          ...(payoffWarning === undefined ? [] : [payoffWarning]),
          ...projectionWarnings(portfolio, profile).filter(
            warning => !warning.startsWith('survivor')
          ),
          'the Social Security earnings test (benefits withheld while working before 67) is not modelled',
        ],
        ...exploration,
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'explore_claiming_ages',
          { ...args, portfolio, profile },
          output,
          {
            seed,
            assumptions: {
              asOfDate: portfolio.asOfDate,
              model: 'project_retirement',
              dollars: "today's dollars",
              fullRetirementAge: 67,
              earlyReduction:
                '5/9 of 1% a month for 36 months, 5/12 of 1% beyond',
              delayedCredits: '8% a year to 70',
              defaultAges: DEFAULT_CLAIM_AGES,
              survivorFromSavedProfileIgnored: profile.survivor !== undefined,
              samePortfolioSeedAndPlanningAgeForEveryPair: true,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-50: the plan through actual market history.
  server.registerTool(
    'historical_backtest',
    {
      title: 'Historical backtest',
      description:
        'Replay the plan through actual US market history: for every start year from 1928 to 2025, retirement begins that year and the portfolio earns that year’s S&P 500 and 10-year Treasury total returns and inflation, then the next year’s (the years before retirement earn the expected returns). Sequences past 2025 continue from 1928 and are marked wrapped. Returns the share of start years that last to the planning age (all, and unwrapped only), the named hard years (1929, 1937, 1966, 1973, 2000, 2008) with depletion age, lowest balance and balance at the planning age, the five worst start years, and charts.namedBalanceByAge. Same rules as project_retirement; today’s dollars.',
      inputSchema: historicalBacktestInput,
    },
    async args => {
      const inputs = await resolveInputs('historical_backtest', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const backtest = backtestHistory(portfolio, profile)
      const payoffWarning = mortgagePayoffWarning(profile)
      const output = {
        warnings: [
          ...(payoffWarning === undefined ? [] : [payoffWarning]),
          ...projectionWarnings(portfolio, profile),
        ],
        ...backtest,
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'historical_backtest',
          { ...args, portfolio, profile },
          output,
          {
            assumptions: {
              asOfDate: portfolio.asOfDate,
              model: 'project_retirement rules, one path per start year',
              dollars: "today's dollars",
              stocks: 'S&P 500 total return (Damodaran, NYU Stern, 1928-2025)',
              bonds: '10-year US Treasury total return (Damodaran, NYU Stern)',
              inflation:
                'annual average CPI-U (Federal Reserve Bank of Minneapolis)',
              beforeRetirement: 'expected returns and inflation',
              wrap: 'sequences past 2025 continue from 1928',
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-56: the month's verdict from the engine's own results.
  server.registerTool(
    'plan_verdict',
    {
      title: 'Plan verdict',
      description:
        "One GO, CAUTION or DELAY verdict for the plan, for the monthly check, from the saved profile and newest snapshot (or profile/portfolio) on asOfDate (pass today's date; defaults to the snapshot date). It runs project_retirement at the long-run means and at the 10-year forecast means (marketAssumptions preset 'forecast'), historical_backtest, spending_guardrails and, with saved planRules, plan_check, on one seed. GO needs a success rate of at least 85%, 75% at forecast returns, 90% of 1928-2025 start years and no overdue trades; DELAY follows from under 60%, under 45% at forecast returns or under 70% of start years; anything else is CAUTION. Returns the verdict, a headline, the measures, the reasons (worst first), at most five next actions (plan check trades first) and the thresholds. Takes several seconds. Nothing is traded.",
      inputSchema: planVerdictInput,
    },
    async args => {
      const inputs = await resolveInputs('plan_verdict', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const asOfDate = args.asOfDate ?? portfolio.asOfDate
      let verdict: ReturnType<typeof planVerdict>
      try {
        verdict = planVerdict(portfolio, profile, asOfDate, { seed })
      } catch (error) {
        if (!(error instanceof PlanCheckError)) throw error
        return errorResult([{ field: error.field, message: error.message }])
      }
      const payoffWarning = mortgagePayoffWarning(profile)
      const output = {
        warnings: [
          ...(payoffWarning === undefined ? [] : [payoffWarning]),
          ...projectionWarnings(portfolio, profile),
        ],
        ...verdict,
      }
      return jsonResult({
        ...output,
        provenance: stamp(
          'plan_verdict',
          { ...args, portfolio, profile, asOfDate },
          output,
          {
            seed,
            assumptions: {
              asOfDate,
              snapshotDate: portfolio.asOfDate,
              tools: [
                'project_retirement',
                "project_retirement with marketAssumptions preset 'forecast'",
                'historical_backtest',
                'spending_guardrails',
                'plan_check',
              ],
              thresholds: VERDICT_THRESHOLDS,
              dollars: "today's dollars",
              nothingTraded: true,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-66: when can I retire?
  server.registerTool(
    'earliest_retirement',
    {
      title: 'Earliest retirement age',
      description:
        "When can I retire? Runs the saved plan (or profile/portfolio) retiring at every age from next year to goals.latestAge (default 70), at long-run and 10-year forecast returns on one seed, and returns the earliest age where both success rates reach the owner's goals (profile goals; default 85% and 75%, the GO thresholds), the gap to the target age, and the table of ages. Moving the retirement age also moves the separation age, the deferred-compensation payout start, the first retirement spending phase and a home sale when they were tied to the old age. Takes several seconds.",
      inputSchema: earliestRetirementInput,
    },
    async args => {
      const inputs = await resolveInputs('earliest_retirement', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const result = earliestRetirement(portfolio, profile, { seed })
      return jsonResult({
        ...result,
        provenance: stamp(
          'earliest_retirement',
          { ...args, portfolio, profile },
          result,
          {
            seed,
            assumptions: {
              snapshotDate: portfolio.asOfDate,
              model: 'project_retirement, long-run and forecast presets',
              dollars: "today's dollars",
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-67: which levers bring retirement forward.
  server.registerTool(
    'rank_levers',
    {
      title: 'Rank the levers',
      description:
        "What gets me to retirement sooner? Pulls each lever that fits the plan one at a time (spend 5% or 10% less, save $10,000 more a year, $2,000/mo part-time for 5 years, downsize the home at retirement) plus up to 4 custom levers (name and profile changes, such as a move to a cheaper town with homeSale), and returns for each the earliest age that reaches the owner's goals, years earlier than today, and the success rates at the target age, ranked best first; then the best lever of each group pulled together. Same seed and goals as earliest_retirement. Takes several seconds.",
      inputSchema: rankLeversInput,
    },
    async args => {
      const inputs = await resolveInputs('rank_levers', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const result = rankLevers(portfolio, profile, {
        seed,
        ...(args.custom === undefined ? {} : { custom: args.custom }),
      })
      return jsonResult({
        ...result,
        provenance: stamp(
          'rank_levers',
          { ...args, portfolio, profile },
          result,
          {
            seed,
            assumptions: {
              snapshotDate: portfolio.asOfDate,
              levers: TIMING_DEFAULTS,
              earliestAgeSearch:
                'bisection between next year and goals.latestAge',
              dollars: "today's dollars",
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-69: the living plan, reviewed.
  server.registerTool(
    'review_plan',
    {
      title: 'Review the plan',
      description:
        "The plan review, for every monthly check and whenever the owner asks where the plan stands. On asOfDate (pass today's date) it returns: the verdict and its measures (plan_verdict), when the owner can retire against the target (earliest age that reaches the goals), the top levers and the best of them together (rank_levers), how many rule changes propose_plan_rules suggests, the actions due from the owner's rules, data to refresh, the decisions only the owner can make, what a human professional should check (fee-only planner, CPA, healthcare quote, Social Security records, estate attorney), and the next review date. Changes nothing. Takes up to half a minute.",
      inputSchema: reviewPlanInput,
    },
    async args => {
      const inputs = await resolveInputs('review_plan', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const asOfDate = args.asOfDate ?? portfolio.asOfDate
      let result: ReturnType<typeof reviewPlan>
      try {
        result = reviewPlan(portfolio, profile, asOfDate, { seed })
      } catch (error) {
        if (!(error instanceof PlanCheckError)) throw error
        return errorResult([{ field: error.field, message: error.message }])
      }
      return jsonResult({
        ...result,
        provenance: stamp(
          'review_plan',
          { ...args, portfolio, profile, asOfDate },
          result,
          {
            seed,
            assumptions: {
              asOfDate,
              snapshotDate: portfolio.asOfDate,
              tools: ['plan_verdict', 'rank_levers', 'propose_plan_rules'],
              review: REVIEW_DEFAULTS,
              nothingSaved: true,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-64: the engine proposes the plan rules; the owner approves them.
  server.registerTool(
    'propose_plan_rules',
    {
      title: 'Propose plan rules',
      description:
        "Propose the owner's plan rules from the saved profile and newest snapshot (or profile/portfolio) on asOfDate (pass today's date), and check the current planRules against them. Returns the stock-share test (the plan run at 30% to 80% stocks and the current target, at long-run and 10-year forecast returns, on one seed; the proposal is the best worse-of-the-two success rate, the lower share on a tie within 1 point), a ladder that funds spending one rung a year from the retirement year through the bridge to Social Security (at most 5 rungs, sized to each year's expected withdrawals and capped by the bonds the share leaves, with early-penalty and 10-year-term flags), a cash buffer that starts a year before retirement (bufferStartAge), the sales the proposed share needs, protected taxable accounts with gains, and findings (keep, change, add, needs_input) with current value, proposed value and reason. proposedRules is a complete planRules ready for save_profile. Nothing is saved: present each finding and save only the changes the owner approves. Takes several seconds.",
      inputSchema: proposePlanRulesInput,
    },
    async args => {
      const inputs = await resolveInputs('propose_plan_rules', args)
      if (!inputs.ok) return errorResult(inputs.errors)
      const { portfolio, profile, savedData } = inputs
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const asOfDate = args.asOfDate ?? portfolio.asOfDate
      let proposal: ReturnType<typeof proposePlanPolicy>
      try {
        proposal = proposePlanPolicy(portfolio, profile, asOfDate, { seed })
      } catch (error) {
        if (!(error instanceof PlanCheckError)) throw error
        return errorResult([{ field: error.field, message: error.message }])
      }
      return jsonResult({
        ...proposal,
        provenance: stamp(
          'propose_plan_rules',
          { ...args, portfolio, profile, asOfDate },
          proposal,
          {
            seed,
            assumptions: {
              asOfDate,
              snapshotDate: portfolio.asOfDate,
              method: POLICY_DEFAULTS,
              stockShareTest:
                'each account rebalanced to the candidate share, totals and taxable basis kept; the share is held to the planning age',
              ladderSizing:
                "expected-path withdrawals less deferred-compensation payouts, today's dollars",
              nothingSaved: true,
              ...savedAssumption(savedData),
            },
          }
        ),
      })
    }
  )

  // REQ-MCP-58: what moved the number between two saved snapshots.
  server.registerTool(
    'explain_change',
    {
      title: 'What moved the number',
      description:
        "Explain the change in the chance of success between two saved snapshots (fromDate and toDate; default the two newest), on the saved profile and one seed: each snapshot's total value, stock share and success rate, the portfolio's effect in points (markets, trades and savings between the dates), and the five holdings that moved most in dollars. Pass previousSuccessRate (the rate recorded last time, such as in the agent log) to split the total change into the portfolio's effect and everything else (profile edits, assumptions, model updates). Use it in the monthly check.",
      inputSchema: explainChangeInput,
    },
    async args => {
      const opened = await fromStore(async () =>
        openDataStore('explain_change')
      )
      if (!opened.ok) return errorResult([opened.error])
      const store = opened.value
      const profileRead = await fromStore(() => store.readProfile())
      if (!profileRead.ok) return errorResult([profileRead.error])
      if (profileRead.value === undefined) {
        return errorResult([{ field: 'profile', message: NO_PROFILE_MESSAGE }])
      }
      const listed = await fromStore(() => store.listSnapshots())
      if (!listed.ok) return errorResult([listed.error])
      const snapshots = listed.value
      const pick = (date: string | undefined, fallback: number) =>
        date === undefined
          ? snapshots[fallback]
          : snapshots.find(s => s.asOfDate === date)
      const to = pick(args.toDate, 0)
      const from = pick(args.fromDate, 1)
      if (to === undefined || from === undefined) {
        return errorResult([
          {
            field: to === undefined ? 'toDate' : 'fromDate',
            message:
              snapshots.length < 2
                ? 'needs two saved snapshots: import_positions with save: true'
                : `no snapshot saved for that date; saved: ${snapshots.map(s => s.asOfDate).join(', ')}`,
          },
        ])
      }
      if (from.asOfDate >= to.asOfDate) {
        return errorResult([
          { field: 'fromDate', message: 'must be before toDate' },
        ])
      }
      const profile = profileRead.value.profile
      const seed = args.seed ?? MONTE_CARLO_DEFAULTS.DEFAULT_SEED
      const output = explainChange(from.portfolio, to.portfolio, profile, {
        seed,
        ...(args.previousSuccessRate === undefined
          ? {}
          : { previousSuccessRate: args.previousSuccessRate }),
      })
      return jsonResult({
        ...output,
        provenance: stamp(
          'explain_change',
          { ...args, from: from.portfolio, to: to.portfolio, profile },
          output,
          {
            seed,
            assumptions: {
              model: 'project_retirement',
              sameProfileAndSeedForBothSnapshots: true,
              portfolioEffect:
                'markets, trades and savings between the snapshot dates',
              otherEffect:
                'profile edits, assumptions and model updates since previousSuccessRate',
              savedData: {
                profile: {
                  file: profileRead.value.file,
                  updatedAt: profileRead.value.updatedAt,
                },
                from: { file: from.file, asOfDate: from.asOfDate },
                to: { file: to.file, asOfDate: to.asOfDate },
              },
            },
          }
        ),
      })
    }
  )
}
