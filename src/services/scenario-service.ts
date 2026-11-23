import type {
  Portfolio,
  UserProfile,
  ScenarioResult,
  ScenarioType,
  ScenarioParameters,
} from '@/engine/types'
import {
  runAllScenarios,
  runCustomScenario,
  getDefaultScenarioParameters,
} from '@/engine/scenarios'

export interface ScenarioAnalysis {
  scenarios: ScenarioResult[]
  baseCase: ScenarioResult | undefined
  worstCase: ScenarioResult | undefined
  bestCase: ScenarioResult | undefined
}

export function projectAllScenarios(
  portfolio: Portfolio,
  profile: UserProfile,
  customParams?: ScenarioParameters | null
): ScenarioAnalysis {
  const scenarios = runAllScenarios(portfolio, profile)

  if (customParams) {
    scenarios.push(runCustomScenario(portfolio, profile, customParams))
  }

  const baseCase = scenarios.find(s => s.scenarioType === 'base')
  const worstCase = scenarios.find(s => s.scenarioType === 'prolonged_bear')
  const bestCase = scenarios.find(s => s.scenarioType === 'bull')

  return {
    scenarios,
    baseCase,
    worstCase,
    bestCase,
  }
}

export function projectWithModifiedProfile(
  portfolio: Portfolio,
  originalProfile: UserProfile,
  profileOverrides: Partial<UserProfile>
): ScenarioResult[] {
  const modifiedProfile = { ...originalProfile, ...profileOverrides }
  return runAllScenarios(portfolio, modifiedProfile)
}

export function getScenarioDefaults(type: ScenarioType): ScenarioParameters {
  return getDefaultScenarioParameters(type)
}
