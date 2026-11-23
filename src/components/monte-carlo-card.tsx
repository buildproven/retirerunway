'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { MonteCarloResult } from '@/engine/monte-carlo'

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

interface MonteCarloCardProps {
  result: MonteCarloResult | null
  retirementAge: number
  isLoading?: boolean
  error?: string | null
}

export function MonteCarloCard({
  result,
  retirementAge,
  isLoading = false,
  error = null,
}: MonteCarloCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Monte Carlo Simulation
            <Badge variant="secondary">Running...</Badge>
          </CardTitle>
          <CardDescription>
            Simulating thousands of market scenarios...
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[320px] w-full" />
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Monte Carlo Simulation
            <Badge variant="destructive">Error</Badge>
          </CardTitle>
          <CardDescription>Failed to run simulation</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-destructive text-sm">{error}</p>
        </CardContent>
      </Card>
    )
  }

  if (!result) {
    return null
  }
  const successPct = Math.round(result.successRate * 100)
  const badgeVariant =
    successPct >= 80
      ? 'default'
      : successPct >= 50
        ? 'secondary'
        : 'destructive'

  const chartData = result.percentiles.map(p => ({
    age: p.age,
    p10: p.p10,
    p25: p.p25,
    p50: p.p50,
    p75: p.p75,
    p90: p.p90,
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Monte Carlo Simulation
          <Badge variant={badgeVariant}>{successPct}% success</Badge>
        </CardTitle>
        <CardDescription>
          {result.paths.toLocaleString()} random paths · Median runway:{' '}
          {result.medianRunwayYears} years
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={320} minWidth={1}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis
              dataKey="age"
              tick={{ fontSize: 12 }}
              label={{ value: 'Age', position: 'insideBottom', offset: -5 }}
            />
            <YAxis
              tickFormatter={formatCompact}
              tick={{ fontSize: 12 }}
              width={70}
            />
            <Tooltip
              formatter={(value?: number | string) =>
                value != null ? formatCompact(Number(value)) : ''
              }
              labelFormatter={label => `Age ${label}`}
            />
            <ReferenceLine
              x={retirementAge}
              stroke="var(--chart-3)"
              strokeDasharray="4 4"
              label={{ value: 'Retire', position: 'top', fontSize: 11 }}
            />
            <Area
              type="monotone"
              dataKey="p90"
              stackId="band"
              stroke="none"
              fill="var(--chart-2)"
              fillOpacity={0.15}
              name="90th %ile"
            />
            <Area
              type="monotone"
              dataKey="p75"
              stackId="band2"
              stroke="none"
              fill="var(--chart-2)"
              fillOpacity={0.2}
              name="75th %ile"
            />
            <Area
              type="monotone"
              dataKey="p50"
              stackId="band3"
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="var(--chart-1)"
              fillOpacity={0.15}
              name="Median"
            />
            <Area
              type="monotone"
              dataKey="p25"
              stackId="band4"
              stroke="none"
              fill="var(--chart-4)"
              fillOpacity={0.2}
              name="25th %ile"
            />
            <Area
              type="monotone"
              dataKey="p10"
              stackId="band5"
              stroke="none"
              fill="var(--chart-5)"
              fillOpacity={0.15}
              name="10th %ile"
            />
          </AreaChart>
        </ResponsiveContainer>
        <div className="mt-4 grid grid-cols-3 gap-4 text-center text-sm">
          <div>
            <p className="text-muted-foreground">Pessimistic (10th)</p>
            <p className="font-semibold">
              {formatCompact(
                result.percentiles[result.percentiles.length - 1]?.p10 ?? 0
              )}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Median (50th)</p>
            <p className="font-semibold">
              {formatCompact(
                result.percentiles[result.percentiles.length - 1]?.p50 ?? 0
              )}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Optimistic (90th)</p>
            <p className="font-semibold">
              {formatCompact(
                result.percentiles[result.percentiles.length - 1]?.p90 ?? 0
              )}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
