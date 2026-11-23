// BUI-1912: analyze_plan takes plan balances from the newest snapshot.
// The intake balances map deterministically from a saved Portfolio snapshot.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildScenario,
  planBalancesFromPortfolio,
  withSnapshotBalances,
} from '../intake'
import type { PlanIntakeValues } from '../intake'
import type { Account, Portfolio } from '../../types'
import { calculatePortfolioValue } from '../../portfolio-math'

const staleValues: PlanIntakeValues = {
  currentAge: 58,
  targetRetirementAge: 65,
  durationYears: 35,
  filingStatus: 'married_filing_jointly',
  acaHouseholdSize: 2,
  acaResidenceRegion: 'contiguous_us',
  annualExpenses: 60_000,
  essentialExpenses: 40_000,
  cashBalance: 1,
  brokerageBalance: 2,
  traditionalBalance: 3,
  rothBalance: 4,
  annualWorkIncome: 100_000,
  annualOutsideIncome: 20_000,
  annualSocialSecurity: 0,
  annualSocialSecurityAtFullRetirementAge: 24_000,
  socialSecurityStartAge: 67,
  annualHealthcare: 12_000,
  reserveFloor: 100_000,
  housingProceeds: 0,
  housingEventAge: 70,
  housingCommitment: 'committed',
}

function account(
  id: string,
  accountType: Account['accountType'],
  parts: {
    cash?: number
    cd?: number
    moneyMarket?: number
    equity?: number
  }
): Account {
  return {
    id,
    name: id,
    institution: 'Test',
    accountType,
    cashBalance: parts.cash ?? 0,
    cds:
      parts.cd === undefined
        ? []
        : [
            {
              id: `${id}-cd`,
              institution: 'Test',
              principal: parts.cd,
              apy: 0.04,
              termMonths: 12,
              maturityDate: '2027-01-01',
              purchaseDate: '2026-01-01',
              earlyWithdrawalPenaltyMonths: 3,
            },
          ],
    holdings: [
      ...(parts.moneyMarket === undefined
        ? []
        : [
            {
              id: `${id}-mm`,
              symbol: 'SPAXX',
              name: 'Money market',
              assetClass: 'money_market' as const,
              shares: parts.moneyMarket,
              costBasis: parts.moneyMarket,
              currentPrice: 1,
              currentValue: parts.moneyMarket,
            },
          ]),
      ...(parts.equity === undefined
        ? []
        : [
            {
              id: `${id}-eq`,
              symbol: 'VTI',
              name: 'Total market',
              assetClass: 'us_equity' as const,
              shares: 1,
              costBasis: parts.equity / 2,
              currentPrice: parts.equity,
              currentValue: parts.equity,
            },
          ]),
    ],
  }
}

const snapshot: Portfolio = {
  id: 'snapshot-2026-10-01',
  name: 'Snapshot',
  asOfDate: '2026-10-01',
  accounts: [
    account('taxable', 'brokerage', {
      cash: 5_000,
      cd: 10_000,
      moneyMarket: 15_000,
      equity: 300_000,
    }),
    account('ira', 'traditional_ira', { cash: 1_000, equity: 200_000 }),
    account('rollover', 'rollover_ira', { equity: 50_000 }),
    account('k401', '401k', { moneyMarket: 4_000, equity: 100_000 }),
    account('b403', '403b', { equity: 10_000 }),
    account('b457', '457b', { equity: 20_000 }),
    account('hsa', 'hsa', { equity: 7_000 }),
    account('roth', 'roth_ira', { cash: 500, equity: 80_000 }),
    account('roth401k', 'roth_401k', { equity: 40_000 }),
  ],
}

describe('BUI-1912 plan balances from a saved snapshot', () => {
  it('BUI-1912-R1: maps each snapshot account into the intake balance buckets by tax treatment', () => {
    const balances = planBalancesFromPortfolio(snapshot)
    expect(balances).toEqual({
      cashBalance: 30_000,
      brokerageBalance: 300_000,
      traditionalBalance: 392_000,
      rothBalance: 120_500,
    })
    const total =
      balances.cashBalance +
      balances.brokerageBalance +
      balances.traditionalBalance +
      balances.rothBalance
    expect(total).toBe(calculatePortfolioValue(snapshot))
  })

  it('BUI-1912-R1: maps an imported brokerage CD holding to the cash reserve', () => {
    const imported: Portfolio = {
      ...snapshot,
      accounts: [
        {
          ...account('taxable', 'brokerage', { equity: 20_000 }),
          holdings: [
            {
              id: 'brokered-cd',
              symbol: 'CD-12M',
              name: 'Certificate of Deposit 12 Month',
              assetClass: 'cd',
              shares: 10_000,
              costBasis: 10_000,
              currentPrice: 1,
              currentValue: 10_000,
            },
            ...account('taxable-equity', 'brokerage', { equity: 20_000 })
              .holdings,
          ],
        },
      ],
    }

    expect(planBalancesFromPortfolio(imported)).toEqual({
      cashBalance: 10_000,
      brokerageBalance: 20_000,
      traditionalBalance: 0,
      rothBalance: 0,
    })
  })

  it('BUI-1912-R1: maps the committed sample snapshot fixture without losing value', () => {
    const { portfolio: fixture } = JSON.parse(
      readFileSync(
        path.resolve(
          __dirname,
          '../../../../skills/retire-runway/fixtures/sample-portfolio.json'
        ),
        'utf8'
      )
    ) as { portfolio: Portfolio }
    const balances = planBalancesFromPortfolio(fixture)
    const total =
      balances.cashBalance +
      balances.brokerageBalance +
      balances.traditionalBalance +
      balances.rothBalance
    expect(total).toBeCloseTo(calculatePortfolioValue(fixture), 2)
    for (const value of Object.values(balances)) {
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('BUI-1912-R1: replaces stale saved intake balances with the newest snapshot balances and keeps every other field', () => {
    const fresh = withSnapshotBalances(staleValues, snapshot)
    expect(fresh).toEqual({
      ...staleValues,
      cashBalance: 30_000,
      brokerageBalance: 300_000,
      traditionalBalance: 392_000,
      rothBalance: 120_500,
    })
    // Input is not mutated.
    expect(staleValues.cashBalance).toBe(1)

    const scenario = buildScenario(fresh)
    expect(
      Object.fromEntries(scenario.accounts.map(a => [a.id, a.balance]))
    ).toEqual({
      'cash-reserve': 30_000,
      brokerage: 300_000,
      traditional: 392_000,
      roth: 120_500,
    })
  })

  it('BUI-1912-R1: a newer snapshot changes the plan balances', () => {
    const newer: Portfolio = {
      ...snapshot,
      id: 'snapshot-2026-11-01',
      asOfDate: '2026-11-01',
      accounts: [account('taxable', 'brokerage', { equity: 999_000 })],
    }
    const older = withSnapshotBalances(staleValues, snapshot)
    const updated = withSnapshotBalances(older, newer)
    expect(updated.brokerageBalance).toBe(999_000)
    expect(updated.cashBalance).toBe(0)
    expect(updated.traditionalBalance).toBe(0)
    expect(updated.rothBalance).toBe(0)
  })

  it('BUI-1912-R1: is deterministic for the same snapshot', () => {
    const first = planBalancesFromPortfolio(snapshot)
    const second = planBalancesFromPortfolio(
      JSON.parse(JSON.stringify(snapshot)) as Portfolio
    )
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('BUI-1912-R1: rejects a snapshot account with an unknown account type', () => {
    const legacy = {
      ...snapshot,
      accounts: [
        {
          ...account('odd', 'brokerage', { equity: 1 }),
          accountType: 'annuity',
        },
      ],
    } as unknown as Portfolio
    expect(() => planBalancesFromPortfolio(legacy)).toThrow(/odd.*annuity/)
  })

  it('BUI-1912-R1: rejects a snapshot value that is not a finite number', () => {
    const broken: Portfolio = {
      ...snapshot,
      accounts: [account('taxable', 'brokerage', { equity: Number.NaN })],
    }
    expect(() => planBalancesFromPortfolio(broken)).toThrow(/taxable/)
  })

  it('BUI-1912-R1: rejects a snapshot whose bucket total is negative', () => {
    const margin: Portfolio = {
      ...snapshot,
      accounts: [account('taxable', 'brokerage', { cash: -5_000, equity: 1 })],
    }
    expect(() => withSnapshotBalances(staleValues, margin)).toThrow(
      /cashBalance/
    )
  })

  it('BUI-1912-R1: maps an empty snapshot to zero balances', () => {
    const empty: Portfolio = { ...snapshot, accounts: [] }
    expect(planBalancesFromPortfolio(empty)).toEqual({
      cashBalance: 0,
      brokerageBalance: 0,
      traditionalBalance: 0,
      rothBalance: 0,
    })
  })
})
