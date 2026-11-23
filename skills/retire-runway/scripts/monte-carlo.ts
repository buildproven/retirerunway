import { runMonteCarlo } from '../../../src/engine/monte-carlo.ts'
import type { Portfolio, UserProfile } from '../../../src/engine/types.ts'
import { readJson, writeJson, stamp, assertPlainObject } from './provenance.ts'

const [, , portfolioPath, profilePath] = process.argv
if (!portfolioPath || !profilePath) {
  console.error('usage: monte-carlo.ts <portfolio.json> <profile.json>')
  process.exit(2)
}

const wrapper = await readJson<unknown>(portfolioPath)
assertPlainObject(wrapper, 'portfolio JSON')
const obj = wrapper as Record<string, unknown>
const portfolio = ('portfolio' in obj ? obj.portfolio : obj) as Portfolio
const profile = await readJson<UserProfile>(profilePath)
assertPlainObject(profile, 'profile JSON')

const result = runMonteCarlo(portfolio, profile)

writeJson({
  monteCarlo: result,
  provenance: [
    stamp('runMonteCarlo', { portfolio, profile }, result, {
      seed: result.config.seed,
      assumptions: { ...result.config },
    }),
  ],
})
