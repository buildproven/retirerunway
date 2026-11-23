import { describe, expect, it } from 'vitest'
import { projectScenario } from '../projection'
import { REGRESSION_FIXTURES } from '../regression-fixtures'

describe('independent plan regression fixtures', () => {
  it('contains all twelve PRD acceptance scenarios', () => {
    expect(REGRESSION_FIXTURES).toHaveLength(12)
    expect(new Set(REGRESSION_FIXTURES.map(fixture => fixture.id)).size).toBe(
      12
    )
  })

  for (const fixture of REGRESSION_FIXTURES) {
    it(fixture.id, () => {
      const row = projectScenario(fixture.scenario).rows.find(
        candidate => candidate.age === fixture.expected.age
      )
      expect(row).toBeDefined()
      if (!row) return
      if (fixture.expected.income !== undefined)
        expect(row.income).toBeCloseTo(fixture.expected.income, 1)
      if (fixture.expected.spending !== undefined)
        expect(row.spending).toBeCloseTo(fixture.expected.spending, 1)
      if (fixture.expected.fundingGap !== undefined)
        expect(row.fundingGap).toBeCloseTo(fixture.expected.fundingGap, 1)
      if (fixture.expected.withdrawal) {
        for (const [accountId, amount] of Object.entries(
          fixture.expected.withdrawal
        )) {
          expect(row.withdrawalsByAccount[accountId] ?? 0).toBeCloseTo(
            amount,
            1
          )
        }
        for (const account of fixture.scenario.accounts) {
          if (!(account.id in fixture.expected.withdrawal)) {
            expect(row.withdrawalsByAccount[account.id] ?? 0).toBeCloseTo(0, 1)
          }
        }
      }
      if (fixture.expected.endBalance) {
        for (const [accountId, amount] of Object.entries(
          fixture.expected.endBalance
        )) {
          expect(row.accounts[accountId]?.endBalance).toBeCloseTo(amount, 1)
        }
      }
    })
  }
})
