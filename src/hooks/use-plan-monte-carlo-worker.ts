import { useCallback, useEffect, useRef, useState } from 'react'
import type { Scenario } from '@/engine/plan'
import type {
  PlanMonteCarloConfig,
  PlanMonteCarloResult,
  PlanWorkerMessage,
  PlanWorkerResponse,
} from '@/engine/plan/monte-carlo.worker'

interface UsePlanMonteCarloWorkerResult {
  result: PlanMonteCarloResult | null
  /** The scenario the current result was computed for. */
  resultFor: Scenario | null
  isLoading: boolean
  error: string | null
  run: (scenario: Scenario, overrides?: Partial<PlanMonteCarloConfig>) => void
}

export function usePlanMonteCarloWorker(): UsePlanMonteCarloWorkerResult {
  const [result, setResult] = useState<PlanMonteCarloResult | null>(null)
  const [resultFor, setResultFor] = useState<Scenario | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)

  const stopWorker = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  useEffect(() => stopWorker, [stopWorker])

  const run = useCallback(
    (scenario: Scenario, overrides?: Partial<PlanMonteCarloConfig>) => {
      if (typeof Worker === 'undefined') {
        setError('This browser cannot run background simulations.')
        return
      }
      stopWorker()
      setResult(null)
      setResultFor(null)
      setError(null)
      setIsLoading(true)
      try {
        const worker = new Worker(
          new URL('../engine/plan/monte-carlo.worker.ts', import.meta.url)
        )
        workerRef.current = worker
        worker.onmessage = (event: MessageEvent<PlanWorkerResponse>) => {
          setIsLoading(false)
          if (event.data.type === 'result' && event.data.result) {
            setResult(event.data.result)
            setResultFor(scenario)
          } else {
            setError(event.data.error ?? 'Simulation failed')
          }
          stopWorker()
        }
        worker.onerror = event => {
          setIsLoading(false)
          setError(event.message || 'Simulation failed')
          stopWorker()
        }
        const message: PlanWorkerMessage = { type: 'run', scenario, overrides }
        worker.postMessage(message)
      } catch (err) {
        setIsLoading(false)
        setError(err instanceof Error ? err.message : 'Simulation failed')
        stopWorker()
      }
    },
    [stopWorker]
  )

  return { result, resultFor, isLoading, error, run }
}
