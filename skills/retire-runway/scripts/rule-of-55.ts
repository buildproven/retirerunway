import { analyzeRuleOf55 } from '../../../src/engine/rule-of-55.ts'
import type { Portfolio, UserProfile } from '../../../src/engine/types.ts'
import { readJson, writeJson, stamp, assertPlainObject } from './provenance.ts'

const [, , portfolioPath, profilePath] = process.argv
if (!portfolioPath || !profilePath) {
  console.error('usage: rule-of-55.ts <portfolio.json> <profile.json>')
  process.exit(2)
}

const wrapper = await readJson<unknown>(portfolioPath)
assertPlainObject(wrapper, 'portfolio JSON')
const obj = wrapper as Record<string, unknown>
const portfolio = ('portfolio' in obj ? obj.portfolio : obj) as Portfolio
const profile = await readJson<UserProfile>(profilePath)
assertPlainObject(profile, 'profile JSON')

const result = analyzeRuleOf55(portfolio, profile)

writeJson({
  ruleOf55: result,
  provenance: [
    stamp('analyzeRuleOf55', { portfolio, profile }, result, {
      assumptions: {},
    }),
  ],
})
