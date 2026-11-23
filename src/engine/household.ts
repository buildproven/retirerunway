// ---------------------------------------------------------------------------
// RetireRunway – Deterministic Household / Spouse Planning Engine
// Combines two portfolios and profiles for joint retirement projections.
// All calculations are deterministic — no AI.
// ---------------------------------------------------------------------------

import type {
  Portfolio,
  UserProfile,
  ScenarioResult,
  ScenarioType,
  ScenarioParameters,
  RiskLevel,
} from './types'
import { runScenario, getDefaultScenarioParameters } from './scenarios'
import { calculateSequenceRisk } from './risk-scoring'
import {
  calculatePortfolioValue,
  calculateEquityFraction,
  calculateOtherIncome,
} from './portfolio-math'
import { HOUSEHOLD_DEFAULTS } from './config'

export interface SpouseProfile extends UserProfile {
  name: string
}

export interface HouseholdConfig {
  primary: SpouseProfile
  spouse: SpouseProfile
  primaryPortfolio: Portfolio
  spousePortfolio: Portfolio | null // null if spouse has no separate portfolio
  jointExpenses: number // combined household annual expenses
  survivorExpenseRatio: number // % of expenses if one spouse passes (e.g. 0.7 = 70%)
  /**
   * Optional survivor event: the age at which the named spouse dies. From the
   * following year, household spending scales by `survivorExpenseRatio` and the
   * deceased spouse's income streams stop.
   *
   * Omit for the both-survive baseline. Without this, `survivorExpenseRatio` has
   * nothing to key off — it was previously declared, defaulted, and never read,
   * so the survivor case silently did not exist.
   */
  survivorEvent?: {
    who: 'primary' | 'spouse'
    atAge: number // age OF THAT PERSON at death
  }
}

export interface HouseholdProjectionYear {
  year: number
  primaryAge: number
  spouseAge: number
  primaryBalance: number
  spouseBalance: number
  combinedBalance: number
  withdrawal: number
  income: number // SS + pension + other for both
  netWithdrawal: number // withdrawal - income
}

export interface HouseholdResult {
  scenarioType: ScenarioType
  projections: HouseholdProjectionYear[]
  primaryResult: ScenarioResult
  spouseResult: ScenarioResult | null
  combinedRunwayYears: number
  combinedDepletionAge: number | null
  combinedRiskScore: RiskLevel
  recommendation: string
}

function mergePortfolios(
  primary: Portfolio,
  spouse: Portfolio | null
): Portfolio {
  if (!spouse) return primary

  return {
    id: `household-${primary.id}`,
    name: `${primary.name} + ${spouse.name}`,
    accounts: [...primary.accounts, ...spouse.accounts],
    asOfDate: primary.asOfDate,
  }
}

/**
 * Household income for the year, summing each living spouse's streams.
 *
 * Delegates to `calculateOtherIncome` rather than re-deriving the per-person
 * gating: this function previously hand-copied that logic and inherited its
 * ungated-other-income bug.
 *
 * A spouse who has died contributes nothing. Survivor benefits (stepping the
 * survivor up to the larger of the two Social Security benefits) are NOT
 * modelled here — that needs the real benefit model, so this deliberately
 * understates survivor income rather than guessing.
 */
function computeHouseholdIncome(
  primary: SpouseProfile,
  spouse: SpouseProfile,
  primaryAge: number,
  spouseAge: number,
  primaryAlive = true,
  spouseAlive = true
): number {
  let income = 0
  if (primaryAlive) income += calculateOtherIncome(primary, primaryAge)
  if (spouseAlive) income += calculateOtherIncome(spouse, spouseAge)
  return income
}

export function runHouseholdScenario(
  config: HouseholdConfig,
  scenarioType: ScenarioType = 'base'
): HouseholdResult {
  const mergedPortfolio = mergePortfolios(
    config.primaryPortfolio,
    config.spousePortfolio
  )

  // Create a combined profile for the scenario engine
  const youngerAge = Math.min(
    config.primary.currentAge,
    config.spouse.currentAge
  )
  const laterRetirement = Math.max(
    config.primary.targetRetirementAge,
    config.spouse.targetRetirementAge
  )

  const combinedProfile: UserProfile = {
    currentAge: youngerAge,
    targetRetirementAge: laterRetirement,
    annualExpenses: config.jointExpenses,
    socialSecurityAge: config.primary.socialSecurityAge,
    socialSecurityMonthly:
      (config.primary.socialSecurityMonthly ?? 0) +
      (config.spouse.socialSecurityMonthly ?? 0),
    pensionMonthly:
      (config.primary.pensionMonthly ?? 0) +
      (config.spouse.pensionMonthly ?? 0),
    otherIncomeMonthly:
      (config.primary.otherIncomeMonthly ?? 0) +
      (config.spouse.otherIncomeMonthly ?? 0),
    stateTaxRate: config.primary.stateTaxRate,
    federalTaxBracket: config.primary.federalTaxBracket,
  }

  // Run individual scenarios
  const primaryResult = runScenario(
    scenarioType,
    config.primaryPortfolio,
    config.primary
  )

  let spouseResult: ScenarioResult | null = null
  if (config.spousePortfolio) {
    spouseResult = runScenario(
      scenarioType,
      config.spousePortfolio,
      config.spouse
    )
  }

  // Build combined projections
  const params = getDefaultScenarioParameters(scenarioType)
  const projections: HouseholdProjectionYear[] = []
  let combinedBalance =
    calculatePortfolioValue(config.primaryPortfolio) +
    (config.spousePortfolio
      ? calculatePortfolioValue(config.spousePortfolio)
      : 0)

  const equityFraction = calculateEquityFraction(
    mergedPortfolio,
    combinedBalance
  )
  const bondFraction = 1 - equityFraction
  for (let i = 0; i < params.durationYears; i++) {
    const year = i + 1
    const primaryAge = config.primary.currentAge + year
    const spouseAge = config.spouse.currentAge + year

    // Both retired?
    const primaryRetired = primaryAge > config.primary.targetRetirementAge
    const spouseRetired = spouseAge > config.spouse.targetRetirementAge
    const bothRetired = primaryRetired && spouseRetired

    // Growth
    const yearReturn = computeYearReturn(
      params,
      i,
      equityFraction,
      bondFraction
    )
    const growth = combinedBalance * yearReturn

    // Survivorship. A spouse is gone from the year AFTER the stated death age.
    const ev = config.survivorEvent
    const primaryAlive = !(ev && ev.who === 'primary' && primaryAge > ev.atAge)
    const spouseAlive = !(ev && ev.who === 'spouse' && spouseAge > ev.atAge)
    const isSurvivorPhase = !primaryAlive || !spouseAlive

    // Income
    const income = computeHouseholdIncome(
      config.primary,
      config.spouse,
      primaryAge,
      spouseAge,
      primaryAlive,
      spouseAlive
    )

    // Withdrawal needed
    const inflationMultiplier = Math.pow(1 + params.inflationRate, i)
    const inflationAdjustedExpenses = config.jointExpenses * inflationMultiplier

    // A surviving spouse spends less than the couple did, but not
    // proportionally less — housing and fixed costs largely persist.
    const survivorAdjusted = isSurvivorPhase
      ? inflationAdjustedExpenses * config.survivorExpenseRatio
      : inflationAdjustedExpenses

    // Once one spouse has died, the survivor's own retirement status governs;
    // the partial-retirement discount no longer applies to a single person.
    const bothRetiredEffective = isSurvivorPhase
      ? (primaryAlive && primaryRetired) || (spouseAlive && spouseRetired)
      : bothRetired

    const withdrawal = bothRetiredEffective
      ? Math.max(0, survivorAdjusted - income)
      : primaryRetired || spouseRetired
        ? Math.max(
            0,
            survivorAdjusted * HOUSEHOLD_DEFAULTS.PARTIAL_RETIREMENT_RATIO -
              income
          )
        : 0

    combinedBalance = Math.max(0, combinedBalance + growth - withdrawal)

    // Get individual balances from their projection arrays
    const primaryProj = primaryResult.projections[i]
    const spouseProj = spouseResult?.projections[i]

    projections.push({
      year,
      primaryAge,
      spouseAge,
      primaryBalance: primaryProj?.endBalance ?? 0,
      spouseBalance: spouseProj?.endBalance ?? 0,
      combinedBalance: Math.round(combinedBalance * 100) / 100,
      withdrawal: Math.round(withdrawal * 100) / 100,
      income: Math.round(income * 100) / 100,
      netWithdrawal: Math.round(Math.max(0, withdrawal - income) * 100) / 100,
    })

    if (combinedBalance === 0) break
  }

  const depleted = projections.find(p => p.combinedBalance === 0)
  const combinedRisk = calculateSequenceRisk(mergedPortfolio, combinedProfile)

  let recommendation: string
  if (!depleted) {
    recommendation = `Household portfolio is projected to last the full ${params.durationYears}-year projection period under the ${scenarioType.replace('_', ' ')} scenario.`
  } else {
    recommendation = `Household funds may be depleted by age ${depleted.primaryAge} (primary) / ${depleted.spouseAge} (spouse). Consider increasing savings or adjusting withdrawal plans.`
  }

  return {
    scenarioType,
    projections,
    primaryResult,
    spouseResult,
    combinedRunwayYears: depleted ? depleted.year : params.durationYears,
    combinedDepletionAge: depleted ? depleted.primaryAge : null,
    combinedRiskScore: combinedRisk.score as RiskLevel,
    recommendation,
  }
}

export function runAllHouseholdScenarios(
  config: HouseholdConfig
): HouseholdResult[] {
  const types: ScenarioType[] = ['bull', 'base', 'early_bear', 'prolonged_bear']
  return types.map(t => runHouseholdScenario(config, t))
}

// --- Helpers ---

function computeYearReturn(
  params: ScenarioParameters,
  yearIndex: number,
  equityFraction: number,
  bondFraction: number
): number {
  if (params.type === 'early_bear' && yearIndex < 3) {
    return (
      equityFraction * -params.drawdownPercent +
      bondFraction * params.bondReturnRate
    )
  }
  if (params.type === 'prolonged_bear' && yearIndex < 5) {
    return (
      equityFraction * (-params.drawdownPercent / 2) +
      bondFraction * params.bondReturnRate
    )
  }
  return (
    equityFraction * params.equityReturnRate +
    bondFraction * params.bondReturnRate
  )
}
