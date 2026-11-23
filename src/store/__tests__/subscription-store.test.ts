import { describe, it, expect, beforeEach } from 'vitest'
import { useSubscriptionStore, getTierLimits } from '../subscription-store'

describe('useSubscriptionStore', () => {
  beforeEach(() => {
    useSubscriptionStore.getState().reset()
  })

  it('starts with free tier', () => {
    const state = useSubscriptionStore.getState()
    expect(state.tier).toBe('free')
    expect(state.stripeCustomerId).toBeNull()
    expect(state.stripeSubscriptionId).toBeNull()
    expect(state.currentPeriodEnd).toBeNull()
  })

  it('sets tier to pro', () => {
    useSubscriptionStore.getState().setTier('pro')
    expect(useSubscriptionStore.getState().tier).toBe('pro')
  })

  it('sets Stripe IDs', () => {
    useSubscriptionStore.getState().setStripeIds('cus_123', 'sub_456')
    const state = useSubscriptionStore.getState()
    expect(state.stripeCustomerId).toBe('cus_123')
    expect(state.stripeSubscriptionId).toBe('sub_456')
  })

  it('sets current period end', () => {
    useSubscriptionStore.getState().setCurrentPeriodEnd('2026-12-31')
    expect(useSubscriptionStore.getState().currentPeriodEnd).toBe('2026-12-31')
  })

  it('hydrates only the server-provided subscription summary', () => {
    useSubscriptionStore.getState().hydrate({
      tier: 'pro',
      stripeCustomerId: 'cus_server',
      stripeSubscriptionId: 'sub_server',
      currentPeriodEnd: '2026-12-31',
    })
    expect(useSubscriptionStore.getState()).toMatchObject({
      tier: 'pro',
      stripeCustomerId: 'cus_server',
      stripeSubscriptionId: 'sub_server',
      currentPeriodEnd: '2026-12-31',
    })
  })

  it('does not allow extra payload keys to replace store actions', () => {
    const summary = {
      tier: 'pro' as const,
      stripeCustomerId: 'cus_server',
      stripeSubscriptionId: 'sub_server',
      currentPeriodEnd: '2026-12-31',
      canAccess: 'not-a-function',
    }
    useSubscriptionStore.getState().hydrate(summary)
    expect(typeof useSubscriptionStore.getState().canAccess).toBe('function')
  })

  it('gets limits for free tier', () => {
    const limits = useSubscriptionStore.getState().getLimits()
    expect(limits.maxScenarios).toBe(4)
    expect(limits.monteCarloEnabled).toBe(false)
    expect(limits.aiNarrationEnabled).toBe(false)
    expect(limits.exportEnabled).toBe(false)
  })

  it('gets limits for pro tier', () => {
    useSubscriptionStore.getState().setTier('pro')
    const limits = useSubscriptionStore.getState().getLimits()
    expect(limits.maxScenarios).toBe(Infinity)
    expect(limits.monteCarloEnabled).toBe(true)
    expect(limits.aiNarrationEnabled).toBe(true)
    expect(limits.exportEnabled).toBe(true)
    expect(limits.taxBracketModeling).toBe(true)
    expect(limits.rothOptimizer).toBe(true)
    expect(limits.alertsEnabled).toBe(true)
    expect(limits.apiAccessEnabled).toBe(true)
    expect(limits.spousePlanning).toBe(true)
  })

  it('canAccess returns false for gated features on free tier', () => {
    const state = useSubscriptionStore.getState()
    expect(state.canAccess('monteCarloEnabled')).toBe(false)
    expect(state.canAccess('aiNarrationEnabled')).toBe(false)
    expect(state.canAccess('whatIfEnabled')).toBe(false)
  })

  it('canAccess returns true for all features on pro tier', () => {
    useSubscriptionStore.getState().setTier('pro')
    const state = useSubscriptionStore.getState()
    expect(state.canAccess('monteCarloEnabled')).toBe(true)
    expect(state.canAccess('aiNarrationEnabled')).toBe(true)
    expect(state.canAccess('whatIfEnabled')).toBe(true)
    expect(state.canAccess('exportEnabled')).toBe(true)
  })

  it('canAccess returns true for numeric limits (checked elsewhere)', () => {
    const state = useSubscriptionStore.getState()
    expect(state.canAccess('maxScenarios')).toBe(true)
  })

  it('resets to initial state', () => {
    useSubscriptionStore.getState().setTier('pro')
    useSubscriptionStore.getState().setStripeIds('cus_x', 'sub_y')
    useSubscriptionStore.getState().setCurrentPeriodEnd('2026-06-01')
    useSubscriptionStore.getState().reset()

    const state = useSubscriptionStore.getState()
    expect(state.tier).toBe('free')
    expect(state.stripeCustomerId).toBeNull()
    expect(state.stripeSubscriptionId).toBeNull()
    expect(state.currentPeriodEnd).toBeNull()
  })
})

describe('getTierLimits', () => {
  it('returns free tier limits', () => {
    const limits = getTierLimits('free')
    expect(limits.maxScenarios).toBe(4)
    expect(limits.monteCarloEnabled).toBe(false)
  })

  it('returns pro tier limits', () => {
    const limits = getTierLimits('pro')
    expect(limits.maxScenarios).toBe(Infinity)
    expect(limits.monteCarloEnabled).toBe(true)
  })
})
