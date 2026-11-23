'use client'

import { useState } from 'react'
import { usePortfolioStore } from '@/store/portfolio-store'
import { UploadStep } from '@/components/upload-step'
import { ProfileStep } from '@/components/profile-step'
import { DashboardStep } from '@/components/dashboard-step'
import { ResultsStep } from '@/components/results-step'
import { LandingHero } from '@/components/landing-hero'
import { PlanIntakeStep } from '@/components/plan-intake-step'
import { PlanResultsStep } from '@/components/plan-results-step'
import type { PlanAnalysis } from '@/engine/plan'
import { FinancialDisclaimer } from '@/components/financial-disclaimer'
import {
  PortfolioPersistenceProvider,
  usePersistenceContext,
} from '@/components/portfolio-persistence-provider'
import { SyncStatusIndicator } from '@/components/sync-status-indicator'

type Step =
  | 'landing'
  | 'upload'
  | 'profile'
  | 'results'
  | 'plan-intake'
  | 'plan-results'

function HomeContent() {
  const [step, setStep] = useState<Step>('landing')
  const [planAnalysis, setPlanAnalysis] = useState<PlanAnalysis | null>(null)
  const [previousPlanAnalysis, setPreviousPlanAnalysis] =
    useState<PlanAnalysis | null>(null)
  const portfolio = usePortfolioStore(s => s.portfolio)
  const { status, lastSyncedAt, error, isLoading, forceSync } =
    usePersistenceContext()

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-zinc-950">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <button
              className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50"
              onClick={() => setStep('landing')}
            >
              RetireRunway
            </button>
            {step !== 'landing' && (
              <SyncStatusIndicator
                status={status}
                lastSyncedAt={lastSyncedAt}
                error={error}
                isLoading={isLoading}
                onRetry={forceSync}
              />
            )}
          </div>
          {step !== 'landing' &&
            (step === 'upload' || step === 'profile' || step === 'results') && (
              <nav className="flex items-center gap-1 text-sm">
                <StepIndicator
                  label="Upload"
                  active={step === 'upload'}
                  done={!!portfolio}
                  onClick={() => setStep('upload')}
                />
                <Chevron />
                <StepIndicator
                  label="Profile"
                  active={step === 'profile'}
                  done={step === 'results'}
                  onClick={() => portfolio && setStep('profile')}
                />
                <Chevron />
                <StepIndicator
                  label="Results"
                  active={step === 'results'}
                  done={false}
                  onClick={() => {}}
                />
              </nav>
            )}
          {step !== 'landing' &&
            (step === 'plan-intake' || step === 'plan-results') && (
              <nav className="flex items-center gap-1 text-sm">
                <StepIndicator
                  label="Plan intake"
                  active={step === 'plan-intake'}
                  done={step === 'plan-results'}
                  onClick={() => setStep('plan-intake')}
                />
                <Chevron />
                <StepIndicator
                  label="Plan results"
                  active={step === 'plan-results'}
                  done={false}
                  onClick={() => {}}
                />
              </nav>
            )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {step === 'landing' && (
          <LandingHero
            onChoosePortfolio={() => setStep('upload')}
            onChoosePlan={() => setStep('plan-intake')}
          />
        )}
        {step === 'upload' && (
          <UploadStep onComplete={() => setStep('profile')} />
        )}
        {step === 'profile' && (
          <ProfileStep
            onComplete={() => setStep('results')}
            onBack={() => setStep('upload')}
          />
        )}
        {step === 'results' && (
          <>
            <DashboardStep />
            <div className="mt-8">
              <ResultsStep onBack={() => setStep('profile')} />
            </div>
          </>
        )}
        {step === 'plan-intake' && (
          <PlanIntakeStep
            onComplete={analysis => {
              setPreviousPlanAnalysis(planAnalysis)
              setPlanAnalysis(analysis)
              setStep('plan-results')
            }}
            onBack={() => setStep('landing')}
          />
        )}
        {step === 'plan-results' && planAnalysis && (
          <PlanResultsStep
            analysis={planAnalysis}
            previousAnalysis={previousPlanAnalysis}
            onBack={() => setStep('plan-intake')}
          />
        )}
      </main>

      <FinancialDisclaimer />
    </div>
  )
}

function StepIndicator({
  label,
  active,
  done,
  onClick,
}: {
  label: string
  active: boolean
  done: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : done
            ? 'text-foreground cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800'
            : 'text-muted-foreground cursor-default'
      }`}
    >
      {label}
    </button>
  )
}

function Chevron() {
  return (
    <svg
      className="text-muted-foreground/50 h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  )
}

export default function Home() {
  return (
    <PortfolioPersistenceProvider>
      <HomeContent />
    </PortfolioPersistenceProvider>
  )
}
