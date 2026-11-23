import type {
  Portfolio,
  UserProfile,
  CashLadder,
  LadderRung,
  CD,
  Account,
  Holding,
} from './types'
import { MARKET_RETURNS } from './config'

export interface LadderConfig {
  yearsOfCoverage: number
  bondReturnRate: number
}

const DEFAULT_CONFIG: LadderConfig = {
  yearsOfCoverage: 5,
  bondReturnRate: MARKET_RETURNS.BOND_RETURN,
}

function collectCashSources(portfolio: Portfolio): number {
  let total = 0
  for (const account of portfolio.accounts) {
    total += account.cashBalance
    for (const holding of account.holdings) {
      if (
        holding.assetClass === 'cash' ||
        holding.assetClass === 'money_market'
      ) {
        total += holding.currentValue
      }
    }
  }
  return total
}

interface CDSource {
  cd: CD
  accountId: string
  maturityYear: number
}

function collectCDSources(portfolio: Portfolio): CDSource[] {
  const sources: CDSource[] = []
  for (const account of portfolio.accounts) {
    for (const cd of account.cds) {
      const maturityYear = new Date(cd.maturityDate).getFullYear()
      sources.push({ cd, accountId: account.id, maturityYear })
    }
  }
  sources.sort((a, b) => a.maturityYear - b.maturityYear)
  return sources
}

interface BondSource {
  holding: Holding
  account: Account
  available: number
}

function collectBondSources(portfolio: Portfolio): BondSource[] {
  const sources: BondSource[] = []
  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      if (
        holding.assetClass === 'us_bond' ||
        holding.assetClass === 'intl_bond' ||
        holding.assetClass === 'tips'
      ) {
        if (holding.currentValue > 0) {
          sources.push({
            holding,
            account,
            available: holding.currentValue,
          })
        }
      }
    }
  }
  sources.sort((a, b) => b.available - a.available)
  return sources
}

function collectEquitySources(portfolio: Portfolio): number {
  let total = 0
  for (const account of portfolio.accounts) {
    for (const holding of account.holdings) {
      if (
        holding.assetClass === 'us_equity' ||
        holding.assetClass === 'intl_equity' ||
        holding.assetClass === 'emerging_equity'
      ) {
        total += holding.currentValue
      }
    }
  }
  return total
}

export function generateLadderPlan(
  portfolio: Portfolio,
  profile: UserProfile,
  config?: Partial<LadderConfig>
): CashLadder {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const annualTarget = profile.annualExpenses
  const startYear = new Date(portfolio.asOfDate).getFullYear()

  if (annualTarget <= 0 || cfg.yearsOfCoverage <= 0) {
    return {
      rungs: [],
      totalFunded: 0,
      yearsOfExpensesCovered: 0,
      annualExpenseTarget: annualTarget,
    }
  }

  const rungs: LadderRung[] = []
  let remainingCash = collectCashSources(portfolio)
  const cdSources = collectCDSources(portfolio)
  const bondSources = collectBondSources(portfolio)
  let remainingEquity = collectEquitySources(portfolio)
  let totalFunded = 0

  for (let i = 0; i < cfg.yearsOfCoverage; i++) {
    const year = startYear + i + 1
    let yearNeeded = annualTarget
    const yearRungs: LadderRung[] = []

    // 1. Use cash first (year 1 priority)
    if (remainingCash > 0 && yearNeeded > 0) {
      const fromCash = Math.min(remainingCash, yearNeeded)
      yearRungs.push({ year, source: 'cash', amount: round(fromCash) })
      remainingCash -= fromCash
      yearNeeded -= fromCash
    }

    // 2. Use maturing CDs for this year
    if (yearNeeded > 0) {
      for (const cdSource of cdSources) {
        if (yearNeeded <= 0) break
        if (cdSource.maturityYear === year && cdSource.cd.principal > 0) {
          const fromCD = Math.min(cdSource.cd.principal, yearNeeded)
          yearRungs.push({
            year,
            source: 'cd',
            amount: round(fromCD),
            maturityDate: cdSource.cd.maturityDate,
            cdId: cdSource.cd.id,
          })
          cdSource.cd = {
            ...cdSource.cd,
            principal: cdSource.cd.principal - fromCD,
          }
          yearNeeded -= fromCD
        }
      }
    }

    // 3. Use bonds
    if (yearNeeded > 0) {
      for (const bondSource of bondSources) {
        if (yearNeeded <= 0) break
        if (bondSource.available <= 0) continue
        const fromBond = Math.min(bondSource.available, yearNeeded)
        yearRungs.push({ year, source: 'bond', amount: round(fromBond) })
        bondSource.available -= fromBond
        yearNeeded -= fromBond
      }
    }

    // 4. Sell equity as last resort
    if (yearNeeded > 0 && remainingEquity > 0) {
      const fromEquity = Math.min(remainingEquity, yearNeeded)
      yearRungs.push({ year, source: 'sell_equity', amount: round(fromEquity) })
      remainingEquity -= fromEquity
      yearNeeded -= fromEquity
    }

    for (const rung of yearRungs) {
      totalFunded += rung.amount
      rungs.push(rung)
    }
  }

  const yearsOfExpensesCovered =
    annualTarget > 0 ? totalFunded / annualTarget : 0

  return {
    rungs,
    totalFunded: round(totalFunded),
    yearsOfExpensesCovered: Math.round(yearsOfExpensesCovered * 100) / 100,
    annualExpenseTarget: annualTarget,
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
