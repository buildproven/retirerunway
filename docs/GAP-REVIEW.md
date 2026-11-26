# Feature gap review

Reviewed 2026-11-25 against what retirement-income planners and the
leading planning tools check (Income Lab, RightCapital, Boldin,
ProjectionLab, MaxiFi, Pralana; retirement-income research by Pfau,
Morningstar and the firms' capital market assumptions). Ranked by how much
each gap can move a typical early-retirement plan: retire before 65, bridge
to Social Security, mostly pre-tax money. Re-rank at each release; the weekly
check reports this file's open items.

## Covered

| Area                                                                      | Where                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Monte Carlo, seeded; historical replay 1928-2025                          | `project_retirement`, `historical_backtest`            |
| Today's markets: Treasury, TIPS, CD yields, firms' forecasts              | `save_market_data` (REQ-MCP-75)                        |
| Every asset class against TIPS; alternatives sleeve; REITs as stocks      | `market.assets`, `altTest` (REQ-MCP-78)                |
| Safe TIPS/CD ladder for the bridge                                        | `safeLadderTest` (REQ-MCP-76)                          |
| Stock share, glide paths, bond tent                                       | `propose_plan_rules`                                   |
| Federal tax (IRS 2026 tables), state tax, 10% penalty, Rule of 55, RMDs   | projection (v1.7.1)                                    |
| Roth conversions, ACA credit cliff, IRMAA                                 | `explore_roth_conversions`, projection                 |
| Social Security claiming ages, survivor case                              | `explore_claiming_ages`                                |
| Withdrawal order                                                          | `explore_withdrawal_order`                             |
| Spending guardrails                                                       | `spending_guardrails`                                  |
| Levers: spend less, save more, part-time, downsize                        | `rank_levers`, `earliest_retirement`                   |
| Deferred comp payout, lump sums (an overseas pension), home sale          | profile                                                |
| Debt against safe yields: card APR, mortgage                              | `review_plan.debt` (REQ-MCP-79, v1.8.0)                |
| Lifetime income annuity (SPIA) at Social Security age                     | `annuityTest` (REQ-MCP-80, v1.8.0)                     |
| Health cover rising faster than prices (+2%/yr stress)                    | `stressTests` (REQ-MCP-81, v1.8.0)                     |
| Stocks and bonds falling together (correlation 0.5 stress)                | `stressTests` (REQ-MCP-82, v1.9.0)                     |
| Long-term care ($74,400/yr for 3 years from 85 stress)                    | `longTermCare`, `stressTests` (REQ-MCP-82)             |
| A year out of work from 55; lump sums 20% lower (currency)                | `stressTests` (REQ-MCP-82, v1.9.0)                     |
| Job change: old 401(k) rolled in, left or moved to an IRA; NQDC start     | `jobChange`, `stressTests` (REQ-MCP-83)                |
| Law tables dated and checked yearly; 2027 tax and IRMAA; senior deduction | `law-tables.ts` (REQ-MCP-84, v1.11.0)                  |
| Asset location swaps; reverse mortgage standby line (HECM)                | `assetLocation`, `reverseMortgageTest` (REQ-MCP-85/86) |
| TIPS gap years 2037-2039: dated auction tasks                             | `tipsGapRungs`, plan tasks (REQ-MCP-87)                |
| Human checks: CFP, CPA, attorney, ssa.gov, Marketplace quote              | `review_plan.humanChecks`                              |

## Gaps, ranked

| #   | Gap                                                                | Why it matters                                                                                                                                                                           | Status                           |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | Healthcare costs rising faster than prices                         | Pre-Medicare cover and Medicare premiums were held flat in today's dollars; medical costs have run 1-3 points above CPI, and healthcare is the largest bridge cost                       | Done (v1.8.0)                    |
| 2   | Stock-bond correlation                                             | Draws are independent; in 2022-style inflation shocks both fall together, which weakens the bond sleeve and the tent. J.P. Morgan's 2027 assumptions point to higher correlation         | Done (v1.9.0): stress test       |
| 3   | Job change and the Rule of 55                                      | A new employer resets which plan the rule applies to: rolling the old 401(k) into the new plan keeps access at separation from 55; leaving it behind does not if separation is before 55 | Done (v1.10.0): profile + stress |
| 4   | Long-term care                                                     | Not modelled; a care event late in life is a large, uninsured cost                                                                                                                       | Done (v1.9.0): stress + profile  |
| 5   | Currency on an overseas pension or lump sum                        | Held flat in today's US dollars; AUD/USD moves change it                                                                                                                                 | Done (v1.9.0): 20% lower stress  |
| 6   | Senior deduction ($6,000 per person 65+, 2025-2028)                | Applies only in tax years 2025-2028, to people 65+                                                                                                                                       | Done (v1.11.0)                   |
| 7   | Asset location (bonds and TIPS in pre-tax, stocks in Roth/taxable) | Matters most with large taxable or Roth balances                                                                                                                                         | Done (v1.12.0)                   |
| 8   | Fees and fund overlap                                              | Fund overlap is reported by `portfolio_analysis`                                                                                                                                         | Covered enough                   |
| 9   | Reverse mortgage standby line                                      | Home equity as a buffer if not downsizing                                                                                                                                                | Done (v1.12.0)                   |
| 10  | Estate, beneficiaries, incapacity                                  | Not modelled by design; human check lists it                                                                                                                                             | Human check                      |
| 11  | TIPS gap years (no TIPS mature 2037-2039)                          | A ladder rung in those years cannot be bought today: cover it with extra 2036 and Feb 2040 TIPS, or buy it at the January 10-year auction that creates that year                         | Done (v1.13.0)                   |

## Owner inputs these features need

- `consumerDebtRate`: the card APR (review asks when missing).
- `marketData.annuityQuotes`: SPIA payout rates by age, joint for a couple.
- `marketData.assetForecasts`: firms' forecasts by asset class.
