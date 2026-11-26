# RetireRunway — Requirements (v1.0)

**Status:** Authoritative. Supersedes the execution-first draft
(`docs/archive/REQUIREMENTS-v1-execution-first-superseded.md`) and the PRD gap
analysis (`docs/archive/PRD_V4_GAP_ANALYSIS-2026-07-26.md`), both kept for history.
**Traceability:** every requirement ID below maps to design, code, and tests in
[`docs/traceability.json`](traceability.json), rendered as
[`docs/TRACEABILITY.md`](TRACEABILITY.md) and enforced by `npm run traceability:check`.

## 1. Product

RetireRunway is a free, open-source (MIT), educational retirement planning
agent for people about to leave full-time work. **Its purpose is to get the
owner to retirement as early as is safe:** say when they can retire, which
levers bring that date forward and by how much, what rules to run the money
by, and what to do next; then keep that plan current, reviewing it with the
owner every month and after every change.

It aims to do most of what a paid planner does for the plan itself (the
analysis, the recommendations and the monitoring) and to hand the judgement
calls to people: the owner decides every change, and the plan review names
what a fee-only planner, a CPA, an estate attorney or the agencies should
check before the plan is final (REQ-MCP-69). The benchmark against paid tools,
advisers and the research is in `docs/RESEARCH.md`.

Its main surface is Claude: a plugin and MCP server (FR-23) whose tools run
the deterministic engine and return every figure with a provenance stamp,
while Claude only explains them. The planning loop follows the planner's
sequence: understand (profile, snapshots, briefing), goals (profile `goals`),
analyse (projections, verdict, earliest retirement age), recommend (levers,
proposed rules), present (the plan review), implement (plan_check trades and
tasks) and monitor (the monthly runway check). The original browser app is
frozen: it still builds and its tests still run, and it computes in the
browser.

**Distribution decision (2026-10-03):** the product is free (MIT-licensed). It
produces outputs close to personalised investment recommendations ("suggested
trades"), which can attract investment-adviser registration questions, and
there is no licensed-counsel review on file. Paid checkout is therefore off by
default (NFR-05), and all output is framed as educational modelling (NFR-04).
Turning billing on needs legal sign-off first; this is a launch gate outside the
codebase.

**Principle:** the LLM narrates; it never calculates (NFR-01, FR-15).

## 2. Functional requirements

### FR-01 Plan intake without prefilled values

The plan wizard collects person, accounts, spending, income, healthcare, Social
Security and housing inputs. No financial value is prefilled; invalid or
inconsistent input is rejected with field-level messages. A "conservative sample"
may be loaded explicitly.

The plan cash, brokerage, traditional and Roth balances can come from a saved
positions snapshot instead of typed values, so a plan built after a new
`import_positions` save uses the newest snapshot rather than stale balances.
The engine maps each snapshot account by tax treatment: brokerage cash, CDs and
cash or money-market holdings go to the cash reserve and other brokerage
holdings to the brokerage balance; traditional IRA, rollover IRA, 401(k),
403(b), 457(b) and HSA accounts go to the traditional balance; Roth IRA and
Roth 401(k) accounts go to the Roth balance. The four balances sum to the
snapshot total. An unknown account type or a non-finite value names the
account and is rejected, and a bucket the plan cannot model (a net negative
cash reserve) is rejected by intake validation (BUI-1912).

### FR-02 Year-by-year projection kernel

A deterministic projection produces per-year rows: income by source, spending,
taxes, withdrawals and closing balance by account, accessible versus restricted
balance, and funding gap, in nominal and real terms.

### FR-03 Account access rules and withdrawal ordering

Withdrawals draw only from accessible accounts: age 59½, Rule of 55 (separation
age), 457(b), and scheduled NQDC access. Pretax money that is not yet accessible
is never spent, so the engine never models penalised early withdrawals; a plan
that needs them reports a funding gap instead.

### FR-04 Tax calculation

Taxes use versioned federal ordinary and LTCG brackets and the standard
deduction, called per projection year (not a flat gross-up).

### FR-05 Social Security

Worker, spouse, divorced-spouse and survivor benefits with claiming-age
reductions and delayed credits (none for pure spouse benefits), full retirement
age by birth year, and the 85% taxable fraction. Rules carry an as-of date and
source URL.

### FR-06 Healthcare and ACA

Phase-driven healthcare (employer, COBRA, ACA, Medicare) with its own inflation,
and the versioned ACA premium-tax-credit cliff. Unsupported residence regions fail
closed.

### FR-07 Deterministic stress suite

Ten deterministic cases run: the baseline plus market shocks (-20%, -30%),
two-year high inflation, doubled healthcare, halved outside income, a combined
bad start, work-exit delays (1 and 3 years), and downsize (committed and not
used).

### FR-08 Outcome-based verdict

GO / CAUTION / DELAY and a robustness score derive from observed outcomes. Each
metric carries weight and evidence. Only committed life events count in the base
verdict.

### FR-09 Minimum outside-income solver

Solves the smallest outside income that keeps the plan solvent, deterministically
and reproducibly.

### FR-10 Housing and life events

Dated life events carry a commitment level (committed, available,
aspirational). Housing sale and downsize proceeds feed the projection.

### FR-11 Plan comparison

Two analyses can be compared; the output lists what changed and why, with
direction.

### FR-12 Regression fixtures

Twelve plan regression fixtures are the acceptance suite for engine changes.

### FR-13 Portfolio import

CSV (Fidelity, Schwab, Vanguard, generic), Plaid mapping, and manual entry. A holding
named with a coupon and a maturity date (an individual CD, Treasury or other
note) is fixed income: `cd` when the name has the word CD or "certificate",
otherwise `us_bond`; a Treasury name is `us_bond`. Only a holding no rule
matches defaults to `us_equity`, with a warning.
Parsing never throws to the UI; malformed rows are skipped with warnings. IDs are
content-derived and stable.

### FR-14 Portfolio analysis tools

Four-scenario projections, seeded Monte Carlo (in a web worker), risk score,
de-risk trade ideas, CD break/hold analysis, cash-ladder planning, Roth
conversion, household and survivor modelling, and alerts.

The four scenarios and the Monte Carlo take three optional profile cash flows
(REQ-CF-1..3). `annualContributions` is added to the portfolio each projection
year before `targetRetirementAge`, fixed in dollars (REQ-CF-1).
`spendingPhases` (`startAge`, `annualExpenses`, increasing `startAge`) replace
`annualExpenses` from each phase's start age, in today's dollars and including
the mortgage payment while it is paid (REQ-CF-2). `homeSale` (`age`, optional
`salePrice` defaulting to the home value, `sellingCostRate` defaulting to 6%,
`replacementHomeCost`, `annualHousingCostChange`) adds the engine's net
proceeds to the portfolio in the sale year: the sale price less selling costs,
less the mortgage balance amortized monthly to 1 January of that year, less the
replacement home cost. The mortgage payment stops from the sale age and the
housing cost change (grown with inflation) applies from it (REQ-CF-3). Sale
amounts are today's dollars and are not grown. `portfolio_analysis` names the
computed sale, the contributions and the phases in its stamp assumptions. A
profile with none of these fields gives the same output as before.

Social Security in the scenarios and the Monte Carlo grows with the
projection's inflation (a COLA), since SSA estimates are in today's dollars;
`socialSecurityCola: false` keeps a benefit fixed in dollars (REQ-CF-4).
Pension and other income stay fixed in dollars. `withdrawalTaxRate` (0–0.6)
grosses each withdrawal up to `need / (1 − rate)`, so `annualExpenses` is
after-tax spending; without it `annualExpenses` is the gross withdrawal
(REQ-CF-5).

### FR-15 AI narration (BYOK)

Optional narration of engine output using the user's own key or the server key.
The narrator receives engine results and never produces numbers. Data-flow
disclosures are accurate.

### FR-16 Reports

Markdown and print-to-PDF export with deterministic identity and explicit
`asOf` / `generatedAt` inputs.

### FR-17 Optional persistence and sync

Local-only operation works with no backend. With Supabase configured, portfolios
and scenarios sync under row-level security and degrade gracefully when the
backend is unavailable.

### FR-18 Public API v1

`/api/v1/analyze` and `/api/v1/tax` use bearer API keys and fail closed (503) when
no keys are configured.

### FR-19 Agent skill

A Claude Code skill wraps the engine as CLIs with a provenance block (tool,
version, canonical input hash, seed).

### FR-20 Marketing, legal and trust pages

Landing, features, pricing, FAQ, about, privacy and terms pages whose claims match
shipped behaviour.

### FR-21 Plan outputs: bridge, milestones, lifetime chart, export

The results page shows a bridge summary (years to Medicare and Social Security,
bridge spending, accessible balance at exit, lowest balance, outside income
needed), a milestone table, and an accessible-versus-restricted lifetime
chart. The plan exports as Markdown and JSON with a deterministic body (no
clock reads) and cited rule sources.

### FR-22 Plan Monte Carlo (chance of success)

The results page offers a seeded Monte Carlo run of the plan: the deterministic
projection replays over random yearly market returns for each market account,
and reports the share of paths with no funding gap plus percentile balance
bands in real dollars. It runs in a web worker on request, is reproducible for
a seed, and equals the deterministic projection at zero volatility. Inflation
is not randomised.

### FR-23 Plan MCP server

`npm run mcp` serves a local stdio MCP server over the plan engine and the
portfolio engine, for development and offline use in Claude Code. Its plan
tools are `build_plan`, `analyze_plan`, `compare_plans` and `plan_monte_carlo`; its
portfolio tools are `import_positions`, `portfolio_analysis`, `tax_strategy`
and `trade_plan`; its user data tools are `get_briefing`, `save_profile`,
`get_profile`, `save_plan_notes`, `list_snapshots` and `delete_user_data`. Each tool has a strict input schema. The engine computes
every number; each result carries the skill provenance stamp (input and output
hashes, assumptions, and the seed for seeded tools). Invalid intake returns
field-level errors and nothing computed. The same seed gives the same Monte
Carlo result. `import_positions` takes the as-of date from its `asOfDate`
argument, else from the export date in the CSV, else leaves it out with the
warning `no as-of date: pass asOfDate`; it never reads the system clock, and
its stamp records the source (`input`, `csv` or `none`). The portfolio tools
apply the `/api/v1` value rules and return the values `/api/v1/analyze` and
`/api/v1/tax` compute.

The server keeps one user's retirement facts on that user's machine, under
`$RETIRE_RUNWAY_DATA_DIR` (default `~/.retire-runway`, an absolute path or
one that starts with `~`), and refuses a data directory inside the package or
repo. The directory is mode 700 and each file mode 600. `save_profile`
validates a profile with the `portfolio_analysis` value rules and writes
`profile.json`, or returns field-level errors and writes nothing;
`get_profile` returns it with its `updatedAt`. `import_positions` with
`save: true` (as-of date required) also writes `snapshots/<asOf>.json`, with
account numbers removed from account names and positional IDs in place of
content-hash IDs; `list_snapshots` returns each snapshot's date and total
value, newest first. `portfolio_analysis`, `tax_strategy` and `trade_plan`
called without `profile` or `portfolio` use the saved profile and the newest
snapshot, give the same result and input hash as a call that passes them, and
name the saved files and dates in the stamp (`assumptions.savedData`); with
nothing saved they return a field-level error that names `save_profile` or
`import_positions`. `delete_user_data` with `confirm: true` removes the
profile, the snapshots and temporary files of interrupted writes, keeps any
other file, and reports both lists.

A server with no disk for the owner's data keeps it in a private GitHub repo
folder instead: when `RETIRE_RUNWAY_DATA_REPO` (`owner/repo`),
`RETIRE_RUNWAY_DATA_PATH` (the folder, for example `retire-runway`),
`RETIRE_RUNWAY_GITHUB_APP_ID` and `RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY` (a
GitHub App with Contents read and write, installed on that repo) are all set,
the user data tools and the portfolio tools read and write the same files (`profile.json`,
`snapshots/<asOf>.json`) in that folder through the GitHub contents API, one
commit per write named `data: <tool> <file>`. When none is set the local
folder store is used; when only some are set the tools return a field-level
error naming the missing ones. A write that races
another write on the same file retries once on the GitHub `409` (or `422`
missing-sha) conflict and then returns a field-level error; it never
overwrites the newer file. A GitHub error returns a field-level error naming
the repo path and status, never the token. Both stores pass one contract test
suite (REQ-MCP-17..21, BUI-1858).

The repo store authenticates as that GitHub App, so no person has to create a
token on the web. It signs an RS256 app JWT with the private key, looks up the
app's installation on the data repo and gets a one-hour installation token
narrowed to that repo, and uses it for the contents API (REQ-STORE-APP-1). It
reuses a token while more than 5 minutes of it are left and otherwise mints a
new one (REQ-STORE-APP-2). When the app is not installed on the data repo, the
store fails with an error that names the repo and the install step, and does
not fall back to the local folder (REQ-STORE-APP-3). The store does not read a
personal access token (REQ-STORE-APP-4), and it does not assume a token length
or format, as GitHub may issue `ghs_APPID_JWT` tokens (REQ-STORE-APP-5). The
new code and test files are traced to FR-23 (REQ-STORE-APP-6). Card
requirements REQ-STORE-APP-1..6 (BUI-1917).

The same server is hosted in the Next app at `/api/mcp` over Streamable
HTTP, for Claude on the web, desktop and mobile, as an OAuth resource server.
A request without a valid bearer token gets `401` with
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`
and runs no tool (REQ-MCP-22); that document returns JSON whose `resource` is
`<origin>/api/mcp` and whose `authorization_servers` lists the configured
issuer `RETIRE_RUNWAY_OAUTH_ISSUER` first (REQ-MCP-23). A valid token is a JWT
signed with a key from `RETIRE_RUNWAY_OAUTH_JWKS_URL`, issued by that issuer
for the `<origin>/api/mcp` audience and unexpired; when its subject is
`RETIRE_RUNWAY_OWNER_SUBJECT` the endpoint serves the same tools as the stdio
server (REQ-MCP-24), and for any other subject it answers `403` and runs no
tool (REQ-MCP-25). When any of those variables is unset, or a URL among them
is not https (http only on a loopback host), the endpoint answers `500`
naming them and serves no tool (REQ-MCP-26). Card requirements
REQ-MCP-22..26 (BUI-1856).

The same deployment is the authorization server that endpoint names, so the
owner can connect from claude.ai on the web, desktop and mobile and from
Claude Code. Sign-in delegates to GitHub: only the GitHub login in
`OWNER_GITHUB_LOGIN` gets a token. `/.well-known/oauth-authorization-server`
returns RFC 8414 metadata with the issuer, the authorization, token and
registration endpoints, `code_challenge_methods_supported: ["S256"]`,
`client_id_metadata_document_supported: true` and `none` among the token
endpoint auth methods (REQ-MCP-27). A client registered by dynamic client
registration (`POST /oauth/register`, JSON) or presented as a client ID
metadata document may use only the redirect
`https://claude.ai/api/mcp/auth_callback` or a loopback redirect
`http://localhost:<port>/callback` or `http://127.0.0.1:<port>/callback`; any
other redirect is refused (REQ-MCP-28). Before fetching a client metadata
document the server resolves its host and refuses it unless every address is
public (no private, loopback, link-local or cloud metadata address), then
connects to the address it checked, so a DNS rebinding answer cannot move the
fetch (REQ-MCP-28). When the spent-grant record cannot be read, the reply says
only to try again later; the detail, which names the owner's private data
repo, goes to the server log, unless it is a setup step the owner must take. When the owner completes GitHub
sign-in, the token endpoint (`POST /oauth/token`, form-urlencoded) trades the
code and a matching PKCE verifier for a JWT access token (audience
`<origin>/api/mcp`, subject `OWNER_GITHUB_LOGIN`, one hour) that the resource
server accepts, and a rotating refresh token (REQ-MCP-29). When another GitHub
login signs in, the server shows an error page and issues no code
(REQ-MCP-30). A refresh token that was already used or has expired gets
`invalid_grant` (REQ-MCP-31), and so does a PKCE verifier that does not match
(REQ-MCP-32). It needs `RETIRE_RUNWAY_OAUTH_SIGNING_KEY` (a private ES256
JWK), `RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_ID` and
`RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_SECRET` (a GitHub OAuth app whose callback
is `<issuer>/oauth/github/callback`) and `OWNER_GITHUB_LOGIN`; the resource
server's `RETIRE_RUNWAY_OAUTH_JWKS_URL` is `<issuer>/oauth/jwks` and its
`RETIRE_RUNWAY_OWNER_SUBJECT` is the same login. Spent codes and refresh
tokens are recorded in `oauth-grants.json` in the owner's data repo folder
(`RETIRE_RUNWAY_DATA_REPO`, `RETIRE_RUNWAY_DATA_PATH`, with the git store's
GitHub App token from `RETIRE_RUNWAY_GITHUB_APP_ID` and
`RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY`) in production, so a reuse is refused on every
server instance; when that record cannot be read or written the token
endpoint answers `503` and issues no token. An unset production setting
answers `500` naming it. Explicit factory instances and non-production route
tests use one process-local grant store when none is injected. Card
requirements REQ-MCP-27..32 (BUI-1857).

The server carries its own agent context, so a chat with only the connector
(web, phone, Claude Code) needs no plugin. `get_briefing` returns the saved
profile, the newest saved snapshots with their totals, the plan notes, and
checks: the inputs a saved profile leaves out that move results most
(savings until retirement, spending phases for healthcare before 65, Social
Security, tax on withdrawals) and the mortgage payoff-date warning.
`save_plan_notes` saves the plan notes in
`notes.json` beside `profile.json` in either store, and `delete_user_data`
removes them too (REQ-MCP-33). The server sends instructions at connect time
that tell the agent to start with `get_briefing`, narrate engine figures
only, name missing inputs and warnings first, and keep confirmed figures and
decisions in the profile and the plan notes; they name only registered tools
(REQ-MCP-34).

Plan notes are kept in five sections: Decisions, Scenarios being weighed,
Confirmed figures, Open items and Agent log. `save_plan_notes` takes
`{ section, text, expectedRevision }` and replaces only that section; each
section carries a revision that starts at 0 and goes up by one per save. A
save whose `expectedRevision` is not the stored revision saves nothing and
returns a conflict naming the current revision. Notes saved as one text
before sections are split at their `##` headings into the sections they
name (each heading kept with its lines; text before the first heading and
headings that name no section go to Decisions; with no such heading the
whole text is Decisions), every line kept, each filled section at revision 1,
and are rewritten in sections on the next save (REQ-MCP-35). The server
refuses notes that hold a card number, a Social Security or other government
ID number, an account or routing number, or a password, with a message that
names the kind of content and the section but never echoes the value, and
refuses a section longer than 4,000 characters (REQ-MCP-36). `get_briefing`
returns, in this order: checks (warnings, then missing inputs, each with the
tool that fixes it, and a warning for any stored section over the limit or
holding such content); the saved profile and the newest snapshot dates and
totals; the notes by section with their revisions; at most five next
actions (fixes first, then open items, else `portfolio_analysis`); and the
server version with a short list of what's new (REQ-MCP-37). The server
instructions tell the agent to start every chat with `get_briefing`, save
confirmed figures with `save_profile`, and save decisions, scenarios and
open items with `save_plan_notes` one section at a time (REQ-MCP-38).

`project_retirement` is the v2 projection (`src/engine/retirement-projection.ts`),
deterministic and seeded like the v1 Monte Carlo, which `portfolio_analysis`
keeps unchanged. It projects to `planningAge` (default 95) over five account
buckets (taxable; 401(k)/403(b)/457(b); IRA; Roth and HSA; NQDC) and
withdraws RMDs (Uniform Lifetime Table, from 75) and the NQDC `nqdcPayout`
schedule first, then taxable money, then the employer plan from 60 (or from
a `separationAge` of 55 or later, the Rule of 55; its 457(b) part from
separation at any age), the IRA and Roth from 60,
and before that the same with the 10% penalty. Tax is the federal brackets
for `filingStatus` (indexed to inflation) with long-term gains on the
taxable bucket's gain share and Social Security taxed by the provisional-
income formula (thresholds not indexed), plus `stateTaxRate`, with
retirement income exempt under `stateExemptsRetirementIncome` (REQ-MCP-39).
It counts the spouse's own Social Security from the spouse's age and
`preMedicareHealthcare` from retirement to 65 (half while only a younger
spouse is under 65), reports every figure in today's dollars, and returns
warnings first, a summary, three charts whose series hold one value per age
(balance band, income and spending, balance by account type), and the
year-by-year expected-return path; same inputs and seed give the same
output hash (REQ-MCP-40). The server instructions tell the agent to use it
for success rates and to draw its charts on any client that can
(REQ-MCP-41).

With `acaPremiumTaxCredit`, `project_retirement` treats `preMedicareHealthcare`
as the unsubsidized benchmark silver premium and subtracts the premium tax
credit each year: the premium less the 2027 applicable percentage
(Rev. Proc. 2026-26) of MAGI, never below 0 or above the premium, with no
credit above 400% of the 2026 poverty line for `householdSize` (default 2
with a spouse); both are indexed to inflation. MAGI is AGI plus untaxed
Social Security. The taxable bucket tracks its cost basis, and home-sale
proceeds are basis (the gain assumed within the main-home exclusion), so
spending them adds no MAGI. A year whose credit does not settle at the cliff
is figured without the credit (REQ-MCP-42). `compare_retirement_scenarios`
runs the current plan and up to four named scenarios (profile changes over
the current plan, optional fields removed), each validated, on the same
portfolio, seed and planning age, and returns each scenario's success rate,
depletion ages, median balances at key ages, lifetime tax and ACA credit,
the profiles used, and three charts (success rates by scenario, median and
poor-market balance by age per scenario) (REQ-MCP-43).

`project_retirement` adds Medicare IRMAA from 65: each person on Medicare
pays the Part B and Part D surcharges of the tier set by the household's AGI
two years earlier, using the CMS 2026 table (joint thresholds for married
filing jointly, individual otherwise; thresholds and amounts held flat in
today's dollars). The surcharge is paid from the portfolio like healthcare.
A lookback year before retirement is not modelled and is named in the
warnings. Each year reports `irmaa` and `irmaaTier`; the expected path and
`compare_retirement_scenarios` report lifetime IRMAA (REQ-MCP-44).

`plan_check` measures the newest snapshot against the owner's own rules, saved
as the profile's `planRules` (target stock share, drift band, minimum cash
buffer in years of retirement spending, account types never to sell from,
tickers that count as cash, and a dated sell schedule), on an `asOfDate` the
caller passes. It returns a status (`on_plan`, `on_schedule`,
`action_needed`), a one-line headline, the measures before and after the
recommended trades, each scheduled sale's status, and ranked recommendations
with the trades by account and estimated tax. Sales come from unprotected
accounts, tax-advantaged first, from one shared pool so no dollar is sold
twice; a scheduled chunk is capped at the stock dollars still above target.
Nothing is traded: the owner reviews and places every order. `get_briefing`
suggests `plan_check` (or setting `planRules`) once a profile and snapshot are
saved (REQ-MCP-47).

A profile `survivor` scenario (`deceased` self or spouse, `deathAge` in the
owner's age, `spendingShare` default 0.75) changes `project_retirement` from
the year after the death: the survivor files single as a household of one,
keeps the larger of their own Social Security and the survivor benefit (the
deceased's benefit, or the full-retirement-age benefit plus delayed credits
earned by death if not yet claimed, times 71.5% at 60 rising to 100% at 67,
at the survivor's age when it starts, and kept at that rate; it starts the
first year it is payable, or at 67 when their own benefit is claimed before 67
(own first, survivor later), or at `survivorClaimAge` when given),
pays pre-Medicare healthcare and IRMAA for one, and spends the share of the
couple's spending beyond the mortgage payment. It works as a
`compare_retirement_scenarios` change (REQ-MCP-48).

`explore_claiming_ages` sweeps Social Security claiming ages 62–70 for the
owner and spouse (default 62, 65, 67, 68, 70; at most 45 pairs) through
`project_retirement` on one seed, moving each saved benefit by the SSA rules
for anyone born 1960 or later (full retirement age 67; 5/9 of 1% a month for
the first 36 months early, 5/12 of 1% beyond; 8% a year delayed to 70). With
`survivor` it also runs each pair with that death. It returns each pair's
benefits, success rate, survivor success rate, median balance and lifetime
Social Security, the current pair, the best pair and best versus current
(REQ-MCP-49).

`historical_backtest` replays the plan from every start year 1928–2025: the
years before retirement earn the expected returns; from the retirement age the
portfolio earns that year's S&P 500 and 10-year Treasury total returns
(Damodaran, NYU Stern) with that year's CPI-U inflation (Federal Reserve Bank
of Minneapolis), then the next year's, continuing from 1928 past 2025
(marked wrapped). The data are committed, never fetched at run time. It
returns the share of start years that last (all and unwrapped), the named
years 1929, 1937, 1966, 1973, 2000 and 2008, the five worst start years and a
balance-by-age chart (REQ-MCP-50).

A profile `marketAssumptions` sets the mean stock, bond and inflation rates for
the first `years` (default 10) of every v2 projection, then the engine's
long-run means (7%, 4%, 3%); volatility is unchanged. Preset `forecast` uses
the 10-year valuation-based forecasts committed in `MARKET_FORECAST` (Vanguard
2026 outlook: US equities 4%–5% and high-quality US bonds about 4%; in line
with Morningstar's 2026 survey of firms), midpoints 4.5% and 4.0%. It applies
to the Monte Carlo, the expected path and the pre-retirement years of the
historical backtest, and the warnings name it (REQ-MCP-51).

A profile `incomeGap` (`startAge`, `months`, optional `severance`,
`newAnnualContributions`, `monthlySpending`, `healthcareMonthly`) models a
gap in pay before retirement: for the gap months household spending and
health insurance come from savings and there are no contributions; severance
joins taxable savings as basis; afterwards the new job's savings apply until
retirement. Leaving at the gap start is the separation for the Rule of 55 on
the old employer's plan (REQ-MCP-52).

The v1 tools follow the owner's rules: `portfolio_analysis` alerts use the
saved `planRules` target stock share, drift band and cash buffer, and return
`projection`, the v2 success rate to quote beside the v1 Monte Carlo;
`trade_plan` never sells from a protected account type (REQ-MCP-53).

`project_retirement` pays the spousal top-up once both spouses have claimed:
half the other spouse's full-retirement-age benefit less the spouse's own,
if positive, reduced 25/36 of 1% a month for the first 36 months before 67
and 5/12 of 1% beyond (65% at 62), with no delayed credits. The reduction
follows the receiving spouse's age when the top-up starts: the later of the
two claims (REQ-MCP-54).

A `survivor` scenario may put the owner's death before retirement: from the
next year pay and savings stop, the survivor's spending and health cover
start, and a beneficiary's withdrawals carry no 10% penalty. `lifeInsurance`
(today's dollars) is paid tax-free into taxable savings the year after the
death (REQ-MCP-55).

`plan_verdict` gives one GO, CAUTION or DELAY verdict on an `asOfDate` from
the engine's own results on one seed: the v2 success rate at the long-run and
at the forecast means, the share of 1928–2025 start years that last, the
spending the plan supports at 85% and, with saved `planRules`, the plan
check. GO needs at least 85%, 75% at forecast returns, 90% of start years and
no overdue trades; DELAY follows from under 60%, under 45% or under 70%;
otherwise CAUTION. It returns the reasons, at most five actions (plan check
trades first) and the thresholds (REQ-MCP-56).

`nqdcPayout.onSeparation` starts the NQDC payout at separation (the income
gap start, or `separationAge`) instead of `startAge`, for elections tied to
leaving the job; the warnings name the start age (REQ-MCP-57).

`explain_change` runs two saved snapshots (default the two newest) through the
v2 projection on the saved profile and one seed and reports each one's total
value, stock share and success rate, the portfolio's effect in points and the
five holdings that moved most. With `previousSuccessRate` it splits the total
change into the portfolio's effect and everything else (REQ-MCP-58).

A profile `socialSecurityCut` (`share` 0 to 0.5, `startYear`) pays every
Social Security benefit (own, spousal and survivor) at `1 - share` of scheduled
from that calendar year in the v2 projection. With no values it follows the
2026 Trustees Report: the OASI trust fund is depleted in the fourth quarter of
2032, so 78% is payable from 2033. The warnings name the cut (REQ-MCP-59).

A profile `lumpSums` (up to 10 of `name`, `age`, `amount`) adds one-off
after-tax money in today's dollars, such as a foreign pension paid out or an
inheritance, to taxable savings as basis in the year the owner reaches `age`.
The warnings name each sum, or say it is ignored when its age is outside the
projection (REQ-MCP-60).

`planRules.tasks` (up to 24 of `id`, `dueDate`, `action`, `done`) holds one-off
actions that are not stock sales, such as a fund switch or a CD rollover.
plan_check lists every task with its status, recommends each overdue or due
task (which makes the status action_needed) and lists a task due within 7 days
without making it action_needed (REQ-MCP-61).

The cash buffer counts liquid cash only: cash, money market, CDs and
`bufferSymbols` holdings in taxable (brokerage) accounts, plus
`planRules.outsideCash` (bank savings not in the snapshot). The same kinds of
holding inside a 401(k), IRA, Roth, HSA or deferred comp plan are reported as
`retirementAccountCash` and never count, because they are taxed (and before
59½ penalised) on the way out; sale proceeds count only when the sale is in a
taxable account. The portfolio_analysis cash-buffer alert uses the same rule
(REQ-MCP-62).

`planRules.cdLadder` (`accountType`, `firstYear`, `lastYear`, optional `total`
and `maxPerIssuer`) is a CD or Treasury ladder with one rung maturing each
year. plan_check counts what each rung already holds (CDs, CD holdings with a
maturity date in the name, iShares iBonds Treasury ETFs by their year), sizes
the ladder (by default: those holdings, holdings that mature into it before
`firstYear`, idle cash in the account type and the sell schedule's proceeds
there) and places the cash ready now (idle cash, sales done after the snapshot
and sales due now) in the earliest short rungs, in $1,000 units. Each rung
gets the highest quote for its term from `rateQuotes` (`kind` cd or treasury,
`termYears`, `apy`, `callProtected`, `source`, `quotedOn`), which the agent
reads from the broker; callable CDs are never used, a tie goes to the Treasury,
quotes older than 7 days are flagged, and a rung above the FDIC limit
($250,000 per bank) is flagged to split. The buys are a `cd_ladder`
recommendation (REQ-MCP-63).

The ladder lives in one account: the account of `accountType` (whose name
contains `accountName`, when given) that holds the most ladder money (idle
cash, dated holdings and sale proceeds); only that account's cash and holdings
count. A scheduled sale marked done on or after the snapshot date is taken off
the stock lots before anything is measured, and its proceeds count as cash
where they landed, so plan_check never sells or counts those dollars twice
(REQ-MCP-63).

**The agent proposes the rules (REQ-MCP-64).** RetireRunway follows the
financial-planning sequence a planner uses: understand the household, set
goals, analyse, develop recommendations, present them, implement, monitor.
The engine already analyses (projections, verdict), implements (plan_check
trades) and monitors (runway check); `propose_plan_rules` develops and
presents the investment rules themselves, so the owner is not left to invent
them. From the saved profile and newest snapshot it returns:

- **Stock share, tested.** The plan is run at each candidate stock share (30%
  to 80% in steps of 10, plus the current target), at the long-run means and
  at the 10-year forecast means, on one seed, with each account rebalanced to
  the candidate and its total and taxable basis kept. The proposal is the share
  with the best worse-of-the-two success rate; within 1 point, the lower share.
  The table of results comes with it.
- **A ladder that funds spending.** Rungs mature one a year from the
  retirement year for the bridge to Social Security (at most 5 rungs), each
  sized to the expected path's withdrawals that year (not counting deferred
  compensation, which pays itself), in today's dollars. The ladder is never
  larger than the bonds and cash the proposed stock share leaves; rungs it
  cannot fill are named. It sits in the account type holding the most money
  outside taxable and deferred-compensation accounts, and a rung whose
  withdrawal would carry the 10% early penalty (before 59½, unless the Rule of
  55 applies to a 401(k)) is flagged. Rungs more than 10 years out are marked
  to buy later.
- **A cash buffer that starts when it is needed:** 1 year of retirement
  spending in liquid cash from one year before retirement (`bufferStartAge`);
  plan_check does not ask for it before then (REQ-MCP-65).
- **A sell schedule** for stocks above the proposed share that the current
  schedule does not cover: up to 3 equal monthly sales on the 15th, from the
  account plan_check would sell in, in $1,000 units.
- **Protected accounts:** taxable accounts with unrealised gains are
  protected, so sales come from tax-advantaged accounts first.
- **Findings** for each rule: keep, change, add or needs input, with the
  current value, the proposed value and the reason, including conflicts in the
  current rules (a ladder that matures before retirement, a buffer asked for
  years early, a target the test does not support, bank savings not given).

`proposedRules` is a complete `planRules` that keeps the owner's tasks,
buffer symbols and done sales. Nothing is saved: the agent presents each
finding, and the owner approves or declines each change before save_profile.
A scheduled run reports the count of changes and never saves (REQ-MCP-64).

`planRules.bufferStartAge` (18 to 100): plan_check measures the liquid cash
buffer always but recommends building it only once the owner's age reaches
it (REQ-MCP-65).

**Goals (REQ-MCP-68).** `goals` in the profile holds what the owner is aiming
for: the chance the money lasts at long-run returns (`successRate`, default
0.85) and at the 10-year forecast returns (`forecastSuccessRate`, default
0.75), the latest retirement age worth considering (`latestAge`, default 70)
and the days between plan reviews (`reviewEveryDays`, default 30).

**When can I retire (REQ-MCP-66).** `earliest_retirement` runs the plan
retiring at every age from next year to `latestAge`, at both return
assumptions on one seed, and returns the earliest age where both success rates
reach the goals, the gap to the target age and the table. Moving the
retirement age moves the separation age, the deferred-compensation payout
start, the first retirement spending phase and a home sale when they were tied
to it; ages fixed by law or contract (a lump sum's age) stay.

**Levers (REQ-MCP-67).** `rank_levers` pulls each lever that fits the plan on
its own: spend 5% and 10% less in retirement, save $10,000 more a year until
retirement, earn $2,000 a month part-time for 5 years after retiring, and
downsize the home at retirement to one at half the price (6% selling costs),
plus up to 4 custom levers (a name and profile changes, such as a move found
with Lifescape). For each it returns the earliest age that reaches the goals,
the years gained against the plan as it is, and both success rates at the
target age, ranked by years gained and then by the worse of the two rates;
then the best helping lever of each group pulled together. The earliest age is
found by bisection, which assumes a later retirement never lowers success;
`earliest_retirement` scans every age and is the reference.

**The plan review (REQ-MCP-69).** `review_plan` is the living plan in one
result, for the monthly check and whenever the owner asks where things stand:
the verdict and its measures, the earliest age against the target, the top 5
levers and the best together, the count and names of the rule changes
propose_plan_rules suggests, the actions due from the owner's rules, the data
to refresh (positions over 35 days old, sales marked done after the snapshot,
a mortgage balance over a year old), the decisions only the owner can make,
the checks for human professionals (always a fee-only planner review, Social
Security records and an estate attorney; a Marketplace quote when healthcare
before 65 is in the plan; the deferred-compensation election; the US tax on
each lump sum; Roth conversion amounts when over 70% of the money is pre-tax;
life cover when there is a spouse), and the next review date: the review
cadence, or sooner when a sale or task falls due. It changes nothing. The
skill records what the owner decides in the plan notes and applies approved
changes with save_profile, so the plan is reviewed and refined with the owner
over time.

**A stable tool surface (REQ-MCP-73).** Claude loads a connector's tools and
their input schemas when a chat starts (the phone and desktop apps can keep
them longer), and no client re-reads them mid-chat, so a tool or field added
in a release is out of reach of an open chat. The server therefore keeps a
registry of every tool it registers; `run_tool` (`tool`, `arguments` as an
open object) calls any of them by name, checks the arguments against that
tool's current schema with field-level errors, and returns the tool's own
result; it will not run itself or `delete_user_data`. `get_briefing`
returns `tools`, every tool with a one-line summary and its arguments
(required ones marked `*`), so a chat learns of new tools from a result. The
instructions and skill tell the agent to use `run_tool` for a listed tool
missing from its list and never to ask the owner to start a new chat for it.

**Patch saves (REQ-MCP-74).** `update_profile` changes saved profile fields
by dotted path (`set`, arrays replaced whole) and drops fields (`remove`),
then checks the merged profile with the same strict schema and value rules as
`save_profile`, saving nothing when any check fails. Its `set` is an open
object, so its schema never changes as fields are added. The agent never
asks the owner for a figure the saved profile or notes already hold.

**Withdrawal order (REQ-MCP-70).** The projection takes spending, after RMDs
and the deferred-compensation payout and before any penalised early
withdrawal, in the profile's `withdrawalOrder`: `taxableFirst` (the default:
taxable, then pre-tax accounts that are open, then Roth), `preTaxFirst`, or
`proportional` (every open account in proportion to its balance).
`explore_withdrawal_order` runs the three orders and taxable first with Roth
conversions filling the 12% bracket on one seed and returns each order's
success rate, median balance at the planning age, lifetime tax, IRMAA and ACA
credit, the change against the current order, the best (highest success,
then median balance, then lowest tax plus IRMAA) and a headline. review_plan
lists a better order as an owner decision when it adds more than 1 point.

**Glide path (REQ-MCP-71).** The profile's `glidePath` sets the stock share
by age: straight lines between points, flat before the first and after the
last; without it the snapshot's share holds every year. propose_plan_rules
tests a bond tent (the target share now, 15 points lower at retirement, back
to the target 10 years later), a rising path (20 points lower at retirement,
10 points above the target 15 years later) and any saved path against the
constant target, on the worse of long-run and forecast returns, and proposes
the best path only when it beats the constant share by more than 1 point.
With a path saved, plan_check measures drift against the path's share at the
owner's age.

**Balances from an aggregator (REQ-MCP-72).** `import_balances` reads a
net-worth list pasted from Empower or another aggregator (one account per
line, name then balance; section headings and their totals recognised and
not counted twice; a last-updated date read), masks account numbers, sorts
each line into cash, investment, credit card, loan, mortgage, home or other,
takes earmarked cash out of free cash, and checks the list against the saved
plan: card and loan debt over free cash, free cash under 3 months of
spending, accounts not updated for 30 days, and investments more than 3% from
the newest positions snapshot or a snapshot over 14 days old. It returns the
profile changes to propose (planRules.outsideCash, consumerDebt, mortgage
balance and date, home value) and saves nothing. review_plan reports free
cash against `consumerDebt` and months of spending.

**Current market data (REQ-MCP-75).** `save_market_data` saves dated market
data on the profile (`marketData`): the 10-year Treasury yield, the 10-year
TIPS real yield, the best call-protected CD yields by term, the firms' 10-year
US stock forecasts and the sources, all read by the agent from dated pages.
With it, preset `forecast` uses stocks at the forecasts' average, bonds at the
Treasury yield and inflation at the breakeven (Treasury less TIPS) for 10
years, in every tool, in place of the committed figures. `get_briefing` names
`marketData` as a missing input, and warns when it is over 35 days old;
`review_plan` lists both in `dataToRefresh`. `propose_plan_rules` and
`review_plan` return the comparison of safe yields with stocks (`market`):
the breakeven, the stocks' expected real return and their expected premium
over TIPS, with a headline.

**Safe ladder for the bridge (REQ-MCP-76).** The profile's `safeLadder` is a
held-to-maturity TIPS or CD ladder: rungs of an age, an amount in today's
dollars and the yield at purchase. The projection takes the ladder's cost
(each rung discounted at its yield) from the account that holds it, cash and
bonds first, and pays each rung in its year, TIPS rungs grown with the
path's inflation and CD rungs fixed, taxed like a withdrawal from that
account. With market data saved, `propose_plan_rules` tests ladders for the
first 3 and 5 bridge years and the whole bridge (retirement to the year
before Social Security), each sized to the expected withdrawals and bought at
the saved yields (TIPS unless a CD's yield less the breakeven beats the TIPS
real yield at a term within a year of the rung), with the best stock share of
the rest, on the same seed. When a ladder beats no ladder by more than a
point on the worse of long-run and forecast returns, it proposes the ladder
(`safeLadder`), the ladder rule's years and total, and the stock share of the
whole portfolio with the ladder counted as bonds.

**The engine's rules as working settings (REQ-MCP-77).** Profile
`goals.autoApplyRules` makes the proposed plan rules the system's working
settings: `review_plan` then reports `rules.mode: 'auto'`, stands its verdict,
levers and actions on the proposed rules, ladder and glide path, lists the
changes for the agent to save with `update_profile`, and asks the owner
nothing about them. Without it (`approve`), the owner approves each change.
Trades and purchases are always the owner's. The scheduled check refreshes
the market data and, in auto mode, saves the changed settings and reports
each as a changed recommendation.

**Asset classes beyond stocks and bonds (REQ-MCP-78).** Holdings fall into
three sleeves: stocks (US, international, emerging, REITs), the safe sleeve
(bonds, TIPS, CDs, cash, money market) and alternatives (gold and other
commodities, crypto, other). Alternatives earn their own return (long-run
4%, volatility 16%, drawn independently, and only when held so plans without
them keep the same seeded results) instead of being modelled as bonds, and
REITs count as stocks. `marketData.assetForecasts` holds the firms' 10-year
forecasts by asset class; under preset `forecast` the near-term stock and
alternatives means are the value-weighted forecasts of the classes the owner
holds. `propose_plan_rules` and `review_plan` compare every saved class with
TIPS (`market.assets`: real return, premium over the TIPS real yield, that
premium per unit of volatility, and a verdict: below TIPS, thin, fair or
strong), and test the alternatives share at none, today's, 5% and 10%
(`altTest`); a better share is advice to act on (`altShare`), not a saved
setting.

**Debt against safe yields (REQ-MCP-79).** `review_plan.debt` ranks each
debt against what safe money pays (the saved 10-year Treasury yield, else
the 4% bond mean): card and loan debt (`consumerDebt`, `consumerDebtRate`)
above it is paid off first and leads the actions; a mortgage more than half
a point above it is worth extra payments, below it is kept. A missing APR is
asked for in `dataToRefresh`.

**Lifetime income annuity (REQ-MCP-80).** The profile's `incomeAnnuity`
buys a SPIA at `purchaseAge` with `premium` (today's dollars) from the
accounts of `accountType`, paying `premium x payoutRate` a year from then,
fixed in dollars, taxed like a withdrawal from that account, to the
survivor when joint. With `marketData.annuityQuotes` saved,
`propose_plan_rules.annuityTest` tests none, 25% and 50% of the expected
balance at Social Security age at the nearest quote (joint for a couple);
a better result is advice (`incomeAnnuity`), not a saved setting.

**Health cover rising faster than prices (REQ-MCP-81).** The profile's
`healthcareRealGrowth` grows pre-Medicare cover by that much a year above
inflation. When it is not set, `review_plan.stressTests` reports the plan
with 2 points a year and the change in the chance of success.

**Stress tests: correlation, care, job loss, currency (REQ-MCP-82).**
`marketAssumptions.stockBondCorrelation` (-0.9 to 0.9, default 0) correlates
each year's stock and bond shocks in the Monte Carlo; at 0 the draws and
seeded results are unchanged. `longTermCare` {startAge, years, annualCost}
adds a care cost (today's dollars) for those years while the owner lives.
`review_plan.stressTests` also reports, each only when the profile does not
already model it: correlation 0.5 (2022-style), a care need of $74,400 a year
(national median assisted living, CareScout 2025) for 3 years from 85, a
year out of work from 55, and lump sums worth 20% less (currency).

**Job change and the Rule of 55 (REQ-MCP-83).** The profile's `jobChange`
{age, oldPlan, nqdcStartsAtChange?} moves the owner to a new employer before
retirement. `rollIn` keeps the old 401(k) in the employer plan, so the Rule
of 55 covers it at the final separation; `ira`, or `leave` before 55, moves
it to the IRA bucket (penalty-free from 59 1/2); `leave` at 55 or later keeps
it open. Leaving the old employer starts the NQDC payout at the change age
unless `nqdcStartsAtChange` is false. When the profile has no job change and
the owner is under 54, `review_plan.stressTests` compares a change at 54 with
a roll-in and with an IRA rollover, and `humanChecks` asks the new plan's
administrator to confirm roll-ins when the Rule of 55 bears on the plan.

**Law figures kept current (REQ-MCP-84).** Every law or benefit table the
engine uses is registered in `law-tables.ts` with its year, its source and
when the next year's figures are normally published (federal tax tables by
mid-November, Medicare premiums and IRMAA by end of November, ACA applicable
percentages by September, HHS poverty guidelines by mid-February, the
Social Security Trustees Report by mid-July). When the law on the date is
ahead of a table, `get_briefing` warns and `review_plan.dataToRefresh` says
which tables are behind and where the new figures are published; a yearly
scheduled check updates them in an engine release. The federal tables are
for 2027 (Rev. Proc. 2026-35) and IRMAA for 2027 (CMS, Nov 17, 2026). The
projection adds the extra standard deduction for each person 65 or older
($1,700 married, $2,100 unmarried) and the senior deduction ($6,000 per
person 65+, phased out 6% above $75,000 / $150,000 MAGI) in tax years
2025-2028 only (OBBBA §70103; listed in `LAW_SUNSETS`).

**Asset location (REQ-MCP-85).** `review_plan.assetLocation` adds up
stocks, bonds and cash by place (taxable, pre-tax, Roth/HSA) and proposes
swaps of $5,000 or more, in whole thousands, that keep the overall mix: bonds
held in taxable against stocks held pre-tax (taxable cash stays as the
buffer), and bonds or cash in Roth/HSA against pre-tax stocks. Protected
account types are left alone. Each swap is an action, with the interest no
longer taxed each year at the saved Treasury yield.

**Reverse mortgage standby (REQ-MCP-86).** The profile's `reverseMortgage`
{openAge} opens an FHA HECM line once both borrowers are 62: the principal
limit is the HUD factor at a 6% expected rate (62: 35.7%, 72: 41.6%, 90:
61.8%, straight line between) times the home value capped at the 2026 FHA
limit ($1,249,125); it pays off the mortgage (whose payment then stops) and
3% upfront costs, and the rest is a line growing at the Treasury yield plus
2%, drawn only to cover a shortfall, adding no income or tax, and repaid
from the home on a sale (never more than the proceeds). When the home is
kept and the profile has none, `review_plan.reverseMortgageTest` compares a
line at the earliest age with none, and a gain of 2 points or more is an
action with a HUD counselor check.

**TIPS gap years (REQ-MCP-87).** No TIPS mature 2037-2039 until the
January 10-year auctions create them (Jan 2027 for 2037, Jan 2028 for 2038,
Jan 2029 for 2039). `tipsGapYears(asOfDate)` lists the years still missing;
`propose_plan_rules` adds a dated task per TIPS ladder rung in a gap year
(`tips-gap-<year>`, due 15 January of its auction year) and a note naming the
bracket alternative (extra July 2036 and February 2040 TIPS), and
`plan_check` labels such a rung "hold it in short Treasuries and buy at the
January auction" instead of naming a TIPS that does not exist.

The ranked list of what is covered and what is not is `docs/GAP-REVIEW.md`.

`spending_guardrails` answers "how much can I spend" in dollars with
risk-based guardrails on the same model and seed: `canSpend` is the first
retirement year's spending without the mortgage payment (all spending phases
scaled together, the payment kept as it is) that gives `targetSuccess`
(default 0.85), as a monthly figure; the lower guardrail is the total
portfolio value at which the chance of success falls to `lowerSuccess`
(default 0.70), where spending is cut by `adjustment` (default 10%); the
upper guardrail is the value at which it reaches `upperSuccess` (default
0.99), where spending is raised by `adjustment`. Each guardrail reports the
chance of success before and after acting. Searches are bisections on a
spending scale and a portfolio scale (every balance and its cost basis), so
the output is deterministic (REQ-MCP-45).

`project_retirement` accepts a Roth conversion strategy (engine option; the
tool itself converts nothing): each retired year up to `conversionEndAge`
(default 74) it converts pre-tax money (IRA first, then the employer plan)
up to a ceiling, solved in the same passes as withdrawals and tax: the top
of a federal bracket for taxable ordinary income (`fillBracket`), an IRMAA
tier's ceiling for AGI (`irmaaTier`), or the ACA 400% line for MAGI while
anyone is under 65 with `acaPremiumTaxCredit`, then IRMAA tier 0
(`acaThenIrmaa`); conversions stop $100 below a cliff. Conversion tax is
paid from the portfolio and raises AGI for IRMAA two years later.
`explore_roth_conversions` runs up to six strategies (default: none, 12%,
22%, the first IRMAA threshold, the ACA line then IRMAA) on the same
portfolio, profile and seed, and returns each one's success rate, median
balance at the planning age, end balances by tax treatment, lifetime tax,
IRMAA, ACA credit and amount converted, each year's conversion and IRMAA
tier, the best strategy (highest success, then median balance, then lowest
tax plus IRMAA) and three charts (REQ-MCP-46).

The repo root is the RetireRunway Claude plugin, which the private
marketplace `buildproven/claude-plugins` lists by its GitHub source:
`.claude-plugin/plugin.json` names it `retire-runway`, and
`claude plugin validate .` passes at the repo root and runs in `npm test`
(the test is skipped with a visible reason where the `claude` CLI is absent)
(REQ-PLUGIN-1). `.mcp.json` declares one server `retire-runway` of type
`http` at the production endpoint `https://retire-runway.vercel.app/api/mcp`;
chat ignores a local command server, so none is declared (REQ-PLUGIN-2). The
skill (`skills/retire-runway/SKILL.md`) names the hosted tools, says the data
comes from the owner's saved profile and snapshots, and has no local path or
install step (REQ-PLUGIN-3); it calls `get_profile` and `list_snapshots`
first and requires every number in a reply to name the tool result it came
from (REQ-AGENT-1). The README starts with the one-time install (through the
plugin marketplace for the owner's copy; a local server or your own hosted
copy, added under Connectors, in the open-source copy) and keeps the stdio
entry (`npm run mcp`);
the `.mcpb` desktop-extension build is removed (REQ-PLUGIN-4, which replaces
REQ-AGENT-2, REQ-AGENT-3 and REQ-MCP-16). The web UI is frozen. Card
requirements REQ-MCP-1..4 (BUI-1778), REQ-MCP-5..8 (BUI-1782),
REQ-MCP-10..15 (BUI-1803), REQ-AGENT-1 (BUI-1786), REQ-MCP-17..21
(BUI-1858), REQ-PLUGIN-1..4 (BUI-1859).

## 3. Non-functional requirements

### NFR-01 Determinism

No `Math.random()` or wall-clock read on a reproducibility-critical path; seeded
LCG (default seed 42); same inputs and seed give byte-identical output; recursive
canonicalisation before hashing; ≥128-bit content IDs.

### NFR-02 Privacy (local-first)

In the web app, planning arithmetic runs in the browser; only optional LLM
calls, sync and Plaid leave it, and each is disclosed. The MCP server computes
where it runs (the owner's own machine or the owner's own deployment) and
stores user data only in the user's own data directory, outside the package
and repo, or in the owner's own private GitHub repo (FR-23). The open-source
copy carries none of the owner's data (NFR-07).

### NFR-03 API security

Routes compose rate limiting, validation, and auth. Stripe webhooks verify the
signature before parsing and enforce a 5-minute timestamp tolerance. No secret is
committed or logged.

### NFR-04 Regulatory posture

Output is framed as educational and hypothetical, not advice; disclosure,
privacy, and terms pages exist; no fiduciary claim is made.

### NFR-05 Billing off by default

Paid checkout and tier gating stay disabled until subscription persistence and
release flags are deliberately enabled; readiness checks prove the flags.

### NFR-06 Accessibility

The customer-facing workflow passes axe checks at component level.

### NFR-07 Supply chain and delivery gates

Type-check, lint, format, tests, dependency audit (production strict), secret
scan, SAST, and license audit pass in CI on a pinned Node version. The required
`summary` check fails when any job it depends on failed or was cancelled.

`scripts/export-public.js <empty folder>` builds the open-source copy: every
tracked file except the private-only paths (owner notes, agent state, the
owner's deploy job, archived plans), with the owner's sections of CLAUDE.md
dropped, the public README in place and the plugin links pointed at the
public repo. It exits 1, listing each hit, when any copied text file matches
the private denylist (`.public-export/denylist.txt`, never exported). Each
release is one commit in the public repo made from a fresh export, so its
history holds only exported copies, never the private history. The release is automatic: when a merge to main changes the version, the
`Publish public copy` workflow runs the export (which fails on any denylist
hit) and commits it with a deploy key held as the `PUBLIC_REPO_DEPLOY_KEY`
secret; without the key it warns and skips.

### NFR-08 Deployment readiness

`readiness:check` and `launch:smoke` prove deploy structure and the public and
protected route boundaries without printing secrets.

### NFR-09 Traceability

Every requirement maps to design, code, and tests; no source or test file in the
governed directories is orphaned. CI enforces both.

## 4. Out of scope for v1 (closed)

These are not planned work. Each issue is closed or canceled; a future version
would reopen it as a new issue.

| ID     | Item                                                   | Reason                                                                            | Issue            |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------- |
| DEF-01 | Multi-currency with dated FX                           | The plan engine is USD-only; v1 is US-only                                        | BUI-503 canceled |
| DEF-02 | International packs (Australia, Europe, Age Pension)   | Needs per-country rule sources and review                                         | BUI-504 canceled |
| DEF-03 | Divorce scenario; penalised early-withdrawal modelling | Engine never spends inaccessible money (FR-03); divorce needs legal-reviewed copy | BUI-496 closed   |
| DEF-04 | Paid tier, checkout, feature gating                    | Regulatory exposure; see §1 distribution decision                                 | BUI-526 canceled |
| DEF-05 | Live brokerage execution, advisor tier, native mobile  | Not part of the product                                                           | n/a              |
| DEF-06 | Headless application contract and plan CLI             | The Claude Code skill covers agent use; branch kept on origin                     | BUI-823 canceled |

## 5. External launch gates (not provable from the repository)

Production Supabase project and keys, Vercel production environment, and, if
billing is ever enabled, licensed-counsel review and Stripe go-live. `npm run
readiness:check` reports these as BLOCK until configured.
