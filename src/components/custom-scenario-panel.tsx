'use client'

import { useState } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Badge } from '@/components/ui/badge'
import { usePortfolioStore } from '@/store/portfolio-store'
import { useSavedScenariosStore } from '@/store/saved-scenarios-store'
import type { ScenarioParameters } from '@/engine/types'
import { getScenarioDefaults } from '@/services'

interface SliderConfig {
  key: keyof Pick<
    ScenarioParameters,
    | 'equityReturnRate'
    | 'bondReturnRate'
    | 'inflationRate'
    | 'durationYears'
    | 'drawdownPercent'
  >
  label: string
  min: number
  max: number
  step: number
  format: (v: number) => string
}

const SLIDERS: SliderConfig[] = [
  {
    key: 'equityReturnRate',
    label: 'Equity Return',
    min: -0.05,
    max: 0.15,
    step: 0.005,
    format: v => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'bondReturnRate',
    label: 'Bond Return',
    min: 0,
    max: 0.08,
    step: 0.005,
    format: v => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'inflationRate',
    label: 'Inflation',
    min: 0.01,
    max: 0.06,
    step: 0.005,
    format: v => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'durationYears',
    label: 'Projection Years',
    min: 10,
    max: 50,
    step: 1,
    format: v => `${v} yrs`,
  },
  {
    key: 'drawdownPercent',
    label: 'Early Drawdown',
    min: 0,
    max: 0.5,
    step: 0.05,
    format: v => `${(v * 100).toFixed(0)}%`,
  },
]

export function CustomScenarioPanel() {
  const customParams = usePortfolioStore(s => s.customScenarioParams)
  const setCustomParams = usePortfolioStore(s => s.setCustomScenarioParams)
  const savedScenarios = useSavedScenariosStore(s => s.scenarios)
  const saveScenario = useSavedScenariosStore(s => s.saveScenario)
  const deleteScenario = useSavedScenariosStore(s => s.deleteScenario)
  const [isOpen, setIsOpen] = useState(customParams !== null)
  const [saveName, setSaveName] = useState('')
  const [showSaved, setShowSaved] = useState(false)

  const defaults = getScenarioDefaults('custom')
  const params = customParams ?? defaults

  function handleChange(key: SliderConfig['key'], value: number) {
    setCustomParams({ ...params, [key]: value })
  }

  function handleReset() {
    setCustomParams({ ...defaults })
  }

  function handleRemove() {
    setCustomParams(null)
    setIsOpen(false)
  }

  function handleSave() {
    const name = saveName.trim()
    if (!name) return
    saveScenario(name, params)
    setSaveName('')
  }

  function handleLoad(savedParams: ScenarioParameters) {
    setCustomParams({ ...savedParams })
    setIsOpen(true)
    setShowSaved(false)
  }

  if (!isOpen) {
    return (
      <div className="space-y-2">
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            setCustomParams({ ...defaults })
            setIsOpen(true)
          }}
        >
          + Add Custom Scenario
        </Button>
        {savedScenarios.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setShowSaved(!showSaved)}
          >
            {showSaved ? 'Hide' : 'Load'} Saved Scenarios (
            {savedScenarios.length})
          </Button>
        )}
        {showSaved && (
          <SavedScenariosList
            scenarios={savedScenarios}
            onLoad={handleLoad}
            onDelete={deleteScenario}
          />
        )}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Custom Scenario
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleReset}>
              Reset
            </Button>
            <Button variant="ghost" size="sm" onClick={handleRemove}>
              Remove
            </Button>
          </div>
        </CardTitle>
        <CardDescription>
          Adjust parameters to model your own scenario
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {SLIDERS.map(slider => (
          <div key={slider.key} className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{slider.label}</span>
              <span className="font-mono font-medium">
                {slider.format(params[slider.key])}
              </span>
            </div>
            <Slider
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={[params[slider.key]]}
              onValueChange={([v]) => handleChange(slider.key, v)}
            />
          </div>
        ))}

        <div className="border-t pt-4">
          <div className="flex gap-2">
            <Input
              placeholder="Scenario name..."
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              className="text-sm"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSave}
              disabled={!saveName.trim()}
            >
              Save
            </Button>
          </div>
          {savedScenarios.length > 0 && (
            <div className="mt-3">
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setShowSaved(!showSaved)}
              >
                {showSaved ? 'Hide' : 'Load from'} Saved (
                {savedScenarios.length})
              </Button>
              {showSaved && (
                <SavedScenariosList
                  scenarios={savedScenarios}
                  onLoad={handleLoad}
                  onDelete={deleteScenario}
                />
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function SavedScenariosList({
  scenarios,
  onLoad,
  onDelete,
}: {
  scenarios: {
    id: string
    name: string
    params: ScenarioParameters
    createdAt: string
  }[]
  onLoad: (params: ScenarioParameters) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="mt-2 space-y-1">
      {scenarios.map(s => (
        <div
          key={s.id}
          className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
        >
          <button
            className="flex-1 text-left hover:underline"
            onClick={() => onLoad(s.params)}
          >
            {s.name}
          </button>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {(s.params.equityReturnRate * 100).toFixed(0)}% eq
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-6 px-1"
              onClick={() => onDelete(s.id)}
            >
              x
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
