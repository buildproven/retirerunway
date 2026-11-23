'use client'

import {
  buildBridgeSummary,
  buildMilestones,
  calculateSocialSecurityBenefit,
  comparePlanAnalyses,
  planToJson,
  planToMarkdown,
  SOCIAL_SECURITY_RULES_AS_OF,
  SOCIAL_SECURITY_RULES_SOURCE,
  type PlanAnalysis,
  type PlanAnalysisChange,
  type PlanVerdict,
} from '@/engine/plan'
import type { HealthcareACAEligibilityStatus } from '@/engine/plan'
import { PlanLifetimeChart } from '@/components/plan-lifetime-chart'
import { PlanMonteCarloCard } from '@/components/plan-monte-carlo-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

interface PlanResultsStepProps {
  analysis: PlanAnalysis
  previousAnalysis?: PlanAnalysis | null
  onBack: () => void
}

function downloadText(filename: string, mime: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function verdictVariant(
  verdict: PlanVerdict
): 'default' | 'secondary' | 'destructive' {
  if (verdict === 'GO') return 'default'
  if (verdict === 'CAUTION') return 'secondary'
  return 'destructive'
}

function verdictSummary(verdict: PlanVerdict): string {
  if (verdict === 'GO') {
    return 'The modeled plan clears the baseline and selected stress gates under the entered assumptions.'
  }
  if (verdict === 'CAUTION') {
    return 'The plan is workable in the modeled base case, but one or more resilience or reserve conditions need attention.'
  }
  return 'The plan has an observed funding or commitment failure. The result is a delay signal, not a prediction of personal outcomes.'
}

function benefitTypeLabel(
  benefitType: NonNullable<
    PlanAnalysis['scenario']['socialSecurityBenefits']
  >[number]['benefitType']
): string {
  return {
    worker: 'Worker benefit',
    spouse: 'Spouse benefit',
    divorced_spouse: 'Divorced-spouse benefit',
    survivor: 'Survivor benefit',
  }[benefitType]
}

function acaStatusLabel(status: HealthcareACAEligibilityStatus): string {
  if (status === 'eligible') return 'Within modeled range'
  if (status === 'below_minimum_fpl') return 'Below 100% FPL — uncertain'
  return 'Above 400% FPL — cliff crossed'
}

export function PlanResultsStep({
  analysis,
  previousAnalysis = null,
  onBack,
}: PlanResultsStepProps) {
  const firstRetirementRow = analysis.projections.real.rows.find(
    row => row.age === analysis.scenario.profile.targetRetirementAge
  )
  const finalRow = analysis.projections.real.rows.at(-1)
  const firstGap = analysis.projections.real.rows.find(
    row => row.fundingGap > 0
  )
  const requiredIncome = analysis.incomeSolver.minimumGrossIncome
  const allEvents = analysis.scenario.lifeEvents
  const socialSecurityBenefits = analysis.scenario.socialSecurityBenefits ?? []
  const acaRows = analysis.projections.nominal.rows.flatMap(row =>
    Object.values(row.healthcare?.acaByTaxYear ?? {}).map(aca => ({ row, aca }))
  )
  const acaByTaxYear = Array.from(
    new Map(acaRows.map(entry => [entry.aca.taxYear, entry])).values()
  )
  const acaCliffRows = acaByTaxYear.filter(
    entry => entry.aca.eligibilityStatus === 'above_maximum_fpl'
  )
  const acaUncertainRows = acaByTaxYear.filter(
    entry => entry.aca.eligibilityStatus === 'below_minimum_fpl'
  )
  const totalAcaCliffLoss = acaCliffRows.reduce(
    (total, entry) => total + entry.aca.costOfCrossingCliff,
    0
  )
  const bridge = buildBridgeSummary(analysis)
  const milestones = buildMilestones(analysis)
  const comparison = previousAnalysis
    ? comparePlanAnalyses(previousAnalysis, analysis)
    : null

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-primary text-sm font-semibold tracking-wide uppercase">
          Retirement plan results
        </p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">
          Your transition runway
        </h2>
        <p className="text-muted-foreground mt-2">
          {analysis.projections.real.rows.length} years modeled in real dollars;
          the engine remains the calculator and this page explains its output.
        </p>
      </div>

      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-3">
            <span>Plan verdict</span>
            <Badge variant={verdictVariant(analysis.verdict.verdict)}>
              {analysis.verdict.verdict}
            </Badge>
          </CardTitle>
          <CardDescription>
            {verdictSummary(analysis.verdict.verdict)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-4">
            <Metric
              label="Robustness score"
              value={`${analysis.verdict.robustnessScore}/10`}
            />
            <Metric
              label="Stress scenarios solvent"
              value={`${analysis.verdict.stressScenariosSolvent}/5`}
            />
            <Metric
              label="Bridge liquidity"
              value={
                analysis.verdict.bridgeLiquidityCovered
                  ? 'Covered'
                  : 'Gap found'
              }
            />
            <Metric
              label="Post-Social Security"
              value={
                analysis.verdict.postSocialSecurityCovered
                  ? 'Covered'
                  : 'Review'
              }
            />
          </div>
          {(analysis.verdict.delayReasons.length > 0 ||
            analysis.verdict.cautionReasons.length > 0) && (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {analysis.verdict.delayReasons.length > 0 && (
                <ReasonList
                  title="Delay reasons"
                  reasons={analysis.verdict.delayReasons}
                />
              )}
              {analysis.verdict.cautionReasons.length > 0 && (
                <ReasonList
                  title="Caution reasons"
                  reasons={analysis.verdict.cautionReasons}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bridge to Social Security and Medicare</CardTitle>
          <CardDescription>
            The years between leaving work and guaranteed income, in real
            dollars.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <Metric
              label="Years to Medicare"
              value={String(bridge.yearsToMedicare)}
            />
            <Metric
              label="Years to Social Security"
              value={
                bridge.yearsToSocialSecurity === null
                  ? 'Not modeled'
                  : String(bridge.yearsToSocialSecurity)
              }
            />
            <Metric
              label="Bridge spending"
              value={formatCurrency(bridge.bridgeSpending)}
            />
            <Metric
              label="Accessible at exit"
              value={formatCurrency(bridge.accessibleAtExit)}
            />
            <Metric
              label="Lowest balance"
              value={`${formatCurrency(bridge.lowestBalance.total)} at ${bridge.lowestBalance.age}`}
            />
            <Metric
              label="Outside income needed"
              value={
                requiredIncome === null
                  ? 'No solution'
                  : formatCurrency(requiredIncome)
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lifetime balances</CardTitle>
          <CardDescription>
            Accessible money can be spent now; restricted money is locked until
            its access rule is met.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PlanLifetimeChart analysis={analysis} />
        </CardContent>
      </Card>

      <PlanMonteCarloCard analysis={analysis} />

      <Card>
        <CardHeader>
          <CardTitle>Milestones</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground border-b text-xs uppercase">
              <tr>
                <th className="px-2 py-3 font-medium">Age</th>
                <th className="px-2 py-3 font-medium">Milestone</th>
                <th className="px-2 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {milestones.map(milestone => (
                <tr
                  key={`${milestone.age}-${milestone.label}`}
                  className="border-b last:border-0"
                >
                  <td className="px-2 py-3 font-medium">{milestone.age}</td>
                  <td className="px-2 py-3">{milestone.label}</td>
                  <td className="text-muted-foreground px-2 py-3">
                    {milestone.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {comparison && <PlanComparisonCard comparison={comparison} />}

      <Card>
        <CardHeader>
          <CardTitle>Social Security assumptions</CardTitle>
          <CardDescription>
            Claiming adjustments are calculated from the entered record amount;
            future cost-of-living increases remain an explicit planning
            assumption.
          </CardDescription>
          <p className="text-muted-foreground text-xs">
            SSA estimates can assume continued future earnings. Recalculate the
            record amount for the planned stop-work age before relying on this
            result. Rules reference:{' '}
            <a
              href={SOCIAL_SECURITY_RULES_SOURCE}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Social Security Administration
            </a>{' '}
            (as of {SOCIAL_SECURITY_RULES_AS_OF}).
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {socialSecurityBenefits.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No Social Security benefit is included in this plan.
            </p>
          ) : (
            socialSecurityBenefits.map(benefit => {
              const result = calculateSocialSecurityBenefit(benefit)
              return (
                <div
                  key={benefit.id}
                  className="grid gap-2 border-b pb-3 text-sm last:border-0 last:pb-0 sm:grid-cols-5"
                >
                  <div>
                    <p className="font-medium">{benefit.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {benefitTypeLabel(benefit.benefitType)}
                    </p>
                  </div>
                  <Metric
                    label="Monthly at claim"
                    value={formatCurrency(result.monthlyBenefit)}
                  />
                  <Metric
                    label="Claim age / FRA"
                    value={`${benefit.claimAge} / ${benefit.fullRetirementAge}`}
                  />
                  <Metric
                    label="Adjustment"
                    value={`${Math.round(result.adjustmentFactor * 100)}%`}
                  />
                  <Metric
                    label="Taxable assumption"
                    value={`${Math.round((benefit.taxableFraction ?? 0.85) * 100)}% max`}
                  />
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>ACA premium-tax-credit planning</CardTitle>
          <CardDescription>
            The deterministic engine compares projected household MAGI with the
            versioned FPL rule for each ACA-covered tax year. This is a planning
            estimate, not a Marketplace eligibility or Form 8962 determination.
          </CardDescription>
          {analysis.scenario.healthcare?.aca && (
            <p className="text-muted-foreground text-xs">
              Modeled contribution assumption:{' '}
              {(
                analysis.scenario.healthcare.aca.contributionRate * 100
              ).toFixed(2)}
              %. Update this planning assumption before relying on a decision.
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {acaByTaxYear.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No ACA phase is included in this plan.
            </p>
          ) : (
            <>
              {acaCliffRows.length > 0 && (
                <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
                  <p className="font-medium">
                    The modeled MAGI cliff is crossed in{' '}
                    {acaCliffRows.map(entry => entry.aca.taxYear).join(', ')}.
                  </p>
                  <p className="text-muted-foreground mt-1">
                    Estimated modeled subsidy lost across those years:{' '}
                    {formatCurrency(totalAcaCliffLoss)} for the covered months.
                    Review withdrawal mix and MAGI assumptions before treating
                    this as a decision.
                  </p>
                </div>
              )}
              {acaUncertainRows.length > 0 && (
                <div className="border-amber-500/40 bg-amber-500/5 rounded-md border p-3 text-sm">
                  The projection is below 100% FPL in{' '}
                  {acaUncertainRows.map(entry => entry.aca.taxYear).join(', ')}.
                  The general rule does not claim a premium tax credit for that
                  range; exceptions require separate verification.
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="text-muted-foreground border-b text-xs uppercase">
                    <tr>
                      <th className="px-2 py-3 font-medium">Tax year</th>
                      <th className="px-2 py-3 font-medium">MAGI</th>
                      <th className="px-2 py-3 font-medium">400% FPL cliff</th>
                      <th className="px-2 py-3 font-medium">FPL</th>
                      <th className="px-2 py-3 font-medium">Rule</th>
                      <th className="px-2 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acaByTaxYear.slice(0, 12).map(({ aca }) => (
                      <tr key={aca.taxYear} className="border-b last:border-0">
                        <td className="px-2 py-2 font-medium">{aca.taxYear}</td>
                        <td className="px-2 py-2">
                          {formatCurrency(aca.magi)}
                        </td>
                        <td className="px-2 py-2">
                          {formatCurrency(aca.cliffThreshold)}
                        </td>
                        <td className="px-2 py-2">
                          {aca.fplPercent.toFixed(0)}%
                        </td>
                        <td className="px-2 py-2">
                          <Badge variant="outline">
                            {aca.ruleStatus === 'official'
                              ? 'Official'
                              : 'Planning estimate'}
                          </Badge>
                          <p className="text-muted-foreground mt-1 text-xs">
                            Effective {aca.ruleEffectiveDate}
                          </p>
                        </td>
                        <td className="px-2 py-2">
                          <Badge
                            variant={
                              aca.eligibilityStatus === 'eligible'
                                ? 'default'
                                : 'destructive'
                            }
                          >
                            {acaStatusLabel(aca.eligibilityStatus)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="First retirement year"
          value={formatCurrency(firstRetirementRow?.accessibleBalance ?? 0)}
          description="Accessible balance after the first modeled year"
        />
        <MetricCard
          title="Final total balance"
          value={formatCurrency(
            (finalRow?.accessibleBalance ?? 0) +
              (finalRow?.restrictedBalance ?? 0)
          )}
          description={`At age ${finalRow?.age ?? '—'}`}
        />
        <MetricCard
          title="Minimum outside income"
          value={
            requiredIncome === null
              ? 'No solution'
              : formatCurrency(requiredIncome)
          }
          description="Gross annual income needed for a GO result"
        />
        <MetricCard
          title="First funding gap"
          value={firstGap ? `Age ${firstGap.age}` : 'None'}
          description={
            firstGap ? formatCurrency(firstGap.fundingGap) : 'No modeled gap'
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stress scenario suite</CardTitle>
          <CardDescription>
            Five outcome gates feed the verdict. The other deterministic cases
            remain available in the engine for future comparison views.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-muted-foreground border-b text-xs uppercase">
                <tr>
                  <th className="px-2 py-3 font-medium">Scenario</th>
                  <th className="px-2 py-3 font-medium">Outcome</th>
                  <th className="px-2 py-3 font-medium">Final total balance</th>
                  <th className="px-2 py-3 font-medium">First gap</th>
                </tr>
              </thead>
              <tbody>
                {analysis.stressResults.map(result => {
                  const final = result.projection.rows.at(-1)
                  const gap = result.projection.rows.find(
                    row => row.fundingGap > 0
                  )
                  return (
                    <tr key={result.id} className="border-b last:border-0">
                      <td className="px-2 py-3">
                        <p className="font-medium">{result.label}</p>
                        <p className="text-muted-foreground max-w-md text-xs">
                          {result.description}
                        </p>
                      </td>
                      <td className="px-2 py-3">
                        <Badge
                          variant={result.solvent ? 'default' : 'destructive'}
                        >
                          {result.solvent ? 'Solvent' : 'Gap'}
                        </Badge>
                      </td>
                      <td className="px-2 py-3 font-medium">
                        {formatCurrency(
                          (final?.accessibleBalance ?? 0) +
                            (final?.restrictedBalance ?? 0)
                        )}
                      </td>
                      <td className="px-2 py-3">
                        {gap
                          ? `${gap.age} · ${formatCurrency(gap.fundingGap)}`
                          : 'None'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Projection timeline</CardTitle>
          <CardDescription>
            Real-dollar annual rows with accessible and restricted balances kept
            separate. Showing the first twelve rows for a readable handoff.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-sm">
              <thead className="text-muted-foreground border-b text-xs uppercase">
                <tr>
                  <th className="px-2 py-3 font-medium">Age</th>
                  <th className="px-2 py-3 font-medium">Income</th>
                  <th className="px-2 py-3 font-medium">Spending</th>
                  <th className="px-2 py-3 font-medium">Accessible</th>
                  <th className="px-2 py-3 font-medium">Restricted</th>
                  <th className="px-2 py-3 font-medium">Funding gap</th>
                  <th className="px-2 py-3 font-medium">Events</th>
                </tr>
              </thead>
              <tbody>
                {analysis.projections.real.rows.slice(0, 12).map(row => (
                  <tr key={row.year} className="border-b last:border-0">
                    <td className="px-2 py-2 font-medium">{row.age}</td>
                    <td className="px-2 py-2">{formatCurrency(row.income)}</td>
                    <td className="px-2 py-2">
                      {formatCurrency(row.spending)}
                    </td>
                    <td className="px-2 py-2">
                      {formatCurrency(row.accessibleBalance)}
                    </td>
                    <td className="px-2 py-2">
                      {formatCurrency(row.restrictedBalance)}
                    </td>
                    <td className="px-2 py-2">
                      {row.fundingGap > 0 ? (
                        <span className="text-destructive font-medium">
                          {formatCurrency(row.fundingGap)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {row.lifeEvents?.map(event => event.name).join(', ') ||
                        '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Income bridge solver</CardTitle>
            <CardDescription>
              A deterministic search for the smallest gross outside-income
              stream that flips the modeled verdict to GO.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <SolverRow
              label="Minimum gross income"
              value={
                requiredIncome === null
                  ? 'No solution under ceiling'
                  : formatCurrency(requiredIncome)
              }
            />
            <SolverRow
              label="Recommended gross income"
              value={
                analysis.incomeSolver.recommendedGrossIncome === null
                  ? '—'
                  : formatCurrency(analysis.incomeSolver.recommendedGrossIncome)
              }
            />
            <SolverRow
              label="Spendable minimum"
              value={
                analysis.incomeSolver.minimumSpendableIncome === null
                  ? '—'
                  : formatCurrency(analysis.incomeSolver.minimumSpendableIncome)
              }
            />
            <SolverRow
              label="Earliest robust exit"
              value={
                analysis.incomeSolver.earliestRobustExitAge === null
                  ? 'Not demonstrated'
                  : `Age ${analysis.incomeSolver.earliestRobustExitAge}`
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Life events and levers</CardTitle>
            <CardDescription>
              Committed events are applied to the base projection; other levers
              remain visible without being silently counted.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {allEvents.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No life events entered.
              </p>
            )}
            {allEvents.map(event => (
              <div
                key={event.id}
                className="flex items-start justify-between gap-3 text-sm"
              >
                <div>
                  <p className="font-medium">{event.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {event.kind.replace(/_/g, ' ')} ·{' '}
                    {'age' in event.date
                      ? `age ${event.date.age}`
                      : event.date.date}
                  </p>
                </div>
                <Badge
                  variant={
                    event.commitment === 'committed' ? 'default' : 'outline'
                  }
                >
                  {event.commitment}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={onBack}>
          Adjust plan
        </Button>
        <Button variant="secondary" onClick={() => window.print()}>
          Print report
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            downloadText(
              'retire-runway-plan.md',
              'text/markdown',
              planToMarkdown(analysis)
            )
          }
        >
          Download Markdown
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            downloadText(
              'retire-runway-plan.json',
              'application/json',
              planToJson(analysis)
            )
          }
        >
          Download JSON
        </Button>
      </div>
    </div>
  )
}

function PlanComparisonCard({
  comparison,
}: {
  comparison: ReturnType<typeof comparePlanAnalyses>
}) {
  const hasChanges =
    comparison.assumptionChanges.length > 0 ||
    comparison.outcomeChanges.length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>What changed from your previous run</CardTitle>
        <CardDescription>
          This comparison uses only the two deterministic plan calculations. It
          does not infer causes that were not part of the entered assumptions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasChanges && (
          <p className="text-muted-foreground text-sm">
            The entered assumptions and modeled outcomes match the previous run.
          </p>
        )}
        {comparison.assumptionChanges.length > 0 && (
          <ChangeGroup
            title="Assumptions changed"
            changes={comparison.assumptionChanges}
          />
        )}
        {comparison.outcomeChanges.length > 0 && (
          <ChangeGroup
            title="Highest-priority modeled outcome changes"
            changes={comparison.outcomeChanges}
          />
        )}
      </CardContent>
    </Card>
  )
}

function ChangeGroup({
  title,
  changes,
}: {
  title: string
  changes: readonly PlanAnalysisChange[]
}) {
  return (
    <div>
      <p className="text-sm font-semibold">{title}</p>
      <ul className="mt-2 space-y-2">
        {changes.map(change => (
          <li key={change.id} className="flex items-start gap-2 text-sm">
            <Badge variant={changeBadgeVariant(change.direction)}>
              {changeDirectionLabel(change.direction)}
            </Badge>
            <span>{change.summary}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function changeBadgeVariant(
  direction: PlanAnalysisChange['direction']
): 'default' | 'destructive' | 'outline' {
  if (direction === 'improved') return 'default'
  if (direction === 'worsened') return 'destructive'
  return 'outline'
}

function changeDirectionLabel(
  direction: PlanAnalysisChange['direction']
): string {
  if (direction === 'improved') return 'Improved'
  if (direction === 'worsened') return 'Worsened'
  return 'Changed'
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  )
}

function MetricCard({
  title,
  value,
  description,
}: {
  title: string
  value: string
  description: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-xs">{description}</p>
      </CardContent>
    </Card>
  )
}

function ReasonList({
  title,
  reasons,
}: {
  title: string
  reasons: readonly string[]
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-semibold">{title}</p>
      <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1 text-xs">
        {reasons.map(reason => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  )
}

function SolverRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b pb-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
