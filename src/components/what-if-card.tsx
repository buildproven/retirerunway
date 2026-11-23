'use client'

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Portfolio, UserProfile, ScenarioResult } from '@/engine/types'
import { projectWithModifiedProfile } from '@/services'
import type { WhatIfOverrides } from '@/ai/what-if'
import type { Provider } from '@/ai/byok-adapter'

interface WhatIfCardProps {
  portfolio: Portfolio
  userProfile: UserProfile
  originalScenarios: ScenarioResult[]
  provider: Provider
  apiKey: string
}

interface WhatIfResult {
  question: string
  explanation: string
  overrides: WhatIfOverrides
  modifiedProfile: UserProfile
  scenarios: ScenarioResult[]
}

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

export function WhatIfCard({
  portfolio,
  userProfile,
  originalScenarios,
  provider,
  apiKey,
}: WhatIfCardProps) {
  const [question, setQuestion] = useState('')
  const [results, setResults] = useState<WhatIfResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAsk = useCallback(async () => {
    if (!question.trim() || !apiKey) return
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/what-if', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          currentProfile: userProfile,
          provider,
          apiKey,
        }),
      })

      if (!res.ok) {
        throw new Error('Failed to process question')
      }

      const data = await res.json()
      const modifiedProfile: UserProfile = { ...userProfile, ...data.overrides }
      const scenarios = projectWithModifiedProfile(
        portfolio,
        userProfile,
        data.overrides
      )

      setResults(prev => [
        ...prev,
        {
          question,
          explanation: data.explanation,
          overrides: data.overrides,
          modifiedProfile,
          scenarios,
        },
      ])
      setQuestion('')
    } catch {
      setError('Failed to process your question. Check your API key.')
    } finally {
      setIsLoading(false)
    }
  }, [question, apiKey, userProfile, provider, portfolio])

  if (!apiKey) return null

  const baseScenario = originalScenarios.find(s => s.scenarioType === 'base')

  return (
    <Card>
      <CardHeader>
        <CardTitle>What-If Explorer</CardTitle>
        <CardDescription>
          Ask questions like &ldquo;What if I retire at 57?&rdquo; or
          &ldquo;What if my expenses are $80K?&rdquo;
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="What if I retire at 57?"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAsk()}
            disabled={isLoading}
          />
          <Button onClick={handleAsk} disabled={isLoading || !question.trim()}>
            {isLoading ? 'Thinking...' : 'Ask'}
          </Button>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {results.map((r, i) => (
          <div key={i} className="rounded-md border p-4 space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">&ldquo;{r.question}&rdquo;</p>
              <p className="text-muted-foreground text-xs">{r.explanation}</p>
            </div>
            {baseScenario && (
              <ComparisonTable
                original={baseScenario}
                modified={r.scenarios.find(s => s.scenarioType === 'base')}
              />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function ComparisonTable({
  original,
  modified,
}: {
  original: ScenarioResult
  modified?: ScenarioResult
}) {
  if (!modified) return null
  if (original.projections.length === 0 || modified.projections.length === 0) {
    return null
  }

  const origFinal = original.projections[original.projections.length - 1]
  const modFinal = modified.projections[modified.projections.length - 1]

  const rows = [
    {
      label: 'Runway',
      orig: `${original.runwayYears} years`,
      mod: `${modified.runwayYears} years`,
      better: modified.runwayYears >= original.runwayYears,
    },
    {
      label: 'Depletion Age',
      orig: original.depletionAge ? `${original.depletionAge}` : 'Never',
      mod: modified.depletionAge ? `${modified.depletionAge}` : 'Never',
      better:
        modified.depletionAge == null ||
        (original.depletionAge != null &&
          modified.depletionAge > original.depletionAge),
    },
    {
      label: 'Final Balance',
      orig: formatCurrency(origFinal?.endBalance ?? 0),
      mod: formatCurrency(modFinal?.endBalance ?? 0),
      better: (modFinal?.endBalance ?? 0) >= (origFinal?.endBalance ?? 0),
    },
  ]

  return (
    <div className="text-sm">
      <div className="grid grid-cols-3 gap-2 text-xs font-medium text-muted-foreground">
        <span>Metric</span>
        <span>Original</span>
        <span>What-If</span>
      </div>
      {rows.map(row => (
        <div key={row.label} className="grid grid-cols-3 gap-2 py-1">
          <span className="text-muted-foreground">{row.label}</span>
          <span>{row.orig}</span>
          <span className="flex items-center gap-1">
            {row.mod}
            <Badge
              variant={row.better ? 'default' : 'destructive'}
              className="h-4 text-[10px]"
            >
              {row.better ? '+' : '-'}
            </Badge>
          </span>
        </div>
      ))}
    </div>
  )
}
