import { generateTradePlan } from '../../../src/engine/trade-plan.ts'
import type { Portfolio, UserProfile } from '../../../src/engine/types.ts'
import { readJson, writeJson, stamp, assertPlainObject } from './provenance.ts'

const [, , portfolioPath, profilePath] = process.argv
if (!portfolioPath || !profilePath) {
  console.error('usage: trade-plan.ts <portfolio.json> <profile.json>')
  process.exit(2)
}

const wrapper = await readJson<unknown>(portfolioPath)
assertPlainObject(wrapper, 'portfolio JSON')
const obj = wrapper as Record<string, unknown>
const portfolio = ('portfolio' in obj ? obj.portfolio : obj) as Portfolio
const profile = await readJson<UserProfile>(profilePath)
assertPlainObject(profile, 'profile JSON')

const result = generateTradePlan(portfolio, profile)

writeJson({
  tradePlan: result,
  provenance: [
    stamp('generateTradePlan', { portfolio, profile }, result, {
      assumptions: {
        targetCashPosition: result.targetCashPosition,
        federalTaxBracket: profile.federalTaxBracket ?? 0.22,
      },
    }),
  ],
})
