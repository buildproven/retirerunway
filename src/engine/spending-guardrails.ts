// ---------------------------------------------------------------------------
// RetireRunway – Spending guardrails on the v2 projection (REQ-MCP-45)
//
// Risk-based guardrails: the yearly spending the plan supports at a target
// chance of success, and the portfolio values at which that chance falls to
// a lower guardrail (cut spending) or rises to an upper one (raise it).
// Every search reruns projectRetirement on the same seed, so the answer is
// deterministic. No AI.
// ---------------------------------------------------------------------------

import { baseExpensesAt, calculatePortfolioValue } from './portfolio-math'
import { projectRetirement } from './retirement-projection'
import type { Portfolio, UserProfile } from './types'

export const GUARDRAIL_DEFAULTS = {
  /** Chance of success the spending number is set at. */
  targetSuccess: 0.85,
  /** Cut spending when the plan's chance of success falls to this. */
  lowerSuccess: 0.7,
  /** Raise spending when it rises to this. */
  upperSuccess: 0.99,
  /** How much a cut or a raise changes spending (share of it). */
  adjustment: 0.1,
} as const

/** Bisection steps: 2^-14 of the range is well under a dollar a month. */
const STEPS = 14
const MAX_SPENDING_SCALE = 3
const MAX_PORTFOLIO_SCALE = 4

export interface GuardrailOptions {
  readonly seed?: number
  readonly paths?: number
  readonly targetSuccess?: number
  readonly lowerSuccess?: number
  readonly upperSuccess?: number
  readonly adjustment?: number
}

export interface Guardrail {
  /** Total portfolio value, today's dollars, at which to act. */
  readonly portfolioValue: number
  /** Change from today's portfolio value (−0.18 = 18% lower). */
  readonly changeFromToday: number
  /** Chance of success at that value before acting. */
  readonly successBefore: number
  /** Monthly spending after the cut or raise, today's dollars. */
  readonly newMonthlySpending: number
  /** Chance of success at that value after acting. */
  readonly successAfter: number
}

export interface SpendingGuardrails {
  readonly settings: Required<
    Pick<
      GuardrailOptions,
      'targetSuccess' | 'lowerSuccess' | 'upperSuccess' | 'adjustment'
    >
  >
  readonly portfolioToday: number
  /** The plan as entered. */
  readonly planned: {
    readonly monthlySpending: number
    readonly successRate: number
  }
  /**
   * The spending the plan supports at the target chance of success: the
   * first retirement year's spending without the mortgage payment, in
   * today's dollars (healthcare and IRMAA are on top). Null when even no
   * discretionary spending reaches the target.
   */
  readonly canSpend: {
    readonly monthlySpending: number
    readonly annualSpending: number
    /** canSpend / planned. */
    readonly shareOfPlan: number
    readonly successRate: number
    /** True when the search hit its upper limit (3× the plan). */
    readonly capped: boolean
  } | null
  /** Cut when the portfolio falls to this; null if it never gets that low. */
  readonly lower: Guardrail | null
  /** Raise when the portfolio grows to this; null if out of reach (4× today). */
  readonly upper: Guardrail | null
  readonly mortgagePaymentExcluded: number
}

/** Yearly mortgage payment taken to be inside spending, today's dollars. */
function mortgagePayment(profile: UserProfile): number {
  return 12 * (profile.mortgage?.monthlyPayment ?? 0)
}

/**
 * The profile with spending scaled by `k`, leaving the mortgage payment
 * (fixed, and ending at payoff) as it is.
 */
export function scaleSpending(profile: UserProfile, k: number): UserProfile {
  const payment = mortgagePayment(profile)
  const scale = (value: number): number =>
    value >= payment ? payment + k * (value - payment) : k * value
  return {
    ...profile,
    annualExpenses: scale(profile.annualExpenses),
    ...(profile.spendingPhases === undefined
      ? {}
      : {
          spendingPhases: profile.spendingPhases.map(phase => ({
            ...phase,
            annualExpenses: scale(phase.annualExpenses),
          })),
        }),
  }
}

/** The portfolio with every balance (and its cost basis) scaled by `m`. */
export function scalePortfolio(portfolio: Portfolio, m: number): Portfolio {
  return {
    ...portfolio,
    accounts: portfolio.accounts.map(account => ({
      ...account,
      cashBalance: account.cashBalance * m,
      holdings: account.holdings.map(holding => ({
        ...holding,
        shares: holding.shares * m,
        costBasis: holding.costBasis * m,
        currentValue: holding.currentValue * m,
      })),
      cds: account.cds.map(cd => ({ ...cd, principal: cd.principal * m })),
    })),
  }
}

/**
 * The largest x in [lo, hi] with ok(x), given ok is true at lo and false
 * at hi and flips once in between.
 */
function lastTrue(lo: number, hi: number, ok: (x: number) => boolean): number {
  let a = lo
  let b = hi
  for (let i = 0; i < STEPS; i++) {
    const mid = (a + b) / 2
    if (ok(mid)) a = mid
    else b = mid
  }
  return a
}

const round2 = (x: number): number => Math.round(x * 100) / 100
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000

export function spendingGuardrails(
  portfolio: Portfolio,
  profile: UserProfile,
  options: GuardrailOptions = {}
): SpendingGuardrails {
  const settings = {
    targetSuccess: options.targetSuccess ?? GUARDRAIL_DEFAULTS.targetSuccess,
    lowerSuccess: options.lowerSuccess ?? GUARDRAIL_DEFAULTS.lowerSuccess,
    upperSuccess: options.upperSuccess ?? GUARDRAIL_DEFAULTS.upperSuccess,
    adjustment: options.adjustment ?? GUARDRAIL_DEFAULTS.adjustment,
  }
  const run = { seed: options.seed, paths: options.paths }
  const success = (k: number, m: number): number =>
    projectRetirement(
      m === 1 ? portfolio : scalePortfolio(portfolio, m),
      k === 1 ? profile : scaleSpending(profile, k),
      run
    ).monteCarlo.successRate

  const payment = mortgagePayment(profile)
  const core = Math.max(
    0,
    baseExpensesAt(profile, profile.targetRetirementAge) - payment
  )
  const monthly = (k: number): number => round2((k * core) / 12)
  const portfolioToday = calculatePortfolioValue(portfolio)
  const plannedSuccess = success(1, 1)
  const planned = { monthlySpending: monthly(1), successRate: plannedSuccess }
  const empty = {
    settings,
    portfolioToday: Math.round(portfolioToday),
    planned,
    mortgagePaymentExcluded: Math.round(payment),
  }

  if (success(0, 1) < settings.targetSuccess) {
    return { ...empty, canSpend: null, lower: null, upper: null }
  }
  const capped = success(MAX_SPENDING_SCALE, 1) >= settings.targetSuccess
  const k = capped
    ? MAX_SPENDING_SCALE
    : lastTrue(
        0,
        MAX_SPENDING_SCALE,
        x => success(x, 1) >= settings.targetSuccess
      )
  const kSuccess = success(k, 1)

  const guardrail = (m: number, newK: number): Guardrail => ({
    portfolioValue: Math.round(portfolioToday * m),
    changeFromToday: round4(m - 1),
    successBefore: success(k, m),
    newMonthlySpending: monthly(newK),
    successAfter: success(newK, m),
  })

  // Lower guardrail: the smallest portfolio still above lowerSuccess.
  const lower =
    success(k, 0) >= settings.lowerSuccess
      ? null
      : guardrail(
          1 - lastTrue(0, 1, d => success(k, 1 - d) > settings.lowerSuccess),
          k * (1 - settings.adjustment)
        )
  // Upper guardrail: the first portfolio at or above upperSuccess.
  const upper =
    success(k, MAX_PORTFOLIO_SCALE) < settings.upperSuccess
      ? null
      : guardrail(
          1 +
            (MAX_PORTFOLIO_SCALE - 1) -
            lastTrue(
              0,
              MAX_PORTFOLIO_SCALE - 1,
              d => success(k, MAX_PORTFOLIO_SCALE - d) >= settings.upperSuccess
            ),
          k * (1 + settings.adjustment)
        )

  return {
    ...empty,
    canSpend: {
      monthlySpending: monthly(k),
      annualSpending: Math.round(k * core),
      shareOfPlan: round4(k),
      successRate: kSuccess,
      capped,
    },
    lower,
    upper,
  }
}
