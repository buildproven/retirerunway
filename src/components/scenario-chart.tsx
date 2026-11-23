'use client'

import { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import type { ScenarioResult } from '@/engine/types'

interface ScenarioChartProps {
  scenarios: ScenarioResult[]
  retirementAge: number
}

const SCENARIO_COLORS: Record<string, string> = {
  bull: 'var(--chart-2)',
  base: 'var(--chart-1)',
  early_bear: 'var(--chart-4)',
  prolonged_bear: 'var(--chart-5)',
  custom: 'var(--chart-3)',
}

const SCENARIO_LABELS: Record<string, string> = {
  bull: 'Bull',
  base: 'Base',
  early_bear: 'Early Bear',
  prolonged_bear: 'Prolonged Bear',
  custom: 'Custom',
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

export function ScenarioChart({
  scenarios,
  retirementAge,
}: ScenarioChartProps) {
  const chartData = useMemo(() => {
    if (scenarios.length === 0) return []

    const maxYears = Math.max(...scenarios.map(s => s.projections.length))
    const data: Record<string, number | string>[] = []

    for (let i = 0; i < maxYears; i++) {
      const row: Record<string, number | string> = {}
      const firstScenario = scenarios[0]
      if (firstScenario.projections[i]) {
        row.age = firstScenario.projections[i].age
        row.year = firstScenario.projections[i].year
      }
      for (const s of scenarios) {
        if (s.projections[i]) {
          row[s.scenarioType] = Math.round(s.projections[i].endBalance)
        }
      }
      if (row.age !== undefined) {
        data.push(row)
      }
    }
    return data
  }, [scenarios])

  if (chartData.length === 0) return null

  return (
    <div className="h-[350px] w-full">
      <ResponsiveContainer width="100%" height={350} minWidth={1}>
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
        >
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis
            dataKey="age"
            label={{ value: 'Age', position: 'insideBottom', offset: -2 }}
            tick={{ fontSize: 12 }}
          />
          <YAxis
            tickFormatter={formatCompact}
            tick={{ fontSize: 12 }}
            width={60}
          />
          <Tooltip
            formatter={(value?: number, name?: string) => [
              formatCompact(value ?? 0),
              SCENARIO_LABELS[name ?? ''] ?? name ?? '',
            ]}
            labelFormatter={label => `Age ${label}`}
          />
          <Legend
            formatter={(value: string) => SCENARIO_LABELS[value] ?? value}
          />
          <ReferenceLine
            x={retirementAge}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            label={{ value: 'Retire', position: 'top', fontSize: 11 }}
          />
          {scenarios.map(s => (
            <Line
              key={s.scenarioType}
              type="monotone"
              dataKey={s.scenarioType}
              stroke={SCENARIO_COLORS[s.scenarioType]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

interface WithdrawalChartProps {
  scenarios: ScenarioResult[]
  retirementAge: number
}

export function WithdrawalChart({
  scenarios,
  retirementAge,
}: WithdrawalChartProps) {
  const chartData = useMemo(() => {
    if (scenarios.length === 0) return []

    const baseScenario =
      scenarios.find(s => s.scenarioType === 'base') ?? scenarios[0]

    return baseScenario.projections
      .filter(p => p.age >= retirementAge)
      .map(p => ({
        age: p.age,
        withdrawal: Math.round(p.withdrawal),
        inflationAdjusted: Math.round(p.inflationAdjustedWithdrawal),
      }))
  }, [scenarios, retirementAge])

  if (chartData.length === 0) return null

  return (
    <div className="h-[250px] w-full">
      <ResponsiveContainer width="100%" height={250} minWidth={1}>
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
        >
          <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
          <XAxis
            dataKey="age"
            label={{ value: 'Age', position: 'insideBottom', offset: -2 }}
            tick={{ fontSize: 12 }}
          />
          <YAxis
            tickFormatter={formatCompact}
            tick={{ fontSize: 12 }}
            width={60}
          />
          <Tooltip
            formatter={(value?: number, name?: string) => [
              formatCompact(value ?? 0),
              name === 'withdrawal'
                ? 'Actual Withdrawal'
                : 'Inflation-Adjusted',
            ]}
            labelFormatter={label => `Age ${label}`}
          />
          <Legend
            formatter={(value: string) =>
              value === 'withdrawal'
                ? 'Actual Withdrawal'
                : 'Inflation-Adjusted Target'
            }
          />
          <Line
            type="monotone"
            dataKey="withdrawal"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="inflationAdjusted"
            stroke="var(--chart-3)"
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
