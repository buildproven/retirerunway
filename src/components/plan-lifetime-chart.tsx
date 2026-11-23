'use client'

import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { buildLifetimeSeries, type PlanAnalysis } from '@/engine/plan'

function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

export function PlanLifetimeChart({ analysis }: { analysis: PlanAnalysis }) {
  const data = useMemo(() => buildLifetimeSeries(analysis), [analysis])
  const exitAge = analysis.scenario.profile.targetRetirementAge

  return (
    <div
      role="img"
      aria-label="Lifetime chart of accessible and restricted balances by age, in real dollars"
      className="h-72 w-full"
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0 }}>
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
          <Legend />
          <ReferenceLine
            x={exitAge}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            label={{
              value: 'Work exit',
              position: 'insideTopLeft',
              fontSize: 11,
            }}
          />
          <Area
            type="monotone"
            dataKey="accessible"
            name="Accessible"
            stackId="balance"
            stroke="var(--chart-1)"
            fill="var(--chart-1)"
            fillOpacity={0.5}
          />
          <Area
            type="monotone"
            dataKey="restricted"
            name="Restricted"
            stackId="balance"
            stroke="var(--chart-4)"
            fill="var(--chart-4)"
            fillOpacity={0.5}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
