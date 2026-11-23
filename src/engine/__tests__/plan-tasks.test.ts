// One-off plan tasks in plan_check (REQ-MCP-61).
import { describe, expect, it } from 'vitest'
import { userProfileSchema } from '../../mcp/schemas'
import { PlanCheckError, checkPlan } from '../plan-check'
import type { Holding, PlanRules, Portfolio, UserProfile } from '../types'

function holding(
  id: string,
  symbol: string,
  assetClass: Holding['assetClass'],
  currentValue: number
): Holding {
  return {
    id,
    symbol,
    name: symbol,
    assetClass,
    shares: currentValue / 100,
    costBasis: currentValue,
    currentPrice: 100,
    currentValue,
  }
}

// $1,000,000 exactly on a 64% target with one year of liquid cash in a
// taxable account.
const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    {
      id: 'k',
      name: 'BrokerageLink',
      institution: 'Fidelity',
      accountType: '401k',
      cashBalance: 0,
      cds: [],
      holdings: [
        holding('h1', 'VOO', 'us_equity', 640_000),
        holding('h2', 'BND', 'us_bond', 260_000),
      ],
    },
    {
      id: 't',
      name: 'Joint',
      institution: 'Fidelity',
      accountType: 'brokerage',
      cashBalance: 100_000,
      cds: [],
      holdings: [],
    },
  ],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 100_000,
}

const rules = (tasks: PlanRules['tasks']): PlanRules => ({
  targetEquityShare: 0.64,
  tasks,
})

const nqdc = {
  id: 'nqdc-fund-switch',
  dueDate: '2026-11-20',
  action: 'Switch the NQDC high-yield fund to the most stable option',
}
const roll = {
  id: 'ibtg-roll',
  dueDate: '2026-12-15',
  action: 'Roll the IBTG payout and idle FDRXX into later CD rungs',
}

describe('REQ-MCP-61 plan tasks', () => {
  it('is on plan with no tasks, and an overdue task needs action', () => {
    expect(checkPlan(portfolio, profile, rules([]), '2026-11-23').status).toBe(
      'on_plan'
    )
    const result = checkPlan(portfolio, profile, rules([nqdc]), '2026-11-23')
    expect(result.status).toBe('action_needed')
    expect(result.headline).toBe(
      'Action needed: Switch the NQDC high-yield fund to the most stable option (nqdc-fund-switch, 3 days overdue).'
    )
    expect(result.tasks).toEqual([
      { ...nqdc, status: 'overdue', daysOverdue: 3 },
    ])
    expect(result.recommendations[0]).toMatchObject({
      priority: 1,
      kind: 'task',
      amount: 0,
      trades: [],
      reason: 'your task list',
    })
  })

  it('lists a task due within a week without needing action, and drops it once done', () => {
    const soon = checkPlan(portfolio, profile, rules([roll]), '2026-12-09')
    expect(soon.status).toBe('on_plan')
    expect(soon.recommendations.map(r => r.action)).toEqual([
      'Roll the IBTG payout and idle FDRXX into later CD rungs (ibtg-roll, due 2026-12-15).',
    ])
    const far = checkPlan(portfolio, profile, rules([roll]), '2026-11-23')
    expect(far.recommendations).toEqual([])
    expect(far.tasks[0]?.status).toBe('upcoming')
    const today = checkPlan(portfolio, profile, rules([roll]), '2026-12-15')
    expect(today.status).toBe('action_needed')
    expect(today.headline).toContain('(ibtg-roll, due today)')
    const done = checkPlan(
      portfolio,
      profile,
      rules([{ ...nqdc, done: true }]),
      '2026-11-23'
    )
    expect(done.status).toBe('on_plan')
    expect(done.tasks[0]?.status).toBe('done')
  })

  it('rejects duplicate ids and bad dates, and validates the profile field', () => {
    expect(() =>
      checkPlan(portfolio, profile, rules([nqdc, nqdc]), '2026-11-23')
    ).toThrow(PlanCheckError)
    expect(() =>
      checkPlan(
        portfolio,
        profile,
        rules([{ ...nqdc, dueDate: '2026-13-40' }]),
        '2026-11-23'
      )
    ).toThrow(PlanCheckError)
    expect(
      userProfileSchema.safeParse({ ...profile, planRules: rules([nqdc]) })
        .success
    ).toBe(true)
    expect(
      userProfileSchema.safeParse({
        ...profile,
        planRules: rules([{ ...nqdc, action: '' }]),
      }).success
    ).toBe(false)
  })
})
