import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { calculateTaxBreakdown } from '@/engine/tax-brackets'
import { optimizeRothConversion } from '@/engine/roth-conversion'
import { withRateLimit } from '@/lib/with-rate-limit'
import { withValidation } from '@/lib/with-validation'
import { TaxRequestSchema } from '@/lib/validation-schemas'
import { authenticateApiKey } from '@/lib/api-key-auth'

type TaxRequest = z.infer<typeof TaxRequestSchema>

// POST /api/v1/tax
// Tax analysis endpoint: bracket breakdown and Roth conversion optimization.

async function handlePOST(req: NextRequest & { validatedBody?: unknown }) {
  const auth = authenticateApiKey(req)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    // withValidation already parsed and validated the body against
    // TaxRequestSchema before this handler runs.
    const body = req.validatedBody as TaxRequest
    const {
      portfolio,
      userProfile,
      filingStatus = 'single',
      ordinaryIncome,
      capitalGains = 0,
      includeRothOptimizer = true,
    } = body

    const income = ordinaryIncome ?? userProfile.annualExpenses
    const stateTaxRate = userProfile.stateTaxRate ?? 0

    const taxBreakdown = calculateTaxBreakdown(
      income,
      capitalGains,
      filingStatus,
      stateTaxRate
    )

    const result: Record<string, unknown> = { taxBreakdown }

    if (includeRothOptimizer && portfolio) {
      result.rothConversion = optimizeRothConversion(portfolio, userProfile, {
        filingStatus,
      })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('API tax error:', error)
    return NextResponse.json(
      { error: 'Tax analysis failed. Check your input data.' },
      { status: 500 }
    )
  }
}

export const POST = withRateLimit(
  withValidation(handlePOST, TaxRequestSchema),
  'api'
)
