import { create } from 'zustand'
import type {
  Portfolio,
  Account,
  Holding,
  CD,
  UserProfile,
  ScenarioResult,
  ScenarioParameters,
} from '@/engine/types'

interface PortfolioState {
  portfolio: Portfolio | null
  userProfile: UserProfile | null
  scenarioResults: ScenarioResult[]
  customScenarioParams: ScenarioParameters | null

  setPortfolio: (portfolio: Portfolio) => void
  clearPortfolio: () => void
  setUserProfile: (profile: UserProfile) => void
  setScenarioResults: (results: ScenarioResult[]) => void
  setCustomScenarioParams: (params: ScenarioParameters | null) => void

  addAccount: (account: Account) => void
  removeAccount: (accountId: string) => void
  addHolding: (accountId: string, holding: Holding) => void
  updateHolding: (accountId: string, holding: Holding) => void
  addCD: (accountId: string, cd: CD) => void
  removeCD: (accountId: string, cdId: string) => void
}

export const usePortfolioStore = create<PortfolioState>(set => ({
  portfolio: null,
  userProfile: null,
  scenarioResults: [],
  customScenarioParams: null,

  setPortfolio: portfolio => set({ portfolio, scenarioResults: [] }),

  clearPortfolio: () =>
    set({ portfolio: null, scenarioResults: [], customScenarioParams: null }),

  setUserProfile: profile => set({ userProfile: profile }),

  setScenarioResults: results => set({ scenarioResults: results }),

  setCustomScenarioParams: params => set({ customScenarioParams: params }),

  addAccount: account =>
    set(state => {
      if (!state.portfolio) return state
      return {
        portfolio: {
          ...state.portfolio,
          accounts: [...state.portfolio.accounts, account],
        },
        scenarioResults: [],
      }
    }),

  removeAccount: accountId =>
    set(state => {
      if (!state.portfolio) return state
      return {
        portfolio: {
          ...state.portfolio,
          accounts: state.portfolio.accounts.filter(a => a.id !== accountId),
        },
        scenarioResults: [],
      }
    }),

  addHolding: (accountId, holding) =>
    set(state => {
      if (!state.portfolio) return state
      return {
        portfolio: {
          ...state.portfolio,
          accounts: state.portfolio.accounts.map(a =>
            a.id === accountId
              ? { ...a, holdings: [...a.holdings, holding] }
              : a
          ),
        },
        scenarioResults: [],
      }
    }),

  updateHolding: (accountId, holding) =>
    set(state => {
      if (!state.portfolio) return state
      return {
        portfolio: {
          ...state.portfolio,
          accounts: state.portfolio.accounts.map(a =>
            a.id === accountId
              ? {
                  ...a,
                  holdings: a.holdings.map(h =>
                    h.id === holding.id ? holding : h
                  ),
                }
              : a
          ),
        },
        scenarioResults: [],
      }
    }),

  addCD: (accountId, cd) =>
    set(state => {
      if (!state.portfolio) return state
      return {
        portfolio: {
          ...state.portfolio,
          accounts: state.portfolio.accounts.map(a =>
            a.id === accountId ? { ...a, cds: [...a.cds, cd] } : a
          ),
        },
        scenarioResults: [],
      }
    }),

  removeCD: (accountId, cdId) =>
    set(state => {
      if (!state.portfolio) return state
      return {
        portfolio: {
          ...state.portfolio,
          accounts: state.portfolio.accounts.map(a =>
            a.id === accountId
              ? { ...a, cds: a.cds.filter(c => c.id !== cdId) }
              : a
          ),
        },
        scenarioResults: [],
      }
    }),
}))
