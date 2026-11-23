import { optimizeRothConversion } from '../../../src/engine/roth-conversion.ts'
import type { Portfolio, UserProfile } from '../../../src/engine/types.ts'
import { readJson, writeJson, stamp, assertPlainObject } from './provenance.ts'

const [, , portfolioPath, profilePath] = process.argv
if (!portfolioPath || !profilePath) {
  console.error('usage: roth-conversion.ts <portfolio.json> <profile.json>')
  process.exit(2)
}

const wrapper = await readJson<unknown>(portfolioPath)
assertPlainObject(wrapper, 'portfolio JSON')
const obj = wrapper as Record<string, unknown>
const portfolio = ('portfolio' in obj ? obj.portfolio : obj) as Portfolio
const profile = await readJson<UserProfile>(profilePath)
assertPlainObject(profile, 'profile JSON')

const result = optimizeRothConversion(portfolio, profile)

// The engine defaults to filingStatus 'single' when UserProfile has no
// filingStatus field (which it currently doesn't). Record the ACTUAL default
// the engine used, not a hardcoded lie.
writeJson({
  rothConversion: result,
  provenance: [
    stamp('optimizeRothConversion', { portfolio, profile }, result, {
      assumptions: { filingStatus: 'single (engine default)' },
    }),
  ],
})
