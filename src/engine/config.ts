// ---------------------------------------------------------------------------
// RetireRunway – Centralized Financial Configuration
// Single source of truth for financial constants and default parameters.
// ---------------------------------------------------------------------------

/**
 * Default market return assumptions.
 * Based on historical averages and conservative forward-looking estimates.
 */
export const MARKET_RETURNS = {
  /** Long-term equity return (7% real, historical average) */
  EQUITY_RETURN: 0.07,
  /** Long-term bond return (4% nominal) */
  BOND_RETURN: 0.04,
  /** Expected inflation rate (3% target) */
  INFLATION_RATE: 0.03,

  // Scenario-specific overrides
  BULL_MARKET: {
    equityReturn: 0.1,
    bondReturn: 0.05,
    inflation: 0.025,
  },
  PROLONGED_BEAR: {
    equityReturn: 0.05,
    bondReturn: 0.03,
    inflation: 0.035,
  },
} as const

/**
 * Monte Carlo simulation parameters.
 * Standard deviations based on historical market volatility.
 */
export const MONTE_CARLO_DEFAULTS = {
  NUM_PATHS: 1000,
  DURATION_YEARS: 30,
  EQUITY_MEAN: 0.07,
  EQUITY_STD_DEV: 0.16,
  BOND_MEAN: 0.04,
  BOND_STD_DEV: 0.06,
  INFLATION_MEAN: 0.03,
  INFLATION_STD_DEV: 0.01,
  DEFAULT_SEED: 42,
} as const

/**
 * Projection and scenario defaults.
 */
export const PROJECTION_DEFAULTS = {
  /** Standard projection duration in years */
  DURATION_YEARS: 30,
  /** Early bear scenario equity drawdown */
  EARLY_BEAR_DRAWDOWN: 0.3,
  /** Prolonged bear scenario equity drawdown */
  PROLONGED_BEAR_DRAWDOWN: 0.4,
  /** Years of negative returns in early bear */
  EARLY_BEAR_YEARS: 3,
  /** Years of subdued returns in prolonged bear */
  PROLONGED_BEAR_YEARS: 5,
} as const

/**
 * Alert thresholds for portfolio monitoring.
 */
export const ALERT_THRESHOLDS = {
  /** Equity allocation drift threshold (10%) */
  EQUITY_DRIFT: 0.1,
  /** Single holding concentration warning (25%) */
  CONCENTRATION_WARNING: 0.25,
  /** Single holding concentration critical (40%) */
  CONCENTRATION_CRITICAL: 0.4,
  /** Minimum years of expenses in cash/CDs */
  CASH_BUFFER_MIN_YEARS: 1,
  /** Maximum safe withdrawal rate (5%) */
  WITHDRAWAL_RATE_MAX: 0.05,
  /** CD maturity warning window (days) */
  CD_MATURITY_WINDOW_DAYS: 90,
  /** Target equity allocation (60%) */
  TARGET_EQUITY_ALLOCATION: 0.6,
  /** Cash buffer critical threshold (years) */
  CASH_BUFFER_CRITICAL: 0.5,
} as const

/**
 * Withdrawal rate risk scoring thresholds.
 */
export const WITHDRAWAL_RATE_THRESHOLDS = {
  VERY_HIGH: 0.08,
  HIGH: 0.06,
  ELEVATED: 0.05,
  MODERATE: 0.04,
  SAFE: 0.035,
  CONSERVATIVE: 0.03,
  VERY_CONSERVATIVE: 0.02,
} as const

/**
 * Equity allocation risk scoring thresholds.
 */
export const EQUITY_ALLOCATION_THRESHOLDS = {
  VERY_HIGH: 0.9,
  HIGH: 0.8,
  ELEVATED: 0.7,
  MODERATE: 0.6,
  BALANCED: 0.5,
  CONSERVATIVE: 0.4,
  VERY_CONSERVATIVE: 0.3,
} as const

/**
 * Roth conversion defaults.
 */
export const ROTH_CONVERSION_DEFAULTS = {
  /** Default target tax bracket rate */
  TARGET_BRACKET_RATE: 0.22,
  /** Expected growth rate for conversions */
  EXPECTED_GROWTH_RATE: 0.06,
  /** Expected retirement tax rate */
  EXPECTED_RETIREMENT_RATE: 0.22,
  /** Social Security taxable portion (85%) */
  SS_TAXABLE_PORTION: 0.85,
} as const

/**
 * Household/spouse planning defaults.
 */
export const HOUSEHOLD_DEFAULTS = {
  /** Survivor expense ratio (70% of joint expenses) */
  SURVIVOR_EXPENSE_RATIO: 0.7,
  /** Partial retirement expense ratio */
  PARTIAL_RETIREMENT_RATIO: 0.6,
} as const

/**
 * Cash buffer scoring thresholds (years of expenses).
 */
export const CASH_BUFFER_THRESHOLDS = {
  EXCELLENT: 5,
  GOOD: 3,
  ADEQUATE: 2,
  LOW: 1,
} as const

/**
 * Concentration risk scoring thresholds.
 */
export const CONCENTRATION_THRESHOLDS = {
  CRITICAL: 0.4,
  HIGH: 0.25,
  ELEVATED: 0.15,
  MODERATE: 0.1,
} as const
