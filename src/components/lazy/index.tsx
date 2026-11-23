'use client'

import dynamic from 'next/dynamic'
import {
  ChartSkeleton,
  MonteCarloSkeleton,
  NarrationSkeleton,
  WhatIfSkeleton,
  WithdrawalChartSkeleton,
} from '@/components/loading-skeletons'

export const LazyScenarioChart = dynamic(
  () =>
    import('@/components/scenario-chart').then(mod => ({
      default: mod.ScenarioChart,
    })),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  }
)

export const LazyWithdrawalChart = dynamic(
  () =>
    import('@/components/scenario-chart').then(mod => ({
      default: mod.WithdrawalChart,
    })),
  {
    ssr: false,
    loading: () => <WithdrawalChartSkeleton />,
  }
)

export const LazyMonteCarloCard = dynamic(
  () =>
    import('@/components/monte-carlo-card').then(mod => ({
      default: mod.MonteCarloCard,
    })),
  {
    ssr: false,
    loading: () => <MonteCarloSkeleton />,
  }
)

export const LazyNarrationCard = dynamic(
  () =>
    import('@/components/narration-card').then(mod => ({
      default: mod.NarrationCard,
    })),
  {
    ssr: false,
    loading: () => <NarrationSkeleton />,
  }
)

export const LazyWhatIfCard = dynamic(
  () =>
    import('@/components/what-if-card').then(mod => ({
      default: mod.WhatIfCard,
    })),
  {
    ssr: false,
    loading: () => <WhatIfSkeleton />,
  }
)
