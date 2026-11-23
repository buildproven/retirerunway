import { describe, it, expect, beforeEach } from 'vitest'
import { usePortfolioStore } from '@/store/portfolio-store'
import type {
  Portfolio,
  Account,
  Holding,
  CD,
  UserProfile,
  ScenarioResult,
} from '@/engine/types'

const makeHolding = (overrides?: Partial<Holding>): Holding => ({
  id: 'h1',
  symbol: 'VTI',
  name: 'Vanguard Total Stock Market ETF',
  assetClass: 'us_equity',
  shares: 100,
  costBasis: 15000,
  currentPrice: 250,
  currentValue: 25000,
  ...overrides,
})

const makeCD = (overrides?: Partial<CD>): CD => ({
  id: 'cd1',
  institution: 'Marcus',
  principal: 50000,
  apy: 0.045,
  termMonths: 12,
  maturityDate: '2027-01-15',
  purchaseDate: '2026-01-15',
  earlyWithdrawalPenaltyMonths: 6,
  ...overrides,
})

const makeAccount = (overrides?: Partial<Account>): Account => ({
  id: 'a1',
  name: 'Fidelity Brokerage',
  institution: 'Fidelity',
  accountType: 'brokerage',
  holdings: [makeHolding()],
  cds: [],
  cashBalance: 10000,
  ...overrides,
})

const makePortfolio = (overrides?: Partial<Portfolio>): Portfolio => ({
  id: 'p1',
  name: 'My Portfolio',
  accounts: [makeAccount()],
  asOfDate: '2026-01-30',
  ...overrides,
})

const stubScenarioResults: ScenarioResult[] = [
  {
    scenarioType: 'base',
    parameters: {
      type: 'base',
      label: 'Base',
      equityReturnRate: 0.07,
      bondReturnRate: 0.04,
      inflationRate: 0.03,
      durationYears: 30,
      drawdownPercent: 0.04,
    },
    projections: [],
    runwayYears: 25,
    depletionAge: 80,
    sequenceOfReturnsRisk: 5,
  },
]

function seedWithScenarios() {
  usePortfolioStore.getState().setPortfolio(makePortfolio())
  usePortfolioStore.getState().setScenarioResults(stubScenarioResults)
  expect(usePortfolioStore.getState().scenarioResults).toHaveLength(1)
}

describe('portfolioStore', () => {
  beforeEach(() => {
    usePortfolioStore.setState({
      portfolio: null,
      userProfile: null,
      scenarioResults: [],
    })
  })

  it('initializes with null state', () => {
    const state = usePortfolioStore.getState()
    expect(state.portfolio).toBeNull()
    expect(state.userProfile).toBeNull()
    expect(state.scenarioResults).toEqual([])
  })

  it('sets and clears a portfolio', () => {
    const portfolio = makePortfolio()
    usePortfolioStore.getState().setPortfolio(portfolio)
    expect(usePortfolioStore.getState().portfolio).toEqual(portfolio)

    usePortfolioStore.getState().clearPortfolio()
    expect(usePortfolioStore.getState().portfolio).toBeNull()
    expect(usePortfolioStore.getState().scenarioResults).toEqual([])
  })

  it('sets a user profile', () => {
    const profile: UserProfile = {
      currentAge: 55,
      targetRetirementAge: 60,
      annualExpenses: 80000,
    }
    usePortfolioStore.getState().setUserProfile(profile)
    expect(usePortfolioStore.getState().userProfile).toEqual(profile)
  })

  it('adds an account to the portfolio', () => {
    usePortfolioStore.getState().setPortfolio(makePortfolio())
    const newAccount = makeAccount({
      id: 'a2',
      name: 'Schwab IRA',
      accountType: 'traditional_ira',
    })
    usePortfolioStore.getState().addAccount(newAccount)

    const accounts = usePortfolioStore.getState().portfolio!.accounts
    expect(accounts).toHaveLength(2)
    expect(accounts[1].name).toBe('Schwab IRA')
  })

  it('does nothing when adding account with no portfolio', () => {
    usePortfolioStore.getState().addAccount(makeAccount())
    expect(usePortfolioStore.getState().portfolio).toBeNull()
  })

  it('removes an account by id', () => {
    usePortfolioStore.getState().setPortfolio(makePortfolio())
    usePortfolioStore.getState().removeAccount('a1')
    expect(usePortfolioStore.getState().portfolio!.accounts).toHaveLength(0)
  })

  it('adds a holding to an account', () => {
    usePortfolioStore.getState().setPortfolio(makePortfolio())
    const newHolding = makeHolding({
      id: 'h2',
      symbol: 'VXUS',
      name: 'Vanguard Total Intl Stock ETF',
    })
    usePortfolioStore.getState().addHolding('a1', newHolding)

    const holdings =
      usePortfolioStore.getState().portfolio!.accounts[0].holdings
    expect(holdings).toHaveLength(2)
    expect(holdings[1].symbol).toBe('VXUS')
  })

  it('updates a holding in a specific account', () => {
    usePortfolioStore.getState().setPortfolio(makePortfolio())
    const updated = makeHolding({ currentPrice: 300, currentValue: 30000 })
    usePortfolioStore.getState().updateHolding('a1', updated)

    const holding =
      usePortfolioStore.getState().portfolio!.accounts[0].holdings[0]
    expect(holding.currentPrice).toBe(300)
    expect(holding.currentValue).toBe(30000)
  })

  it('adds a CD to an account', () => {
    usePortfolioStore.getState().setPortfolio(makePortfolio())
    const cd = makeCD()
    usePortfolioStore.getState().addCD('a1', cd)

    const cds = usePortfolioStore.getState().portfolio!.accounts[0].cds
    expect(cds).toHaveLength(1)
    expect(cds[0].principal).toBe(50000)
  })

  it('removes a CD from an account', () => {
    const account = makeAccount({ cds: [makeCD()] })
    usePortfolioStore
      .getState()
      .setPortfolio(makePortfolio({ accounts: [account] }))
    usePortfolioStore.getState().removeCD('a1', 'cd1')

    expect(
      usePortfolioStore.getState().portfolio!.accounts[0].cds
    ).toHaveLength(0)
  })

  it('sets scenario results', () => {
    usePortfolioStore.getState().setScenarioResults(stubScenarioResults)
    expect(usePortfolioStore.getState().scenarioResults).toHaveLength(1)
    expect(usePortfolioStore.getState().scenarioResults[0].runwayYears).toBe(25)
  })

  describe('scenario invalidation', () => {
    it('clears scenarios when portfolio is replaced', () => {
      seedWithScenarios()
      usePortfolioStore.getState().setPortfolio(makePortfolio({ id: 'p2' }))
      expect(usePortfolioStore.getState().scenarioResults).toEqual([])
    })

    it('clears scenarios when account is added', () => {
      seedWithScenarios()
      usePortfolioStore.getState().addAccount(makeAccount({ id: 'a2' }))
      expect(usePortfolioStore.getState().scenarioResults).toEqual([])
    })

    it('clears scenarios when account is removed', () => {
      seedWithScenarios()
      usePortfolioStore.getState().removeAccount('a1')
      expect(usePortfolioStore.getState().scenarioResults).toEqual([])
    })

    it('clears scenarios when holding is added', () => {
      seedWithScenarios()
      usePortfolioStore.getState().addHolding('a1', makeHolding({ id: 'h2' }))
      expect(usePortfolioStore.getState().scenarioResults).toEqual([])
    })

    it('clears scenarios when holding is updated', () => {
      seedWithScenarios()
      usePortfolioStore
        .getState()
        .updateHolding('a1', makeHolding({ currentPrice: 300 }))
      expect(usePortfolioStore.getState().scenarioResults).toEqual([])
    })

    it('clears scenarios when CD is added', () => {
      seedWithScenarios()
      usePortfolioStore.getState().addCD('a1', makeCD())
      expect(usePortfolioStore.getState().scenarioResults).toEqual([])
    })

    it('clears scenarios when CD is removed', () => {
      const account = makeAccount({ cds: [makeCD()] })
      usePortfolioStore
        .getState()
        .setPortfolio(makePortfolio({ accounts: [account] }))
      usePortfolioStore.getState().setScenarioResults(stubScenarioResults)
      usePortfolioStore.getState().removeCD('a1', 'cd1')
      expect(usePortfolioStore.getState().scenarioResults).toEqual([])
    })
  })
})
