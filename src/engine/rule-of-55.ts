import type { Portfolio, UserProfile, AccountType } from './types'

/**
 * How each account type is reached before 59½. `rule_of_55`: an employer plan
 * the Rule of 55 opens. `penalty_free`: no early-withdrawal penalty.
 * `restricted`: neither — an IRA, or an NQDC plan, which pays out on the
 * schedule elected at deferral and is outside the Rule of 55.
 */
const EARLY_ACCESS: Readonly<
  Record<AccountType, 'rule_of_55' | 'penalty_free' | 'restricted'>
> = {
  '401k': 'rule_of_55',
  roth_401k: 'rule_of_55',
  '403b': 'rule_of_55',
  brokerage: 'penalty_free',
  roth_ira: 'penalty_free',
  '457b': 'penalty_free',
  hsa: 'penalty_free',
  traditional_ira: 'restricted',
  rollover_ira: 'restricted',
  nqdc: 'restricted',
}
const STANDARD_PENALTY_FREE_AGE = 59.5
const RULE_OF_55_AGE = 55

export interface RuleOf55Result {
  eligible: boolean
  eligibleAccounts: EligibleAccount[]
  totalEligibleValue: number
  separationAge: number | null
  guidancePoints: string[]
}

export interface EligibleAccount {
  accountId: string
  accountName: string
  accountType: AccountType
  value: number
}

function computeAccountValue(account: Portfolio['accounts'][number]): number {
  let total = account.cashBalance
  for (const h of account.holdings) total += h.currentValue
  for (const c of account.cds) total += c.principal
  return total
}

export function analyzeRuleOf55(
  portfolio: Portfolio,
  profile: UserProfile
): RuleOf55Result {
  const separationAge = profile.targetRetirementAge
  const willRetireBefore59_5 = separationAge < STANDARD_PENALTY_FREE_AGE
  const meetsAgeRequirement = separationAge >= RULE_OF_55_AGE

  const eligibleAccounts: EligibleAccount[] = []
  for (const account of portfolio.accounts) {
    if (EARLY_ACCESS[account.accountType] === 'rule_of_55') {
      eligibleAccounts.push({
        accountId: account.id,
        accountName: account.name,
        accountType: account.accountType,
        value: computeAccountValue(account),
      })
    }
  }

  const totalEligibleValue = eligibleAccounts.reduce(
    (sum, a) => sum + a.value,
    0
  )
  const eligible =
    willRetireBefore59_5 && meetsAgeRequirement && eligibleAccounts.length > 0

  const guidancePoints = buildGuidance(
    eligible,
    eligibleAccounts,
    totalEligibleValue,
    separationAge,
    portfolio,
    profile
  )

  return {
    eligible,
    eligibleAccounts,
    totalEligibleValue,
    separationAge: eligible ? separationAge : null,
    guidancePoints,
  }
}

function buildGuidance(
  eligible: boolean,
  eligibleAccounts: EligibleAccount[],
  totalEligibleValue: number,
  separationAge: number,
  portfolio: Portfolio,
  profile: UserProfile
): string[] {
  const points: string[] = []

  if (eligibleAccounts.length === 0) {
    points.push(
      'No 401(k) or 403(b) accounts detected. The Rule of 55 only applies to employer-sponsored plans.'
    )
    return points
  }

  if (separationAge < RULE_OF_55_AGE) {
    points.push(
      `Your target retirement age (${separationAge}) is before 55. The Rule of 55 requires separation from service in or after the year you turn 55.`
    )
    return points
  }

  if (separationAge >= STANDARD_PENALTY_FREE_AGE) {
    points.push(
      `At age ${separationAge}, you can already access retirement accounts penalty-free (59½ rule). The Rule of 55 is not needed.`
    )
    return points
  }

  points.push(
    `You may qualify for the Rule of 55, allowing penalty-free withdrawals from your ${eligibleAccounts.map(a => a.accountType).join(', ')} account(s) starting at age ${separationAge}.`
  )

  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
  points.push(
    `Total eligible balance: ${fmt.format(totalEligibleValue)} across ${eligibleAccounts.length} account(s).`
  )

  points.push(
    'Key requirement: You must leave your employer in or after the year you turn 55. The funds must stay in the employer plan (not rolled to an IRA).'
  )

  const gapYears = Math.ceil(STANDARD_PENALTY_FREE_AGE - separationAge)
  const annualNeed = profile.annualExpenses
  const gapFunding = gapYears * annualNeed
  if (totalEligibleValue >= gapFunding) {
    points.push(
      `Your eligible balance can cover the ${gapYears}-year gap before 59½ (estimated ${fmt.format(gapFunding)} needed at current expenses).`
    )
  } else {
    points.push(
      `Gap funding shortfall: you need approximately ${fmt.format(gapFunding)} for the ${gapYears} years before 59½, but eligible accounts hold ${fmt.format(totalEligibleValue)}.`
    )
  }

  const has457b = portfolio.accounts.some(a => a.accountType === '457b')
  if (has457b) {
    points.push(
      'Your 457(b) account has no early withdrawal penalty at any age after separation — it can supplement Rule of 55 withdrawals.'
    )
  }

  const hasPenaltyFreeAccounts = portfolio.accounts.some(
    a => EARLY_ACCESS[a.accountType] === 'penalty_free'
  )
  if (hasPenaltyFreeAccounts) {
    points.push(
      'Consider drawing from brokerage and Roth IRA contributions first to preserve tax-deferred growth in your 401(k).'
    )
  }

  return points
}
