import { projectScenario } from './projection'
import type {
  AnnualMultiplierOverride,
  AnnualRateOverride,
  IncomeStream,
  LifeEvent,
  PlanBoundary,
  PlanProjection,
  PlanProjectionMode,
  Scenario,
  SpendingStream,
  HealthcarePhase,
} from './types'

export const STRESS_SCENARIO_IDS = [
  'baseline',
  'market-shock-20-first-retirement-year',
  'market-shock-30-first-retirement-year',
  'two-year-high-inflation',
  'healthcare-double-two-years',
  'outside-income-half-three-years',
  'combined-bad-start',
  'work-exit-delay-one-year',
  'work-exit-delay-three-years',
  'downsize',
] as const

export type StressScenarioId = (typeof STRESS_SCENARIO_IDS)[number]

export type StressScenarioCaseId =
  | StressScenarioId
  | 'downsize-committed'
  | 'downsize-not-used'

export interface StressScenarioCase {
  readonly id: StressScenarioCaseId
  readonly requirementId?: StressScenarioId
  readonly label: string
  readonly description: string
  readonly scenario: Scenario
}

export interface DownsizeStressScenarioCase extends StressScenarioCase {
  readonly id: 'downsize'
  readonly variants: Readonly<{
    readonly committed: StressScenarioCase
    readonly notUsed: StressScenarioCase
  }>
}

export type StressScenarioDefinition =
  | StressScenarioCase
  | DownsizeStressScenarioCase

export interface StressScenarioBuildOptions {
  /** Absolute annual inflation rate used for the two-year inflation shock. */
  readonly highInflationRate?: number
  /** Stream IDs for recurring healthcare spending. Required unless inferable. */
  readonly healthcareStreamIds?: readonly string[]
  /** Stream IDs for consulting/business income. Required unless inferable. */
  readonly outsideIncomeStreamIds?: readonly string[]
  /** Stream IDs whose end boundary represents work exit. Required unless inferable. */
  readonly workIncomeStreamIds?: readonly string[]
  /** Housing transaction event ID. Required unless the baseline has one event. */
  readonly downsizeEventId?: string
  /** Allow plans without a housing transaction to run the other stress cases. */
  readonly allowMissingDownsize?: boolean
}

export interface StressScenarioSuite {
  /** Exactly ten high-level deterministic requirements, including baseline. */
  readonly scenarios: readonly StressScenarioDefinition[]
  readonly downsizeComparison: Readonly<{
    readonly committed: StressScenarioCase
    readonly notUsed: StressScenarioCase
  }>
}

export interface ProjectedStressScenario {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly scenario: Scenario
  readonly projection: PlanProjection
}

const INVESTED_ACCOUNT_TYPES = new Set<Scenario['accounts'][number]['type']>([
  'brokerage',
  'traditional_ira',
  'rollover_ira',
  '401k',
  '403b',
  '457b',
  'roth_ira',
  'roth_401k',
  'nqdc',
])

const DEFAULT_HIGH_INFLATION_RATE = 0.08

function retirementYear(scenario: Scenario): number {
  const year =
    scenario.profile.targetRetirementAge - scenario.profile.currentAge
  if (!Number.isInteger(year) || year < 1) {
    throw new Error(
      'Stress scenarios require a target retirement age after the current age'
    )
  }
  if (year > scenario.assumptions.durationYears) {
    throw new Error(
      'Stress scenarios require the retirement year inside the projection horizon'
    )
  }
  return year
}

function range(
  startYear: number,
  years: number
): Readonly<{
  startYear: number
  endYear: number
}> {
  return { startYear, endYear: startYear + years - 1 }
}

function prependRateOverride(
  existing: readonly AnnualRateOverride[] | undefined,
  override: AnnualRateOverride
): readonly AnnualRateOverride[] {
  return [override, ...(existing ?? [])]
}

function prependMultiplierOverride(
  existing: readonly AnnualMultiplierOverride[] | undefined,
  override: AnnualMultiplierOverride
): readonly AnnualMultiplierOverride[] {
  return [override, ...(existing ?? [])]
}

function cloneScenario(
  baseline: Scenario,
  suffix: string,
  changes: Partial<Scenario>
): Scenario {
  return { ...baseline, ...changes, id: `${baseline.id}--stress--${suffix}` }
}

function findStreamIds<T extends IncomeStream | SpendingStream>(
  streams: readonly T[],
  requested: readonly string[] | undefined,
  predicate: (stream: T) => boolean,
  label: string
): readonly string[] {
  const ids = requested ?? streams.filter(predicate).map(stream => stream.id)
  if (ids.length === 0) {
    throw new Error(`Stress scenario requires ${label} stream IDs`)
  }
  const known = new Set(streams.map(stream => stream.id))
  const unknown = ids.filter(id => !known.has(id))
  if (unknown.length > 0) {
    throw new Error(`Unknown ${label} stream IDs: ${unknown.join(', ')}`)
  }
  return [...new Set(ids)]
}

function addReturnShock(
  baseline: Scenario,
  suffix: string,
  startYear: number,
  returnRate: number
): Scenario {
  const override = { ...range(startYear, 1), rate: returnRate }
  const accounts = baseline.accounts.map(account =>
    INVESTED_ACCOUNT_TYPES.has(account.type)
      ? {
          ...account,
          returnSchedule: prependRateOverride(account.returnSchedule, override),
        }
      : account
  )
  return cloneScenario(baseline, suffix, { accounts })
}

function addHighInflation(
  baseline: Scenario,
  suffix: string,
  startYear: number,
  highInflationRate: number
): Scenario {
  const override = { ...range(startYear, 2), rate: highInflationRate }
  const spendingStreams = baseline.spendingStreams.map(stream => ({
    ...stream,
    annualInflationRateSchedule: prependRateOverride(
      stream.annualInflationRateSchedule,
      override
    ),
  }))
  return cloneScenario(baseline, suffix, {
    assumptions: {
      ...baseline.assumptions,
      inflationRateSchedule: prependRateOverride(
        baseline.assumptions.inflationRateSchedule,
        override
      ),
    },
    spendingStreams,
  })
}

function addHealthcareShock(
  baseline: Scenario,
  suffix: string,
  streamIds: readonly string[],
  startYear: number
): Scenario {
  const selected = new Set(streamIds)
  const override = { ...range(startYear, 2), multiplier: 2 }
  const spendingStreams = baseline.spendingStreams.map(stream =>
    selected.has(stream.id)
      ? {
          ...stream,
          amountMultiplierSchedule: prependMultiplierOverride(
            stream.amountMultiplierSchedule,
            override
          ),
        }
      : stream
  )
  const healthcare = baseline.healthcare
    ? {
        ...baseline.healthcare,
        phases: baseline.healthcare.phases.map(phase => {
          if ('medicareComponents' in phase && phase.medicareComponents) {
            return {
              ...phase,
              kind: 'medicare' as const,
              medicareComponents: phase.medicareComponents.map(component => ({
                ...component,
                monthlyPremium: component.monthlyPremium * 2,
                monthlyOutOfPocket: (component.monthlyOutOfPocket ?? 0) * 2,
              })),
            }
          }
          return {
            ...phase,
            kind: phase.kind as 'employer' | 'cobra' | 'aca',
            monthlyPremium: phase.monthlyPremium * 2,
            monthlyOutOfPocket: phase.monthlyOutOfPocket * 2,
          }
        }) as HealthcarePhase[],
      }
    : baseline.healthcare
  return cloneScenario(baseline, suffix, { spendingStreams, healthcare })
}

function addIncomeShock(
  baseline: Scenario,
  suffix: string,
  streamIds: readonly string[],
  startYear: number
): Scenario {
  const selected = new Set(streamIds)
  const override = { ...range(startYear, 3), multiplier: 0.5 }
  const incomeStreams = baseline.incomeStreams.map(stream =>
    selected.has(stream.id)
      ? {
          ...stream,
          amountMultiplierSchedule: prependMultiplierOverride(
            stream.amountMultiplierSchedule,
            override
          ),
        }
      : stream
  )
  return cloneScenario(baseline, suffix, { incomeStreams })
}

function shiftedBoundary(boundary: PlanBoundary, years: number): PlanBoundary {
  if ('age' in boundary) return { age: boundary.age + years }
  const date = new Date(`${boundary.date}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid work-exit boundary date: ${boundary.date}`)
  }
  const targetYear = date.getUTCFullYear() + years
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  const lastDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate()
  date.setUTCFullYear(targetYear, month, Math.min(day, lastDay))
  return { date: date.toISOString().slice(0, 10) }
}

function addWorkExitDelay(
  baseline: Scenario,
  suffix: string,
  streamIds: readonly string[],
  years: number
): Scenario {
  const selected = new Set(streamIds)
  const incomeStreams = baseline.incomeStreams.map(stream => {
    if (!selected.has(stream.id)) return stream
    if (!stream.end) {
      throw new Error(
        `Work-exit stress requires an end boundary for income stream ${stream.id}`
      )
    }
    return { ...stream, end: shiftedBoundary(stream.end, years) }
  })
  return cloneScenario(baseline, suffix, { incomeStreams })
}

function housingEvent(
  baseline: Scenario,
  eventId: string | undefined,
  allowMissingDownsize = false
): LifeEvent | null {
  const event = eventId
    ? baseline.lifeEvents.find(candidate => candidate.id === eventId)
    : (() => {
        const candidates = baseline.lifeEvents.filter(
          candidate => candidate.kind === 'housing_transaction'
        )
        if (candidates.length !== 1) {
          if (candidates.length === 0 && allowMissingDownsize) return null
          throw new Error(
            candidates.length === 0
              ? 'Downsize stress requires a housing_transaction life event with net proceeds'
              : 'Downsize stress found multiple housing transactions; provide downsizeEventId'
          )
        }
        return candidates[0]
      })()
  if (!event || event.kind !== 'housing_transaction') {
    if (!event && allowMissingDownsize) return null
    throw new Error(
      'Downsize stress requires a housing_transaction life event with net proceeds'
    )
  }
  if (!Number.isFinite(event.amount) || (event.amount ?? 0) <= 0) {
    throw new Error(
      `Downsize event ${event.id} requires a positive net proceeds amount`
    )
  }
  return event
}

function annualBucketBoundary(
  baseline: Scenario,
  boundary: PlanBoundary
): PlanBoundary {
  let years: number
  if ('age' in boundary) {
    years = boundary.age - baseline.profile.currentAge
  } else {
    const asOfDate = new Date(`${baseline.assumptions.asOfDate}T00:00:00Z`)
    const eventDate = new Date(`${boundary.date}T00:00:00Z`)
    if (Number.isNaN(asOfDate.getTime()) || Number.isNaN(eventDate.getTime())) {
      throw new Error(`Invalid downsize event date: ${boundary.date}`)
    }
    if (eventDate < asOfDate) {
      throw new Error(
        `Downsize event date ${boundary.date} must not precede as-of date ${baseline.assumptions.asOfDate}`
      )
    }
    // Projection rows are annual calendar buckets. A date anywhere in a
    // calendar year is represented by that year's row, including dates that do
    // not coincide with the as-of anniversary.
    years = Math.max(1, eventDate.getUTCFullYear() - asOfDate.getUTCFullYear())
  }
  if (
    !Number.isInteger(years) ||
    years < 1 ||
    years > baseline.assumptions.durationYears
  ) {
    throw new Error(
      `Downsize event must fall within projection years 1-${baseline.assumptions.durationYears}`
    )
  }
  return { age: baseline.profile.currentAge + years }
}

function downsizeVariants(
  baseline: Scenario,
  eventId: string | undefined,
  allowMissingDownsize = false
): Readonly<{
  committed: StressScenarioCase
  notUsed: StressScenarioCase
}> | null {
  const event = housingEvent(baseline, eventId, allowMissingDownsize)
  if (!event) return null
  const committedEvent: LifeEvent = { ...event, commitment: 'committed' }
  const notUsedEvent: LifeEvent = { ...event, commitment: 'available' }
  const proceedsBoundary = annualBucketBoundary(baseline, event.date)
  const proceeds: IncomeStream = {
    id: `${event.id}-net-proceeds`,
    name: `${event.name} net proceeds`,
    owner: 'household',
    currency: event.currency ?? baseline.assumptions.baseCurrency,
    gross: event.amount ?? 0,
    start: proceedsBoundary,
    end: proceedsBoundary,
    annualGrowthRate: 0,
    taxCategory: 'tax_free',
    reliability: 1,
    includedInBase: true,
  }
  if (baseline.incomeStreams.some(candidate => candidate.id === proceeds.id)) {
    throw new Error(
      `Downsize proceeds stream ID ${proceeds.id} collides with an existing income stream`
    )
  }
  const committedScenario = cloneScenario(baseline, 'downsize-committed', {
    lifeEvents: baseline.lifeEvents.map(candidate =>
      candidate.id === event.id ? committedEvent : candidate
    ),
    incomeStreams: [...baseline.incomeStreams, proceeds],
  })
  const notUsedScenario = cloneScenario(baseline, 'downsize-not-used', {
    lifeEvents: baseline.lifeEvents.map(candidate =>
      candidate.id === event.id ? notUsedEvent : candidate
    ),
    incomeStreams: baseline.incomeStreams,
  })
  return {
    committed: {
      id: 'downsize-committed',
      requirementId: 'downsize',
      label: 'Downsize committed',
      description:
        'Includes committed net housing-sale proceeds at the event date.',
      scenario: committedScenario,
    },
    notUsed: {
      id: 'downsize-not-used',
      requirementId: 'downsize',
      label: 'Downsize not used',
      description:
        'Keeps the housing option available but does not count its proceeds.',
      scenario: notUsedScenario,
    },
  }
}

function withCase(
  id: Exclude<StressScenarioId, 'baseline' | 'downsize'>,
  label: string,
  description: string,
  scenario: Scenario
): StressScenarioCase {
  return { id, label, description, scenario }
}

export function buildStressScenarioSuite(
  baseline: Scenario,
  options: StressScenarioBuildOptions = {}
): StressScenarioSuite {
  const startYear = retirementYear(baseline)
  const highInflationRate =
    options.highInflationRate ?? DEFAULT_HIGH_INFLATION_RATE
  if (!Number.isFinite(highInflationRate) || highInflationRate <= -1) {
    throw new Error('highInflationRate must be finite and greater than -100%')
  }
  const healthcareStreamIds = findStreamIds(
    baseline.spendingStreams,
    options.healthcareStreamIds,
    stream =>
      /health|medical|medicare|aca|cobra/i.test(
        `${stream.id} ${stream.category}`
      ),
    'healthcare'
  )
  const outsideIncomeStreamIds = findStreamIds(
    baseline.incomeStreams,
    options.outsideIncomeStreamIds,
    stream =>
      /consult|business|contract|outside|retainer/i.test(
        `${stream.id} ${stream.name}`
      ),
    'outside-income'
  )
  const workIncomeStreamIds = findStreamIds(
    baseline.incomeStreams,
    options.workIncomeStreamIds,
    stream =>
      Boolean(stream.end) &&
      /salary|wage|employment|work|consult|business/i.test(
        `${stream.id} ${stream.name}`
      ),
    'work'
  )
  const downsize = downsizeVariants(
    baseline,
    options.downsizeEventId,
    options.allowMissingDownsize
  )
  const baselineCase: StressScenarioCase = {
    id: 'baseline',
    label: 'Baseline',
    description:
      'The supplied plan assumptions without a deterministic stress override.',
    scenario: baseline,
  }
  const downsizeCase: StressScenarioDefinition = downsize
    ? {
        id: 'downsize',
        label: 'Downsize committed vs. not used',
        description:
          'Compares a committed net housing-sale event with leaving that option unused.',
        scenario: downsize.committed.scenario,
        variants: downsize,
      }
    : {
        id: 'downsize',
        label: 'Downsize not configured',
        description:
          'Add a housing transaction to compare committed and unused proceeds.',
        scenario: baseline,
      }
  const scenarios: readonly StressScenarioDefinition[] = [
    baselineCase,
    withCase(
      'market-shock-20-first-retirement-year',
      '−20% portfolio shock',
      'Applies a −20% return to invested accounts in the first retirement year.',
      addReturnShock(
        baseline,
        'market-shock-20-first-retirement-year',
        startYear,
        -0.2
      )
    ),
    withCase(
      'market-shock-30-first-retirement-year',
      '−30% portfolio shock',
      'Applies a −30% return to invested accounts in the first retirement year.',
      addReturnShock(
        baseline,
        'market-shock-30-first-retirement-year',
        startYear,
        -0.3
      )
    ),
    withCase(
      'two-year-high-inflation',
      'Two-year high inflation',
      `Uses ${highInflationRate * 100}% inflation for the first two retirement years.`,
      addHighInflation(
        baseline,
        'two-year-high-inflation',
        startYear,
        highInflationRate
      )
    ),
    withCase(
      'healthcare-double-two-years',
      'Healthcare doubles for two years',
      'Doubles selected healthcare spending for the first two retirement years.',
      addHealthcareShock(
        baseline,
        'healthcare-double-two-years',
        healthcareStreamIds,
        startYear
      )
    ),
    withCase(
      'outside-income-half-three-years',
      'Outside income −50% for three years',
      'Halves selected consulting/business income for the first three retirement years.',
      addIncomeShock(
        baseline,
        'outside-income-half-three-years',
        outsideIncomeStreamIds,
        startYear
      )
    ),
    withCase(
      'combined-bad-start',
      'Combined bad start',
      'Combines a −25% market return, high inflation, and a 50% outside-income loss.',
      addIncomeShock(
        addHighInflation(
          addReturnShock(baseline, 'combined-bad-start', startYear, -0.25),
          'combined-bad-start',
          startYear,
          highInflationRate
        ),
        'combined-bad-start',
        outsideIncomeStreamIds,
        startYear
      )
    ),
    withCase(
      'work-exit-delay-one-year',
      'Work exit delayed one year',
      'Moves selected work-income end boundaries one year later.',
      addWorkExitDelay(
        baseline,
        'work-exit-delay-one-year',
        workIncomeStreamIds,
        1
      )
    ),
    withCase(
      'work-exit-delay-three-years',
      'Work exit delayed three years',
      'Moves selected work-income end boundaries three years later.',
      addWorkExitDelay(
        baseline,
        'work-exit-delay-three-years',
        workIncomeStreamIds,
        3
      )
    ),
    downsizeCase,
  ]
  return {
    scenarios,
    downsizeComparison: downsize ?? {
      committed: {
        id: 'downsize-committed',
        requirementId: 'downsize',
        label: 'Downsize committed',
        description: 'No committed housing transaction was supplied.',
        scenario: baseline,
      },
      notUsed: {
        id: 'downsize-not-used',
        requirementId: 'downsize',
        label: 'Downsize not used',
        description: 'No housing transaction was supplied.',
        scenario: baseline,
      },
    },
  }
}

export function materializeStressScenarios(
  suite: StressScenarioSuite
): readonly StressScenarioCase[] {
  return suite.scenarios.flatMap(definition =>
    'variants' in definition
      ? [definition.variants.committed, definition.variants.notUsed]
      : [definition]
  )
}

export function projectStressScenarioSuite(
  suite: StressScenarioSuite,
  mode: PlanProjectionMode = 'real'
): readonly ProjectedStressScenario[] {
  return materializeStressScenarios(suite).map(definition => ({
    ...definition,
    projection: projectScenario(definition.scenario, mode),
  }))
}
