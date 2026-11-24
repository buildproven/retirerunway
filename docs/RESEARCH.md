# Research: what a retirement planning agent should do

Status: 2026-11-24. Reference for REQUIREMENTS section 1 and REQ-MCP-64..69.
Claims about other products are only what the cited pages say on this date.

## 1. The process a planner follows

The CFP Board's practice standards (effective 2019, enforced from June 2020)
set a seven-step process: understand the client's circumstances, identify and
select goals, analyse the current course and alternatives, develop
recommendations, present them, implement them, and monitor progress and update
the plan ([Kitces](https://kitces.com/?p=40246)). RetireRunway maps each step
to a tool:

| Step                     | RetireRunway                                                        |
| ------------------------ | ------------------------------------------------------------------- |
| Understand circumstances | profile, positions import, snapshots, get_briefing                  |
| Goals                    | profile `goals` (REQ-MCP-68), target retirement age, spending       |
| Analyse                  | project_retirement, plan_verdict, earliest_retirement, backtest     |
| Develop recommendations  | rank_levers, propose_plan_rules, Roth and claiming explorers        |
| Present                  | review_plan (REQ-MCP-69), charts, the skill's narration             |
| Implement                | plan_check trades and tasks, the CD ladder; the owner places orders |
| Monitor and update       | the monthly runway check, explain_change, plan notes                |

## 2. What advice is worth, and which part software can do

Vanguard's research splits the value of advice into financial planning,
portfolio outcomes, emotional support and time saved
([Vanguard 2022](https://corpaemdisp.essp.c1.vanguard.com/content/dam/corp/research/pdf/the_value_of_personalized_advice_final.pdf)).
Its Advisor's Alpha estimates about 3% in net returns from best practices, of
which behavioural coaching is up to 1.5%, and is not an annual figure
([PlanAdviser](https://www.planadviser.com/?p=27219)).

RetireRunway's share of that work, and what it leaves to people:

| Area              | RetireRunway                                                                                                               | Left to people                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Planning analysis | projections with tax, ACA, IRMAA, RMDs, Rule of 55, deferred compensation, Social Security, survivor; earliest age; levers | checking the inputs (healthcare quote, Social Security records) |
| Portfolio         | tested stock share, rebalancing rules, CD and Treasury ladder from quotes, tax-aware sale order                            | placing every order                                             |
| Spending          | risk-based guardrails in dollars (spending_guardrails)                                                                     | choosing a lifestyle                                            |
| Tax               | Roth conversion explorer, bracket and IRMAA limits                                                                         | the filed return, foreign pension treatment (CPA)               |
| Behaviour         | a monthly review, what changed and why, rules set in calm markets                                                          | the decision itself                                             |
| Estate, insurance | survivor scenario, life cover test                                                                                         | documents and policies (attorney, agent)                        |

`review_plan` lists the human checks for the owner's own plan.

## 3. Spending: guardrails over a single success rate

Risk-based guardrails express spending as a dollar amount with upper and
lower portfolio values that trigger a change, and recalculate monthly; Income
Lab's default sets spending at the 20th-percentile outcome
([Income Lab](https://incomelaboratory.com/retirement-withdrawal-guardrails-method/)).
RetireRunway's spending_guardrails follows the same idea: a monthly figure at a
target chance of success, with portfolio values that call for a 10% cut or
raise.

## 4. Sequence risk before and after retirement

The "bond tent" builds a bond reserve in the decade before retirement and
spends it in the first years after, so equity exposure returns to normal later
([Kitces](https://www.kitces.com/?p=14329)). propose_plan_rules implements it
as a ladder that funds the first retirement years, sized to each year's
expected withdrawals and capped by the bonds the tested stock share leaves.

## 5. Consumer tools

- **Boldin** leads with the earliest retirement age
  ([Boldin](https://www.boldin.com/retirement/how-much-do-i-need-to-retire-early-retirement-calculators-help/));
  its paid tier ($144 a year) adds Monte Carlo, a Roth conversion explorer,
  side-by-side scenarios and an assistant that answers from the plan data
  ([Boldin](https://www.boldin.com/retirement/newretirement-vs-best-retirement-planning/)).
- **ProjectionLab** focuses on scenario modelling and side-by-side timelines
  ([Gerald](https://joingerald.com/learn/saving--investing/projectionlab-review-features-pricing-alternatives)),
  premium about $129 a year
  ([Quicken](https://www.quicken.com/blog/top-retirement-planning-software-with-savings-and-retirement-calculators-2026/)).
- **Empower** is the free account aggregator.

## 6. Where RetireRunway stands

Ahead:

- Every figure is reproducible: same inputs and seed give the same result, with
  input and output hashes.
- It acts on the owner's rules: trades by account with estimated tax, a CD
  ladder priced from the broker's quotes, due tasks.
- It proposes the rules and tests them, ranks the levers that bring retirement
  forward, and reviews the plan every month without being asked.
- It is free and open source, and the owner's data stays in the owner's own
  storage.

Behind, and the roadmap:

1. No live account link: balances come from a positions CSV. Next: import the
   Empower net-worth export (cash, debts, home) alongside the CSV.
2. Withdrawal order is fixed by the model, not optimised.
3. The stock-share test holds the share constant; no rising glide path after
   retirement.
4. No consumption-smoothing view (the economics approach that sets spending
   to use the money evenly over life).
5. Moves to another town are custom levers the owner enters; Lifescape can
   supply the figures.
