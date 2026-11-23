import type {
  HealthcareACAFplRule,
  HealthcareACAProjection,
  HealthcareACAResidenceRegion,
  HealthcarePhase,
  HealthcarePhaseProjection,
  HealthcarePlan,
  HealthcareProjectionRow,
  PlanAccount,
  Scenario,
} from './types'

const PRETAX_TYPES = new Set<PlanAccount['type']>([
  'traditional_ira',
  'rollover_ira',
  '401k',
  '403b',
  '457b',
  'nqdc',
])
const TAXABLE_TYPES = new Set<PlanAccount['type']>(['cash', 'brokerage'])

interface HealthcareProjectionInput {
  readonly year: number
  readonly rowStartMonth: string
  readonly rowEndMonthExclusive: string
  readonly incomeOrdinary: number
  readonly incomeCapitalGains: number
  readonly incomeMagiAdditions?: number
  readonly withdrawals: Readonly<Record<string, number>>
}

export const ACA_FPL_SOURCE_2025 =
  'https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/prior-hhs-poverty-guidelines-federal-register-references'
export const ACA_FPL_SOURCE_2026 =
  'https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines'
export const ACA_PTC_SOURCE_2026 =
  'https://www.irs.gov/pub/taxpros/fs-2025-10.pdf'
export const ACA_CONTRIBUTION_SOURCE_2026 =
  'https://www.irs.gov/pub/irs-drop/rp-25-25.pdf'
export const ACA_PLANNING_FPL_GROWTH_RATE = 0.03
export const ACA_DEFAULT_CONTRIBUTION_RATE = 0.0996

export const ACA_RULE_2026: HealthcareACAFplRule = {
  id: 'aca-fpl-2025-contiguous-us',
  taxYear: 2026,
  fplYear: 2025,
  effectiveDate: '2025-01-15',
  residenceRegion: 'contiguous_us',
  annualBaseFpl: 15_650,
  annualAdditionalPersonFpl: 5_500,
  minimumFplPercent: 100,
  maximumFplPercent: 400,
  status: 'official',
  source: ACA_FPL_SOURCE_2025,
}

export const ACA_RULE_2027: HealthcareACAFplRule = {
  id: 'aca-fpl-2026-contiguous-us',
  taxYear: 2027,
  fplYear: 2026,
  effectiveDate: '2026-01-15',
  residenceRegion: 'contiguous_us',
  annualBaseFpl: 15_960,
  annualAdditionalPersonFpl: 5_680,
  minimumFplPercent: 100,
  maximumFplPercent: 400,
  status: 'official',
  source: ACA_FPL_SOURCE_2026,
}

const SUPPORTED_ACA_REGIONS = new Set<HealthcareACAResidenceRegion>([
  'contiguous_us',
])

function planningRuleFrom(
  previous: HealthcareACAFplRule,
  taxYear: number
): HealthcareACAFplRule {
  return {
    id: `aca-fpl-planning-${taxYear}-contiguous-us`,
    taxYear,
    fplYear: taxYear - 1,
    effectiveDate: `${taxYear - 1}-01-01`,
    residenceRegion: 'contiguous_us',
    annualBaseFpl:
      Math.round(
        (previous.annualBaseFpl * (1 + ACA_PLANNING_FPL_GROWTH_RATE)) / 10
      ) * 10,
    annualAdditionalPersonFpl:
      Math.round(
        (previous.annualAdditionalPersonFpl *
          (1 + ACA_PLANNING_FPL_GROWTH_RATE)) /
          10
      ) * 10,
    minimumFplPercent: previous.minimumFplPercent,
    maximumFplPercent: previous.maximumFplPercent,
    status: 'planning_estimate',
    source: `${ACA_FPL_SOURCE_2025} (planning estimate using ${ACA_PLANNING_FPL_GROWTH_RATE * 100}% annual FPL growth)`,
  }
}

export function buildAcaRules(
  startTaxYear: number,
  endTaxYear: number
): Readonly<Record<string, HealthcareACAFplRule>> {
  if (!Number.isInteger(startTaxYear) || !Number.isInteger(endTaxYear)) {
    throw new Error('ACA rule years must be integers')
  }
  if (endTaxYear < startTaxYear) return {}
  const rules: Record<string, HealthcareACAFplRule> = {}
  let previous = ACA_RULE_2026
  for (let taxYear = 2026; taxYear <= endTaxYear; taxYear += 1) {
    const rule =
      taxYear === 2026
        ? ACA_RULE_2026
        : taxYear === 2027
          ? ACA_RULE_2027
          : planningRuleFrom(previous, taxYear)
    if (taxYear >= startTaxYear) rules[String(taxYear)] = rule
    previous = rule
  }
  if (startTaxYear < 2026) {
    throw new Error('ACA rules before tax year 2026 are not supported')
  }
  return rules
}

export function annualAcaFpl(
  rule: HealthcareACAFplRule,
  householdSize: number
): number {
  return (
    rule.annualBaseFpl +
    rule.annualAdditionalPersonFpl * Math.max(0, householdSize - 1)
  )
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`)
  }
}

function assertRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= -1) {
    throw new Error(`${label} must be finite and greater than -100%`)
  }
}

function monthIndex(month: string): number {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error(`Invalid healthcare calendar month: ${month}`)
  }
  const [year, monthNumber] = month.split('-').map(Number)
  return year * 12 + monthNumber - 1
}

function monthFromIndex(index: number): string {
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}`
}

function monthsBetween(start: string, end: string): string[] {
  const startIndex = monthIndex(start)
  const endIndex = monthIndex(end)
  if (endIndex <= startIndex) return []
  return Array.from({ length: endIndex - startIndex }, (_, offset) =>
    monthFromIndex(startIndex + offset)
  )
}

function fxRate(
  from: string,
  to: string,
  month: string,
  scenario: Scenario
): number {
  if (from === to) return 1
  const effectiveDate = `${month}-01`
  const direct = scenario.fxRates
    .filter(
      rate =>
        rate.from === from &&
        rate.to === to &&
        rate.effectiveDate <= effectiveDate
    )
    .sort((left, right) =>
      right.effectiveDate.localeCompare(left.effectiveDate)
    )[0]
  if (direct) return direct.rate
  const inverse = scenario.fxRates
    .filter(
      rate =>
        rate.from === to &&
        rate.to === from &&
        rate.effectiveDate <= effectiveDate
    )
    .sort((left, right) =>
      right.effectiveDate.localeCompare(left.effectiveDate)
    )[0]
  if (inverse) return 1 / inverse.rate
  throw new Error(
    `Missing FX rate from ${from} to ${to} effective ${effectiveDate}`
  )
}

function toBase(
  amount: number,
  currency: string,
  month: string,
  scenario: Scenario
): number {
  return (
    amount *
    fxRate(currency, scenario.assumptions.baseCurrency, month, scenario)
  )
}

function phaseForMonth(
  phases: readonly HealthcarePhase[],
  month: string
): HealthcarePhase | undefined {
  return phases.find(
    phase => phase.startMonth <= month && month < phase.endMonthExclusive
  )
}

function validatePlan(
  scenario: Scenario,
  plan: HealthcarePlan,
  horizonStartMonth: string,
  horizonEndMonthExclusive: string
): void {
  assertRate(plan.annualInflationRate, 'Healthcare inflation rate')

  const sorted = [...plan.phases].sort((left, right) =>
    left.startMonth.localeCompare(right.startMonth)
  )
  let previousEnd: string | undefined
  const ids = new Set<string>()
  for (const phase of sorted) {
    if (ids.has(phase.id))
      throw new Error(`Duplicate healthcare phase: ${phase.id}`)
    ids.add(phase.id)
    const start = monthIndex(phase.startMonth)
    const end = monthIndex(phase.endMonthExclusive)
    if (end <= start) {
      throw new Error(
        `Healthcare phase ${phase.id} must cover at least one month`
      )
    }
    if (previousEnd && phase.startMonth < previousEnd) {
      throw new Error(`Healthcare phases overlap at ${phase.startMonth}`)
    }
    previousEnd = phase.endMonthExclusive

    if (phase.medicareComponents) {
      if (phase.kind !== 'medicare' || phase.medicareComponents.length === 0) {
        throw new Error(
          `Invalid Medicare components for healthcare phase ${phase.id}`
        )
      }
      if (
        Object.prototype.hasOwnProperty.call(phase, 'monthlyPremium') ||
        Object.prototype.hasOwnProperty.call(phase, 'monthlyOutOfPocket')
      ) {
        throw new Error(
          `Healthcare phase ${phase.id} cannot use aggregate and component amounts together`
        )
      }
      const componentIds = new Set<string>()
      for (const component of phase.medicareComponents) {
        if (componentIds.has(component.id)) {
          throw new Error(`Duplicate Medicare component: ${component.id}`)
        }
        componentIds.add(component.id)
        assertFiniteNonNegative(
          component.monthlyPremium,
          `Medicare component ${component.id} premium`
        )
        assertFiniteNonNegative(
          component.monthlyOutOfPocket ?? 0,
          `Medicare component ${component.id} out-of-pocket`
        )
        if (component.annualInflationRate !== undefined) {
          assertRate(
            component.annualInflationRate,
            `Medicare component inflation ${component.id}`
          )
        }
      }
    } else {
      assertFiniteNonNegative(
        phase.monthlyPremium,
        `Healthcare phase ${phase.id} premium`
      )
      assertFiniteNonNegative(
        phase.monthlyOutOfPocket,
        `Healthcare phase ${phase.id} out-of-pocket`
      )
    }
  }

  const acaMonths = monthsBetween(
    horizonStartMonth,
    horizonEndMonthExclusive
  ).filter(month => phaseForMonth(plan.phases, month)?.kind === 'aca')
  if (acaMonths.length > 0 && horizonStartMonth.slice(5, 7) !== '01') {
    throw new Error(
      'ACA projections require a January-aligned asOfDate until calendar-month MAGI is supported'
    )
  }

  if (acaMonths.length > 0 && !plan.aca) {
    throw new Error('ACA phase requires ACA configuration')
  }
  if (
    acaMonths.length > 0 &&
    (scenario.profile.filingStatus as string) === 'married_filing_separately'
  ) {
    throw new Error(
      'ACA premium tax credit is not modeled for married-filing-separately scenarios'
    )
  }

  if (plan.aca) {
    const aca = plan.aca
    if (!Number.isInteger(aca.householdSize) || aca.householdSize <= 0) {
      throw new Error('ACA household size must be a positive integer')
    }
    if (!SUPPORTED_ACA_REGIONS.has(aca.residenceRegion)) {
      throw new Error(
        `Unsupported ACA residence region: ${aca.residenceRegion}`
      )
    }
    const ruleEntries = Object.entries(aca.rulesByTaxYear)
    if (ruleEntries.length === 0) {
      throw new Error('ACA rulesByTaxYear must contain at least one rule')
    }
    for (const [year, rule] of ruleEntries) {
      if (!/^\d{4}$/.test(year) || rule.taxYear !== Number(year)) {
        throw new Error(`ACA rule key must match its tax year: ${year}`)
      }
      if (rule.residenceRegion !== aca.residenceRegion) {
        throw new Error(`ACA rule ${year} does not match the residence region`)
      }
      if (
        !Number.isInteger(rule.taxYear) ||
        !Number.isInteger(rule.fplYear) ||
        rule.fplYear <= 0
      ) {
        throw new Error(`ACA rule ${year} must have valid tax and FPL years`)
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveDate)) {
        throw new Error(`ACA rule ${year} must have an ISO effective date`)
      }
      const effectiveDate = new Date(`${rule.effectiveDate}T00:00:00Z`)
      if (
        Number.isNaN(effectiveDate.getTime()) ||
        effectiveDate.toISOString().slice(0, 10) !== rule.effectiveDate
      ) {
        throw new Error(`ACA rule ${year} must have a valid effective date`)
      }
      if (rule.status !== 'official' && rule.status !== 'planning_estimate') {
        throw new Error(`ACA rule ${year} has an invalid status`)
      }
      assertFiniteNonNegative(
        rule.annualBaseFpl,
        `ACA annual base FPL for ${year}`
      )
      if (rule.annualBaseFpl <= 0) {
        throw new Error(`ACA annual base FPL for ${year} must be positive`)
      }
      assertFiniteNonNegative(
        rule.annualAdditionalPersonFpl,
        `ACA annual additional-person FPL for ${year}`
      )
      if (
        !Number.isFinite(rule.minimumFplPercent) ||
        rule.minimumFplPercent <= 0 ||
        !Number.isFinite(rule.maximumFplPercent) ||
        rule.maximumFplPercent < rule.minimumFplPercent
      ) {
        throw new Error(`ACA FPL bounds are invalid for ${year}`)
      }
      if (!rule.source.trim())
        throw new Error(`ACA rule ${year} needs a source`)
    }
    assertFiniteNonNegative(aca.benchmarkAnnualPremium, 'ACA benchmark premium')
    if (!Number.isFinite(aca.contributionRate) || aca.contributionRate < 0) {
      throw new Error('ACA contribution rate must be non-negative')
    }
  }
  for (const [year, amount] of Object.entries(
    plan.additionalMagiByYear ?? {}
  )) {
    if (!/^\d{4}$/.test(year)) throw new Error(`Invalid ACA MAGI year: ${year}`)
    assertFiniteNonNegative(amount, `Additional MAGI for ${year}`)
  }
  for (const shock of plan.shocks ?? []) {
    monthIndex(shock.month)
    assertFiniteNonNegative(shock.amount, `Healthcare shock ${shock.id}`)
    if (shock.currency !== scenario.assumptions.baseCurrency) {
      throw new Error(`Healthcare shock ${shock.id} must use the base currency`)
    }
    if (
      shock.month < horizonStartMonth ||
      shock.month >= horizonEndMonthExclusive
    ) {
      throw new Error(
        `Healthcare shock ${shock.id} is outside the projection horizon`
      )
    }
  }
  for (const month of acaMonths) {
    const taxYear = month.slice(0, 4)
    if (!plan.aca?.rulesByTaxYear[taxYear]) {
      throw new Error(`Missing ACA FPL rule for tax year ${taxYear}`)
    }
  }
}

function phaseAmounts(
  phase: HealthcarePhase,
  month: string,
  originMonth: string,
  scenario: Scenario
): { premium: number; outOfPocket: number } {
  const elapsedMonths = monthIndex(month) - monthIndex(originMonth)
  const planRate = scenario.healthcare?.annualInflationRate ?? 0
  const inflated = (amount: number, rate: number): number =>
    amount * Math.pow(1 + rate, elapsedMonths / 12)

  if (phase.medicareComponents) {
    return phase.medicareComponents.reduce(
      (totals, component) => {
        const rate = component.annualInflationRate ?? planRate
        totals.premium += toBase(
          inflated(component.monthlyPremium, rate),
          component.currency ?? phase.currency,
          month,
          scenario
        )
        totals.outOfPocket += toBase(
          inflated(component.monthlyOutOfPocket ?? 0, rate),
          component.currency ?? phase.currency,
          month,
          scenario
        )
        return totals
      },
      { premium: 0, outOfPocket: 0 }
    )
  }

  return {
    premium: toBase(
      inflated(phase.monthlyPremium ?? 0, planRate),
      phase.currency,
      month,
      scenario
    ),
    outOfPocket: toBase(
      inflated(phase.monthlyOutOfPocket ?? 0, planRate),
      phase.currency,
      month,
      scenario
    ),
  }
}

export function validateHealthcarePlan(
  scenario: Scenario,
  horizonStartMonth: string,
  horizonEndMonthExclusive: string
): void {
  if (scenario.healthcare) {
    validatePlan(
      scenario,
      scenario.healthcare,
      horizonStartMonth,
      horizonEndMonthExclusive
    )
  }
}

export function projectHealthcareYear(
  scenario: Scenario,
  input: HealthcareProjectionInput
): HealthcareProjectionRow | undefined {
  const plan = scenario.healthcare
  if (!plan) return undefined
  const months = monthsBetween(input.rowStartMonth, input.rowEndMonthExclusive)
  const originMonth = scenario.assumptions.asOfDate.slice(0, 7)
  const withdrawalAccounts = new Map(
    scenario.accounts.map(account => [account.id, account])
  )
  const ordinaryWithdrawals = Object.entries(input.withdrawals).reduce(
    (total, [id, amount]) =>
      total +
      (PRETAX_TYPES.has(withdrawalAccounts.get(id)?.type ?? 'cash')
        ? amount
        : 0),
    0
  )
  const capitalGainsWithdrawals = Object.entries(input.withdrawals).reduce(
    (total, [id, amount]) => {
      const account = withdrawalAccounts.get(id)
      return (
        total +
        (account && TAXABLE_TYPES.has(account.type)
          ? amount * (account.capitalGainsRatio ?? 0)
          : 0)
      )
    },
    0
  )
  const annualMagiBase =
    input.incomeOrdinary +
    input.incomeCapitalGains +
    ordinaryWithdrawals +
    capitalGainsWithdrawals +
    (input.incomeMagiAdditions ?? 0)
  const byPhase = new Map<string, HealthcarePhaseProjection>()
  const acaByTaxYear = new Map<string, HealthcareACAProjection>()
  let premium = 0
  let outOfPocket = 0
  let subsidy = 0
  let shocks = 0
  let magiTotal = 0
  for (const month of months) {
    const monthShocks = (plan.shocks ?? [])
      .filter(shock => shock.month === month)
      .reduce((total, shock) => total + shock.amount, 0)
    const phase = phaseForMonth(plan.phases, month)
    if (!phase) {
      shocks += monthShocks
      continue
    }
    const amounts = phaseAmounts(phase, month, originMonth, scenario)
    const calendarYear = month.slice(0, 4)
    const annualMagi =
      annualMagiBase + (plan.additionalMagiByYear?.[calendarYear] ?? 0)
    const acaRule =
      phase.kind === 'aca' && plan.aca
        ? plan.aca.rulesByTaxYear[calendarYear]
        : undefined
    const acaAnnualFpl =
      acaRule && plan.aca ? annualAcaFpl(acaRule, plan.aca.householdSize) : 0
    const acaMinimumThreshold = acaRule
      ? (acaAnnualFpl * acaRule.minimumFplPercent) / 100
      : 0
    const acaCliffThreshold = acaRule
      ? (acaAnnualFpl * acaRule.maximumFplPercent) / 100
      : 0
    const eligibilityStatus = acaRule
      ? annualMagi < acaMinimumThreshold
        ? 'below_minimum_fpl'
        : annualMagi > acaCliffThreshold
          ? 'above_maximum_fpl'
          : 'eligible'
      : undefined
    const monthlySubsidy =
      phase.kind === 'aca' && plan.aca && acaRule
        ? eligibilityStatus === 'eligible'
          ? Math.max(
              0,
              plan.aca.benchmarkAnnualPremium / 12 -
                Math.max(0, (annualMagi * plan.aca.contributionRate) / 12)
            )
          : 0
        : 0
    const appliedSubsidy = Math.min(amounts.premium, monthlySubsidy)
    if (phase.kind === 'aca' && plan.aca && acaRule && eligibilityStatus) {
      const subsidyAtCliff = Math.min(
        amounts.premium,
        Math.max(
          0,
          plan.aca.benchmarkAnnualPremium / 12 -
            Math.max(0, (acaCliffThreshold * plan.aca.contributionRate) / 12)
        )
      )
      const current = acaByTaxYear.get(calendarYear) ?? {
        taxYear: Number(calendarYear),
        ruleId: acaRule.id,
        ruleStatus: acaRule.status,
        ruleEffectiveDate: acaRule.effectiveDate,
        ruleSource: acaRule.source,
        annualFpl: acaAnnualFpl,
        minimumThreshold: acaMinimumThreshold,
        cliffThreshold: acaCliffThreshold,
        magi: annualMagi,
        fplPercent: (annualMagi / acaAnnualFpl) * 100,
        amountBelowMinimum: Math.max(0, acaMinimumThreshold - annualMagi),
        amountOverCliff: Math.max(0, annualMagi - acaCliffThreshold),
        eligibilityStatus,
        eligibleForPremiumTaxCredit: eligibilityStatus === 'eligible',
        subsidyAtCliff: 0,
        costOfCrossingCliff: 0,
      }
      acaByTaxYear.set(calendarYear, {
        ...current,
        subsidyAtCliff: current.subsidyAtCliff + subsidyAtCliff,
        costOfCrossingCliff:
          current.costOfCrossingCliff +
          (eligibilityStatus === 'above_maximum_fpl' ? subsidyAtCliff : 0),
      })
    }
    const current = byPhase.get(phase.id) ?? {
      kind: phase.kind,
      premium: 0,
      outOfPocket: 0,
      subsidy: 0,
      shocks: 0,
    }
    byPhase.set(phase.id, {
      ...current,
      premium: current.premium + amounts.premium,
      outOfPocket: current.outOfPocket + amounts.outOfPocket,
      subsidy: current.subsidy + appliedSubsidy,
      shocks: current.shocks + monthShocks,
    })
    premium += amounts.premium
    outOfPocket += amounts.outOfPocket
    subsidy += appliedSubsidy
    shocks += monthShocks
    magiTotal += annualMagi
  }

  return {
    total: roundMoney(premium - subsidy + outOfPocket + shocks),
    premium: roundMoney(premium),
    outOfPocket: roundMoney(outOfPocket),
    subsidy: roundMoney(subsidy),
    shocks: roundMoney(shocks),
    magi: roundMoney(magiTotal / Math.max(1, months.length)),
    byPhase: Object.fromEntries(
      [...byPhase.entries()].map(([id, value]) => [
        id,
        {
          ...value,
          premium: roundMoney(value.premium),
          outOfPocket: roundMoney(value.outOfPocket),
          subsidy: roundMoney(value.subsidy),
          shocks: roundMoney(value.shocks),
        },
      ])
    ),
    acaByTaxYear:
      acaByTaxYear.size > 0
        ? Object.fromEntries(
            [...acaByTaxYear.entries()].map(([year, value]) => [
              year,
              {
                ...value,
                annualFpl: roundMoney(value.annualFpl),
                minimumThreshold: roundMoney(value.minimumThreshold),
                cliffThreshold: roundMoney(value.cliffThreshold),
                magi: roundMoney(value.magi),
                fplPercent: roundMoney(value.fplPercent),
                amountBelowMinimum: roundMoney(value.amountBelowMinimum),
                amountOverCliff: roundMoney(value.amountOverCliff),
                subsidyAtCliff: roundMoney(value.subsidyAtCliff),
                costOfCrossingCliff: roundMoney(value.costOfCrossingCliff),
              },
            ])
          )
        : undefined,
  }
}
