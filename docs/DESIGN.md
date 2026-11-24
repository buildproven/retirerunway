# RetireRunway — Design

Requirement IDs (`FR-xx`, `NFR-xx`) are defined in [REQUIREMENTS.md](REQUIREMENTS.md).
The code and test for each is in [TRACEABILITY.md](TRACEABILITY.md). Decisions
are recorded as ADRs in [decisions/](decisions/).

## 1. Shape

A Next.js 16 App Router app around one pure TypeScript engine. The main
surface is the MCP server (`src/mcp`, FR-23): Claude calls its tools over
stdio (Claude Code) or HTTP (`/api/mcp`, signed in through the owner-only
OAuth server), the tools run the engine and stamp every result, and the
owner's data lives in a private GitHub repo or a local folder. The original
browser app is frozen; it runs the same engine in the browser. Other server
routes are optional: AI narration, auth and sync, Plaid, the public API and
(disabled) billing. The landing page (`site/`) is static and ships with the
open-source copy.

```
UI (src/app, src/components)  ──►  stores (src/store, Zustand)
        │                                   │
        ▼                                   ▼
services (src/services)  ──►  engine (src/engine)   ◄── skill CLIs (skills/retire-runway)
        │                       ├─ plan/   transition planner   (FR-01..FR-12)
        │                       └─ *.ts    portfolio tools      (FR-13, FR-14)
        ▼
API routes (src/app/api) ─► lib (rate limit, validation, auth) ─► Supabase / Stripe / Plaid
        │
        ▼
src/ai  narration (BYOK adapter, prompts) — consumes engine output only
```

## 2. Layers and rules

| Layer             | Rule                                                                                           | Req           |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------- |
| `src/engine`      | Pure, no I/O, no AI, no wall clock or `Math.random` on repeatable paths. Inputs are immutable. | NFR-01        |
| `src/engine/plan` | The transition planner. Intake → `Scenario` → projection → stress suite → verdict.             | FR-01..FR-12  |
| `src/ai`          | Receives engine results; produces prose only. Validation of any numbers stays in the engine.   | FR-15         |
| `src/lib`         | `withRateLimit → withValidation → handler`; `withAuth` for user routes.                        | NFR-03        |
| `src/app/api`     | Thin handlers. Stripe: verify signature, then parse. `/api/v1`: bearer keys, fail closed.      | NFR-03, FR-18 |
| `skills/…`        | Same determinism contract plus a `provenance` block with canonical input hash and seed.        | FR-19, NFR-01 |
| `src/mcp`         | MCP server, stdio and HTTP. Zod input schemas, engine calls, `provenance` stamp. No math.      | FR-23, NFR-01 |

The MCP server (`src/mcp/server.ts`, FR-23) is the agent-first entry point.
Its schemas (`src/mcp/schemas.ts`) check shape and types only; value rules stay
in `validatePlanIntake` and the engine, so there is one source of truth. An
intake the engine rejects returns `{ ok: false, errors: [{ field, message }] }`
and no scenario. Other engine errors return as MCP tool errors. Results reuse
`stamp()` from the skill, so hashes match the skill CLIs. The portfolio tools
(`src/mcp/portfolio-tools.ts`, REQ-MCP-5..8) wrap the skill-script engine
calls: `import_positions` (`parsePortfolioCSV`), `portfolio_analysis` (risk
score, scenarios, ladder, alerts, CD analysis and, unless `includeMonteCarlo`
is false, the seeded Monte Carlo result, as `/api/v1/analyze`),
`tax_strategy` (Roth schedule, Rule of 55 and tax breakdown, with the
`/api/v1/tax` defaults) and `trade_plan` (`generateTradePlan`). After the
strict shape check they apply the `/api/v1` value rules from
`src/lib/validation-schemas.ts` and require a real calendar as-of date, and
return `{ ok: false, errors: [{ field, message }] }` on a violation. The
import as-of date comes from the `asOfDate` argument, else from the first CSV
line with `Date downloaded` or `as of` and a real date (`MM/DD/YYYY` or
`YYYY-MM-DD`), else it is absent with a warning; the stamp records the source
as `input`, `csv` or `none`. No portfolio tool reads the clock for a value.
Only `portfolio_analysis` draws random numbers (its Monte Carlo, seeded LCG,
`seed` argument, default 42), and only its stamp carries a seed.

User data (REQ-MCP-10..15) lives in `src/mcp/user-store.ts`, with its tools
in `src/mcp/user-data-tools.ts`. The data directory is
`$RETIRE_RUNWAY_DATA_DIR` (default `~/.retire-runway`); it is resolved on each
call, so listing tools touches no disk. A relative path, or one whose real
path (symlinks resolved) is inside the package root (the nearest
`package.json` named `retire-runway` above the module), is refused. Files are
`profile.json` (`{ version: 1, updatedAt, profile }`) and
`snapshots/<asOf>.json` (`{ version: 1, portfolio }`). Each write goes to a
unique mode-600 temporary file that is renamed into place; directories the
store creates get mode 700, and an existing directory keeps its mode, so a
data directory set to a shared folder such as `~` is never re-permissioned. Reads never create anything, and a file
that fails the strict schema returns a field-level error naming it. A
snapshot removes every account-number token (four or more digits, with an
optional mask or two-letter prefix) from account names, numbers duplicate
names, and replaces the content-hash IDs, which hash the account name, with
positional ones. A portfolio tool fills a missing `profile` or `portfolio`
from the saved profile or the newest snapshot, then applies the same value
rules; it hashes the resolved input, so the input hash equals a call that
passes the values, and the stamp adds `assumptions.savedData`.
`updatedAt` is the one wall-clock read: it is metadata, never hashed.
`delete_user_data` removes only the files the store owns, so a data directory
set to a shared folder by mistake loses nothing else.

The tools reach saved data only through the `DataStore` contract in
`src/mcp/user-store.ts` (REQ-MCP-21); `openDataStore(tool)` in
`src/mcp/git-store.ts` picks the adapter on each call. With
`RETIRE_RUNWAY_DATA_REPO`, `RETIRE_RUNWAY_DATA_PATH`,
`RETIRE_RUNWAY_GITHUB_APP_ID` and `RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY` all
set it returns a `GitStore` over that repo
folder (REQ-MCP-17); with none set, the folder `UserStore` (REQ-MCP-18); with
some set, a field-level error naming the missing ones. Both share the file
formats, schemas and parse errors. `GitStore` calls only the contents API
(`/repos/{owner}/{repo}/contents/<path>/...`) and reads only `status` and the
JSON body of a reply, any 2xx being success: a read decodes the base64 file
(a file over 1 MB, returned with encoding `none`, is an error rather than
empty), a listing entry needs only its `name` (a delete reads the sha when the
listing has none), a listing at
the API's 1,000-entry limit is an error rather than a silent truncation, and
each write or delete is one commit named `data: <tool> <file>` that sends the
sha it read (REQ-MCP-19). On a `409`, or a `422` about the sha, it retries
once with the same sha, which succeeds only when the branch moved and the
file did not; a second conflict is a field-level error, so the newer file is
never overwritten. Every GitHub failure, network errors included, becomes a
`UserStoreError` naming `owner/repo/<path>` and the status; the token is
replaced in any text GitHub or `fetch` returns, so no error carries it
(REQ-MCP-20). `delete_user_data` reports `dataRepo` and `dataPath` for the
git store and `dataDir` for the folder store.

`GitStore` authenticates as a GitHub App (`src/mcp/github-app-token.ts`,
REQ-STORE-APP-1..5, BUI-1917), following GitHub's "Generating an
installation access token for a GitHub App": it signs an RS256 JWT with
`RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY` (PKCS#1 or PKCS#8 PEM, `\n` escapes
allowed; `iss` the app ID, `iat` 60 s back, `exp` 9 minutes ahead, under
GitHub's 10-minute limit), calls `GET /repos/{owner}/{repo}/installation`,
then `POST /app/installations/{id}/access_tokens` with `repositories` set to
the data repo alone. A `404` from either is the not-installed error, which
names the repo and the install step; `openDataStore` has already chosen the
repo store, so it never falls back to the folder. Tokens are cached per
process, keyed by app, repo and key, and shared by the git store and the
spent-grant record; a token is reused while more than 5 minutes of its
`expires_at` are left, concurrent calls share one mint, a failed mint is not
cached, and a token the contents API refuses with `401` is dropped so the
next call mints a new one. The token is sent as GitHub returns it, with no
length or format check, and is redacted from error text like a fixed token.
No personal access token is read.

The hosted entry (`src/app/api/mcp/route.ts`, REQ-MCP-22..26) serves the
same `createPlanServer` factory through the SDK's `createMcpHandler`:
stateless, one server instance per request, both protocol eras. It is an
OAuth resource server only; sign-in belongs to the authorization server.
`authorizeMcpRequest` in `src/mcp/http-auth.ts` runs before the handler on
every method. It first reads `RETIRE_RUNWAY_OAUTH_ISSUER`,
`RETIRE_RUNWAY_OAUTH_JWKS_URL` and `RETIRE_RUNWAY_OWNER_SUBJECT` and answers
`500` naming each unset one and each URL that is not https (http only on a
loopback host), so a half-configured deployment never serves tools. It then
takes the bearer token and verifies it with `jose` against the issuer's
remote key set (cached per URL, refetched on an unknown key ID): the `iss`
must equal the issuer exactly, the `aud` must be this deployment's
`<origin>/api/mcp` (RFC 8707, so a token for another resource is refused),
`sub` and `exp` must be present and the token unexpired, and only asymmetric
algorithms are accepted. Any token failure answers `401` with exactly
`WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`,
the challenge Claude needs to start sign-in. A key set that cannot be fetched
answers `502` naming the key URL, since the caller cannot fix it. A valid token
whose `sub` is not the owner answers `403`. The origin comes from the request
URL, so each Vercel deployment (production or preview) advertises its own
MCP URL. `src/app/.well-known/oauth-protected-resource/route.ts` serves the
RFC 9728 document: `resource` is the MCP URL and `authorization_servers` is
the configured issuer.

The authorization server (`src/mcp/oauth-server.ts`, REQ-MCP-27..32) is
`createOAuthServer`, which the routes under `src/app/oauth/` and
`src/app/.well-known/oauth-authorization-server/route.ts` call; its settings,
fetch, clock and grant store are injected so the tests fake GitHub. It keeps no
database. The DCR client ID, the sign-in state, the authorization code and the
refresh token are JWTs signed with `RETIRE_RUNWAY_OAUTH_SIGNING_KEY` (ES256),
each with its own `typ` and `aud`, so one kind never verifies as another and
none verifies as an access token (whose `aud` is the MCP URL). `/oauth/jwks`
publishes the public key for the resource server. `/oauth/authorize` resolves
the client, either a DCR client ID (signed, carrying its redirects) or a CIMD
`https://` URL fetched with a 4 s timeout, no redirects and a 16 KB cap (an IP
literal, a single-label or `localhost`/`.local`/`.internal` host is never
fetched), and requires every redirect to pass `isAllowedRedirect` (the Claude
callback, or `http://localhost|127.0.0.1[:port]/callback` with no query or
fragment). A bad client or redirect gets an error page, never a redirect;
after that, errors go back to the client. It requires `S256`, then seals the
request into a 10-minute `state` and sends the browser to GitHub with a nonce
cookie (HttpOnly, Lax, scoped to the callback); the callback refuses a state
whose nonce is not in the browser's cookie, so a sign-in link started in
another browser cannot deliver the owner's code to an attacker's client. The
callback exchanges the GitHub code, reads `GET /user`, and issues a 60-second
code only when `login` equals `OWNER_GITHUB_LOGIN` without regard to case (the
subject is the configured spelling); a GitHub failure is `502`, another login
`403`, neither with a code. The token endpoint accepts only
`application/x-www-form-urlencoded` and no repeated parameter. A code is spent
before its PKCE verifier is checked, so a stolen code allows one guess. A
refresh token carries a family ID; presenting a spent one answers
`invalid_grant` and revokes the family for one full refresh lifetime (30
days) from the revocation, so the revocation outlasts the newest token in the
family; the owner setting is checked again at every refresh. The one state is
the `GrantStore` of spent codes, spent refresh tokens and revoked families.
Vercel runs instances in parallel and recycles them, so the store is not in
memory: `createGitHubGrantStore` keeps it as `oauth-grants.json` in the
owner's data folder (`RETIRE_RUNWAY_DATA_REPO`, `RETIRE_RUNWAY_DATA_PATH`,
the git store's repo) through the GitHub contents API, with the git store's
GitHub App installation token. A claim reads the file, refuses an ID already there, and writes
it back with the sha it read; GitHub requires that sha ("the blob SHA of the
file being replaced") and answers `409 Conflict` when the file moved, so the
claim reads again (up to four times) and two instances never both claim one
ID. Each write drops expired entries, so the file holds about one entry per
refresh in the last 30 days. When the file cannot be read, parsed or written,
the token endpoint answers `503 temporarily_unavailable` naming the file and
issues no token; an unset or invalid data repo setting answers `500`. The
user data store's `delete_user_data` keeps this file, since it is not a
profile or snapshot. A GitHub
login is a name that can change hands, and the owner setting compares the
name, not the numeric GitHub ID.

The production route singleton is built by `createHostedOAuthServer`, which
requires the shared GitHub store and fails closed when it is unavailable.
Local development and route tests use `createOAuthServer`, which creates a
process-local grant store when no store is supplied. This keeps explicit test
and non-hosted instances self-contained without weakening the deployed route.

`npm run mcp` runs
`src/mcp/run.mjs`, which bundles the server with esbuild into
`node_modules/.cache/retire-runway-mcp/` (the engine uses extensionless
imports that Node cannot load directly) and then starts it.
`src/mcp/bundle.mjs` writes the bundle to a temporary file unique to each
start and renames it into place, so overlapping starts never import a
half-written bundle. Use
`npm run --silent mcp` from an MCP client, because npm writes its script banner
to stdout.

`npm run mcpb` runs `src/mcp/pack.mjs` (REQ-AGENT-2). It checks that
`manifest.json` has the `package.json` version and passes `mcpb validate`,
bundles `src/mcp/main.ts` with every dependency inlined (esbuild, target
node22, a `createRequire` banner for inlined CommonJS) into a temporary
staging directory as `server/index.mjs`, adds the manifest and a minimal
`package.json` named `retire-runway`, and runs `mcpb pack`. That
`package.json` makes the user store treat the installed extension as the
package root, so a data directory inside it is refused. It also writes the
skill ZIP (`retire-runway/SKILL.md`, fixed timestamp). `@anthropic-ai/mcpb`
pins zod 3, which has a high advisory below 4.6.6; an npm override gives it
the project's zod 4, and `mcpb validate` and `mcpb pack` pass with it.

### 2.x Plan rules: proposed by the engine, approved by the owner (REQ-MCP-64)

`src/engine/plan-policy.ts` turns the profile and snapshot into proposed
`planRules`. It is a pure function over the engine: the stock-share test calls
`projectRetirement` once per candidate and assumption set on a rebalanced copy
of the portfolio; the ladder reads the expected path's yearly withdrawals; the
sell schedule comes from `checkPlan` run with the proposed rules. The MCP tool
`propose_plan_rules` stamps the result. The flow is propose, present, approve,
save: the tool never writes, the skill walks the owner through each finding,
and only save_profile persists a rule. See ADR-009.

### 2.y Retire as early as is safe: timing, levers and the review loop (REQ-MCP-66..69)

`src/engine/retirement-timing.ts` holds `retireAt` (the profile retiring at
another age), `earliestRetirement` (a full scan of ages), `earliestBySearch`
(bisection) and `rankLevers`. `src/engine/plan-review.ts` composes
`planVerdict`, `rankLevers` and `proposePlanPolicy` into `reviewPlan`, adds
the data-freshness checks, the owner's decisions, the human checks and the
next review date. All are pure functions on one seed; the MCP tools
`earliest_retirement`, `rank_levers` and `review_plan` stamp them. One review
runs about 100 projections (about 15 seconds at 0.15 s each), so the hosted
route allows 60 seconds. The loop: the monthly runway check calls
`review_plan` and reports; in a chat the owner decides; the skill saves the
decisions to the notes and the approved changes to the profile; the next
review starts from them. See ADR-010.

### 2.w Stable tool surface (REQ-MCP-73, REQ-MCP-74)

`createPlanServer` calls `recordTools(server)` before any tool is
registered: it wraps `registerTool` so each tool's name, description, zod
schema and handler go into a registry. `registerToolDoor` adds `run_tool`,
which validates `arguments` against the registered schema and calls the
registered handler, so the call path, provenance and errors are the tool's
own. `toolCatalog` turns the registry into the `tools` list in
`get_briefing`. `update_profile` applies `patchProfile`
(`src/mcp/profile-patch.ts`) to the saved profile and validates the result
with `userProfileSchema` and `UserProfileSchema` before saving. Rule for
releases: new features are added as tools as before; old chats reach them
through `run_tool`, new chats see them directly. Tool names and argument
meanings are never removed or changed within a major version. See ADR-012.

### 2.z Withdrawal order, glide path and balances (REQ-MCP-70..72)

`drawDown` in `src/engine/retirement-projection.ts` takes the order from the
context (options, then profile, then `taxableFirst`); `glideShareAt` sets
each year's blended return from the profile's `glidePath` in the expected
path, the Monte Carlo and `projectSequence`, so every tool that projects
follows the owner's saved path and order. Both default to the old behaviour,
so results without them are unchanged (model 2.9.0).
`src/engine/withdrawal-order.ts` runs the orders on one seed;
`proposePlanPolicy` scores the glide candidates beside the share test; and
`src/engine/balance-sheet.ts` parses the pasted list without network or
storage, with `compareWithPlan` adding the checks against the saved profile
and snapshot. review_plan calls the order explorer too, about 5 more
projections. See ADR-011.

## 3. The planner pipeline (FR-01..FR-12)

1. **Intake** (`intake.ts`) validates form values and builds an immutable
   `Scenario`. Nothing is prefilled; the sample is an explicit action (FR-01).
   `withSnapshotBalances` replaces the four account balances with
   `planBalancesFromPortfolio(snapshot)`, a pure tax-treatment mapping of a
   saved `Portfolio`, so plan balances follow the newest snapshot (FR-01).
2. **Projection** (`projection.ts`) loops year by year. Each year it computes
   income (Social Security from `social-security.ts`), spending, healthcare
   (`healthcare.ts`), taxes (`tax-brackets.ts`), then draws from accessible
   accounts in a fixed order. Access is gated by age 59½, Rule of 55, 457(b),
   and NQDC schedules. Inaccessible money is never spent, so a shortfall shows
   as `fundingGap` rather than a hidden penalty (FR-02, FR-03, FR-04).
3. **Stress suite** (`stress-scenarios.ts`) derives ten deterministic variants
   from the baseline and projects each (FR-07). Downsize runs committed and
   not-used (FR-10).
4. **Verdict** (`verdict.ts`) scores observed outcomes: solvency, bridge
   liquidity, post-Social-Security coverage, healthcare and tax funding. Every
   metric carries weight and evidence. Uncommitted levers cannot make a plan GO
   (FR-08).
5. **Solver** (`income-solver.ts`) bisects on outside income against the same
   projection (FR-09).
6. **Compare** (`analysis-delta.ts`) diffs two analyses (FR-11).
7. **Plan Monte Carlo** (`monte-carlo.ts`) replays the same projection over
   seeded return paths via per-account `returnSchedule`; it never computes
   money itself (FR-22).
8. **Fixtures** (`regression-fixtures.ts`) pin twelve cases as engine acceptance
   tests (FR-12).

9. **Summary and export** (`summary.ts`) derives the bridge summary,
   milestones, lifetime series, and the Markdown/JSON export from a
   `PlanAnalysis`. Pure functions; `plan-results-step.tsx` and
   `plan-lifetime-chart.tsx` only render them (FR-21).

`analyze.ts` composes steps 2–5 into one `PlanAnalysis` consumed by
`plan-results-step.tsx`.

## 4. Versioned rules

Social Security factors, ACA subsidy tables, and tax brackets are constants with
an as-of date and source URL (`SOCIAL_SECURITY_RULES_*`, `ACA_*_SOURCE_*`).
Changing a rule means a new dated constant and a regression-fixture update, not
an in-place edit (ADR-006).

## 5. Determinism (NFR-01)

Monte Carlo uses a seeded LCG (seed 42). The web worker imports the same
modules as the main-thread path, and a parity test pins byte equality. Provenance
hashing canonicalises recursively and throws on non-plain objects. Imported
portfolio IDs and report identity use 128-bit content hashes.

## 6. Failure and degradation

- Missing Supabase config: routes return a generic 503; local analysis keeps
  working (ADR-005, ADR-007).
- Unsupported ACA region or unconfirmed divorced-spouse eligibility: validation
  rejects; no silent default.
- CSV parsing never throws to the UI; it returns warnings (FR-13).
- AI failure leaves all numbers intact; only the prose is missing (FR-15).

## 7. Regulatory and distribution posture (NFR-04, NFR-05)

Free and MIT-licensed. Output is labelled educational. Billing code exists but
is off by default and gated by `SUBSCRIPTIONS_READY` / `SUBSCRIPTIONS_ENABLED`
(ADR-004). Enabling it needs licensed-counsel review first.

## 8. SDLC

| Stage            | Mechanism                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Requirements     | `REQUIREMENTS.md`, IDs                                                                              |
| Design           | this file + `decisions/ADR-*`                                                                       |
| Trace            | `traceability.json` → `TRACEABILITY.md`; `npm run traceability:check` (CI, NFR-09)                  |
| Build gates      | `type-check`, `lint`, `format:check`, `test`, `security:audit`, `license:check`, Semgrep, gitleaks  |
| Deploy readiness | `readiness:check`, `launch:smoke` (NFR-08)                                                          |
| Change process   | Linear issue → branch + worktree → PR (`Closes BUI-xxx`) → CI → merge; `keel gate` where applicable |
