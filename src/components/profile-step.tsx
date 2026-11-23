'use client'

import { useState } from 'react'
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
import { usePortfolioStore } from '@/store/portfolio-store'

interface ProfileStepProps {
  onComplete: () => void
  onBack: () => void
}

/** '' represents "not yet entered" — distinct from a deliberate 0. */
type NumericField = number | ''

interface FormState {
  currentAge: NumericField
  targetRetirementAge: NumericField
  annualExpenses: NumericField
  socialSecurityAge: NumericField
  socialSecurityMonthly: NumericField
  pensionMonthly: NumericField
  federalTaxBracket: NumericField
}

const EMPTY_FORM: FormState = {
  currentAge: '',
  targetRetirementAge: '',
  annualExpenses: '',
  socialSecurityAge: '',
  socialSecurityMonthly: '',
  pensionMonthly: '',
  federalTaxBracket: '',
}

/**
 * Deliberately conservative illustrative values. Shown only when the user
 * explicitly asks for them, never as silent defaults.
 */
const CONSERVATIVE_SAMPLE: FormState = {
  currentAge: 58,
  targetRetirementAge: 65,
  annualExpenses: 70000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 2000,
  pensionMonthly: 0,
  federalTaxBracket: 22,
}

export function ProfileStep({ onComplete, onBack }: ProfileStepProps) {
  const setUserProfile = usePortfolioStore(s => s.setUserProfile)
  const existing = usePortfolioStore(s => s.userProfile)

  // No financial values are prefilled. A user who never touches a field must
  // not end up with a plan built on a number the product invented — examples
  // live in placeholders instead. Use "Load conservative sample" to populate
  // every field at once with clearly-labelled sample values.
  const [form, setForm] = useState<FormState>(() =>
    existing
      ? {
          currentAge: existing.currentAge,
          targetRetirementAge: existing.targetRetirementAge,
          annualExpenses: existing.annualExpenses,
          socialSecurityAge: existing.socialSecurityAge ?? '',
          socialSecurityMonthly: existing.socialSecurityMonthly ?? '',
          pensionMonthly: existing.pensionMonthly ?? '',
          federalTaxBracket:
            existing.federalTaxBracket != null
              ? existing.federalTaxBracket * 100
              : '',
        }
      : EMPTY_FORM
  )

  const [errors, setErrors] = useState<Record<string, string>>({})

  function validate(): boolean {
    const e: Record<string, string> = {}
    const { currentAge, targetRetirementAge, annualExpenses } = form

    if (currentAge === '') e.currentAge = 'Enter your current age'
    else if (currentAge < 25 || currentAge > 90)
      e.currentAge = 'Enter an age between 25 and 90'

    if (targetRetirementAge === '')
      e.targetRetirementAge = 'Enter your target retirement age'
    else if (currentAge !== '' && targetRetirementAge <= currentAge)
      e.targetRetirementAge = 'Must be after current age'

    if (annualExpenses === '') e.annualExpenses = 'Enter your annual expenses'
    else if (annualExpenses <= 0)
      e.annualExpenses = 'Enter your annual expenses'

    if (form.federalTaxBracket === '')
      e.federalTaxBracket = 'Enter your federal tax bracket'

    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSubmit() {
    if (!validate()) return
    // validate() guarantees the required fields are populated.
    setUserProfile({
      currentAge: form.currentAge as number,
      targetRetirementAge: form.targetRetirementAge as number,
      annualExpenses: form.annualExpenses as number,
      socialSecurityAge: form.socialSecurityAge || undefined,
      socialSecurityMonthly: form.socialSecurityMonthly || undefined,
      pensionMonthly: form.pensionMonthly || undefined,
      federalTaxBracket: (form.federalTaxBracket as number) / 100,
    })
    onComplete()
  }

  function loadSample() {
    setForm(CONSERVATIVE_SAMPLE)
    setErrors({})
  }

  function field(
    label: string,
    key: keyof FormState,
    opts?: {
      prefix?: string
      suffix?: string
      hint?: string
      placeholder?: string
    }
  ) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={key}>{label}</Label>
        <div className="relative">
          {opts?.prefix && (
            <span className="text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 text-sm">
              {opts.prefix}
            </span>
          )}
          <Input
            id={key}
            type="number"
            value={form[key]}
            placeholder={opts?.placeholder}
            onChange={e => {
              const raw = e.target.value
              setForm(f => ({ ...f, [key]: raw === '' ? '' : Number(raw) }))
            }}
            className={opts?.prefix ? 'pl-7' : opts?.suffix ? 'pr-7' : ''}
          />
          {opts?.suffix && (
            <span className="text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2 text-sm">
              {opts.suffix}
            </span>
          )}
        </div>
        {opts?.hint && (
          <p className="text-muted-foreground text-xs">{opts.hint}</p>
        )}
        {errors[key] && (
          <p className="text-destructive text-xs">{errors[key]}</p>
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold tracking-tight">Your Profile</h2>
        <p className="text-muted-foreground mt-2">
          Tell us about your retirement timeline and expenses.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={loadSample}
        >
          Load conservative sample
        </Button>
        <p className="text-muted-foreground mt-2 text-xs">
          Fills every field with illustrative values you can edit. Your own
          numbers are never assumed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Retirement Details</CardTitle>
          <CardDescription>Used to model scenario projections</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {field('Current Age', 'currentAge', { placeholder: 'e.g. 58' })}
            {field('Target Retirement Age', 'targetRetirementAge', {
              placeholder: 'e.g. 65',
            })}
          </div>
          {field('Annual Expenses in Retirement', 'annualExpenses', {
            prefix: '$',
            placeholder: 'e.g. 70000',
            hint: "Today's dollars — inflation will be applied automatically",
          })}
          {field('Federal Tax Bracket', 'federalTaxBracket', {
            suffix: '%',
            placeholder: 'e.g. 22',
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Income Sources</CardTitle>
          <CardDescription>
            Optional — leave blank if not applicable
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {field('Social Security Start Age', 'socialSecurityAge', {
              placeholder: 'e.g. 67',
            })}
            {field('Social Security Monthly', 'socialSecurityMonthly', {
              prefix: '$',
              placeholder: 'e.g. 2000',
              hint: 'From your SSA statement. Note SSA estimates usually assume you keep working until this age.',
            })}
          </div>
          {field('Pension Monthly', 'pensionMonthly', {
            prefix: '$',
            placeholder: 'e.g. 0',
          })}
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button className="flex-1" onClick={handleSubmit}>
          Run Scenarios
        </Button>
      </div>
    </div>
  )
}
