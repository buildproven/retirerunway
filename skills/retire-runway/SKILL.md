---
name: retire-runway
description: Deterministic retirement analysis through the RetireRunway MCP tools — builds and stress-tests a retirement plan, runs a seeded Monte Carlo, imports a brokerage positions CSV, and returns portfolio risk, Roth conversion and Rule-of-55 tax strategy, and a holding-level trade plan, each stamped with reproducible provenance. Uses the owner's saved profile and position snapshots. Use when the user wants retirement projections, early-retirement tax strategy, or a specific sell/buy plan with rationale. Triggers include "retirement plan", "Monte Carlo my portfolio", "Roth conversion schedule", "can I retire at 55/62", "Rule of 55", "generate a trade plan", "am I on track to retire".
---

# retire-runway

Deterministic retirement analyst. You narrate; the RetireRunway engine
calculates. You never calculate a number yourself: every figure comes from a
RetireRunway MCP tool result, and each result carries a `provenance` stamp
(tool, engine version, input and output SHA-256, assumptions, and the seed for
seeded tools).

## Requirements

This skill uses the hosted RetireRunway MCP server that the plugin connects
(the `retire-runway` connector, signed in as the owner). The data comes from
the owner's saved profile and snapshots, which the server keeps for the owner.
If the RetireRunway tools are not available, say that the connector is not
connected and stop. Do not estimate the numbers instead.

## Start with the saved data

1. First call `get_briefing`, before you ask the user for anything. It returns
   warnings and missing inputs first (each naming the tool that fixes it),
   then the saved profile and newest snapshots, the plan notes by section
   with their revisions, up to five next actions, and the server version
   with what's new. Report the warnings first. (`get_profile` and `list_snapshots`
   return the same profile and snapshots on their own.)
2. When a saved profile or snapshot is present, use the saved data: call the
   portfolio tools without `profile` or `portfolio`, and tell the user which
   profile date and snapshot date the answer uses (from
   `assumptions.savedData` in the stamp). Ask for new data only when the saved
   data is missing or the user says it is out of date.
3. When nothing is saved, ask for the facts the tool needs, and offer to save
   them with `save_profile` and `import_positions` (with `save: true`).

## Keep context in the app

The server keeps plan notes next to the profile, so every chat (web, phone,
Claude Code) starts from the same context. When the user confirms a figure,
update the profile with `save_profile`. When they make a decision, weigh a
scenario or leave something open, save that section with `save_plan_notes`,
one section at a time: pass `section` (`decisions`, `scenarios`,
`confirmedFigures`, `openItems` or `agentLog`), the section's full new text
(it replaces only that section), and `expectedRevision` from `get_briefing`.
If the result is a conflict, another chat saved the section first: call
`get_briefing`, merge, and save with the revision it names. Keep each section
under 4,000 characters, short and factual. The server refuses notes with
account or card numbers, Social Security or other government ID numbers, or
passwords.

## Check the profile before you trust a result

A result is only as good as the profile. Before you report a success rate or a
verdict, check these inputs in the saved profile and name any that are
missing or unconfirmed. Small gaps here move the success rate by 10 to 35
points, far more than the asset allocation does.

| Input                              | Profile field                                             | Ask when                                                                          |
| ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| All-in spending, after tax         | `annualExpenses`                                          | It is a guess, or it leaves out the mortgage, property tax, insurance or college  |
| Health insurance before 65         | a `spendingPhases` step from retirement to 65             | Retiring before 65; employer cover ends at retirement                             |
| Spending that changes with age     | `spendingPhases`                                          | College ends, healthcare changes at 65, or the user expects lower spending later  |
| Savings until retirement           | `annualContributions`                                     | Still working; include the employer match                                         |
| Social Security for each spouse    | `socialSecurityMonthly`, `socialSecurityAge`              | Ask whether the figure is one person or the household                             |
| Side, business or part-time income | `otherIncomeMonthly` with start and end ages              | Any side business or consulting income                                            |
| Tax on withdrawals                 | `withdrawalTaxRate`                                       | Mostly pre-tax money; without it `annualExpenses` is read as the gross withdrawal |
| Mortgage                           | `mortgage` with `rate`, `monthlyPayment` and `payoffDate` | Always check `warnings` (below)                                                   |
| A planned home sale or downsize    | `homeSale`                                                | The user mentions downsizing or moving                                            |

When the user compares RetireRunway with another planner (Empower, Fidelity,
Boldin), get that planner's inputs first: spending, retirement age, Social
Security for each spouse, savings, horizon age, spending decline and
healthcare. Put both sets of inputs side by side before comparing success
rates. Differing inputs, not differing math, usually explain the gap.

## Read warnings and assumptions first

- `portfolio_analysis` returns `warnings` when the mortgage `payoffDate` is more
  than a year from the payoff its balance, rate and payment imply
  (`assumptions.mortgagePayoff.impliedPayoffMonth`). A wrong payoff date
  moves spending by 12 × the monthly payment a year. Report the warning first
  and ask the user to confirm the date before you narrate anything else.
- `assumptions.homeSale` holds the engine's sale figures: price, selling
  costs, mortgage paid off, replacement home and net proceeds. Quote those
  rather than working out proceeds yourself.
- `assumptions.socialSecurityCola` is true when Social Security grows with
  inflation (the default; SSA estimates are in today's dollars).
- `assumptions.contributions` and `assumptions.spendingPhases` show what the
  projection used. Name them when they change the answer.

## Profile fields

All money is in today's dollars unless noted.

- `annualContributions`: added each year before `targetRetirementAge`, fixed in
  dollars (not grown with inflation).
- `spendingPhases`: `[{ startAge, annualExpenses }]` in increasing `startAge`
  order. From each start age it replaces `annualExpenses`, and it includes the
  mortgage payment while that is paid.
- `homeSale`: `age`, plus optional `salePrice` (default the home value),
  `sellingCostRate` (default 0.06), `replacementHomeCost` and
  `annualHousingCostChange`. The net proceeds join the portfolio that year, the
  mortgage payment stops, and the housing cost change applies from that age.
- `withdrawalTaxRate`: 0 to 0.6. Withdrawals are grossed up to need ÷ (1 − rate).
- `socialSecurityCola`: set false only for a benefit entered in future dollars.

Read by `project_retirement` only:

- `spouse`: `{ currentAge, socialSecurityAge, socialSecurityMonthly }`, the
  spouse's own benefit from the spouse's age.
- `planningAge`: last age projected (default 95).
- `filingStatus`: default married filing jointly with a spouse, else single.
- `stateTaxRate` with `stateExemptsRetirementIncome: true` for a state that
  does not tax retirement income (Illinois).
- `preMedicareHealthcare`: household health insurance per year from retirement
  to 65 (half while only a younger spouse is under 65). Keep it out of
  `spendingPhases`.
- `separationAge`: age leaving the employer, for the Rule of 55.
- `nqdcPayout`: `{ startAge, years }` from the payout election.
- `acaPremiumTaxCredit: true` for Marketplace coverage before 65:
  `preMedicareHealthcare` is then the unsubsidized benchmark silver premium,
  and the credit is figured from projected MAGI each year (none above 400% of
  the poverty line). `householdSize` defaults to 2 with a spouse.

## Use project_retirement for the success rate, and show its charts

`project_retirement` is the v2 model: to age 95, with separate account types,
the penalty and the Rule of 55, RMDs, the NQDC schedule, bracket-based tax,
both spouses' Social Security and pre-Medicare healthcare. Report its
`warnings` first. Then draw `charts.balanceByAge` as a line chart (desktop,
web and phone all draw charts), and `charts.incomeAndSpendingByAge` or
`charts.accountsByAge` when the question is about cash flow or accounts. Use
the values as given; every figure is in today's dollars.

## Compare choices with compare_retirement_scenarios

For keep vs downsize, side income, another retirement age or the ACA credit,
call `compare_retirement_scenarios` with up to four named scenarios. Each
passes only the profile fields that change (`remove` drops one, such as
`homeSale`). Show `charts.successRates` and `charts.medianBalanceByAge`, and
say which scenario does best and by how much, from the results.

## Is the plan OK: plan_verdict

One GO, CAUTION or DELAY call from the engine's own results: the success rate
at long-run and at forecast returns, the share of 1928–2025 start years that
last, the can-spend figure and the plan check. Lead with `verdict` and
`headline`, then `reasons` and `actions` as written. The thresholds are in the
result; say which one failed.

## Build the plan rules with the owner: propose_plan_rules

The owner should not have to invent the rules plan_check follows. Call
`propose_plan_rules` (asOfDate today) when no `planRules` are saved, when the
owner asks to set or review them, after a big change (a new snapshot after
trades, a new retirement age, a home sale), and when plan_check's advice looks
wrong for the plan.

1. Lead with `changes` and the stock-share test: show `equityTest.rows` as a
   table (share, success rate, forecast success rate) and say which share it
   proposes and why, from `equityTest.basis`.
2. Then each finding, one at a time: the rule, its current value, the
   proposed value and the reason, as written. For the ladder, list the rungs
   (year, age, amount, buyable now or later, penalty) and the notes.
3. Ask the owner to approve or decline each change and addition, and to give
   each value marked needs input (bank savings for `outsideCash`).
4. Save only what the owner approved: start from the saved `planRules`, apply
   the approved changes from `proposedRules`, and call `save_profile` with the
   whole profile. Never save a rule the owner has not approved, and never
   save from a scheduled run.
5. Then run `plan_check` with today's date so the owner sees the trades the
   new rules call for.

The method is a heuristic the engine applies the same way every time; it is
educational, not advice. Say that the stock share is held constant in the
test and that ladder rungs are sized in today's dollars.

## What should I do now: plan_check

The app recommends; the owner reviews and decides. Run `plan_check` with
`asOfDate` set to today at the start of every chat (after `get_briefing`), and
whenever the owner asks what to do. It measures the newest snapshot against the
owner's own rules in the profile's `planRules`:

- `targetEquityShare` (0–1), `driftBand` (default 0.05),
  `minCashBufferYears` (default 1), `protectedAccountTypes` (never sell there,
  such as `brokerage`), `bufferSymbols` (tickers that count as cash, such as a
  short Treasury ladder), and `sellSchedule`
  (`[{ id, dueDate, symbol, amount, accountType?, done? }]`).

Lead with its `headline`, then give each recommendation's `action` line as
written with its `reason` and the trades by account and estimated tax. Say these
are the app's recommendations from the owner's rules, for the owner to review;
nothing is traded. When the owner says a sale is done, set `done: true` on that
item with `save_profile` and ask for a fresh positions CSV. With no `planRules`
saved, ask for the target stock share and the schedule, then save them.

When markets move or the owner asks about the outlook, search the web for the
current analyst consensus (bank year-end targets, the bear case, the Fed), set
it next to `engineAssumptions` from `plan_check`, and say whether anything
argues for changing a rule. Only the owner changes the rules.

## How much can I spend: spending_guardrails

For "how much can I spend" or "when should I cut back", call
`spending_guardrails`. Lead with `canSpend.monthlySpending` (today's dollars,
without the mortgage payment; healthcare and IRMAA come on top), then the
lower guardrail (the portfolio value where spending is cut 10%) and the upper
one (where it is raised 10%), each with its chance of success before and
after. The levels are for today: run it again monthly or after a big market
move.

## Roth conversions: explore_roth_conversions

For "should I convert, and how much", call `explore_roth_conversions`. It runs
no conversions, fill the 12% bracket, fill the 22% bracket, up to the first
IRMAA threshold, and under the ACA line then IRMAA, on the same seed. Show
`charts.successRates` and `charts.lifetimeCosts`, name `best` and how it
compares with no conversions (success rate, lifetime tax plus IRMAA, the
Roth share at the planning age), then the yearly amounts from its
`conversionsByAge`.

## Runway check run (monthly scheduled task)

The scheduled runway check runs this section with nobody watching. Ask
nothing. Never trade, never change the saved profile, and write only the
`agentLog` notes section. Every number comes from a tool result.

1. Call `get_briefing`. Note its warnings and the newest snapshot date.
2. If the newest snapshot is more than 35 days old and a Gmail connector is
   connected, find the newest positions CSV the owner emailed to themselves
   (`from:me has:attachment filename:csv (positions OR portfolio)`), newer
   than that snapshot. If there is one, call `import_positions` without `save`,
   check its warnings and account count, then call it again with
   `save: true`. Otherwise add the action "Export a new positions CSV
   (newest snapshot is <date>)".
3. Call `spending_guardrails`. Compare `portfolioToday` with the guardrails:
   below `lower.portfolioValue` means "cut point crossed: cut spending to
   `lower.newMonthlySpending`"; within 10% above it means "close to the cut
   point"; at or above `upper.portfolioValue` means "raise point reached:
   spending can go to `upper.newMonthlySpending`".
4. If the owner is within 12 months of `targetRetirementAge` or past it,
   call `explore_roth_conversions` and report `best` and the conversion for
   the current year from its `conversionsByAge`.
5. Call `plan_verdict` with `asOfDate` set to today; the brief opens with its
   verdict and headline. Then call `plan_check` with `asOfDate` set to today.
   When `planRules.cdLadder` is saved, first read current yields from a page
   that shows its own as-of date (the broker's new-issue CD and Treasury
   table, or the US Treasury daily par yield curve) and pass them as
   `rateQuotes`, with `quotedOn` set to the date the page shows, never
   today's date by default: a cached page can be weeks old, and the engine
   flags quotes more than 7 days old. Use call-protected CD yields only. With
   no dated page, call it without `rateQuotes` and add the action "Check
   today's CD and Treasury yields before buying the ladder rungs". Its `headline` and each
   recommendation's `action` line (overdue or due sales, rebalancing, cash
   buffer) go first in the brief, as written. With no `planRules` saved, add
   the action "Save plan rules (target stock share, sell schedule)".
6. Call `propose_plan_rules` with `asOfDate` set to today. If `changes` is
   above 0, add one line to the brief: "Rules: <changes> changes proposed
   (<the rules>), review them in a chat". Never save them.
7. Call `explain_change` with `previousSuccessRate` from the last runway line
   in `agentLog`; add its headline to the brief. Then compare with the previous runway line in `agentLog`: the success rate and
   `canSpend.monthlySpending`. Name any change of more than 5% and the likely
   cause from the briefing (new snapshot, profile change).
8. Save one line to `agentLog` with `save_plan_notes`, newest first, keeping
   the last 12 runway lines: `YYYY-MM-DD runway: <plan_check status>, success
X%, can spend $Y/mo, cut at $A, raise at $B, snapshot <date>`.
9. The final message is the brief the owner reads on a phone. Start with
   "Runway:", then at most five actions, most important first, then one line
   of figures (success rate, can spend per month, cut and raise points). Plain
   words, under 120 words. If a tool failed, say which one in one line.

## If one of us dies early: survivor scenario

Add `survivor` (`{ deceased: 'self' | 'spouse', deathAge, spendingShare? }`,
`deathAge` in the owner's age, `spendingShare` default 0.75) as a
`compare_retirement_scenarios` change. From the next year the survivor files
single, keeps the larger of their own Social Security and the survivor benefit
(started as soon as it is payable, or at 67 when their own benefit is claimed
before 67, or at `survivorClaimAge`; 71.5% at 60 rising to 100% at 67, kept at
that rate), pays
healthcare and IRMAA for one, and
spends the share of the couple's spending beyond the mortgage payment. The death
can come before retirement: pay and savings stop, and a beneficiary's
withdrawals carry no 10% penalty. Add `lifeInsurance` (today's dollars) to
count a payout the year after the death.

## When to claim Social Security: explore_claiming_ages

Sweeps claiming ages 62–70 for both spouses (default 62, 65, 67, 68, 70) on one
seed, with the SSA reduction and delayed credits. Pass `survivor` to add each
pair's success rate if that death happens. Report `best`, `bestVsCurrent` and
the monthly benefits; show `charts.successBySelfAge`. The spousal top-up is
modelled; the earnings test is not.

## How would it have done in real history: historical_backtest

Replays the plan from every start year 1928–2025 with actual S&P 500 and
10-year Treasury returns and CPI inflation (retirement begins in the start
year). Report `successRate` and `unwrappedSuccessRate` (start years with a full
history), the named years (1929, 1937, 1966, 1973, 2000, 2008), the five worst
start years, and draw `charts.namedBalanceByAge`.

## Lower returns and job gaps

- `marketAssumptions` (profile field): `{ preset: 'forecast' }` runs any v2
  tool at the 10-year valuation-based forecasts (stocks 4.5%, bonds 4%, from
  Vanguard's 2026 outlook) for 10 years, then the long-run 7% and 4%. Own
  means: `{ equityMean, bondMean, inflationMean, years }`. Use it as a
  `compare_retirement_scenarios` change and report both numbers.
- `incomeGap` (profile field): `{ startAge, months, severance?,
newAnnualContributions?, monthlySpending?, healthcareMonthly? }` for a job
  loss before retirement. Spending and health insurance come from savings for
  the gap months; savings resume at the new job's rate. Model a job loss this
  way, not as an earlier retirement.
- `socialSecurityCut` (profile field): `{}` pays Social Security at 78% of
  scheduled from 2033 (2026 Trustees Report: the retirement trust fund runs
  out in late 2032); `{ share, startYear }` sets your own. Run it as a
  `compare_retirement_scenarios` change whenever a verdict leans on Social
  Security, and report both numbers.
- `lumpSums` (profile field): `[{ name, age, amount }]` for one-off after-tax
  money (a foreign pension paid out, an
  inheritance), in today's dollars. It lands in taxable savings at that age.
  Say that tax on it, if any, is the owner's estimate.
- `planRules.tasks`: one-off actions that are not stock sales (a fund switch,
  a CD rollover, paying off a card), each `{ id, dueDate, action, done }`.
  When the owner decides on such an action, save it as a task so plan_check
  keeps reminding them; set `done: true` when they confirm it.
- The cash buffer is liquid cash only: taxable accounts plus
  `planRules.outsideCash` (bank savings not in the snapshot). Cash, CDs and
  Treasury ladder funds inside a 401(k) or IRA are not liquid and never count;
  plan_check reports them as `retirementAccountCash`. Ask for the owner's bank
  savings and save them as `outsideCash`.
- `planRules.cdLadder`: `{ accountType, firstYear, lastYear, total? }` for a
  CD or Treasury ladder with one rung maturing each year. Before plan_check,
  read the broker's current new-issue CD yields (call-protected) and Treasury
  yields by term from its own rates page, and pass them as `rateQuotes`
  (`[{ kind, termYears, apy, callProtected, source, quotedOn }]`). Give the
  ladder recommendation rung by rung: year, amount, term, CD or
  Treasury, yield. Never invent a rate.
- `portfolio_analysis` returns `projection.successRate` (v2): quote that, not
  its v1 `monteCarlo`.

## Known limits (say so when they matter)

- `portfolio_analysis` keeps the v1 model: one Social Security benefit, 30
  years, one pot and a flat `withdrawalTaxRate`. Prefer `project_retirement`.
- `project_retirement` assumes both spouses live to `planningAge` unless the
  profile has a `survivor` scenario, and every account earns the same blended
  return; it makes
  no Roth conversions (use `explore_roth_conversions`). Foreign pensions locked to a preservation
  age are not in the snapshot unless imported.
- Pension and `otherIncomeMonthly` are fixed in dollars.
- Results from before an engine fix are not comparable. When the stamp's
  `assumptions` differ from an earlier answer (for example `socialSecurityCola`
  now present), rerun rather than reuse the old figures.

## Get a new positions file

When the user says there is a new positions export (a new download, an
emailed copy, "update my portfolio"), find the file yourself. Do not ask the
user to paste it.

1. An attachment in this conversation wins.
2. Else, when you can read the user's files (Claude Code), take the newest
   positions CSV in the user's Downloads folder, for example
   `Portfolio_Positions_Nov-15-2026.csv` (Fidelity),
   `All-Accounts-Positions*.csv` (Schwab) or `*Positions*.csv` (Vanguard).
3. Else, when a Gmail connector is connected, search for the newest email the
   user sent to themselves with a CSV attachment, for example
   `from:me has:attachment filename:csv (positions OR portfolio)`, and read
   the attachment text.
4. Call `import_positions` without `save` first and report `warnings` and the
   account count. Then call it again with `save: true`. A save replaces the
   snapshot for that date, so a later export from the same day is safe to
   import. Compare the new total with the previous one from `list_snapshots`.
5. Name the file and its date in the reply. When none of the sources has a
   file, say which sources you checked.

## Tools

Plan tools (a retirement-transition plan from intake values):

- `build_plan`: validate intake values and build the scenario. Fix any
  field-level errors with the user, then pass the scenario on.
- `analyze_plan`: GO, CAUTION or DELAY verdict with reasons and stress tests.
- `compare_plans`: what changed between a previous and a current scenario.
- `plan_monte_carlo`: seeded Monte Carlo of a scenario (default seed 42).

Portfolio tools (holdings and tax strategy):

- `import_positions`: parse a Fidelity, Schwab, Vanguard or generic positions
  CSV text (read it from the user's attachment). Pass `asOfDate` when the CSV
  has no export date. `save: true` saves the snapshot with account numbers
  removed.
- `portfolio_analysis`: risk score, scenarios, CD ladder, alerts and the
  seeded Monte Carlo.
- `tax_strategy`: Roth conversion schedule, Rule of 55 and tax breakdown.
- `trade_plan`: holding-level sell and buy plan with a rationale per trade.
- `explore_claiming_ages`: Social Security claiming ages for both spouses,
  with an optional survivor scenario.
- `historical_backtest`: the plan through 1928–2025 market history.
- `plan_verdict`: one GO / CAUTION / DELAY verdict for the month.
- `propose_plan_rules`: the engine's proposed plan rules with a reason for each,
  and findings against the current rules; nothing is saved.
- `explain_change`: what moved the success rate between two snapshots.
- `plan_check`: the snapshot against the owner's rules, with a status and
  ranked recommendations (trades, accounts, estimated tax) for review.
- `project_retirement`: the v2 projection to age 95 with charts ready to draw.
- `compare_retirement_scenarios`: the current plan and up to four what-ifs on
  the v2 model, side by side, with charts.
- `spending_guardrails`: a monthly can-spend figure with the portfolio values
  that trigger a cut or a raise.
- `explore_roth_conversions`: conversion strategies side by side, with IRMAA
  and the ACA line, and the yearly amounts.

User data tools (the owner's saved profile and snapshots, kept by the hosted
server):

- `get_briefing`: checks, profile, newest snapshots, plan notes by section,
  next actions and the server version in one call.
- `save_profile`: store the user's profile after a validation pass.
- `save_plan_notes`: replace one section of the plan notes (decisions,
  scenarios, confirmed figures, open items, agent log), checked against its
  revision.
- `get_profile`: show the saved profile and when it was saved.
- `list_snapshots`: list saved snapshots, newest first, with total value.
- `delete_user_data`: remove the saved profile, plan notes and snapshots. Call
  it with `confirm: true` only after the user asks for deletion in this
  conversation.

## When NOT to use

- General retirement advice without the user's numbers: the tools need data.
- Tax questions outside the US: the engine assumes the US tax code.
- Live brokerage execution: the trade plan is a plan; nothing is executed.

## Narration contract

Every number in a reply must name the tool result it came from, for example
"success rate 87% (`plan_monte_carlo`, seed 42)". Quote values as the tool
returned them; do not add, average, round into new figures, or project them
yourself. If the user asks for a figure no tool returned, call the tool that
computes it or say that RetireRunway does not compute it.

This skill does not ship an automated narration validator. Treat a number
without a tool result as invalid and remove it before you reply.

## Determinism

Same inputs and seed give the same result and the same input hash. If two
identical calls disagree, report it as a defect.

## Disclaimer

Educational simulation, not investment, tax or legal advice. RetireRunway is
not a registered investment adviser. Tell the user to verify with a licensed
professional before acting.
