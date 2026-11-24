// CD and Treasury ladder in plan_check (REQ-MCP-63). Invented household only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { planCheckInput, userProfileSchema } from '../../mcp/schemas'
import {
  FDIC_LIMIT,
  QUOTE_STALE_DAYS,
  maturityYearFromName,
  planCdLadder,
} from '../cd-ladder'
import { parsePortfolioCSV } from '../csv-parser'
import { PlanCheckError, checkPlan } from '../plan-check'
import type {
  CdLadderRule,
  Holding,
  PlanRules,
  Portfolio,
  RateQuote,
  UserProfile,
} from '../types'

function holding(
  id: string,
  symbol: string,
  assetClass: Holding['assetClass'],
  currentValue: number,
  name = symbol
): Holding {
  return {
    id,
    symbol,
    name,
    assetClass,
    shares: currentValue / 100,
    costBasis: currentValue,
    currentPrice: 100,
    currentValue,
  }
}

// A 401(k) window with $30,000 idle money market, a 2027 Treasury ETF of
// $20,000, a 2026 Treasury ETF of $10,000 (matures before the ladder) and a
// brokered CD of $15,000 maturing in 2029.
function portfolio(extraCash = 0): Portfolio {
  return {
    id: 'p',
    name: 'Test',
    asOfDate: '2026-11-10',
    accounts: [
      {
        id: 'k',
        name: 'Window',
        institution: 'Broker',
        accountType: '401k',
        cashBalance: extraCash,
        cds: [],
        holdings: [
          holding('h1', 'SPY', 'us_equity', 500_000),
          holding('h2', 'SPAXX', 'money_market', 30_000),
          holding('h3', 'IBTH', 'us_bond', 20_000),
          holding('h4', 'IBTG', 'us_bond', 10_000),
          holding(
            'h5',
            '12345ABC9',
            'cd',
            15_000,
            'EXAMPLE BANK CD 4.50% 06/15/2029'
          ),
        ],
      },
      {
        id: 't',
        name: 'Joint',
        institution: 'Broker',
        accountType: 'brokerage',
        cashBalance: 80_000,
        cds: [],
        holdings: [],
      },
    ],
  }
}

const rule: CdLadderRule = {
  accountType: '401k',
  firstYear: 2027,
  lastYear: 2030,
}

const quotes: RateQuote[] = [
  {
    kind: 'cd',
    termYears: 1,
    apy: 0.048,
    callProtected: true,
    source: 'Q',
    quotedOn: '2026-11-23',
  },
  {
    kind: 'treasury',
    termYears: 1,
    apy: 0.046,
    source: 'Q',
    quotedOn: '2026-11-23',
  },
  {
    kind: 'cd',
    termYears: 2,
    apy: 0.052,
    callProtected: false,
    source: 'Q',
    quotedOn: '2026-11-23',
  },
  {
    kind: 'cd',
    termYears: 2,
    apy: 0.049,
    callProtected: true,
    source: 'Q',
    quotedOn: '2026-11-23',
  },
  {
    kind: 'treasury',
    termYears: 3,
    apy: 0.047,
    source: 'Q',
    quotedOn: '2026-11-23',
  },
  {
    kind: 'treasury',
    termYears: 4,
    apy: 0.05,
    source: 'Q',
    quotedOn: '2026-11-23',
  },
  {
    kind: 'cd',
    termYears: 4,
    apy: 0.05,
    callProtected: true,
    source: 'Q',
    quotedOn: '2026-11-23',
  },
]

describe('maturityYearFromName', () => {
  it('reads US and ISO dates, or nothing', () => {
    expect(maturityYearFromName('BANK CD 4.5% 06/15/2029')).toBe(2029)
    expect(maturityYearFromName('BANK CD 2031-01-02')).toBe(2031)
    expect(maturityYearFromName('BANK CD')).toBeUndefined()
  })
})

describe('planCdLadder', () => {
  const plan = planCdLadder(portfolio(), rule, {
    asOfDate: '2026-11-23',
    saleProceedsNow: [{ accountName: 'Window', amount: 40_000 }],
    saleProceedsLater: [{ accountName: 'Window', amount: 45_000 }],
    quotes,
  })

  it('sizes the ladder from what it holds and the money coming to it', () => {
    expect(plan).not.toBeNull()
    if (plan === null) return
    // held 20,000 (IBTH) + 15,000 (CD 2029); now 30,000 + 40,000; later 45,000 + 10,000 (IBTG).
    expect(plan.accountName).toBe('Window')
    expect(plan.idleCash).toBe(30_000)
    expect(plan.fundingNow).toBe(70_000)
    expect(plan.fundingLater).toBe(55_000)
    expect(plan.total).toBe(160_000)
    expect(plan.rungTarget).toBe(40_000)
    expect(plan.rollingIn.map(h => h.symbol)).toEqual(['IBTG'])
    expect(plan.heldInLadder.map(h => [h.symbol, h.year])).toEqual([
      ['IBTH', 2027],
      ['12345ABC9', 2029],
    ])
  })

  it('fills the earliest short rungs first, in $1,000 units, never past the cash ready now', () => {
    if (plan === null) return
    const byYear = Object.fromEntries(plan.rungs.map(r => [r.year, r]))
    expect(byYear[2027]?.shortfall).toBe(20_000)
    expect(byYear[2027]?.buyNow).toBe(20_000)
    expect(byYear[2028]?.buyNow).toBe(40_000)
    expect(byYear[2029]?.buyNow).toBe(10_000)
    expect(byYear[2030]?.buyNow).toBe(0)
    expect(plan.buyNowTotal).toBe(70_000)
    expect(plan.unplaced).toBe(0)
    for (const rung of plan.rungs) expect(rung.buyNow % 1_000).toBe(0)
  })

  it('takes the highest call-protected quote per term and skips callable CDs', () => {
    if (plan === null) return
    const byYear = Object.fromEntries(plan.rungs.map(r => [r.year, r]))
    expect(byYear[2027]?.quote?.kind).toBe('cd')
    expect(byYear[2027]?.quote?.apy).toBe(0.048)
    // The 5.2% callable CD is skipped; the 4.9% call-protected one wins.
    expect(byYear[2028]?.quote?.apy).toBe(0.049)
    // A tie goes to the Treasury (sells easily before maturity).
    expect(byYear[2030]?.quote?.kind).toBe('treasury')
    expect(byYear[2028]?.annualInterest).toBe(1_960)
    expect(plan.skippedCallableQuotes).toBe(1)
  })

  it('flags stale quotes, missing quotes and the FDIC limit', () => {
    const stale = planCdLadder(portfolio(600_000), rule, {
      asOfDate: '2026-12-15',
      saleProceedsNow: [],
      saleProceedsLater: [],
      quotes,
    })
    expect(stale?.notes.join(' ')).toContain(`${QUOTE_STALE_DAYS} days old`)
    expect(stale?.rungs.some(r => r.note?.includes('banks') === true)).toBe(
      stale?.rungs.some(r => r.buyNow > FDIC_LIMIT)
    )
    const big = planCdLadder(portfolio(2_000_000), rule, {
      asOfDate: '2026-11-23',
      saleProceedsNow: [],
      saleProceedsLater: [],
    })
    expect(big?.rungs[0]?.buyNow).toBeGreaterThan(FDIC_LIMIT)
    expect(big?.rungs[0]?.note).toContain('split across')
    expect(big?.notes[0]).toContain('no rate quotes')
  })

  it('drops past years and returns null once the ladder is over', () => {
    const later = planCdLadder(portfolio(), rule, {
      asOfDate: '2028-03-01',
      saleProceedsNow: [],
      saleProceedsLater: [],
    })
    expect(later?.firstYear).toBe(2028)
    expect(later?.rungs[0]?.termYears).toBe(1)
    expect(
      planCdLadder(portfolio(), rule, {
        asOfDate: '2031-01-01',
        saleProceedsNow: [],
        saleProceedsLater: [],
      })
    ).toBeNull()
  })
})

describe('plan_check with a ladder', () => {
  const profile: UserProfile = {
    currentAge: 53,
    targetRetirementAge: 60,
    annualExpenses: 80_000,
  }
  const rules: PlanRules = {
    targetEquityShare: 0.8,
    sellSchedule: [
      {
        id: 'c1',
        dueDate: '2026-11-17',
        symbol: 'SPY',
        amount: 40_000,
        accountType: '401k',
        done: true,
      },
      {
        id: 'c2',
        dueDate: '2026-12-15',
        symbol: 'SPY',
        amount: 45_000,
        accountType: '401k',
      },
    ],
    cdLadder: rule,
  }

  it('recommends the ladder buys with the sale already done as cash ready now', () => {
    const result = checkPlan(portfolio(), profile, rules, '2026-11-23', quotes)
    expect(result.cdLadder?.fundingNow).toBe(70_000)
    const rec = result.recommendations.find(r => r.kind === 'cd_ladder')
    expect(rec?.amount).toBe(70_000)
    expect(rec?.action).toContain('2027–2030 ladder in Window')
    expect(rec?.action).toContain('2028 $40,000 (2-yr call-protected CD 4.90%)')
    expect(rec?.trades.map(t => [t.action, t.symbol, t.amount])).toEqual([
      ['buy', 'CD 2027', 20_000],
      ['buy', 'CD 2028', 40_000],
      ['buy', 'TREASURY 2029', 10_000],
    ])
    expect(result.status).toBe('action_needed')
  })

  it('without a ladder rule returns no ladder', () => {
    const { cdLadder, ...rest } = rules
    void cdLadder
    expect(
      checkPlan(portfolio(), profile, rest, '2026-11-23').cdLadder
    ).toBeNull()
  })

  it('reports a bad ladder rule as a field error', () => {
    expect(() =>
      checkPlan(
        portfolio(),
        profile,
        { ...rules, cdLadder: { ...rule, lastYear: 2026 } },
        '2026-11-23'
      )
    ).toThrow(PlanCheckError)
  })

  it('accepts the ladder rule and quotes in the tool schemas', () => {
    expect(
      userProfileSchema.safeParse({ ...profile, planRules: rules }).success
    ).toBe(true)
    expect(planCheckInput.safeParse({ rateQuotes: quotes }).success).toBe(true)
    expect(
      planCheckInput.safeParse({
        rateQuotes: [{ ...quotes[0], termYears: 11 }],
      }).success
    ).toBe(false)
  })
})

describe('ladder account and sales already done (REQ-MCP-63)', () => {
  const profile: UserProfile = {
    currentAge: 53,
    targetRetirementAge: 60,
    annualExpenses: 80_000,
  }
  // A core 401(k) with a stable-value fund and cash, next to the window.
  function twoAccounts(): Portfolio {
    const base = portfolio()
    return {
      ...base,
      accounts: [
        {
          id: 'core',
          name: 'Core plan',
          institution: 'Broker',
          accountType: '401k',
          cashBalance: 5_000,
          cds: [],
          holdings: [holding('c1', 'STABLE', 'money_market', 20_000)],
        },
        ...base.accounts,
      ],
    }
  }

  it('buys in the account of the type that holds the ladder money', () => {
    const plan = planCdLadder(twoAccounts(), rule, {
      asOfDate: '2026-11-23',
      saleProceedsNow: [],
      saleProceedsLater: [],
    })
    expect(plan?.accountName).toBe('Window')
    // The core plan's cash is not ladder money: only the window's 30,000.
    expect(plan?.idleCash).toBe(30_000)
    const named = planCdLadder(
      twoAccounts(),
      { ...rule, accountName: 'core' },
      { asOfDate: '2026-11-23', saleProceedsNow: [], saleProceedsLater: [] }
    )
    expect(named?.accountName).toBe('Core plan')
    expect(named?.idleCash).toBe(25_000)
  })

  it('takes a sale marked done after the snapshot off the stocks, so it is not sold or counted twice', () => {
    const rules: PlanRules = {
      targetEquityShare: 0.7,
      sellSchedule: [
        {
          id: 'c1',
          dueDate: '2026-11-17',
          symbol: 'SPY',
          amount: 60_000,
          accountType: '401k',
          done: true,
        },
      ],
      cdLadder: rule,
    }
    const before = checkPlan(
      portfolio(),
      profile,
      {
        ...rules,
        sellSchedule: [
          { ...rules.sellSchedule![0]!, done: false, dueDate: '2026-12-15' },
        ],
      },
      '2026-11-23'
    )
    const after = checkPlan(portfolio(), profile, rules, '2026-11-23')
    expect(after.measures.equityValue).toBe(
      before.measures.equityValue - 60_000
    )
    expect(after.measures.retirementAccountCash).toBe(
      before.measures.retirementAccountCash + 60_000
    )
    // 440,000 of 655,000 is 67.2%, inside 70% ± 5%: nothing more to sell.
    expect(after.recommendations.some(r => r.kind === 'rebalance_sell')).toBe(
      false
    )
    expect(after.recommendations[0]?.kind).toBe('refresh_snapshot')
    // The ladder gets the 60,000 once: 30,000 idle + 60,000 done.
    expect(after.cdLadder?.fundingNow).toBe(90_000)
  })
})

describe('a Fidelity positions file with brokered CDs (REQ-MCP-63)', () => {
  const csv = readFileSync(
    join(
      __dirname,
      '../../../skills/retire-runway/fixtures/csv/fidelity-cds.csv'
    ),
    'utf8'
  )
  const parsed = parsePortfolioCSV(csv)
  const imported: Portfolio = {
    id: 'import',
    name: 'Import',
    asOfDate: '2026-12-01',
    accounts: parsed.accounts,
  }

  it('reads each CD as a CD, valued from the Current value column, not quantity × price', () => {
    const window = imported.accounts.find(a => a.name === 'BrokerageLink')
    expect(window?.accountType).toBe('401k')
    const cds = window?.holdings.filter(h => h.assetClass === 'cd') ?? []
    expect(cds.map(h => h.currentValue)).toEqual([
      35_003.5, 36_007.2, 6_000, 25_994.8,
    ])
    // A Treasury note is fixed income, and nothing in the file defaults to stock.
    const note = window?.holdings.find(h => h.symbol === '91282CAB1')
    expect(note?.assetClass).toBe('us_bond')
    expect(parsed.warnings.join(' ')).not.toContain('as us_equity')
  })

  it('places each CD in the rung of its maturity year', () => {
    const plan = planCdLadder(imported, rule, {
      asOfDate: '2026-12-01',
      saleProceedsNow: [],
      saleProceedsLater: [],
    })
    expect(plan?.accountName).toBe('BrokerageLink')
    expect(plan?.unknownMaturity).toEqual([])
    // The Treasury note counts in its 2029 rung too.
    expect(plan?.heldInLadder.map(h => h.year)).toEqual([
      2027, 2028, 2029, 2030, 2029,
    ])
    expect(plan?.idleCash).toBe(9_000)
  })
})
