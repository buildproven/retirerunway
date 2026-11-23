'use client'

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { PlanAnalysis } from '@/engine/plan'
import { PLAN_MONTE_CARLO_DEFAULTS } from '@/engine/plan/monte-carlo'
import { usePlanMonteCarloWorker } from '@/hooks/use-plan-monte-carlo-worker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

export function successLabel(rate: number): {
  text: string
  variant: 'default' | 'secondary' | 'destructive'
} {
  if (rate >= 0.85) return { text: 'Strong', variant: 'default' }
  if (rate >= 0.65) return { text: 'Moderate', variant: 'secondary' }
  return { text: 'Weak', variant: 'destructive' }
}

export function PlanMonteCarloCard({ analysis }: { analysis: PlanAnalysis }) {
  const { result, resultFor, isLoading, error, run } = usePlanMonteCarloWorker()
  const stale = result !== null && resultFor !== analysis.scenario
  const marginPoints = result
    ? Math.round(
        196 *
          Math.sqrt(
            (result.successRate * (1 - result.successRate)) /
              result.config.numPaths
          )
      )
    : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3">
          <span>Chance of success</span>
          {result && (
            <Badge variant={successLabel(result.successRate).variant}>
              {successLabel(result.successRate).text}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Replays your plan over {PLAN_MONTE_CARLO_DEFAULTS.numPaths} random
          market-return paths (seeded, so the result repeats). Success means no
          funding gap in any year. All invested balances move together as one
          diversified portfolio (12% yearly volatility); inflation stays at your
          assumption.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(!result || stale) && (
          <Button
            onClick={() => run(analysis.scenario)}
            disabled={isLoading}
            aria-busy={isLoading}
          >
            {isLoading
              ? 'Simulating…'
              : stale
                ? 'Plan changed: re-run simulation'
                : 'Run simulation'}
          </Button>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {result && !stale && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-muted-foreground text-xs">
                  Paths with no funding gap
                </p>
                <p className="text-2xl font-semibold">
                  {Math.round(result.successRate * 100)}%
                  <span className="text-muted-foreground ml-2 text-sm font-normal">
                    ±{marginPoints} pts
                  </span>
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">
                  Median balance at plan end (real)
                </p>
                <p className="text-2xl font-semibold">
                  {formatCompact(result.medianFinalBalance)}
                </p>
              </div>
            </div>
            <div
              role="img"
              aria-label="Median and 10th to 90th percentile total balance by age, in real dollars"
              className="h-64 w-full"
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={result.bands}
                  margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="age" tickLine={false} />
                  <YAxis tickFormatter={formatCompact} width={64} />
                  <Tooltip
                    formatter={(value, name) => [
                      formatCompact(Number(value ?? 0)),
                      String(name),
                    ]}
                    labelFormatter={age => `Age ${age}`}
                  />
                  <Line
                    dataKey="p90"
                    name="90th percentile"
                    stroke="var(--chart-2)"
                    dot={false}
                    strokeDasharray="4 4"
                  />
                  <Line
                    dataKey="p50"
                    name="Median"
                    stroke="var(--chart-1)"
                    dot={false}
                    strokeWidth={2}
                  />
                  <Line
                    dataKey="p10"
                    name="10th percentile"
                    stroke="var(--chart-4)"
                    dot={false}
                    strokeDasharray="4 4"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
