// The engine proposes the plan rules (REQ-MCP-64) and the cash buffer starts
// when it is needed (REQ-MCP-65). Invented household only.
import { describe, expect, it } from 'vitest'
import { planCheckInput, userProfileSchema } from '../../mcp/schemas'
import { checkPlan } from '../plan-check'
import {
  POLICY_DEFAULTS,
  earlyPenaltyAt,
  proposePlanPolicy,
  withEquityShare,
} from '../plan-policy'
import {
  calculateEquityFraction,
  calculatePortfolioValue,
} from '../portfolio-math'
import type {
  AccountType,
  Holding,
  PlanRules,
  Portfolio,
  UserProfile,
} from '../types'

function holding(
  id: string,
  symbol: string,
  assetClass: Holding['assetClass'],
  value: number,
  basis = value
): Holding {
  return {
    id,
    symbol,
    name: symbol,
    assetClass,
    shares: value / 100,
    costBasis: basis,
    currentPrice: 100,
    currentValue: value,
  }
}

function account(
  id: string,
  name: string,
  accountType: AccountType,
  holdings: Holding[],
  cashBalance = 0
) {
  return {
    id,
    name,
    institution: 'Broker',
    accountType,
    cashBalance,
    cds: [],
    holdings,
  }
}

// About $1.2M: a 401(k) window that is 85% stocks, a taxable account with
// gains, deferred compensation and an IRA.
const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    account('w', 'Window', '401k', [
      holding('w1', 'SPY', 'us_equity', 700_000),
      holding('w2', 'BND', 'us_bond', 100_000),
      holding('w3', 'SPAXX', 'money_market', 20_000),
    ]),
    account('t', 'Joint', 'brokerage', [
      holding('t1', 'VTI', 'us_equity', 60_000, 30_000),
    ]),
    account('n', 'Deferred', 'nqdc', [
      holding('n1', 'FUND', 'us_equity', 120_000),
    ]),
    account('i', 'IRA', 'traditional_ira', [
      holding('i1', 'VXUS', 'intl_equity', 40_000),
    ]),
  ],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 90_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_500,
  annualContributions: 30_000,
  stateTaxRate: 0.0495,
  stateExemptsRetirementIncome: true,
  preMedicareHealthcare: 25_000,
  separationAge: 60,
  nqdcPayout: { startAge: 60, years: 5 },
  spouse: {
    currentAge: 52,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_800,
  },
}

const currentRules: PlanRules = {
  targetEquityShare: 0.8,
  driftBand: 0.05,
  minCashBufferYears: 1,
  sellSchedule: [
    {
      id: 's1',
      dueDate: '2026-12-15',
      symbol: 'SPY',
      amount: 30_000,
      accountType: '401k',
    },
  ],
  tasks: [{ id: 't1', dueDate: '2027-01-31', action: 'Pay off the card' }],
  cdLadder: { accountType: '401k', firstYear: 2027, lastYear: 2030 },
}

const run = { seed: 42, paths: 200 }
const withRules: UserProfile = { ...profile, planRules: currentRules }
const proposal = proposePlanPolicy(portfolio, withRules, '2026-11-24', run)

describe('withEquityShare', () => {
  it('rebalances every account to the share and keeps totals', () => {
    for (const share of [0.3, 0.6]) {
      const test = withEquityShare(portfolio, share)
      const total = calculatePortfolioValue(test)
      expect(total).toBeCloseTo(calculatePortfolioValue(portfolio), 6)
      expect(calculateEquityFraction(test, total)).toBeCloseTo(share, 9)
      const joint = test.accounts.find(a => a.id === 't')
      expect(joint?.holdings.reduce((s, h) => s + h.costBasis, 0)).toBeCloseTo(
        30_000,
        6
      )
    }
  })
})

describe('earlyPenaltyAt', () => {
  it('applies the 59½ rule, the Rule of 55 and the exempt accounts', () => {
    expect(earlyPenaltyAt('401k', 57, 56)).toBe(false) // left at 56: Rule of 55
    expect(earlyPenaltyAt('401k', 57, 54)).toBe(true) // left before 55
    expect(earlyPenaltyAt('traditional_ira', 57, 56)).toBe(true)
    expect(earlyPenaltyAt('traditional_ira', 60, 56)).toBe(false)
    expect(earlyPenaltyAt('brokerage', 50, 50)).toBe(false)
    expect(earlyPenaltyAt('457b', 50, 50)).toBe(false)
  })
})

describe('propose_plan_rules: stock share (REQ-MCP-64)', () => {
  it('tests every candidate plus the current target, long-run and forecast', () => {
    expect(proposal.equityTest.rows.map(r => r.equityShare)).toEqual([
      0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
    ])
    for (const row of proposal.equityTest.rows) {
      expect(row.worse).toBe(Math.min(row.successRate, row.forecastSuccessRate))
      // Forecast returns are lower than long-run ones: never a better result.
      expect(row.forecastSuccessRate).toBeLessThanOrEqual(
        row.successRate + 1e-9
      )
    }
  })

  it('proposes the lowest share within a point of the best worse-of-two rate', () => {
    const rows = proposal.equityTest.rows
    const best = Math.max(...rows.map(r => r.worse))
    const eligible = rows.filter(
      r => r.worse >= best - POLICY_DEFAULTS.tieTolerance
    )
    expect(proposal.equityTest.proposed).toBe(eligible[0]?.equityShare)
  })

  it('is deterministic', () => {
    const again = proposePlanPolicy(portfolio, withRules, '2026-11-24', run)
    expect(JSON.stringify(again)).toBe(JSON.stringify(proposal))
  })
})

describe('propose_plan_rules: ladder', () => {
  const ladder = proposal.ladder

  it('funds the first retirement years, not the years before', () => {
    expect(proposal.retirementYear).toBe(2033)
    expect(ladder?.firstYear).toBe(2033)
    // Bridge to Social Security is 7 years; at most 5 rungs.
    expect(ladder?.lastYear).toBe(2037)
    expect(ladder?.rungs.map(r => r.age)).toEqual([60, 61, 62, 63, 64])
    expect(ladder?.rungs.map(r => r.buyableNow)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
    expect(ladder?.rungs.every(r => !r.penalty)).toBe(true)
  })

  it('never holds more than the bonds the proposed share leaves', () => {
    const total = calculatePortfolioValue(portfolio)
    const share = proposal.proposedRules.targetEquityShare
    expect(ladder?.total ?? 0).toBeLessThanOrEqual((1 - share) * total + 1)
    for (const rung of ladder?.rungs ?? []) {
      expect(rung.target).toBeLessThanOrEqual(rung.need + 0.01)
      expect(rung.need).toBeGreaterThan(0)
    }
  })

  it('flags the current ladder that matures before retirement', () => {
    const finding = proposal.findings.find(f => f.rule === 'cdLadder')
    expect(finding?.status).toBe('change')
    expect(finding?.reason).toContain('before you retire in 2033')
    expect(proposal.proposedRules.cdLadder?.firstYear).toBe(2033)
  })

  it('flags rungs that would carry the early penalty', () => {
    const early = proposePlanPolicy(
      portfolio,
      { ...withRules, targetRetirementAge: 55, separationAge: 54 },
      '2026-11-24',
      run
    )
    expect(early.ladder?.rungs.some(r => r.penalty)).toBe(true)
    expect(early.notes.join(' ')).toContain('10% early-withdrawal penalty')
  })
})

describe('propose_plan_rules: buffer, accounts, sales, inputs', () => {
  it('starts the cash buffer a year before retirement', () => {
    const finding = proposal.findings.find(f => f.rule === 'bufferStartAge')
    expect(finding?.proposed).toBe(59)
    expect(proposal.proposedRules.bufferStartAge).toBe(59)
  })

  it('protects the taxable account that holds gains', () => {
    expect(proposal.proposedRules.protectedAccountTypes).toContain('brokerage')
  })

  it('asks for bank savings and keeps the owner tasks', () => {
    expect(proposal.findings.find(f => f.rule === 'outsideCash')?.status).toBe(
      'needs_input'
    )
    expect(proposal.proposedRules.tasks).toEqual(currentRules.tasks)
  })

  it('replaces its own earlier sales on the next review instead of adding to them', () => {
    const first = proposePlanPolicy(
      portfolio,
      { ...profile, planRules: { ...currentRules, sellSchedule: [] } },
      '2026-11-24',
      run
    )
    const again = proposePlanPolicy(
      portfolio,
      { ...profile, planRules: first.proposedRules },
      '2026-11-24',
      run
    )
    const ids = (again.proposedRules.sellSchedule ?? []).map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const total = (rules: typeof first.proposedRules) =>
      (rules.sellSchedule ?? [])
        .filter(s => s.id.startsWith('policy-'))
        .reduce((sum, s) => sum + s.amount, 0)
    expect(total(again.proposedRules)).toBe(total(first.proposedRules))
    // The same sales worked out again are kept, not reported as a change.
    const sales = again.findings.find(f => f.rule === 'sellSchedule')
    expect(sales?.status).toBe('keep')
    expect(
      again.findings.some(
        f => f.rule === 'sellSchedule' && f.status === 'change'
      )
    ).toBe(false)
    // Different earlier sales (here half the size) are replaced: a change.
    const halved = {
      ...first.proposedRules,
      sellSchedule: (first.proposedRules.sellSchedule ?? []).map(s =>
        s.id.startsWith('policy-') ? { ...s, amount: s.amount / 2 } : s
      ),
    }
    const shifted = proposePlanPolicy(
      portfolio,
      { ...profile, planRules: halved },
      '2026-11-24',
      run
    )
    expect(shifted.findings.find(f => f.rule === 'sellSchedule')?.status).toBe(
      'change'
    )
    expect(total(shifted.proposedRules)).toBe(total(first.proposedRules))
  })

  it('schedules the sales a lower share needs, monthly on the 15th, in $1,000 units', () => {
    const forced = proposePlanPolicy(
      portfolio,
      { ...profile, planRules: { ...currentRules, sellSchedule: [] } },
      '2026-11-24',
      run
    )
    const sales = forced.findings.find(f => f.rule === 'sellSchedule')
    expect(forced.proposedRules.targetEquityShare).toBeLessThan(0.8)
    {
      expect(sales?.status).toBe('add')
      const added = forced.proposedRules.sellSchedule ?? []
      expect(added.map(s => s.dueDate)).toEqual([
        '2026-12-15',
        '2027-01-15',
        '2027-02-15',
      ])
      for (const sale of added) {
        expect(sale.amount % 1_000).toBe(0)
        expect(sale.accountType).toBe('401k')
        expect(sale.symbol).toBe('SPY')
      }
      const after = checkPlan(
        portfolio,
        profile,
        forced.proposedRules,
        '2026-11-24'
      )
      expect(after.recommendations.some(r => r.kind === 'rebalance_sell')).toBe(
        false
      )
    }
  })

  it('counts changes and adds, and returns rules the schema accepts', () => {
    expect(proposal.changes).toBe(
      proposal.findings.filter(f => f.status === 'change' || f.status === 'add')
        .length
    )
    expect(
      userProfileSchema.safeParse({
        ...profile,
        planRules: proposal.proposedRules,
      }).success
    ).toBe(true)
  })
})

describe('plan_check: bufferStartAge (REQ-MCP-65)', () => {
  const rules: PlanRules = { targetEquityShare: 0.85, minCashBufferYears: 1 }

  it('asks for the buffer only from bufferStartAge', () => {
    const now = checkPlan(portfolio, profile, rules, '2026-11-24')
    expect(now.recommendations.some(r => r.kind === 'cash_buffer')).toBe(true)
    const later = checkPlan(
      portfolio,
      profile,
      { ...rules, bufferStartAge: 59 },
      '2026-11-24'
    )
    expect(later.recommendations.some(r => r.kind === 'cash_buffer')).toBe(
      false
    )
    expect(later.measures.cashBufferYears).toBe(now.measures.cashBufferYears)
    const due = checkPlan(
      portfolio,
      { ...profile, currentAge: 59 },
      { ...rules, bufferStartAge: 59 },
      '2026-11-24'
    )
    expect(due.recommendations.some(r => r.kind === 'cash_buffer')).toBe(true)
  })

  it('rejects an out-of-range start age', () => {
    expect(() =>
      checkPlan(
        portfolio,
        profile,
        { ...rules, bufferStartAge: 12 },
        '2026-11-24'
      )
    ).toThrow()
    expect(
      planCheckInput.safeParse({ rules: { ...rules, bufferStartAge: 59 } })
        .success
    ).toBe(true)
  })
})
