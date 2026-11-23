// What moved the number (REQ-MCP-58): two saved snapshots run through the
// v2 projection on the same profile and seed. The difference is the
// portfolio's effect (markets, trades and savings between the dates); with
// the success rate recorded last time, the rest is everything else (profile
// edits, assumptions, model updates). Holdings are compared by ticker.
// Deterministic. No AI.
import {
  calculateEquityFraction,
  calculatePortfolioValue,
} from './portfolio-math'
import { projectRetirement } from './retirement-projection'
import type { Portfolio, UserProfile } from './types'

export interface SnapshotSide {
  readonly snapshotDate: string
  readonly totalValue: number
  readonly equityShare: number
  readonly successRate: number
}

export interface HoldingChange {
  readonly symbol: string
  readonly from: number
  readonly to: number
  readonly change: number
}

export interface ChangeExplanation {
  readonly from: SnapshotSide
  readonly to: SnapshotSide
  readonly valueChange: number
  readonly equityShareChange: number
  /** Success-rate points from the portfolio alone (same profile and seed). */
  readonly portfolioEffect: number
  /** With a recorded earlier success rate: the total change and the part not from the portfolio. */
  readonly recorded: {
    readonly previousSuccessRate: number
    readonly totalChange: number
    readonly otherEffect: number
  } | null
  /** The five holdings that moved most in dollars, largest first. */
  readonly biggestMoves: readonly HoldingChange[]
  readonly headline: string
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000
const points = (value: number) =>
  `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)} pts`

function bySymbol(portfolio: Portfolio): Map<string, number> {
  const totals = new Map<string, number>()
  for (const account of portfolio.accounts) {
    if (account.cashBalance !== 0) {
      totals.set('CASH', (totals.get('CASH') ?? 0) + account.cashBalance)
    }
    for (const holding of account.holdings) {
      const symbol = holding.symbol.toUpperCase()
      totals.set(symbol, (totals.get(symbol) ?? 0) + holding.currentValue)
    }
    for (const cd of account.cds) {
      totals.set('CDS', (totals.get('CDS') ?? 0) + cd.principal)
    }
  }
  return totals
}

function side(
  portfolio: Portfolio,
  profile: UserProfile,
  seed: number | undefined
): SnapshotSide {
  const totalValue = calculatePortfolioValue(portfolio)
  return {
    snapshotDate: portfolio.asOfDate,
    totalValue: Math.round(totalValue * 100) / 100,
    equityShare: round4(calculateEquityFraction(portfolio, totalValue)),
    successRate: projectRetirement(
      portfolio,
      profile,
      seed === undefined ? {} : { seed }
    ).monteCarlo.successRate,
  }
}

export function explainChange(
  previous: Portfolio,
  current: Portfolio,
  profile: UserProfile,
  options: {
    readonly seed?: number
    readonly previousSuccessRate?: number
  } = {}
): ChangeExplanation {
  const from = side(previous, profile, options.seed)
  const to = side(current, profile, options.seed)
  const portfolioEffect = round4(to.successRate - from.successRate)
  const recorded =
    options.previousSuccessRate === undefined
      ? null
      : {
          previousSuccessRate: options.previousSuccessRate,
          totalChange: round4(to.successRate - options.previousSuccessRate),
          otherEffect: round4(
            to.successRate - options.previousSuccessRate - portfolioEffect
          ),
        }
  const before = bySymbol(previous)
  const after = bySymbol(current)
  const symbols = [...new Set([...before.keys(), ...after.keys()])]
  const biggestMoves = symbols
    .map(symbol => {
      const a = before.get(symbol) ?? 0
      const b = after.get(symbol) ?? 0
      return {
        symbol,
        from: Math.round(a),
        to: Math.round(b),
        change: Math.round(b - a),
      }
    })
    .filter(move => move.change !== 0)
    .sort(
      (x, y) =>
        Math.abs(y.change) - Math.abs(x.change) ||
        x.symbol.localeCompare(y.symbol)
    )
    .slice(0, 5)
  const valueChange = Math.round((to.totalValue - from.totalValue) * 100) / 100
  const headline =
    `Success ${(to.successRate * 100).toFixed(1)}% on ${to.snapshotDate} vs ${(from.successRate * 100).toFixed(1)}% on ${from.snapshotDate}: portfolio ${points(portfolioEffect)}` +
    (recorded === null
      ? ''
      : `, everything else ${points(recorded.otherEffect)} since the recorded ${(recorded.previousSuccessRate * 100).toFixed(1)}%`)
  return {
    from,
    to,
    valueChange,
    equityShareChange: round4(to.equityShare - from.equityShare),
    portfolioEffect,
    recorded,
    biggestMoves,
    headline,
  }
}
