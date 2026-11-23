import { create } from 'zustand'

export type SubscriptionTier = 'free' | 'pro'

export interface TierLimits {
  maxScenarios: number
  monteCarloEnabled: boolean
  aiNarrationEnabled: boolean
  whatIfEnabled: boolean
  exportEnabled: boolean
  taxBracketModeling: boolean
  rothOptimizer: boolean
  alertsEnabled: boolean
  apiAccessEnabled: boolean
  spousePlanning: boolean
}

const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: {
    maxScenarios: 4,
    monteCarloEnabled: false,
    aiNarrationEnabled: false,
    whatIfEnabled: false,
    exportEnabled: false,
    taxBracketModeling: false,
    rothOptimizer: false,
    alertsEnabled: false,
    apiAccessEnabled: false,
    spousePlanning: false,
  },
  pro: {
    maxScenarios: Infinity,
    monteCarloEnabled: true,
    aiNarrationEnabled: true,
    whatIfEnabled: true,
    exportEnabled: true,
    taxBracketModeling: true,
    rothOptimizer: true,
    alertsEnabled: true,
    apiAccessEnabled: true,
    spousePlanning: true,
  },
}

interface SubscriptionState {
  tier: SubscriptionTier
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodEnd: string | null

  setTier: (tier: SubscriptionTier) => void
  setStripeIds: (customerId: string, subscriptionId: string) => void
  setCurrentPeriodEnd: (date: string | null) => void
  hydrate: (summary: {
    tier: SubscriptionTier
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
    currentPeriodEnd: string | null
  }) => void
  getLimits: () => TierLimits
  canAccess: (feature: keyof TierLimits) => boolean
  reset: () => void
}

export const useSubscriptionStore = create<SubscriptionState>((set, get) => ({
  tier: 'free',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodEnd: null,

  setTier: tier => set({ tier }),

  setStripeIds: (customerId, subscriptionId) =>
    set({ stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId }),

  setCurrentPeriodEnd: date => set({ currentPeriodEnd: date }),

  hydrate: ({
    tier,
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodEnd,
  }) => set({ tier, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd }),

  getLimits: () => TIER_LIMITS[get().tier],

  canAccess: feature => {
    const limits = TIER_LIMITS[get().tier]
    const value = limits[feature]
    if (typeof value === 'boolean') return value
    return true // numeric limits checked elsewhere
  },

  reset: () =>
    set({
      tier: 'free',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
    }),
}))

export function getTierLimits(tier: SubscriptionTier): TierLimits {
  return TIER_LIMITS[tier]
}
