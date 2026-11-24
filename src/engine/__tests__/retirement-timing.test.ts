// When can I retire, which levers bring it forward, and the plan review
// (REQ-MCP-66..69). Invented household only.
import { describe, expect, it } from 'vitest'
import { reviewPlanInput, userProfileSchema } from '../../mcp/schemas'
import { humanChecksFor, reviewPlan } from '../plan-review'
import {
  earliestBySearch,
  earliestRetirement,
  goalsOf,
  rankLevers,
  retireAt,
} from '../retirement-timing'
import type { AccountType, Holding, Portfolio, UserProfile } from '../types'

function holding(
  id: string,
  assetClass: Holding['assetClass'],
  value: number
): Holding {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    assetClass,
    shares: 1,
    costBasis: value,
    currentPrice: value,
    currentValue: value,
  }
}
function account(
  id: string,
  accountType: AccountType,
  stocks: number,
  bonds: number
) {
  return {
    id,
    name: id,
    institution: 'Broker',
    accountType,
    cashBalance: 0,
    cds: [],
    holdings: [
      holding(`${id}s`, 'us_equity', stocks),
      holding(`${id}b`, 'us_bond', bonds),
    ],
  }
}

const portfolio: Portfolio = {
  id: 'p',
  name: 'Test',
  asOfDate: '2026-11-17',
  accounts: [
    account('k', '401k', 560_000, 240_000),
    account('t', 'brokerage', 60_000, 20_000),
  ],
}

const profile: UserProfile = {
  currentAge: 53,
  targetRetirementAge: 60,
  annualExpenses: 85_000,
  socialSecurityAge: 67,
  socialSecurityMonthly: 3_200,
  annualContributions: 30_000,
  stateTaxRate: 0.04,
  preMedicareHealthcare: 24_000,
  acaPremiumTaxCredit: true,
  separationAge: 60,
  spendingPhases: [{ startAge: 60, annualExpenses: 85_000 }],
  home: { estimatedValue: 600_000 },
  spouse: {
    currentAge: 52,
    socialSecurityAge: 67,
    socialSecurityMonthly: 1_500,
  },
}

const run = { seed: 42, paths: 200 }

describe('retireAt', () => {
  it('moves what was tied to the old retirement age and nothing else', () => {
    const moved = retireAt(
      {
        ...profile,
        nqdcPayout: { startAge: 60, years: 5 },
        lumpSums: [{ name: 'Pension', age: 60, amount: 10_000 }],
        homeSale: { age: 60, salePrice: 600_000 },
      },
      58
    )
    expect(moved.targetRetirementAge).toBe(58)
    expect(moved.separationAge).toBe(58)
    expect(moved.nqdcPayout?.startAge).toBe(58)
    expect(moved.spendingPhases?.[0]?.startAge).toBe(58)
    expect(moved.homeSale?.age).toBe(58)
    // A lump sum at a fixed age (a pension's preservation age) stays put.
    expect(moved.lumpSums?.[0]?.age).toBe(60)
    const partTime = retireAt(
      {
        ...profile,
        otherIncomeMonthly: 2_000,
        otherIncomeStartAge: 60,
        otherIncomeEndAge: 64,
      },
      58
    )
    expect([partTime.otherIncomeStartAge, partTime.otherIncomeEndAge]).toEqual([
      58, 62,
    ])
    const separate = retireAt({ ...profile, separationAge: 56 }, 58)
    expect(separate.separationAge).toBe(56)
  })
})

describe('earliest_retirement (REQ-MCP-66)', () => {
  const result = earliestRetirement(portfolio, profile, run)

  it('tests every age from next year to 70 and picks the first that meets both goals', () => {
    expect(result.ages.map(a => a.age)).toEqual(
      Array.from({ length: 17 }, (_, i) => 54 + i)
    )
    const first = result.ages.find(a => a.meetsGoal)
    expect(result.earliestAge).toBe(first?.age ?? null)
    for (const a of result.ages)
      expect(a.meetsGoal).toBe(
        a.successRate >= 0.85 - 1e-9 && a.forecastSuccessRate >= 0.75 - 1e-9
      )
  })

  it('a later retirement is never much worse, and the search agrees with the scan', () => {
    const at = (age: number) => result.ages.find(a => a.age === age)
    expect(at(70)?.successRate ?? 0).toBeGreaterThan(at(54)?.successRate ?? 1)
    const found = earliestBySearch(
      portfolio,
      profile,
      goalsOf(profile),
      run,
      54,
      70
    )
    expect(found?.age ?? null).toBe(result.earliestAge)
  })

  it('looser goals never give a later age; impossible goals give none', () => {
    const loose = earliestRetirement(
      portfolio,
      { ...profile, goals: { successRate: 0.6, forecastSuccessRate: 0.4 } },
      run
    )
    expect(loose.earliestAge ?? 99).toBeLessThanOrEqual(
      result.earliestAge ?? 99
    )
    const none = earliestRetirement(
      portfolio,
      {
        ...profile,
        annualExpenses: 400_000,
        spendingPhases: [{ startAge: 60, annualExpenses: 400_000 }],
        goals: { latestAge: 62 },
      },
      run
    )
    expect(none.earliestAge).toBeNull()
    expect(none.headline).toContain('needs a lever')
  })
})

describe('rank_levers (REQ-MCP-67)', () => {
  const ranking = rankLevers(portfolio, profile, {
    ...run,
    custom: [
      {
        name: 'Move to a cheaper town',
        changes: {
          homeSale: {
            age: 60,
            salePrice: 600_000,
            replacementHomeCost: 250_000,
          },
        },
      },
    ],
  })
  const byId = Object.fromEntries(ranking.levers.map(l => [l.id, l]))

  it('pulls every lever that fits, plus the custom one', () => {
    expect(Object.keys(byId).sort()).toEqual(
      [
        'custom_1',
        'downsize',
        'part_time',
        'save_more',
        'spend_10pct_less',
        'spend_5pct_less',
      ].sort()
    )
  })

  it('every lever helps or holds, and a deeper cut helps at least as much', () => {
    for (const lever of ranking.levers) {
      expect(lever.successChange).toBeGreaterThanOrEqual(-0.02)
      expect(lever.yearsEarlier ?? 0).toBeGreaterThanOrEqual(0)
    }
    expect(byId.spend_10pct_less?.successAtTarget ?? 0).toBeGreaterThanOrEqual(
      (byId.spend_5pct_less?.successAtTarget ?? 1) - 1e-9
    )
  })

  it('ranks by years earlier first', () => {
    const years = ranking.levers.map(l => l.yearsEarlier ?? 0)
    expect(years).toEqual([...years].sort((a, b) => b - a))
  })

  it('the levers together are at least as good as the best one alone', () => {
    expect(ranking.combined).not.toBeNull()
    const best = Math.min(
      ...ranking.levers
        .filter(l => l.group !== 'custom')
        .map(l => l.earliestAge ?? 99)
    )
    expect(ranking.combined?.earliestAge ?? 99).toBeLessThanOrEqual(best)
    expect(ranking.combined?.ids).not.toContain('custom_1')
  })

  it('is deterministic', () => {
    const again = rankLevers(portfolio, profile, {
      ...run,
      custom: [
        {
          name: 'Move to a cheaper town',
          changes: {
            homeSale: {
              age: 60,
              salePrice: 600_000,
              replacementHomeCost: 250_000,
            },
          },
        },
      ],
    })
    expect(JSON.stringify(again)).toBe(JSON.stringify(ranking))
  })
})

describe('review_plan (REQ-MCP-69)', () => {
  const withRules: UserProfile = {
    ...profile,
    lumpSums: [{ name: 'Overseas pension', age: 60, amount: 30_000 }],
    planRules: {
      targetEquityShare: 0.75,
      sellSchedule: [
        {
          id: 's1',
          dueDate: '2026-12-10',
          symbol: 'KS',
          amount: 10_000,
          accountType: '401k',
        },
      ],
    },
  }
  const review = reviewPlan(portfolio, withRules, '2027-01-05', run)

  it('leads with the verdict and when you can retire', () => {
    expect(review.headline.startsWith(review.standing.verdict)).toBe(true)
    expect(review.timing.targetAge).toBe(60)
    expect(review.levers.length).toBeGreaterThan(0)
  })

  it('asks for fresh positions when the snapshot is old', () => {
    expect(review.dataToRefresh.join(' ')).toContain('49 days old')
  })

  it('lists the decisions only the owner can make', () => {
    expect(
      review.ownerDecisions.some(d => d.startsWith('Approve or decline'))
    ).toBe(review.rules.changes > 0)
    expect(review.ownerDecisions.some(d => d.includes('outsideCash'))).toBe(
      true
    )
  })

  it('names what a human professional should check', () => {
    const who = humanChecksFor(portfolio, withRules)
      .map(c => c.what)
      .join(' | ')
    expect(who).toContain('Marketplace quote')
    expect(who).toContain('"Overseas pension"')
    expect(who).toContain('Wills')
    expect(who).toContain('survivor')
  })

  it('reviews again at the cadence, or sooner when something falls due', () => {
    expect(review.nextReviewDate).toBe('2027-02-04')
    const soon = reviewPlan(
      portfolio,
      {
        ...withRules,
        planRules: {
          targetEquityShare: 0.75,
          tasks: [{ id: 't', dueDate: '2027-01-20', action: 'Roll the CD' }],
        },
      },
      '2027-01-05',
      run
    )
    expect(soon.nextReviewDate).toBe('2027-01-20')
  })

  it('accepts goals and the review input', () => {
    expect(
      userProfileSchema.safeParse({
        ...profile,
        goals: { successRate: 0.8, reviewEveryDays: 30 },
      }).success
    ).toBe(true)
    expect(
      userProfileSchema.safeParse({ ...profile, goals: { successRate: 1.2 } })
        .success
    ).toBe(false)
    expect(reviewPlanInput.safeParse({ asOfDate: '2027-01-05' }).success).toBe(
      true
    )
  })
})
