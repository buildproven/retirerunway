// BUI-1940: a non-qualified deferred compensation (NQDC) account is pre-tax
// money. The CSV import names it `nqdc` (FR-13), the tax engine taxes every
// dollar drawn from it as ordinary income with no penalty (FR-04), the Roth
// conversion (FR-14) and Rule of 55 (FR-03) strategies leave it out, and the
// plan intake counts it in the pre-tax bucket (FR-01).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePortfolioCSV } from '../csv-parser'
import { estimateWithdrawalTax } from '../tax-brackets'
import { optimizeRothConversion } from '../roth-conversion'
import { analyzeRuleOf55 } from '../rule-of-55'
import { planBalancesFromPortfolio } from '../plan/intake'
import { generateTradePlan } from '../trade-plan'
import { PortfolioSchema } from '@/lib/validation-schemas'
import type { Account, AccountType, Portfolio, UserProfile } from '../types'

const fixtureDir = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'skills',
  'retire-runway',
  'fixtures',
  'csv'
)

function fixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf8')
}

function account(
  id: string,
  accountType: AccountType,
  cashBalance: number
): Account {
  return {
    id,
    name: id,
    institution: 'Fidelity',
    accountType,
    holdings: [],
    cds: [],
    cashBalance,
  }
}

function portfolio(accounts: Account[]): Portfolio {
  return { id: 'p', name: 'Test', accounts, asOfDate: '2026-11-15' }
}

const age54: UserProfile = {
  currentAge: 54,
  targetRetirementAge: 56,
  annualExpenses: 60_000,
  federalTaxBracket: 0.22,
  stateTaxRate: 0.05,
}

describe('FR-13 BUI-1940 CSV import names NQDC accounts', () => {
  const types = Object.fromEntries(
    parsePortfolioCSV(fixture('fidelity-nqdc.csv')).accounts.map(a => [
      a.name,
      a.accountType,
    ])
  )

  it('FR-13 reads the Fidelity non-qualified deferred compensation plan as nqdc', () => {
    expect(types['NON-QUALIFIED DEFERRED COMPENSATION PLAN - EXAMPLE CO']).toBe(
      'nqdc'
    )
  })

  it('FR-13 reads an account named NQDC as nqdc', () => {
    expect(types['Example Co NQDC Excess Plan']).toBe('nqdc')
  })

  it('FR-13 keeps a 457(b) deferred compensation plan as 457b', () => {
    expect(types['State of Example 457(b) Deferred Compensation Plan']).toBe(
      '457b'
    )
  })

  it('FR-13 keeps an ordinary brokerage account as brokerage', () => {
    expect(types['Joint WROS - TOD']).toBe('brokerage')
  })
})

describe('FR-04 BUI-1940 tax engine taxes NQDC draws as ordinary income', () => {
  it('FR-04 taxes a $10,000 nqdc withdrawal at age 54 as $10,000 ordinary income with no penalty', () => {
    const [estimate] = estimateWithdrawalTax(
      portfolio([account('nqdc', 'nqdc', 120_000)]),
      age54,
      10_000
    )
    expect(estimate.accountType).toBe('nqdc')
    expect(estimate.withdrawalAmount).toBe(10_000)
    expect(estimate.taxableAmount).toBe(10_000)
    // Federal bracket + state only: no 10% early-withdrawal penalty and no
    // capital-gains rate.
    expect(estimate.effectiveRate).toBe(0.27)
    expect(estimate.estimatedTax).toBe(2_700)
  })

  it('FR-04 taxes an nqdc draw the same as a 401(k) draw of the same size', () => {
    const [nqdc, k401] = estimateWithdrawalTax(
      portfolio([
        account('nqdc', 'nqdc', 50_000),
        account('k', '401k', 50_000),
      ]),
      age54,
      20_000
    )
    expect(nqdc.taxableAmount).toBe(k401.taxableAmount)
    expect(nqdc.estimatedTax).toBe(k401.estimatedTax)
  })

  it('FR-04 throws on an account type it has no tax treatment for, rather than taxing it as brokerage', () => {
    const unknown = {
      ...account('x', 'brokerage', 1_000),
      accountType: 'pension' as unknown as AccountType,
    }
    expect(() =>
      estimateWithdrawalTax(portfolio([unknown]), age54, 1_000)
    ).toThrow('No tax treatment for account type pension')
  })
})

describe('FR-14 BUI-1940 Roth conversion leaves NQDC out', () => {
  it('FR-14 finds no pre-tax balance to convert in an nqdc-only portfolio', () => {
    const plan = optimizeRothConversion(
      portfolio([account('nqdc', 'nqdc', 120_000)]),
      { ...age54, targetRetirementAge: 60 }
    )
    expect(plan.traditionalBalanceStart).toBe(0)
    expect(plan.totalConverted).toBe(0)
    expect(plan.years).toEqual([])
  })

  it('FR-14 converts only the 401(k) balance when an nqdc account sits beside it', () => {
    const plan = optimizeRothConversion(
      portfolio([
        account('nqdc', 'nqdc', 120_000),
        account('k', '401k', 200_000),
      ]),
      { ...age54, targetRetirementAge: 60 }
    )
    expect(plan.traditionalBalanceStart).toBe(200_000)
  })
})

describe('FR-03 BUI-1940 Rule of 55 leaves NQDC out', () => {
  it('FR-03 lists no eligible account for an nqdc-only portfolio', () => {
    const result = analyzeRuleOf55(
      portfolio([account('nqdc', 'nqdc', 120_000)]),
      age54
    )
    expect(result.eligibleAccounts).toEqual([])
    expect(result.eligible).toBe(false)
  })

  it('FR-03 lists only the 401(k) when an nqdc account sits beside it', () => {
    const result = analyzeRuleOf55(
      portfolio([
        account('nqdc', 'nqdc', 120_000),
        account('k', '401k', 200_000),
      ]),
      { ...age54, targetRetirementAge: 56 }
    )
    expect(result.eligibleAccounts.map(a => a.accountId)).toEqual(['k'])
    expect(result.totalEligibleValue).toBe(200_000)
  })
})

describe('FR-01 BUI-1940 plan intake counts NQDC as pre-tax', () => {
  it('FR-01 maps an nqdc balance to the traditional (pre-tax) bucket', () => {
    expect(
      planBalancesFromPortfolio(
        portfolio([
          account('nqdc', 'nqdc', 120_000),
          account('b', 'brokerage', 1_000),
        ])
      )
    ).toEqual({
      cashBalance: 1_000,
      brokerageBalance: 0,
      traditionalBalance: 120_000,
      rothBalance: 0,
    })
  })
})

describe('FR-14 BUI-1940 trade plan treats NQDC as tax-deferred', () => {
  it('FR-14 sells NQDC equity with no capital-gains tax impact', () => {
    const nqdc: Account = {
      ...account('nqdc', 'nqdc', 0),
      holdings: [
        {
          id: 'fxaix',
          symbol: 'FXAIX',
          name: 'FIDELITY 500 INDEX FUND',
          assetClass: 'us_equity',
          shares: 500,
          costBasis: 50_000,
          currentPrice: 200,
          currentValue: 100_000,
        },
      ],
    }
    const plan = generateTradePlan(portfolio([nqdc]), age54, {
      targetCashPosition: 20_000,
    })
    expect(plan.trades.length).toBeGreaterThan(0)
    expect(plan.trades.every(t => t.accountId === 'nqdc')).toBe(true)
    expect(plan.totalTaxImpact).toBe(0)
    expect(plan.trades[0].rationale).toContain('tax-advantaged')
  })
})

describe('FR-13 BUI-1940 API portfolio schema accepts NQDC', () => {
  it('FR-13 accepts an nqdc account and still rejects an unknown type', () => {
    const body = portfolio([account('nqdc', 'nqdc', 1_000)])
    expect(PortfolioSchema.safeParse(body).success).toBe(true)
    const bad = {
      ...body,
      accounts: [{ ...body.accounts[0], accountType: 'pension' }],
    }
    expect(PortfolioSchema.safeParse(bad).success).toBe(false)
  })
})
