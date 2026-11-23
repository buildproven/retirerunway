'use client'

import { useState } from 'react'
import { buildScenario, analyzePlan } from '@/engine/plan'
import type { FilingStatus } from '@/engine/tax-brackets'
import type {
  HealthcareACAResidenceRegion,
  PlanAnalysis,
  SocialSecurityBenefitType,
} from '@/engine/plan'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type NumericValue = number | ''

interface PlanFormState {
  currentAge: NumericValue
  targetRetirementAge: NumericValue
  durationYears: NumericValue
  filingStatus: FilingStatus
  acaHouseholdSize: NumericValue
  acaResidenceRegion: HealthcareACAResidenceRegion
  annualExpenses: NumericValue
  essentialExpenses: NumericValue
  cashBalance: NumericValue
  brokerageBalance: NumericValue
  traditionalBalance: NumericValue
  rothBalance: NumericValue
  annualWorkIncome: NumericValue
  annualOutsideIncome: NumericValue
  annualSocialSecurityAtFullRetirementAge: NumericValue
  socialSecurityStartAge: NumericValue
  socialSecurityWorkerClaimAge: NumericValue
  socialSecurityWorkerBirthYear: NumericValue
  socialSecurityFullRetirementAge: NumericValue
  socialSecurityClaimantFullRetirementAge: NumericValue
  socialSecurityBenefitType: SocialSecurityBenefitType
  divorcedSpouseEligibilityConfirmed: boolean
  annualHealthcare: NumericValue
  reserveFloor: NumericValue
  housingProceeds: NumericValue
  housingEventAge: NumericValue
  housingCommitment: 'committed' | 'available' | 'aspirational'
}

const EMPTY_FORM: PlanFormState = {
  currentAge: '',
  targetRetirementAge: '',
  durationYears: 35,
  filingStatus: 'single',
  acaHouseholdSize: 1,
  acaResidenceRegion: 'contiguous_us',
  annualExpenses: '',
  essentialExpenses: '',
  cashBalance: 0,
  brokerageBalance: 0,
  traditionalBalance: 0,
  rothBalance: 0,
  annualWorkIncome: 0,
  annualOutsideIncome: 0,
  annualSocialSecurityAtFullRetirementAge: 0,
  socialSecurityStartAge: '',
  socialSecurityWorkerClaimAge: '',
  socialSecurityWorkerBirthYear: '',
  socialSecurityFullRetirementAge: 67,
  socialSecurityClaimantFullRetirementAge: 67,
  socialSecurityBenefitType: 'worker',
  divorcedSpouseEligibilityConfirmed: false,
  annualHealthcare: 0,
  reserveFloor: 0,
  housingProceeds: 0,
  housingEventAge: '',
  housingCommitment: 'available',
}

const CONSERVATIVE_SAMPLE: PlanFormState = {
  currentAge: 58,
  targetRetirementAge: 65,
  durationYears: 35,
  filingStatus: 'married_filing_jointly',
  acaHouseholdSize: 2,
  acaResidenceRegion: 'contiguous_us',
  annualExpenses: 70_000,
  essentialExpenses: 48_000,
  cashBalance: 50_000,
  brokerageBalance: 350_000,
  traditionalBalance: 650_000,
  rothBalance: 150_000,
  annualWorkIncome: 110_000,
  annualOutsideIncome: 20_000,
  annualSocialSecurityAtFullRetirementAge: 36_000,
  socialSecurityStartAge: 67,
  socialSecurityWorkerClaimAge: 67,
  socialSecurityWorkerBirthYear: 1960,
  socialSecurityFullRetirementAge: 67,
  socialSecurityClaimantFullRetirementAge: 67,
  socialSecurityBenefitType: 'worker',
  divorcedSpouseEligibilityConfirmed: false,
  annualHealthcare: 14_000,
  reserveFloor: 100_000,
  housingProceeds: 200_000,
  housingEventAge: 70,
  housingCommitment: 'available',
}

interface PlanIntakeStepProps {
  onComplete: (analysis: PlanAnalysis) => void
  onBack: () => void
}

function numberValue(value: NumericValue, fallback = 0): number {
  return value === '' ? fallback : value
}

function defaultSocialSecurityClaimAge(
  benefitType: SocialSecurityBenefitType,
  targetRetirementAge: number
): number {
  const requested = targetRetirementAge + 5
  if (benefitType === 'survivor') return Math.max(60, requested)
  return Math.min(70, Math.max(62, requested))
}

export function PlanIntakeStep({ onComplete, onBack }: PlanIntakeStepProps) {
  const [form, setForm] = useState<PlanFormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<string[]>([])
  const [isRunning, setIsRunning] = useState(false)

  function updateNumber(key: keyof PlanFormState, raw: string) {
    setForm(previous => ({
      ...previous,
      [key]: raw === '' ? '' : Number(raw),
    }))
  }

  function field(
    key: keyof PlanFormState,
    label: string,
    options: {
      prefix?: string
      hint?: string
      step?: string
      min?: string
      max?: string
    } = {}
  ) {
    const value = form[key]
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`plan-${key}`}>{label}</Label>
        <div className="relative">
          {options.prefix && (
            <span className="text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 text-sm">
              {options.prefix}
            </span>
          )}
          <Input
            id={`plan-${key}`}
            type="number"
            min={options.min ?? '0'}
            max={options.max}
            step={options.step}
            value={typeof value === 'number' ? value : ''}
            onChange={event => updateNumber(key, event.target.value)}
            className={options.prefix ? 'pl-7' : undefined}
          />
        </div>
        {options.hint && (
          <p className="text-muted-foreground text-xs">{options.hint}</p>
        )}
      </div>
    )
  }

  function runPlan() {
    const nextErrors: string[] = []
    if (form.currentAge === '') nextErrors.push('Enter your current age.')
    if (form.targetRetirementAge === '')
      nextErrors.push('Enter your target retirement age.')
    if (form.annualExpenses === '') nextErrors.push('Enter annual spending.')
    if (form.essentialExpenses === '')
      nextErrors.push('Enter essential annual spending.')
    if (
      form.housingProceeds !== '' &&
      form.housingProceeds > 0 &&
      form.housingEventAge === ''
    ) {
      nextErrors.push('Enter the age for the housing transaction.')
    }
    if (
      form.annualSocialSecurityAtFullRetirementAge !== '' &&
      form.annualSocialSecurityAtFullRetirementAge > 0 &&
      form.socialSecurityBenefitType === 'spouse' &&
      form.socialSecurityWorkerClaimAge === ''
    ) {
      nextErrors.push(
        'Enter the associated worker claim age for spouse benefits.'
      )
    }
    if (
      form.annualSocialSecurityAtFullRetirementAge !== '' &&
      form.annualSocialSecurityAtFullRetirementAge > 0 &&
      form.socialSecurityBenefitType === 'worker' &&
      numberValue(
        form.socialSecurityStartAge,
        defaultSocialSecurityClaimAge(
          form.socialSecurityBenefitType,
          numberValue(form.targetRetirementAge)
        )
      ) > numberValue(form.socialSecurityFullRetirementAge, 67) &&
      form.socialSecurityWorkerBirthYear === ''
    ) {
      nextErrors.push(
        'Enter the worker birth year when claiming after full retirement age.'
      )
    }
    if (
      form.annualSocialSecurityAtFullRetirementAge !== '' &&
      form.annualSocialSecurityAtFullRetirementAge > 0 &&
      form.socialSecurityBenefitType === 'divorced_spouse' &&
      !form.divorcedSpouseEligibilityConfirmed
    ) {
      nextErrors.push(
        'Confirm that the divorced-spouse benefit eligibility requirements are met.'
      )
    }
    setErrors(nextErrors)
    if (nextErrors.length > 0) return

    setIsRunning(true)
    try {
      const currentAge = numberValue(form.currentAge)
      const targetRetirementAge = numberValue(form.targetRetirementAge)
      const scenario = buildScenario({
        currentAge,
        targetRetirementAge,
        durationYears: numberValue(form.durationYears, 35),
        filingStatus: form.filingStatus,
        acaHouseholdSize: numberValue(form.acaHouseholdSize),
        acaResidenceRegion: form.acaResidenceRegion,
        annualExpenses: numberValue(form.annualExpenses),
        essentialExpenses: numberValue(form.essentialExpenses),
        cashBalance: numberValue(form.cashBalance),
        brokerageBalance: numberValue(form.brokerageBalance),
        traditionalBalance: numberValue(form.traditionalBalance),
        rothBalance: numberValue(form.rothBalance),
        annualWorkIncome: numberValue(form.annualWorkIncome),
        annualOutsideIncome: numberValue(form.annualOutsideIncome),
        annualSocialSecurity: 0,
        annualSocialSecurityAtFullRetirementAge: numberValue(
          form.annualSocialSecurityAtFullRetirementAge
        ),
        socialSecurityStartAge: numberValue(
          form.socialSecurityStartAge,
          defaultSocialSecurityClaimAge(
            form.socialSecurityBenefitType,
            targetRetirementAge
          )
        ),
        socialSecurityWorkerClaimAge:
          form.socialSecurityWorkerClaimAge === ''
            ? undefined
            : numberValue(form.socialSecurityWorkerClaimAge),
        socialSecurityWorkerBirthYear:
          form.socialSecurityWorkerBirthYear === ''
            ? undefined
            : numberValue(form.socialSecurityWorkerBirthYear),
        divorcedSpouseEligibilityConfirmed:
          form.divorcedSpouseEligibilityConfirmed,
        socialSecurityFullRetirementAge: numberValue(
          form.socialSecurityFullRetirementAge,
          67
        ),
        socialSecurityClaimantFullRetirementAge: numberValue(
          form.socialSecurityClaimantFullRetirementAge,
          67
        ),
        socialSecurityBenefitType: form.socialSecurityBenefitType,
        annualHealthcare: numberValue(form.annualHealthcare),
        reserveFloor: numberValue(form.reserveFloor),
        housingProceeds: numberValue(form.housingProceeds),
        housingEventAge: numberValue(
          form.housingEventAge,
          targetRetirementAge + 5
        ),
        housingCommitment: form.housingCommitment,
      })
      const analysis = analyzePlan(scenario, {
        reserveFloor: numberValue(form.reserveFloor),
        socialSecurityAge: numberValue(
          form.socialSecurityStartAge,
          defaultSocialSecurityClaimAge(
            form.socialSecurityBenefitType,
            targetRetirementAge
          )
        ),
      })
      onComplete(analysis)
    } catch (error) {
      setErrors([
        error instanceof Error
          ? error.message
          : 'The plan could not be modeled. Check the entered values.',
      ])
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="text-center">
        <p className="text-primary text-sm font-semibold tracking-wide uppercase">
          Retirement plan mode
        </p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight">
          Model the transition, not just the portfolio
        </h2>
        <p className="text-muted-foreground mt-2">
          Enter the assumptions that determine when work can end, which bridge
          years are exposed, and what survives a bad start.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => {
            setForm(CONSERVATIVE_SAMPLE)
            setErrors([])
          }}
        >
          Load conservative sample
        </Button>
      </div>

      {errors.length > 0 && (
        <Card className="border-destructive/50">
          <CardContent className="pt-6">
            <ul className="text-destructive list-inside list-disc space-y-1 text-sm">
              {errors.map(error => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Timeline and household</CardTitle>
          <CardDescription>
            These inputs anchor every annual projection row.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {field('currentAge', 'Current age')}
          {field('targetRetirementAge', 'Target retirement age')}
          {field('durationYears', 'Projection years', {
            hint: 'Must include the target retirement year.',
          })}
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="plan-filingStatus">Filing status</Label>
            <select
              id="plan-filingStatus"
              value={form.filingStatus}
              onChange={event =>
                setForm(previous => ({
                  ...previous,
                  filingStatus: event.target.value as FilingStatus,
                }))
              }
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            >
              <option value="single">Single</option>
              <option value="married_filing_jointly">
                Married filing jointly
              </option>
              <option value="head_of_household">Head of household</option>
            </select>
          </div>
          {field('acaHouseholdSize', 'ACA tax-family size', {
            hint: 'Include yourself and every person in the Marketplace tax family, including dependents. This is not inferred from filing status.',
            min: '1',
            step: '1',
          })}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="plan-acaResidenceRegion">
              ACA residence region
            </Label>
            <select
              id="plan-acaResidenceRegion"
              value={form.acaResidenceRegion}
              onChange={event =>
                setForm(previous => ({
                  ...previous,
                  acaResidenceRegion: event.target
                    .value as HealthcareACAResidenceRegion,
                }))
              }
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            >
              <option value="contiguous_us">Contiguous United States</option>
              <option value="alaska">Alaska</option>
              <option value="hawaii">Hawaii</option>
            </select>
            <p className="text-muted-foreground text-xs">
              Alaska and Hawaii tables are not yet modeled. Those selections
              fail closed until their official rules are added.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spending and assets</CardTitle>
          <CardDescription>
            Use today&apos;s dollars. The deterministic engine applies its
            documented inflation and withdrawal rules.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {field('annualExpenses', 'Annual spending', { prefix: '$' })}
          {field('essentialExpenses', 'Essential annual spending', {
            prefix: '$',
            hint: 'Must not exceed annual spending.',
          })}
          {field('cashBalance', 'Cash reserve', { prefix: '$' })}
          {field('brokerageBalance', 'Taxable brokerage', { prefix: '$' })}
          {field('traditionalBalance', 'Traditional retirement accounts', {
            prefix: '$',
          })}
          {field('rothBalance', 'Roth accounts', { prefix: '$' })}
          {field('reserveFloor', 'Minimum reserve floor', {
            prefix: '$',
            hint: 'Used by the verdict at Social Security age.',
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Income and healthcare</CardTitle>
          <CardDescription>
            Optional income is still modeled explicitly when entered as zero,
            allowing the solver to show the bridge requirement.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {field('annualWorkIncome', 'Annual work income', { prefix: '$' })}
          {field('annualOutsideIncome', 'Annual outside income', {
            prefix: '$',
          })}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="plan-socialSecurityBenefitType">
              Social Security benefit type
            </Label>
            <select
              id="plan-socialSecurityBenefitType"
              value={form.socialSecurityBenefitType}
              onChange={event =>
                setForm(previous => ({
                  ...previous,
                  socialSecurityBenefitType: event.target
                    .value as SocialSecurityBenefitType,
                }))
              }
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            >
              <option value="worker">My worker benefit</option>
              <option value="spouse">Spouse benefit</option>
              <option value="divorced_spouse">Divorced-spouse benefit</option>
              <option value="survivor">Survivor benefit</option>
            </select>
            <p className="text-muted-foreground text-xs">
              Choose the record that supplies the amount below. The engine
              applies the claim-age rule for that benefit type.
            </p>
          </div>
          {field(
            'annualSocialSecurityAtFullRetirementAge',
            'Annual record benefit at full retirement age',
            {
              prefix: '$',
              hint: "Use the worker record amount. For spouse benefits, use the worker's FRA amount; for survivor benefits, use the deceased worker's amount if known. The projection uses a fixed conservative 85% taxable planning assumption.",
            }
          )}
          <p className="text-muted-foreground text-xs sm:col-span-2">
            SSA estimates can assume continued future earnings. If you plan to
            stop work before claiming, enter a benefit estimate recalculated for
            your planned stop-work age. RetireRunway does not infer that
            adjustment.
          </p>
          {field('socialSecurityStartAge', 'Social Security start age', {
            min: form.socialSecurityBenefitType === 'survivor' ? '60' : '62',
            max:
              form.socialSecurityBenefitType === 'survivor' ? undefined : '70',
            step: 'any',
          })}
          {form.socialSecurityBenefitType === 'spouse' &&
            field(
              'socialSecurityWorkerClaimAge',
              'Associated worker claim age',
              {
                min: '62',
                max: '70',
                step: 'any',
                hint: 'Spouse benefits cannot start before the associated worker is entitled.',
              }
            )}
          {form.socialSecurityBenefitType === 'worker' &&
            field('socialSecurityWorkerBirthYear', 'Worker birth year', {
              min: '1900',
              step: '1',
              hint: 'Required only when claiming after full retirement age; the model supports the 1943-and-later delayed-credit rule.',
            })}
          {form.socialSecurityBenefitType === 'divorced_spouse' && (
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={form.divorcedSpouseEligibilityConfirmed}
                onChange={event =>
                  setForm(previous => ({
                    ...previous,
                    divorcedSpouseEligibilityConfirmed: event.target.checked,
                  }))
                }
              />
              <span>
                I confirm that the divorced-spouse benefit eligibility
                requirements are met.
              </span>
            </label>
          )}
          {field(
            'socialSecurityFullRetirementAge',
            'Record owner full retirement age',
            {
              hint: 'Usually 66–67. Check the SSA estimate for the worker or deceased worker record.',
              step: 'any',
            }
          )}
          {form.socialSecurityBenefitType !== 'worker' &&
            field(
              'socialSecurityClaimantFullRetirementAge',
              'Claimant full retirement age',
              {
                hint: "Use the claimant's own SSA full retirement age. This controls spouse, divorced-spouse, and survivor reductions.",
                step: 'any',
              }
            )}
          {field('annualHealthcare', 'Annual healthcare estimate', {
            prefix: '$',
            hint: 'An explicit estimate; legal subsidy rules are not inferred.',
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Committed and available levers</CardTitle>
          <CardDescription>
            Only committed events affect the base plan. The stress view keeps
            available housing proceeds separate for comparison.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {field('housingProceeds', 'Potential net housing proceeds', {
            prefix: '$',
          })}
          {field('housingEventAge', 'Housing transaction age')}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="plan-housingCommitment">Housing commitment</Label>
            <select
              id="plan-housingCommitment"
              value={form.housingCommitment}
              onChange={event =>
                setForm(previous => ({
                  ...previous,
                  housingCommitment: event.target
                    .value as PlanFormState['housingCommitment'],
                }))
              }
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            >
              <option value="committed">Committed to the base plan</option>
              <option value="available">Available, but not assumed</option>
              <option value="aspirational">Aspirational only</option>
            </select>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} disabled={isRunning}>
          Back
        </Button>
        <Button className="flex-1" onClick={runPlan} disabled={isRunning}>
          {isRunning ? 'Modeling plan...' : 'Run retirement plan'}
        </Button>
      </div>
    </div>
  )
}
