import { calculateTaxBreakdown } from '../tax-brackets'
import type {
  AnnualMultiplierOverride,
  AnnualRateOverride,
  FXRate,
  IncomeStream,
  LifeEvent,
  PlanAccount,
  PlanBoundary,
  PlanProjection,
  PlanProjectionMode,
  PlanProjectionPair,
  ProjectionAccountRow,
  ProjectionRow,
  Scenario,
  SpendingStream,
} from './types'
import { projectHealthcareYear, validateHealthcarePlan } from './healthcare'
import type { HealthcareProjectionRow } from './types'
import { materializeSocialSecurityIncomeStreams } from './social-security'

const PRETAX_TYPES = new Set<PlanAccount['type']>([
  'traditional_ira',
  'rollover_ira',
  '401k',
  '403b',
  '457b',
  'nqdc',
])
const TAXABLE_TYPES = new Set<PlanAccount['type']>(['cash', 'brokerage'])
const ROTH_TYPES = new Set<PlanAccount['type']>(['roth_ira', 'roth_401k'])

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function parseDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date: ${value}`)
  }
  return date
}

function dateForYear(asOfDate: string, year: number): string {
  const date = parseDate(asOfDate)
  date.setUTCFullYear(date.getUTCFullYear() + year)
  return date.toISOString().slice(0, 10)
}

function boundaryAge(boundary: PlanBoundary, scenario: Scenario): number {
  if ('age' in boundary) return boundary.age
  const start = parseDate(scenario.assumptions.asOfDate)
  const target = parseDate(boundary.date)
  return (
    scenario.profile.currentAge +
    (target.getUTCFullYear() - start.getUTCFullYear())
  )
}

function isActive(
  start: PlanBoundary,
  end: PlanBoundary | undefined,
  age: number,
  date: string,
  scenario: Scenario
): boolean {
  const startActive =
    age >= boundaryAge(start, scenario) &&
    (!('date' in start) || date >= start.date)
  if (!startActive) return false
  if (!end) return true
  return (
    age <= boundaryAge(end, scenario) && (!('date' in end) || date <= end.date)
  )
}

function fxRate(
  from: string,
  to: string,
  date: string,
  rates: readonly FXRate[]
): number {
  if (from === to) return 1
  const candidates = rates
    .filter(
      rate => rate.from === from && rate.to === to && rate.effectiveDate <= date
    )
    .sort((left, right) =>
      right.effectiveDate.localeCompare(left.effectiveDate)
    )
  const direct = candidates[0]
  if (direct) return direct.rate
  const inverse = rates
    .filter(
      rate => rate.from === to && rate.to === from && rate.effectiveDate <= date
    )
    .sort((left, right) =>
      right.effectiveDate.localeCompare(left.effectiveDate)
    )[0]
  if (inverse) return 1 / inverse.rate
  throw new Error(`Missing FX rate from ${from} to ${to} effective ${date}`)
}

function toBase(
  amount: number,
  currency: string,
  date: string,
  scenario: Scenario
): number {
  return (
    amount *
    fxRate(currency, scenario.assumptions.baseCurrency, date, scenario.fxRates)
  )
}

function rateForYear(
  defaultRate: number,
  schedule: readonly AnnualRateOverride[] | undefined,
  year: number
): number {
  const override = schedule?.find(
    entry => year >= entry.startYear && year <= entry.endYear
  )
  return override?.rate ?? defaultRate
}

function multiplierForYear(
  schedule: readonly AnnualMultiplierOverride[] | undefined,
  year: number
): number {
  const override = schedule?.find(
    entry => year >= entry.startYear && year <= entry.endYear
  )
  return override?.multiplier ?? 1
}

function compoundStreamGrowth(
  defaultRate: number,
  schedule: readonly AnnualRateOverride[] | undefined,
  year: number,
  elapsed: number
): number {
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new Error(`Invalid stream elapsed years: ${elapsed}`)
  }
  if (!schedule || schedule.length === 0) {
    return Math.pow(1 + defaultRate, elapsed)
  }

  // Start with the constant-time default-rate factor, then replace only the
  // portions covered by an override. Override intervals are annual buckets,
  // so fractional boundary ages are handled without iterating historical
  // years one by one.
  const firstGrowthYear = year - elapsed
  let factor = Math.pow(1 + defaultRate, elapsed)
  const boundaries = new Set<number>([firstGrowthYear, year])
  for (const override of schedule) {
    const start = Math.max(firstGrowthYear, override.startYear)
    const end = Math.min(year, override.endYear + 1)
    if (end > start) {
      boundaries.add(start)
      boundaries.add(end)
    }
  }
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right)
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const segmentStart = sortedBoundaries[index]!
    const segmentEnd = sortedBoundaries[index + 1]!
    const midpoint = (segmentStart + segmentEnd) / 2
    const override = schedule.find(
      entry => midpoint >= entry.startYear && midpoint < entry.endYear + 1
    )
    if (!override) continue
    factor *= Math.pow(
      (1 + override.rate) / (1 + defaultRate),
      segmentEnd - segmentStart
    )
  }
  return factor
}

function streamAmount(
  stream: IncomeStream | SpendingStream,
  year: number,
  age: number,
  date: string,
  scenario: Scenario,
  rate: number
): number {
  if (!isActive(stream.start, stream.end, age, date, scenario)) return 0
  const startAge = boundaryAge(stream.start, scenario)
  const elapsed = Math.max(0, age - startAge)
  const amount = 'gross' in stream ? stream.gross : stream.amount
  const growthSchedule =
    'gross' in stream
      ? stream.annualGrowthRateSchedule
      : stream.annualInflationRateSchedule
  const multiplier = multiplierForYear(stream.amountMultiplierSchedule, year)
  return toBase(
    amount *
      compoundStreamGrowth(rate, growthSchedule, year, elapsed) *
      multiplier,
    stream.currency,
    date,
    scenario
  )
}

function annualEventAge(event: LifeEvent, scenario: Scenario): number {
  if ('age' in event.date) return event.date.age
  const asOf = parseDate(scenario.assumptions.asOfDate)
  const eventDate = parseDate(event.date.date)
  return (
    scenario.profile.currentAge +
    (eventDate.getUTCFullYear() - asOf.getUTCFullYear())
  )
}

function annualEventBoundary(
  event: LifeEvent,
  scenario: Scenario
): PlanBoundary {
  if ('age' in event.date) return event.date
  const asOf = parseDate(scenario.assumptions.asOfDate)
  const eventDate = parseDate(event.date.date)
  const years = Math.max(1, eventDate.getUTCFullYear() - asOf.getUTCFullYear())
  return { age: scenario.profile.currentAge + years }
}

function applyCommittedLifeEvents(scenario: Scenario): Scenario {
  const committed = scenario.lifeEvents.filter(
    event => event.commitment === 'committed'
  )
  const existingIncomeIds = new Set(
    scenario.incomeStreams.map(stream => stream.id)
  )
  const proceedsStreams: IncomeStream[] = []

  for (const event of committed) {
    if (event.kind !== 'housing_transaction') continue
    if (!Number.isFinite(event.amount) || (event.amount ?? 0) <= 0) {
      throw new Error(
        `Committed housing event ${event.id} requires a positive net proceeds amount`
      )
    }
    const proceedsId = `${event.id}-net-proceeds`
    // The stress-suite downsize variant already materializes this stream. Do
    // not double-count it when the projection applies committed events.
    if (existingIncomeIds.has(proceedsId)) continue
    proceedsStreams.push({
      id: proceedsId,
      name: `${event.name} net proceeds`,
      owner: 'household',
      currency: event.currency ?? scenario.assumptions.baseCurrency,
      gross: event.amount ?? 0,
      start: annualEventBoundary(event, scenario),
      end: annualEventBoundary(event, scenario),
      annualGrowthRate: 0,
      taxCategory: 'tax_free',
      reliability: 1,
      includedInBase: true,
    })
  }

  return proceedsStreams.length === 0
    ? scenario
    : {
        ...scenario,
        incomeStreams: [...scenario.incomeStreams, ...proceedsStreams],
      }
}

function accountAccessible(
  account: PlanAccount,
  rowAge: number,
  eligibilityAge = rowAge
): boolean {
  if (account.type === 'home_equity') return false
  if (account.type === '457b') return true
  if (account.type === 'nqdc')
    return rowAge >= (account.accessibleAge ?? Number.POSITIVE_INFINITY)
  if (account.type === '401k' || account.type === '403b') {
    const rule55 =
      account.separationAge !== undefined &&
      account.separationAge >= 55 &&
      rowAge >= account.separationAge
    if (rule55) return true
  }
  if (ROTH_TYPES.has(account.type) || PRETAX_TYPES.has(account.type)) {
    return eligibilityAge >= 59.5
  }
  return TAXABLE_TYPES.has(account.type)
}

function orderedAccounts(
  accounts: readonly PlanAccount[],
  age: number
): PlanAccount[] {
  // Annual rows represent the calendar year centered on the row's age. This
  // lets the 59.5 access rule take effect in the year containing the half-year
  // threshold without delaying Rule-of-55 or scheduled NQDC access.
  const eligibilityAge = age - 0.5
  const priority = (account: PlanAccount): number => {
    if (!accountAccessible(account, age, eligibilityAge)) return 99
    if (TAXABLE_TYPES.has(account.type)) return 1
    if (PRETAX_TYPES.has(account.type)) return 2
    if (ROTH_TYPES.has(account.type)) return 3
    return 99
  }
  return accounts
    .filter(
      account =>
        accountAccessible(account, age, eligibilityAge) &&
        priority(account) < 99
    )
    .sort(
      (left, right) =>
        priority(left) - priority(right) || left.id.localeCompare(right.id)
    )
}

// Tight enough that the solved withdrawal is path-independent to well under
// a cent, so cent-level callers (the income solver) see a stable verdict.
const CONVERGENCE_TOLERANCE = 1e-6
// A cliff year can have no exact fixed point; accept the former 1 cent bar
// rather than fail an analysis that used to solve.
const ACCEPTABLE_RESIDUAL = 0.01
const UNDAMPED_ITERATIONS = 20

function projectYearWithdrawals(
  scenario: Scenario,
  accounts: readonly PlanAccount[],
  balances: Readonly<Record<string, number>>,
  age: number,
  date: string,
  incomeOrdinary: number,
  incomeCapitalGains: number,
  spending: number,
  income: number,
  healthcareForWithdrawals?: (
    withdrawals: Readonly<Record<string, number>>
  ) => HealthcareProjectionRow | undefined
): {
  withdrawals: Record<string, number>
  taxes: number
  fundingGap: number
  healthcare?: HealthcareProjectionRow
} {
  const order = orderedAccounts(accounts, age)
  const accountsById = new Map(accounts.map(account => [account.id, account]))
  let estimate = Math.max(0, spending - income)
  let withdrawals: Record<string, number> = {}
  let taxes = 0
  let converged = false
  let residual = Number.POSITIVE_INFINITY
  let healthcare: HealthcareProjectionRow | undefined
  const damping = 0.5
  let damped = false
  const maxIterations = 100
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const next: Record<string, number> = {}
    let remaining = estimate
    for (const account of order) {
      const amount = Math.min(Math.max(0, balances[account.id] ?? 0), remaining)
      next[account.id] = amount
      remaining -= amount
    }
    const ordinaryWithdrawal = Object.entries(next)
      .filter(([id]) => {
        const account = accountsById.get(id)
        if (!account) throw new Error(`Unknown withdrawal account ${id}`)
        return PRETAX_TYPES.has(account.type)
      })
      .reduce((total, [, amount]) => total + amount, 0)
    const capitalGainsWithdrawal = Object.entries(next)
      .filter(([id]) => {
        const account = accountsById.get(id)
        if (!account) throw new Error(`Unknown withdrawal account ${id}`)
        return TAXABLE_TYPES.has(account.type)
      })
      .reduce((total, [id, amount]) => {
        const account = accountsById.get(id)
        if (!account) throw new Error(`Unknown withdrawal account ${id}`)
        return total + amount * (account.capitalGainsRatio ?? 0)
      }, 0)
    const tax = calculateTaxBreakdown(
      incomeOrdinary + ordinaryWithdrawal,
      incomeCapitalGains + capitalGainsWithdrawal,
      scenario.profile.filingStatus,
      scenario.profile.stateTaxRate ?? 0
    ).totalTax
    healthcare = healthcareForWithdrawals?.(next)
    const nextEstimate = Math.max(
      0,
      spending + (healthcare?.total ?? 0) + tax - income
    )
    withdrawals = next
    taxes = tax
    const previousResidual = residual
    residual = Math.abs(nextEstimate - estimate)
    if (residual < CONVERGENCE_TOLERANCE) {
      converged = true
      break
    }
    // Undamped steps converge in a few iterations because the marginal rate
    // is below 1. Fall back to damping when the residual stops shrinking
    // (for example across an ACA cliff) so the solve still terminates.
    if (residual >= previousResidual || iteration >= UNDAMPED_ITERATIONS) {
      damped = true
    }
    estimate += (damped ? damping : 1) * (nextEstimate - estimate)
  }
  if (!converged && residual >= ACCEPTABLE_RESIDUAL) {
    throw new Error(
      `Tax gross-up did not converge for scenario ${scenario.id} at age ${age} (residual ${residual.toFixed(2)})`
    )
  }
  const funded = Object.values(withdrawals).reduce(
    (total, amount) => total + amount,
    0
  )
  const totalRequired = spending + (healthcare?.total ?? 0)
  return {
    withdrawals,
    taxes: roundMoney(taxes),
    fundingGap: roundMoney(
      Math.max(0, totalRequired + taxes - income - funded)
    ),
    healthcare,
  }
}

function project(scenario: Scenario, mode: PlanProjectionMode): PlanProjection {
  const effectiveScenario = applyCommittedLifeEvents(scenario)
  const balances: Record<string, number> = Object.fromEntries(
    effectiveScenario.accounts.map(account => [
      account.id,
      toBase(
        account.balance,
        account.currency,
        effectiveScenario.assumptions.asOfDate,
        effectiveScenario
      ),
    ])
  )
  const rows: ProjectionRow[] = []
  const incomeStreams = [
    ...effectiveScenario.incomeStreams,
    ...materializeSocialSecurityIncomeStreams(effectiveScenario),
  ]
  const healthcareStartMonth = dateForYear(
    effectiveScenario.assumptions.asOfDate,
    1
  ).slice(0, 7)
  const healthcareEndMonthExclusive = dateForYear(
    effectiveScenario.assumptions.asOfDate,
    effectiveScenario.assumptions.durationYears + 1
  ).slice(0, 7)
  validateHealthcarePlan(
    effectiveScenario,
    healthcareStartMonth,
    healthcareEndMonthExclusive
  )
  let cumulativeInflation = 1
  for (
    let year = 1;
    year <= effectiveScenario.assumptions.durationYears;
    year += 1
  ) {
    const age = effectiveScenario.profile.currentAge + year
    const date = dateForYear(effectiveScenario.assumptions.asOfDate, year)
    cumulativeInflation *=
      1 +
      rateForYear(
        effectiveScenario.assumptions.inflationRate,
        effectiveScenario.assumptions.inflationRateSchedule,
        year
      )
    const accountRows: Record<string, ProjectionAccountRow> = {}
    for (const account of effectiveScenario.accounts) {
      const startBalance = balances[account.id] ?? 0
      const annualReturnRate = rateForYear(
        account.annualReturnRate,
        account.returnSchedule,
        year
      )
      const growth = startBalance * annualReturnRate
      balances[account.id] = startBalance + growth
      accountRows[account.id] = {
        startBalance: roundMoney(startBalance),
        growth: roundMoney(growth),
        withdrawal: 0,
        endBalance: roundMoney(balances[account.id]),
        accessible: accountAccessible(account, age, age - 0.5),
      }
    }

    const incomeBySource: Record<string, number> = {}
    let income = 0
    let incomeOrdinary = 0
    let incomeCapitalGains = 0
    let incomeMagiAdditions = 0
    const socialSecurityIncomeIds = new Set(
      (effectiveScenario.socialSecurityBenefits ?? []).map(
        benefit => benefit.id
      )
    )
    for (const stream of incomeStreams) {
      if (!stream.includedInBase) continue
      const amount = streamAmount(
        stream,
        year,
        age,
        date,
        effectiveScenario,
        stream.annualGrowthRate
      )
      incomeBySource[stream.id] = roundMoney(amount)
      income += amount
      if (stream.taxCategory === 'ordinary') {
        incomeOrdinary += amount * (stream.taxableFraction ?? 1)
        if (socialSecurityIncomeIds.has(stream.id)) {
          incomeMagiAdditions += amount * (1 - (stream.taxableFraction ?? 1))
        }
      }
      if (stream.taxCategory === 'capital_gains') incomeCapitalGains += amount
    }

    const spendingByCategory: Record<string, number> = {}
    let spending = 0
    let essentialSpending = 0
    for (const stream of effectiveScenario.spendingStreams) {
      const amount = streamAmount(
        stream,
        year,
        age,
        date,
        effectiveScenario,
        stream.annualInflationRate
      )
      if (amount === 0) continue
      spendingByCategory[stream.id] = roundMoney(amount)
      spending += amount
      if (stream.essential) essentialSpending += amount
    }

    const yearWithdrawals = projectYearWithdrawals(
      effectiveScenario,
      effectiveScenario.accounts,
      balances,
      age,
      date,
      incomeOrdinary,
      incomeCapitalGains,
      spending,
      income,
      withdrawals =>
        projectHealthcareYear(effectiveScenario, {
          year,
          rowStartMonth: date.slice(0, 7),
          rowEndMonthExclusive: dateForYear(
            effectiveScenario.assumptions.asOfDate,
            year + 1
          ).slice(0, 7),
          incomeOrdinary,
          incomeCapitalGains,
          incomeMagiAdditions,
          withdrawals,
        })
    )
    const healthcare = yearWithdrawals.healthcare
    const totalSpending = spending + (healthcare?.total ?? 0)
    if (healthcare) {
      spendingByCategory.healthcare = healthcare.total
      essentialSpending += healthcare.total
    }
    for (const account of effectiveScenario.accounts) {
      const withdrawal = yearWithdrawals.withdrawals[account.id] ?? 0
      const endBalance = (balances[account.id] ?? 0) - withdrawal
      if (endBalance < -0.01) {
        throw new Error(`Account ${account.id} was overdrawn during projection`)
      }
      balances[account.id] = Math.max(0, endBalance)
      const accountRow = accountRows[account.id]
      accountRows[account.id] = {
        ...accountRow,
        withdrawal: roundMoney(withdrawal),
        endBalance: roundMoney(balances[account.id]),
      }
    }

    const nominalFactor = mode === 'real' ? cumulativeInflation : 1
    const normalize = (value: number): number =>
      roundMoney(value / nominalFactor)
    const normalizedAccounts: Record<string, ProjectionAccountRow> =
      Object.fromEntries(
        Object.entries(accountRows).map(([id, row]) => [
          id,
          {
            ...row,
            startBalance: normalize(row.startBalance),
            growth: normalize(row.growth),
            withdrawal: normalize(row.withdrawal),
            endBalance: normalize(row.endBalance),
          },
        ])
      )
    const accessibleBalance = Object.entries(normalizedAccounts)
      .filter(([, row]) => row.accessible)
      .reduce((total, [, row]) => total + row.endBalance, 0)
    const restrictedBalance = Object.entries(normalizedAccounts)
      .filter(([, row]) => !row.accessible)
      .reduce((total, [, row]) => total + row.endBalance, 0)
    const normalizedHealthcare = healthcare
      ? {
          ...healthcare,
          total: normalize(healthcare.total),
          premium: normalize(healthcare.premium),
          outOfPocket: normalize(healthcare.outOfPocket),
          subsidy: normalize(healthcare.subsidy),
          shocks: normalize(healthcare.shocks),
          magi:
            healthcare.magi === undefined
              ? undefined
              : normalize(healthcare.magi),
          acaByTaxYear: healthcare.acaByTaxYear
            ? Object.fromEntries(
                Object.entries(healthcare.acaByTaxYear).map(([year, aca]) => [
                  year,
                  {
                    ...aca,
                    annualFpl: normalize(aca.annualFpl),
                    minimumThreshold: normalize(aca.minimumThreshold),
                    cliffThreshold: normalize(aca.cliffThreshold),
                    magi: normalize(aca.magi),
                    amountBelowMinimum: normalize(aca.amountBelowMinimum),
                    amountOverCliff: normalize(aca.amountOverCliff),
                    subsidyAtCliff: normalize(aca.subsidyAtCliff),
                    costOfCrossingCliff: normalize(aca.costOfCrossingCliff),
                  },
                ])
              )
            : undefined,
          byPhase: Object.fromEntries(
            Object.entries(healthcare.byPhase).map(([id, phase]) => [
              id,
              {
                ...phase,
                premium: normalize(phase.premium),
                outOfPocket: normalize(phase.outOfPocket),
                subsidy: normalize(phase.subsidy),
                shocks: normalize(phase.shocks),
              },
            ])
          ),
        }
      : undefined
    rows.push({
      year,
      date,
      age,
      lifeEvents: effectiveScenario.lifeEvents.filter(
        event => annualEventAge(event, effectiveScenario) === age
      ),
      incomeBySource: Object.fromEntries(
        Object.entries(incomeBySource).map(([id, value]) => [
          id,
          normalize(value),
        ])
      ),
      spendingByCategory: Object.fromEntries(
        Object.entries(spendingByCategory).map(([id, value]) => [
          id,
          normalize(value),
        ])
      ),
      income: normalize(income),
      spending: normalize(totalSpending),
      essentialSpending: normalize(essentialSpending),
      taxes: normalize(yearWithdrawals.taxes),
      withdrawalsByAccount: Object.fromEntries(
        Object.entries(yearWithdrawals.withdrawals).map(([id, value]) => [
          id,
          normalize(value),
        ])
      ),
      accounts: normalizedAccounts,
      accessibleBalance: roundMoney(accessibleBalance),
      restrictedBalance: roundMoney(restrictedBalance),
      fundingGap: normalize(yearWithdrawals.fundingGap),
      healthcare: normalizedHealthcare,
    })
  }
  return { scenarioId: scenario.id, mode, rows }
}

export function projectScenario(
  scenario: Scenario,
  mode: PlanProjectionMode = 'nominal'
): PlanProjection {
  return project(scenario, mode)
}

export function projectScenarioBothModes(
  scenario: Scenario
): PlanProjectionPair {
  return {
    nominal: project(scenario, 'nominal'),
    real: project(scenario, 'real'),
  }
}

export function committedLifeEvents(scenario: Scenario): readonly LifeEvent[] {
  return scenario.lifeEvents.filter(event => event.commitment === 'committed')
}
