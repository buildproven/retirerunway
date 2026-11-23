// ---------------------------------------------------------------------------
// Monte Carlo Web Worker
// Runs simulation in background thread to prevent UI blocking.
//
// This file is a THIN TRANSPORT WRAPPER. It must not contain simulation logic.
// The simulation lives in `monte-carlo.ts` and is imported below.
//
// Why: this worker previously hand-copied the simulation, and the copy drifted.
// It raised a single year's inflation draw to a power instead of compounding a
// running product, and started withdrawals a year late, violating both
// invariants documented in CLAUDE.md. The tests covered monte-carlo.ts while the
// UI rendered the worker, so the two disagreed silently. Keeping the logic in
// one place is what prevents that recurring; see the parity test in
// __tests__/monte-carlo-worker-parity.test.ts.
// ---------------------------------------------------------------------------

import type { Portfolio, UserProfile } from './types'
import { runMonteCarlo } from './monte-carlo'

// Re-exported so consumers (e.g. use-monte-carlo-worker) can import worker
// message types and the result shape from one place.
export type {
  MonteCarloConfig,
  MonteCarloResult,
  PercentileBand,
} from './monte-carlo'

import type { MonteCarloConfig } from './monte-carlo'

export interface WorkerMessage {
  type: 'run'
  portfolio: Portfolio
  profile: UserProfile
  overrides?: Partial<MonteCarloConfig>
}

export interface WorkerResponse {
  type: 'result' | 'error'
  result?: import('./monte-carlo').MonteCarloResult
  error?: string
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const { type, portfolio, profile, overrides } = event.data

  if (type === 'run') {
    try {
      const result = runMonteCarlo(portfolio, profile, overrides)
      const response: WorkerResponse = { type: 'result', result }
      self.postMessage(response)
    } catch (err) {
      const response: WorkerResponse = {
        type: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      }
      self.postMessage(response)
    }
  }
}
