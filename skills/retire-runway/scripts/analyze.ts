// Combined analysis: Monte Carlo + Roth + Rule-of-55 + trade plan, one provenance bundle.

import { runMonteCarlo } from '../../../src/engine/monte-carlo.ts'
import { optimizeRothConversion } from '../../../src/engine/roth-conversion.ts'
import { analyzeRuleOf55 } from '../../../src/engine/rule-of-55.ts'
import { generateTradePlan } from '../../../src/engine/trade-plan.ts'
import type { Portfolio, UserProfile } from '../../../src/engine/types.ts'
import {
  readJson,
  writeJson,
  stamp,
  assertPlainObject,
  type ProvenanceStamp,
} from './provenance.ts'

const [, , portfolioPath, profilePath] = process.argv
if (!portfolioPath || !profilePath) {
  console.error('usage: analyze.ts <portfolio.json> <profile.json>')
  process.exit(2)
}

const wrapper = await readJson<unknown>(portfolioPath)
assertPlainObject(wrapper, 'portfolio JSON')
const obj = wrapper as Record<string, unknown>
const portfolio = ('portfolio' in obj ? obj.portfolio : obj) as Portfolio
const profile = await readJson<UserProfile>(profilePath)
assertPlainObject(profile, 'profile JSON')

const provenance: ProvenanceStamp[] = []

const mc = runMonteCarlo(portfolio, profile)
provenance.push(
  stamp('runMonteCarlo', { portfolio, profile }, mc, {
    seed: mc.config.seed,
    assumptions: { ...mc.config },
  })
)

const roth = optimizeRothConversion(portfolio, profile)
provenance.push(
  stamp('optimizeRothConversion', { portfolio, profile }, roth, {
    assumptions: { filingStatus: 'single (engine default)' },
  })
)

const r55 = analyzeRuleOf55(portfolio, profile)
provenance.push(
  stamp('analyzeRuleOf55', { portfolio, profile }, r55, { assumptions: {} })
)

const trade = generateTradePlan(portfolio, profile)
provenance.push(
  stamp('generateTradePlan', { portfolio, profile }, trade, {
    assumptions: {
      targetCashPosition: trade.targetCashPosition,
      federalTaxBracket: profile.federalTaxBracket ?? 0.22,
    },
  })
)

writeJson({
  disclaimer: 'Educational simulation, not investment advice.',
  monteCarlo: mc,
  rothConversion: roth,
  ruleOf55: r55,
  tradePlan: trade,
  provenance,
})
