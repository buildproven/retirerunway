// Thin transport wrapper: the simulation lives in `monte-carlo.ts` so the
// worker and the tested engine cannot drift (see engine/monte-carlo.worker.ts).
import { runPlanMonteCarlo } from './monte-carlo'
import type { PlanMonteCarloConfig, PlanMonteCarloResult } from './monte-carlo'
import type { Scenario } from './types'

export type { PlanMonteCarloConfig, PlanMonteCarloResult } from './monte-carlo'

export interface PlanWorkerMessage {
  type: 'run'
  scenario: Scenario
  overrides?: Partial<PlanMonteCarloConfig>
}

export interface PlanWorkerResponse {
  type: 'result' | 'error'
  result?: PlanMonteCarloResult
  error?: string
}

self.onmessage = (event: MessageEvent<PlanWorkerMessage>) => {
  const { type, scenario, overrides } = event.data
  if (type !== 'run') return
  try {
    const response: PlanWorkerResponse = {
      type: 'result',
      result: runPlanMonteCarlo(scenario, overrides),
    }
    self.postMessage(response)
  } catch (err) {
    const response: PlanWorkerResponse = {
      type: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    }
    self.postMessage(response)
  }
}
