'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { usePortfolioStore } from '@/store/portfolio-store'
import type { ScenarioResult, TradePlan, CashLadder } from '@/engine/types'
import type { RuleOf55Result } from '@/engine/rule-of-55'
import type { RiskScoreBreakdown } from '@/engine/risk-scoring'
import { CustomScenarioPanel } from '@/components/custom-scenario-panel'
import {
  projectAllScenarios,
  getSequenceOfReturnsRisk,
  generateTradePlans,
  generateReport,
  getRuleOf55Analysis,
} from '@/services'
import { useApiKeyStore } from '@/store/api-key-store'
import {
  LazyScenarioChart,
  LazyWithdrawalChart,
  LazyMonteCarloCard,
  LazyNarrationCard,
  LazyWhatIfCard,
} from '@/components/lazy'
import { InlineDisclaimer } from '@/components/financial-disclaimer'
import {
  ErrorBoundary,
  ResultsErrorFallback,
} from '@/components/error-boundary'
import { useMonteCarloWorker } from '@/hooks/use-monte-carlo-worker'

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

interface ResultsStepProps {
  onBack: () => void
}

export function ResultsStep({ onBack }: ResultsStepProps) {
  const portfolio = usePortfolioStore(s => s.portfolio)
  const userProfile = usePortfolioStore(s => s.userProfile)
  const customScenarioParams = usePortfolioStore(s => s.customScenarioParams)
  const provider = useApiKeyStore(s => s.provider)
  const apiKey = useApiKeyStore(s => s.apiKey)
  const [tradeMode, setTradeMode] = useState<'standard' | 'minimal'>('minimal')

  const {
    result: monteCarloResult,
    isLoading: isMonteCarloLoading,
    error: monteCarloError,
    runSimulation,
  } = useMonteCarloWorker()

  const results = useMemo(() => {
    if (!portfolio || !userProfile) return null

    const scenarioAnalysis = projectAllScenarios(
      portfolio,
      userProfile,
      customScenarioParams
    )
    const risk = getSequenceOfReturnsRisk(portfolio, userProfile)
    const tradePlans = generateTradePlans(portfolio, userProfile)
    const ruleOf55 = getRuleOf55Analysis(portfolio, userProfile)

    return {
      scenarios: scenarioAnalysis.scenarios,
      risk,
      trades: tradePlans.standardPlan,
      minimalTrades: tradePlans.minimalPlan,
      ladder: tradePlans.ladder,
      ruleOf55,
    }
  }, [portfolio, userProfile, customScenarioParams])

  useEffect(() => {
    if (portfolio && userProfile) {
      runSimulation(portfolio, userProfile)
    }
  }, [portfolio, userProfile, runSimulation])

  const handleExportMarkdown = useCallback(() => {
    if (!portfolio || !userProfile || !results) return
    const markdown = generateReport({
      portfolio,
      userProfile,
      scenarios: results.scenarios,
      riskScore: results.risk,
      tradePlan: results.trades,
      ladderPlan: results.ladder,
    })
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `retire-runway-report-${portfolio.asOfDate}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [portfolio, userProfile, results])

  if (!portfolio || !userProfile || !results) {
    return (
      <div className="text-muted-foreground text-center">
        Upload a portfolio and complete your profile first.
      </div>
    )
  }

  const { scenarios, risk, trades, minimalTrades, ladder, ruleOf55 } = results
  const activeTrades = tradeMode === 'minimal' ? minimalTrades : trades

  return (
    <ErrorBoundary fallback={<ResultsErrorFallback onBack={onBack} />}>
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-tight">
            Scenario Results
          </h2>
          <p className="text-muted-foreground mt-1">
            {scenarios.length} market scenarios modeled for your portfolio
          </p>
        </div>

        <CustomScenarioPanel />

        <ErrorBoundary>
          <RiskScoreCard riskScore={risk} />
        </ErrorBoundary>

        <ErrorBoundary>
          <Card>
            <CardHeader>
              <CardTitle>Portfolio Projection</CardTitle>
              <CardDescription>
                End-of-year balance across all 4 scenarios
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LazyScenarioChart
                scenarios={scenarios}
                retirementAge={userProfile.targetRetirementAge}
              />
            </CardContent>
          </Card>
        </ErrorBoundary>

        <div className="grid gap-4 md:grid-cols-2">
          {scenarios.map(result => (
            <ErrorBoundary key={result.scenarioType}>
              <ScenarioCard result={result} />
            </ErrorBoundary>
          ))}
        </div>

        <ErrorBoundary>
          <LazyMonteCarloCard
            result={monteCarloResult}
            retirementAge={userProfile.targetRetirementAge}
            isLoading={isMonteCarloLoading}
            error={monteCarloError}
          />
        </ErrorBoundary>

        <ErrorBoundary>
          <Card>
            <CardHeader>
              <CardTitle>Withdrawal Schedule</CardTitle>
              <CardDescription>
                Annual withdrawals vs. inflation-adjusted target (base case)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LazyWithdrawalChart
                scenarios={scenarios}
                retirementAge={userProfile.targetRetirementAge}
              />
            </CardContent>
          </Card>
        </ErrorBoundary>

        {activeTrades.trades.length > 0 && (
          <ErrorBoundary>
            <TradePlanCard
              tradePlan={activeTrades}
              tradeMode={tradeMode}
              onToggleMode={() =>
                setTradeMode(m => (m === 'standard' ? 'minimal' : 'standard'))
              }
            />
          </ErrorBoundary>
        )}

        {ladder.rungs.length > 0 && (
          <ErrorBoundary>
            <LadderPlanCard ladder={ladder} />
          </ErrorBoundary>
        )}

        {ruleOf55.guidancePoints.length > 0 && (
          <ErrorBoundary>
            <RuleOf55Card ruleOf55={ruleOf55} />
          </ErrorBoundary>
        )}

        <ErrorBoundary>
          <LazyNarrationCard
            context={{
              portfolio,
              userProfile,
              scenarios,
              riskScore: risk,
              tradePlan: trades,
              ladderPlan: ladder,
            }}
          />
        </ErrorBoundary>

        {apiKey && (
          <ErrorBoundary>
            <LazyWhatIfCard
              portfolio={portfolio}
              userProfile={userProfile}
              originalScenarios={scenarios}
              provider={provider}
              apiKey={apiKey}
            />
          </ErrorBoundary>
        )}

        <InlineDisclaimer />

        <div className="flex gap-3">
          <Button variant="outline" onClick={onBack}>
            Back to Profile
          </Button>
          <Button variant="secondary" onClick={handleExportMarkdown}>
            Export .md
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            Export PDF
          </Button>
        </div>
      </div>
    </ErrorBoundary>
  )
}

function RiskScoreCard({ riskScore }: { riskScore: RiskScoreBreakdown }) {
  const colorMap: Record<string, string> = {
    Low: 'text-green-600 dark:text-green-400',
    Moderate: 'text-amber-600 dark:text-amber-400',
    High: 'text-orange-600 dark:text-orange-400',
    'Very High': 'text-red-600 dark:text-red-400',
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Sequence-of-Returns Risk
          <span className={`text-3xl ${colorMap[riskScore.label] ?? ''}`}>
            {riskScore.score}/10
          </span>
        </CardTitle>
        <CardDescription>{riskScore.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bg-muted h-2 overflow-hidden rounded-full">
          <div
            className={`h-full transition-all ${
              riskScore.score <= 3
                ? 'bg-green-500'
                : riskScore.score <= 5
                  ? 'bg-amber-500'
                  : riskScore.score <= 7
                    ? 'bg-orange-500'
                    : 'bg-red-500'
            }`}
            style={{ width: `${riskScore.score * 10}%` }}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function ScenarioCard({ result }: { result: ScenarioResult }) {
  const labelMap: Record<string, string> = {
    bull: 'Bull Market',
    base: 'Base Case',
    early_bear: 'Early Bear',
    prolonged_bear: 'Prolonged Bear',
    custom: 'Custom Scenario',
  }

  const badgeVariant =
    result.scenarioType === 'bull'
      ? 'default'
      : result.scenarioType === 'base' || result.scenarioType === 'custom'
        ? 'secondary'
        : 'destructive'

  const finalProjection = result.projections[result.projections.length - 1]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          {labelMap[result.scenarioType]}
          <Badge variant={badgeVariant}>{result.runwayYears}yr runway</Badge>
        </CardTitle>
        <CardDescription>
          {result.depletionAge
            ? `Depletes at age ${result.depletionAge}`
            : 'Money lasts through projection'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Final Balance</p>
            <p className="font-semibold">
              {formatCurrency(finalProjection?.endBalance ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Total Withdrawn</p>
            <p className="font-semibold">
              {formatCurrency(finalProjection?.cumulativeWithdrawals ?? 0)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function TradePlanCard({
  tradePlan,
  tradeMode,
  onToggleMode,
}: {
  tradePlan: TradePlan
  tradeMode: 'standard' | 'minimal'
  onToggleMode: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          De-Risk Trade Plan
          <button
            onClick={onToggleMode}
            className="bg-muted text-muted-foreground hover:bg-muted/80 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
          >
            {tradeMode === 'minimal' ? 'Fewest trades' : 'Standard'} · Switch
          </button>
        </CardTitle>
        <CardDescription>
          {tradePlan.trades.length} trade
          {tradePlan.trades.length !== 1 ? 's' : ''} to reach{' '}
          {formatCurrency(tradePlan.targetCashPosition)} cash target
          {tradeMode === 'minimal' && ' (minimal trades mode)'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {tradePlan.trades.map((trade, i) => (
            <div key={i} className="flex items-start justify-between text-sm">
              <div className="space-y-0.5">
                <p className="font-medium">
                  #{trade.priority} · {formatCurrency(trade.estimatedValue)}
                </p>
                <p className="text-muted-foreground text-xs">
                  {trade.rationale}
                </p>
              </div>
              {trade.estimatedTaxImpact > 0 && (
                <Badge variant="outline" className="shrink-0 text-xs">
                  Tax: {formatCurrency(trade.estimatedTaxImpact)}
                </Badge>
              )}
            </div>
          ))}
          <div className="border-t pt-3">
            <div className="flex justify-between text-sm font-medium">
              <span>Total Proceeds</span>
              <span>{formatCurrency(tradePlan.totalProceeds)}</span>
            </div>
            <div className="text-muted-foreground flex justify-between text-sm">
              <span>Estimated Tax Impact</span>
              <span>{formatCurrency(tradePlan.totalTaxImpact)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function LadderPlanCard({ ladder }: { ladder: CashLadder }) {
  const sourceLabels: Record<string, string> = {
    cash: 'Cash',
    cd: 'CD Maturity',
    bond: 'Bond',
    sell_equity: 'Sell Equity',
  }
  const sourceColors: Record<string, string> = {
    cash: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    cd: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    bond: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    sell_equity:
      'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash Ladder Plan</CardTitle>
        <CardDescription>
          {ladder.yearsOfExpensesCovered.toFixed(1)} years of expenses covered ·{' '}
          {formatCurrency(ladder.annualExpenseTarget)}/yr target
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {ladder.rungs.map((rung, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground w-12 font-mono">
                  {rung.year}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${sourceColors[rung.source]}`}
                >
                  {sourceLabels[rung.source]}
                </span>
              </div>
              <span className="font-medium">{formatCurrency(rung.amount)}</span>
            </div>
          ))}
          <div className="border-t pt-2">
            <div className="flex justify-between text-sm font-medium">
              <span>Total Funded</span>
              <span>{formatCurrency(ladder.totalFunded)}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function RuleOf55Card({ ruleOf55 }: { ruleOf55: RuleOf55Result }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Rule of 55
          <Badge variant={ruleOf55.eligible ? 'default' : 'secondary'}>
            {ruleOf55.eligible ? 'Eligible' : 'Not Applicable'}
          </Badge>
        </CardTitle>
        <CardDescription>
          Early 401(k)/403(b) withdrawal without 10% penalty
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {ruleOf55.guidancePoints.map((point, i) => (
            <li key={i} className="text-muted-foreground flex gap-2">
              <span className="mt-1 shrink-0">
                {ruleOf55.eligible ? '\u2713' : '\u2022'}
              </span>
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
