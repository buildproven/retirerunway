// Balance sheet from an aggregator list (REQ-MCP-72). Invented balances only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BalanceSheetError,
  compareWithPlan,
  maskAccountNumbers,
  readBalanceSheet,
} from '../balance-sheet'
import type { UserProfile } from '../types'

const text = readFileSync(
  join(
    __dirname,
    '../../../skills/retire-runway/fixtures/balances/empower-sample.txt'
  ),
  'utf8'
)

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 96_000,
  home: { estimatedValue: 650_000 },
  mortgage: {
    balance: 255_000,
    asOfDate: '2026-10-01',
    rate: 0.03,
    monthlyPayment: 1_500,
    payoffDate: '2050-11-01',
  },
  planRules: { targetEquityShare: 0.6, outsideCash: 20_000 },
}

describe('readBalanceSheet', () => {
  const sheet = readBalanceSheet(text, '2026-11-24', [
    { account: 'HYSA', amount: 25_000, purpose: 'college' },
  ])

  it('sorts each line and ignores section totals', () => {
    expect(sheet.lines).toHaveLength(13)
    expect(sheet.totals).toMatchObject({
      cash: 41_200,
      earmarked: 25_000,
      freeCash: 16_200,
      investments: 905_000,
      creditCards: 12_300,
      mortgage: 250_000,
      home: 700_000,
    })
    expect(sheet.totals.netWorth).toBe(
      41_200 + 905_000 + 700_000 - 12_300 - 250_000
    )
  })

  it('masks account numbers and flags stale accounts', () => {
    expect(sheet.lines.map(l => l.name).join(' ')).not.toMatch(/4821|7712/)
    expect(maskAccountNumbers('Visa ...7712')).toBe('Visa ••••')
    expect(sheet.checks.map(c => c.id)).toContain('stale-account')
    expect(sheet.checks.find(c => c.id === 'stale-account')?.message).toMatch(
      /2025-09-04/
    )
  })

  it('keeps a 401 in a name and reads debts as amounts owed', () => {
    const one = readBalanceSheet('Plan 401 $1,000\nVisa -$500', '2026-11-24')
    expect(one.lines[0]).toMatchObject({
      name: 'Plan 401',
      category: 'otherAsset',
      amount: 1_000,
    })
    expect(one.lines[1]).toMatchObject({ category: 'creditCard', amount: 500 })
  })

  it('refuses an earmark larger than the account or with no account', () => {
    expect(() =>
      readBalanceSheet(text, '2026-11-24', [
        { account: 'HYSA', amount: 31_000, purpose: 'x' },
      ])
    ).toThrow(BalanceSheetError)
    expect(() =>
      readBalanceSheet(text, '2026-11-24', [
        { account: 'Nowhere', amount: 1, purpose: 'x' },
      ])
    ).toThrow(/no account name/)
    expect(() => readBalanceSheet('nothing here', '2026-11-24')).toThrow(
      /no account lines/
    )
  })

  it('checks the plan and proposes profile changes without saving', () => {
    const checked = compareWithPlan(sheet, profile, {
      asOfDate: '2026-11-01',
      totalValue: 850_000,
    })
    const ids = checked.checks.map(c => c.id)
    expect(ids).toEqual(
      expect.arrayContaining(['thin-cash', 'snapshot-differs'])
    )
    // 16,200 free cash vs 12,300 of card debt: not over.
    expect(ids).not.toContain('debt-over-free-cash')
    expect(checked.checks.find(c => c.id === 'thin-cash')?.message).toMatch(
      /2 months/
    )
    const fields = Object.fromEntries(
      checked.proposedChanges.map(c => [c.field, c.proposed])
    )
    expect(fields).toMatchObject({
      'planRules.outsideCash': 16_200,
      consumerDebt: 12_300,
      'mortgage.balance': 250_000,
      'mortgage.asOfDate': '2026-11-24',
      'home.estimatedValue': 700_000,
    })
    const tight = compareWithPlan(
      readBalanceSheet(text, '2026-11-24', [
        { account: 'HYSA', amount: 30_000, purpose: 'college' },
      ]),
      profile,
      undefined
    )
    expect(tight.checks.map(c => c.id)).toContain('debt-over-free-cash')
  })
})
