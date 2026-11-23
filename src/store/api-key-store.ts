import { create } from 'zustand'
import type { Provider } from '@/ai/byok-adapter'

interface ApiKeyState {
  provider: Provider
  apiKey: string
  setProvider: (provider: Provider) => void
  setApiKey: (key: string) => void
}

export const useApiKeyStore = create<ApiKeyState>(set => ({
  provider: 'anthropic',
  apiKey: '',
  setProvider: provider => set({ provider }),
  setApiKey: apiKey => set({ apiKey }),
}))
