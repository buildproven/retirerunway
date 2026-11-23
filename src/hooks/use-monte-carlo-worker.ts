import { useState, useEffect, useCallback, useRef } from 'react'
import type { Portfolio, UserProfile } from '@/engine/types'
import type {
  MonteCarloConfig,
  MonteCarloResult,
  WorkerMessage,
  WorkerResponse,
} from '@/engine/monte-carlo.worker'

interface UseMonteCarloWorkerResult {
  result: MonteCarloResult | null
  isLoading: boolean
  error: string | null
  runSimulation: (
    portfolio: Portfolio,
    profile: UserProfile,
    overrides?: Partial<MonteCarloConfig>
  ) => void
}

export function useMonteCarloWorker(): UseMonteCarloWorkerResult {
  const [result, setResult] = useState<MonteCarloResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../engine/monte-carlo.worker.ts', import.meta.url)
    )

    workerRef.current.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const { type, result: workerResult, error: workerError } = event.data
      setIsLoading(false)

      if (type === 'result' && workerResult) {
        setResult(workerResult)
        setError(null)
      } else if (type === 'error') {
        setError(workerError ?? 'Unknown error')
        setResult(null)
      }
    }

    workerRef.current.onerror = event => {
      setIsLoading(false)
      setError(event.message ?? 'Worker error')
      setResult(null)
    }

    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const runSimulation = useCallback(
    (
      portfolio: Portfolio,
      profile: UserProfile,
      overrides?: Partial<MonteCarloConfig>
    ) => {
      if (!workerRef.current) {
        setError('Worker not initialized')
        return
      }

      setIsLoading(true)
      setError(null)

      const message: WorkerMessage = {
        type: 'run',
        portfolio,
        profile,
        overrides,
      }

      workerRef.current.postMessage(message)
    },
    []
  )

  return { result, isLoading, error, runSimulation }
}
