// plan_check engine (REQ-MCP-47): the snapshot against the owner's rules.
import { describe, expect, it } from 'vitest'
import { PlanCheckError, checkPlan } from '../plan-check'
import type { Holding, PlanRules, Portfolio, UserProfile } from '../types'

function holding(
  id: string,
  symbol: string,
  assetClass: Holding['assetClass'],
  currentValue: number,
  costBasis = currentValue
): Holding {
  return {
    id,
    symbol,
    name: symbol,
    assetClass,
    shares: currentValue / 100,
    costBasis,
    currentPrice: 100,
    currentValue,
  }
}

// $1,000,000: 80% stocks. 401(k) holds VOO $500K, VXUS $100K, IBTG $50K, cash $10K;
// the joint taxable account holds VOO $200K (half gain) and BND $140K.
const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    {
      id: 'a-401k',
      name: 'BrokerageLink',
      institution: 'Fidelity',
      accountType: '401k',
      cashBalance: 10_000,
      cds: [],
      holdings: [
        holding('h1', 'VOO', 'us_equity', 500_000, 300_000),
        holding('h2', 'VXUS', 'intl_equity', 100_000),
        holding('h3', 'IBTG', 'us_bond', 50_000),
      ],
    },
    {
      id: 'a-joint',
      name: 'Joint WROS',
      institution: 'Fidelity',
      accountType: 'brokerage',
      cashBalance: 0,
      cds: [],
      holdings: [
        holding('h4', 'VOO', 'us_equity', 200_000, 100_000),
        holding('h5', 'BND', 'us_bond', 140_000),
      ],
    },
  ],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 100_000,
}

const schedule: PlanRules['sellSchedule'] = [
  {
    id: 'chunk 1',
    dueDate: '2026-11-17',
    symbol: 'VOO',
    amount: 50_000,
    accountType: '401k',
  },
  {
    id: 'chunk 2',
    dueDate: '2026-12-15',
    symbol: 'VOO',
    amount: 50_000,
    accountType: '401k',
  },
  {
    id: 'chunk 3',
    dueDate: '2027-01-15',
    symbol: 'VOO',
    amount: 55_000,
    accountType: '401k',
  },
]

const rules: PlanRules = {
  targetEquityShare: 0.64,
  protectedAccountTypes: ['brokerage'],
  sellSchedule: schedule,
}

describe('REQ-MCP-47 plan check', () => {
  it('measures stock share, drift and cash buffer from the snapshot', () => {
    const r = checkPlan(portfolio, profile, rules, '2026-11-20')
    expect(r.measures.totalValue).toBe(1_000_000)
    expect(r.measures.equityValue).toBe(800_000)
    expect(r.measures.equityShare).toBeCloseTo(0.8, 10)
    expect(r.measures.drift).toBeCloseTo(0.16, 10)
    expect(r.measures.excessEquity).toBe(160_000)
    // REQ-MCP-62: the $10K cash sits in the 401(k), so none of it is liquid.
    expect(r.measures.cashBuffer).toBe(0)
    expect(r.measures.retirementAccountCash).toBe(10_000)
    expect(r.measures.outsideCash).toBe(0)
    expect(r.measures.cashBufferYears).toBe(0)
    expect(r.snapshotAgeDays).toBe(3)
  })

  it('recommends the overdue chunk from the 401(k), tax-free, never the protected taxable account', () => {
    const r = checkPlan(portfolio, profile, rules, '2026-11-20')
    expect(r.status).toBe('action_needed')
    const sale = r.recommendations.find(rec => rec.kind === 'scheduled_sale')
    expect(sale?.priority).toBe(1)
    expect(sale?.amount).toBe(50_000)
    expect(sale?.trades).toEqual([
      {
        action: 'sell',
        symbol: 'VOO',
        accountName: 'BrokerageLink',
        accountType: '401k',
        amount: 50_000,
        estimatedTax: 0,
      },
    ])
    expect(sale?.action).toContain('3 days overdue')
    expect(r.headline).toMatch(
      /^Action needed: Sell \$50,000 VOO in BrokerageLink/
    )
    expect(r.schedule.map(item => item.status)).toEqual([
      'overdue',
      'upcoming',
      'upcoming',
    ])
    expect(r.nextScheduledSale?.id).toBe('chunk 2')
    // The trade lowers the stock share by exactly the sale.
    expect(r.measures.equityShareAfter).toBeCloseTo(0.75, 10)
    // Proceeds stay inside the 401(k): the liquid buffer does not move.
    expect(r.measures.cashBufferYearsAfter).toBe(0)
  })

  it('REQ-MCP-62 counts only liquid cash toward the buffer, never cash inside a 401(k)', () => {
    const r = checkPlan(portfolio, profile, rules, '2026-11-20')
    const cash = r.recommendations.find(rec => rec.kind === 'cash_buffer')
    // One year of $100K spending, none of it liquid: the 401(k) sale does not help.
    expect(cash?.amount).toBe(100_000)
    expect(cash?.action).toBe(
      'Build $100,000 of liquid cash outside retirement accounts (savings, money market or Treasuries in a taxable account).'
    )
    expect(cash?.reason).toContain(
      '$10,000 more in cash, CDs and ladder funds inside retirement accounts does not count'
    )
    // A Treasury ladder ETF inside the 401(k) is still not liquid.
    const withLadder = checkPlan(
      portfolio,
      profile,
      { ...rules, bufferSymbols: ['ibtg'] },
      '2026-11-20'
    )
    expect(withLadder.measures.cashBuffer).toBe(0)
    expect(withLadder.measures.retirementAccountCash).toBe(60_000)
    expect(
      withLadder.recommendations.find(rec => rec.kind === 'cash_buffer')?.amount
    ).toBe(100_000)
    // Bank savings outside the snapshot count, and cash in a taxable account counts.
    const withSavings = checkPlan(
      portfolio,
      profile,
      { ...rules, outsideCash: 60_000 },
      '2026-11-20'
    )
    expect(withSavings.measures.cashBuffer).toBe(60_000)
    expect(
      withSavings.recommendations.find(rec => rec.kind === 'cash_buffer')
        ?.amount
    ).toBe(40_000)
    const taxableCash: typeof portfolio = {
      ...portfolio,
      accounts: portfolio.accounts.map(account =>
        account.accountType === 'brokerage'
          ? { ...account, cashBalance: 100_000 }
          : account
      ),
    }
    const covered = checkPlan(taxableCash, profile, rules, '2026-11-20')
    expect(covered.measures.cashBuffer).toBe(100_000)
    expect(
      covered.recommendations.some(rec => rec.kind === 'cash_buffer')
    ).toBe(false)
  })

  it('is on schedule when no chunk is due and the upcoming ones cover the excess', () => {
    const r = checkPlan(
      portfolio,
      profile,
      {
        ...rules,
        minCashBufferYears: 0,
        sellSchedule: [
          { ...schedule[0], done: true },
          { ...schedule[1], amount: 80_000 },
          { ...schedule[2], amount: 80_000 },
        ],
      },
      '2026-11-20'
    )
    expect(r.status).toBe('on_schedule')
    expect(r.headline).toContain('chunk 2')
    // A sale marked done on or after the snapshot date asks for a re-import first.
    expect(r.recommendations[0].kind).toBe('refresh_snapshot')
  })

  it('without a schedule, sells the excess once outside the band, tax-advantaged first', () => {
    const r = checkPlan(
      portfolio,
      profile,
      { targetEquityShare: 0.64, minCashBufferYears: 0 },
      '2026-11-20'
    )
    const sell = r.recommendations.find(rec => rec.kind === 'rebalance_sell')
    expect(sell?.amount).toBe(160_000)
    expect(sell?.trades.every(trade => trade.accountType === '401k')).toBe(true)
    expect(r.measures.equityShareAfter).toBeCloseTo(0.64, 10)
  })

  it('uses the taxable account only when allowed and needed, with estimated tax on the gain', () => {
    const r = checkPlan(
      portfolio,
      profile,
      { targetEquityShare: 0.1, minCashBufferYears: 0 },
      '2026-11-20'
    )
    const sell = r.recommendations.find(rec => rec.kind === 'rebalance_sell')
    expect(sell?.amount).toBe(700_000)
    const taxable = sell?.trades.find(
      trade => trade.accountType === 'brokerage'
    )
    // $100K of the $200K VOO lot is gain: $100K × 50% × 22%.
    expect(taxable?.amount).toBe(100_000)
    expect(taxable?.estimatedTax).toBe(11_000)
  })

  it('caps a scheduled chunk at the dollars still above target, and skips it at target', () => {
    const capped = checkPlan(
      portfolio,
      profile,
      { ...rules, targetEquityShare: 0.77, minCashBufferYears: 0 },
      '2026-11-20'
    )
    const sale = capped.recommendations.find(
      rec => rec.kind === 'scheduled_sale'
    )
    expect(sale?.amount).toBe(30_000)
    const atTarget = checkPlan(
      portfolio,
      profile,
      { ...rules, targetEquityShare: 0.8, minCashBufferYears: 0 },
      '2026-11-20'
    )
    const skip = atTarget.recommendations.find(
      rec => rec.kind === 'scheduled_sale'
    )
    expect(skip?.amount).toBe(0)
    expect(skip?.action).toMatch(/^Skip chunk 1/)
    expect(atTarget.status).toBe('on_plan')
  })

  it('does not count a scheduled bond sale as stocks sold, so the stock drift is still flagged', () => {
    // IBTG is a bond fund: selling it does not lower the 80% stock share.
    const r = checkPlan(
      portfolio,
      profile,
      {
        targetEquityShare: 0.7,
        protectedAccountTypes: ['brokerage'],
        minCashBufferYears: 0,
        sellSchedule: [
          {
            id: 'bonds',
            dueDate: '2026-11-17',
            symbol: 'IBTG',
            amount: 50_000,
          },
        ],
      },
      '2026-11-20'
    )
    const sale = r.recommendations.find(rec => rec.kind === 'scheduled_sale')
    expect(sale?.amount).toBe(0)
    expect(sale?.action).toContain('no IBTG stock holding')
    const sell = r.recommendations.find(rec => rec.kind === 'rebalance_sell')
    expect(sell?.amount).toBe(100_000)
    expect(sell?.trades.every(trade => trade.symbol !== 'IBTG')).toBe(true)
    expect(r.measures.equityShareAfter).toBeCloseTo(0.7, 10)
  })

  it('does not count an upcoming bond chunk as stocks to be sold', () => {
    const upcomingBond = (amount: number) =>
      checkPlan(
        portfolio,
        profile,
        {
          targetEquityShare: 0.7,
          protectedAccountTypes: ['brokerage'],
          minCashBufferYears: 0,
          sellSchedule: [
            { id: 'bonds', dueDate: '2026-12-15', symbol: 'IBTG', amount },
          ],
        },
        '2026-11-20'
      )
    // Stocks are 80% vs 70% ± 5: the bond chunk cannot fix that.
    const r = upcomingBond(50_000)
    expect(r.status).toBe('action_needed')
    const sell = r.recommendations.find(rec => rec.kind === 'rebalance_sell')
    expect(sell?.amount).toBe(100_000)
    expect(r.measures.equityShareAfter).toBeCloseTo(0.7, 10)
    // A smaller bond chunk does not shrink the stock sale either.
    const small = upcomingBond(20_000).recommendations.find(
      rec => rec.kind === 'rebalance_sell'
    )
    expect(small?.amount).toBe(100_000)
  })

  it('recommends buying when stocks fall below the band', () => {
    const r = checkPlan(
      portfolio,
      profile,
      { targetEquityShare: 0.9, minCashBufferYears: 0 },
      '2026-11-20'
    )
    const buy = r.recommendations.find(rec => rec.kind === 'rebalance_buy')
    expect(buy?.amount).toBe(100_000)
  })

  it('flags a stale snapshot', () => {
    const r = checkPlan(portfolio, profile, rules, '2027-01-05')
    expect(r.recommendations[0].kind).toBe('refresh_snapshot')
    expect(r.recommendations[0].reason).toContain('49 days old')
  })

  it('is deterministic and rejects bad input', () => {
    expect(checkPlan(portfolio, profile, rules, '2026-11-20')).toEqual(
      checkPlan(portfolio, profile, rules, '2026-11-20')
    )
    expect(() => checkPlan(portfolio, profile, rules, '2026-11-16')).toThrow(
      PlanCheckError
    )
    expect(() => checkPlan(portfolio, profile, rules, '2026-02-30')).toThrow(
      'not a calendar date'
    )
    expect(() =>
      checkPlan(portfolio, profile, { targetEquityShare: 1.2 }, '2026-11-20')
    ).toThrow('from 0 to 1')
  })
})
