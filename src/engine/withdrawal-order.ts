// ---------------------------------------------------------------------------
// RetireRunway – which accounts to spend from first (REQ-MCP-70)
//
// Runs projectRetirement once per withdrawal order (taxable first, pre-tax
// first, proportional, and taxable first while Roth conversions fill the 12%
// bracket) on the same portfolio, profile and seed, and lines up the success
// rate, median balance at the planning age, lifetime tax, IRMAA and ACA
// credit. The best order is the highest success rate, then the larger
// median balance, then the lower tax plus IRMAA. No AI.
// ---------------------------------------------------------------------------

import { projectRetirement } from './retirement-projection'
import type {
  ChartSpec,
  ProjectionOptions,
  RothConversionStrategy,
} from './retirement-projection'
import type { Portfolio, UserProfile, WithdrawalOrder } from './types'

export interface NamedOrder {
  readonly name: string
  readonly order: WithdrawalOrder
  readonly rothConversion: RothConversionStrategy
}

export const DEFAULT_WITHDRAWAL_ORDERS: readonly NamedOrder[] = [
  {
    name: 'Taxable first',
    order: 'taxableFirst',
    rothConversion: { kind: 'none' },
  },
  {
    name: 'Pre-tax first',
    order: 'preTaxFirst',
    rothConversion: { kind: 'none' },
  },
  {
    name: 'Proportional',
    order: 'proportional',
    rothConversion: { kind: 'none' },
  },
  {
    name: 'Taxable first, fill the 12% bracket with Roth conversions',
    order: 'taxableFirst',
    rothConversion: { kind: 'fillBracket', rate: 0.12 },
  },
]

export interface WithdrawalOrderResult {
  readonly name: string
  readonly order: WithdrawalOrder
  readonly rothConversion: RothConversionStrategy
  readonly successRate: number
  readonly medianBalanceAtPlanningAge: number
  readonly lifetimeTax: number
  readonly lifetimeIrmaa: number
  readonly lifetimeAcaCredit: number
  readonly lifetimeRothConversion: number
  /** Against the owner's current order (profile.withdrawalOrder, no conversions). */
  readonly vsCurrent: {
    readonly successRate: number
    readonly medianBalanceAtPlanningAge: number
    readonly taxPlusIrmaa: number
  }
}

export interface WithdrawalOrderExploration {
  readonly current: WithdrawalOrder
  readonly orders: readonly WithdrawalOrderResult[]
  readonly best: string
  /** One line: the best order and what it changes against the current one. */
  readonly headline: string
  readonly charts: {
    readonly successRates: ChartSpec
    readonly lifetimeCosts: ChartSpec
  }
}

const pct = (rate: number): string => `${Math.round(rate * 1000) / 10}%`
const usd = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`

export function exploreWithdrawalOrders(
  portfolio: Portfolio,
  profile: UserProfile,
  orders: readonly NamedOrder[] = DEFAULT_WITHDRAWAL_ORDERS,
  options: Pick<ProjectionOptions, 'seed' | 'paths'> = {}
): WithdrawalOrderExploration {
  const current = profile.withdrawalOrder ?? 'taxableFirst'
  const run = (
    order: WithdrawalOrder,
    rothConversion: RothConversionStrategy
  ) =>
    projectRetirement(portfolio, profile, {
      ...options,
      withdrawalOrder: order,
      rothConversion,
    })
  const summary = (p: ReturnType<typeof run>) => ({
    successRate: p.monteCarlo.successRate,
    medianBalanceAtPlanningAge: p.monteCarlo.percentiles.at(-1)?.p50 ?? 0,
    lifetimeTax: p.expectedPath.lifetimeTax,
    lifetimeIrmaa: p.expectedPath.lifetimeIrmaa,
    lifetimeAcaCredit: p.expectedPath.lifetimeAcaCredit,
    lifetimeRothConversion: p.expectedPath.lifetimeRothConversion,
  })
  const base = summary(run(current, { kind: 'none' }))
  const results: WithdrawalOrderResult[] = orders.map(o => {
    const s = summary(run(o.order, o.rothConversion))
    return {
      name: o.name,
      order: o.order,
      rothConversion: o.rothConversion,
      ...s,
      vsCurrent: {
        successRate: s.successRate - base.successRate,
        medianBalanceAtPlanningAge:
          s.medianBalanceAtPlanningAge - base.medianBalanceAtPlanningAge,
        taxPlusIrmaa:
          s.lifetimeTax +
          s.lifetimeIrmaa -
          (base.lifetimeTax + base.lifetimeIrmaa),
      },
    }
  })
  const ranked = [...results].sort(
    (a, b) =>
      b.successRate - a.successRate ||
      b.medianBalanceAtPlanningAge - a.medianBalanceAtPlanningAge ||
      a.lifetimeTax + a.lifetimeIrmaa - (b.lifetimeTax + b.lifetimeIrmaa)
  )
  const best = ranked[0]
  const headline =
    best === undefined
      ? 'No orders to compare.'
      : best.order === current && best.rothConversion.kind === 'none'
        ? `Keep ${best.name.toLowerCase()}: no order tested does better (${pct(best.successRate)}).`
        : `${best.name}: ${pct(best.successRate)} vs ${pct(base.successRate)} now, median at the planning age ${usd(best.vsCurrent.medianBalanceAtPlanningAge)} and lifetime tax plus IRMAA ${usd(best.vsCurrent.taxPlusIrmaa)} against your current order.`
  const names = results.map(r => r.name)
  return {
    current,
    orders: results,
    best: best?.name ?? '',
    headline,
    charts: {
      successRates: {
        title: 'Chance the money lasts, by withdrawal order',
        style: 'bar',
        xLabel: 'Order',
        yLabel: 'Success rate (%)',
        x: names,
        series: [
          {
            name: 'Success rate (%)',
            values: results.map(r => Math.round(r.successRate * 1000) / 10),
          },
        ],
      },
      lifetimeCosts: {
        title: 'Lifetime tax and Medicare IRMAA (today’s dollars)',
        style: 'bar',
        xLabel: 'Order',
        yLabel: 'Today’s dollars',
        x: names,
        series: [
          { name: 'Tax', values: results.map(r => r.lifetimeTax) },
          { name: 'IRMAA', values: results.map(r => r.lifetimeIrmaa) },
        ],
      },
    },
  }
}
