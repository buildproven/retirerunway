import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScenarioParameters } from '@/engine/types'

interface SavedScenario {
  id: string
  name: string
  params: ScenarioParameters
  createdAt: string
}

interface SavedScenariosState {
  scenarios: SavedScenario[]
  saveScenario: (name: string, params: ScenarioParameters) => void
  deleteScenario: (id: string) => void
  renameScenario: (id: string, name: string) => void
}

export const useSavedScenariosStore = create<SavedScenariosState>()(
  persist(
    set => ({
      scenarios: [],

      saveScenario: (name, params) =>
        set(state => ({
          scenarios: [
            ...state.scenarios,
            {
              id: crypto.randomUUID(),
              name,
              params: { ...params },
              createdAt: new Date().toISOString(),
            },
          ],
        })),

      deleteScenario: id =>
        set(state => ({
          scenarios: state.scenarios.filter(s => s.id !== id),
        })),

      renameScenario: (id, name) =>
        set(state => ({
          scenarios: state.scenarios.map(s =>
            s.id === id ? { ...s, name } : s
          ),
        })),
    }),
    { name: 'retire-runway-saved-scenarios' }
  )
)
