# ADR-004: Deterministic healthcare costs and durable subscription authority

## Status

Accepted for implementation on the RetireRunway PRD parallel-build path.

The transition-planner PRD (`docs/archive/PRD_V4_GAP_ANALYSIS-2026-07-26.md`) is the product
authority for this work. The execution-first `docs/archive/REQUIREMENTS-v1-execution-first-superseded.md` is already
marked superseded and remains historical context only. This ADR does not
replace the currently shipping portfolio flow; it adds the plan engine and
durable subscription boundary in parallel.

## Context

RetireRunway's new `src/engine/plan` projection kernel models immutable
accounts, income streams, and spending streams; committed life events are
available as source data but are not yet applied to projection rows. The next PRD P0
requires healthcare to be explicit rather than hidden in general spending:
employer coverage, COBRA, ACA, Medicare, healthcare-specific inflation, income-
sensitive ACA subsidy handling, and one-time shocks.

The existing Stripe webhook only logs subscription events. There is no durable
subscription table, webhook idempotency record, or server-side feature gate. The
client Zustand store is therefore useful for presentation state but cannot be
the authority for paid access.

Both changes cross an architectural boundary: healthcare adds a public domain
contract to the deterministic projection API, while subscriptions add durable
data, authentication/authorization, payment event processing, and RLS.

## Decisions

### Healthcare

1. Add an optional immutable `HealthcarePlan` to `Scenario`; scenarios without
   one remain behaviorally unchanged.
2. Represent coverage with explicit half-open calendar-month boundaries
   (`YYYY-MM`, `startMonth` inclusive and `endMonth` exclusive) and kinds
   `employer`, `cobra`, `aca`, and `medicare`. Age-only boundaries are rejected
   until a date-of-birth/month anchor is added to the scenario contract; this
   keeps a phase starting at age 55 deterministic rather than silently choosing
   an arbitrary month. Healthcare uses a half-open interval: projection row
   `year` starts at the calendar month of
   `dateForYear(asOfDate, year)` and ends immediately before the calendar month
   of `dateForYear(asOfDate, year + 1)`. There is no implicit row 0. Healthcare
   months are assigned by intersection with those stored row start/end months,
   so a mid-year `asOfDate` follows the existing projection horizon rather than
   silently restarting at January or dropping partial-year costs. Existing
   income and spending streams retain their current annual boundary semantics;
   only healthcare phase and row-month selection is half-open. Phase
   intervals may transition inside a projection year; the projector prorates
   each phase by covered calendar months and exposes the per-phase
   contributions. A phase must cover at least one month, and two phases may not
   cover the same month. Each phase carries monthly premium and expected
   out-of-pocket amounts in its currency.
3. Apply the plan's own annual inflation rate, independent from general
   spending inflation. For a Medicare component, an explicitly supplied
   component inflation rate replaces the plan rate for that component; when it
   is absent, the plan rate applies. Rates never compound with one another.
   Aggregate Medicare phase totals use the plan rate. Healthcare projection is
   deterministic and has no AI or wall-clock inputs.
4. Model ACA subsidy as an explicit, user-supplied contribution schedule:
   household size, annual FPL basis per person, annual MAGI cap, annual
   benchmark premium, and contribution rate, plus an optional deterministic
   `additionalMagiByYear` schedule for MAGI items not represented by the plan
   (for example tax-exempt interest or non-taxable Social Security). All ACA
   schedule monetary inputs and additional-MAGI amounts are in the scenario's
   base currency; phase amounts are converted at the effective FX rate before
   applying the formula. For each
   year, canonical household MAGI is included ordinary and capital-gains
   income streams, plus the ordinary portion of pretax withdrawals and the
   capital-gains portion of taxable-account withdrawals (using each account's
   `capitalGainsRatio`), plus `additionalMagiByYear`; Roth and tax-free basis
   withdrawals are excluded. The bounded formula is:
   `expectedContribution = max(0, MAGI * contributionRate)`;
   `monthlyBenchmark = benchmarkAnnualPremium / 12`;
   `monthlyContribution = max(0, MAGI * contributionRate / 12)`;
   `monthlySubsidy = MAGI > annualMagiCap ? 0 : max(0, monthlyBenchmark - monthlyContribution)`;
   `appliedSubsidy(month) = min(phaseMonthlyPremium, monthlySubsidy)` for every
   covered month; `netPremium = sum_over_covered_months(phaseMonthlyPremium -
appliedSubsidy(month))`. All operands in the latter expression are monthly;
   the result is the annual row's prorated amount.
   Summing this monthly formula over covered months automatically prorates both
   benchmark and contribution for partial-year ACA phases. The subsidy applies
   only to ACA premiums, never employer/COBRA/Medicare premiums or out-of-pocket
   costs. A Medicare phase uses either aggregate monthly premium/out-of-pocket
   values or component schedules, never both; when components are present,
   Part B, Part D, supplemental, dental, and vision are authoritative and the
   phase totals are derived from their sum. The calculation is deterministic and uses the same withdrawal
   fixed-point iteration as tax gross-up; if it does not converge, projection
   fails closed. The FPL basis and household size are
   retained for audit and validation but do not silently encode current law.
   Jurisdictional rules must be versioned separately with source and effective
   date before production use.
5. Model one-time shocks as dated ISO calendar-month amounts only, assigned to
   the annual projection bucket containing the shock month. Each shock carries
   a currency and must use the scenario base currency; FX conversion for
   shocks is deliberately unsupported until a dated monthly FX schedule is
   added. Age-only shocks are rejected until a calendar anchor exists. Shocks
   do not silently recur.
6. Expose an auditable per-year healthcare breakdown on projection rows and add
   the healthcare total to spending. Medicare is componentized as Part B, Part D,
   supplemental (Medigap/Advantage), dental, and vision schedules; each
   component can carry its own monthly amount and inflation. The module fails
   closed for invalid dates, overlapping monthly coverage, negative amounts, or
   an out-of-horizon shock.

### Subscriptions

1. Add `subscriptions` and `stripe_webhook_events` migrations. Store one
   snapshot row per Stripe subscription (`stripe_subscription_id` is the
   primary identity) with a nullable resolved `user_id`; the Stripe
   subscription ID is unique, the customer ID is indexed but not unique, and
   there is an index on `user_id`; access is derived as
   the OR of all current allowlisted rows for that user. Webhook event IDs are
   unique for idempotent replay handling. This prevents an old subscription's
   cancellation from overwriting a replacement subscription.
2. Browser clients may select/display a tier, but paid access is decided on the
   server from the authenticated user's subscription row. The client store is
   hydrated from a server response and is never trusted for authorization.
3. Stripe webhook verification remains signature-first and timestamp-bounded.
   The route writes through a service-role Supabase client only after signature
   verification. Event claiming is an atomic insert with a unique event ID, and
   the claim plus subscription mutation are one transaction (or an equivalent
   database function); a failed transaction leaves the event retryable. Checkout
   writes the authenticated user ID into both session metadata and
   `subscription_data[metadata]`, so lifecycle events carry their owner even if
   they arrive before `checkout.session.completed`. If Stripe omits that
   metadata, the event is retained as pending and reconciled by the later
   identifier link; it never grants access without a resolved user. Before
   mutating state, the handler retrieves the current Stripe subscription object
   by ID and persists that authoritative object, rather than treating webhook
   arrival time, event creation time, or event ID as a total order. The handler
   acquires a short-lived database lease keyed by resolved user/customer (and
   by Stripe subscription ID while ownership is pending) using an atomic
   compare-and-swap, then fetches the current Stripe object, updates the
   snapshot only while its lease token is valid, and releases the lease in a
   finally path. A second delivery waits or retries after the lease expires;
   the event claim and snapshot update remain transactional once the lease is
   held. This lease-and-refresh protocol is the implementable serialization
   contract, not a comparison of mutable status, cancellation, or period fields.
4. `checkout.session.completed` records Stripe identifiers only; it never
   grants Pro by itself. Subscription status is taken from the authoritative
   `customer.subscription.created|updated|deleted` object, with the configured
   price allowlist and user metadata checked before persistence. Pro access is
   `active` or `trialing` plus a non-null `current_period_end` later than the
   deterministic request-time clock; `past_due`, `unpaid`, `canceled`, unknown,
   and expired rows are Free. Missing persistence/configuration fails closed.
5. Gate the server feature boundaries for AI narration and What-If, plus any
   future server-generated export or user-owned API route, with one shared
   helper. The current browser-only Markdown/print export remains explicitly
   free MVP behavior because it has no server boundary; it is not represented
   as a paid capability until a server export endpoint exists. A server rollout flag defaults to off;
   while off, the current free behavior remains unchanged. When enabled, only
   a current `active`/`trialing` row is Pro. Checkout itself fails closed unless
   the migration-readiness flag and an allowlisted real Stripe price are
   configured, and it always binds metadata to the authenticated user. The
   existing static-key `/api/v1/*` endpoints remain a separately authenticated
   legacy surface until API keys have persisted `user_id` ownership; they are
   not treated as a paid-user gate in this rollout, so a static key cannot
   masquerade as a Supabase user or silently bypass a subscription check. The
   existing static-key `/api/v1/analyze` and `/api/v1/tax` routes are explicitly
   outside the paid feature set for this rollout; a future paid API must use a
   persisted API-key-to-user ownership record before it is gated.

## Alternatives rejected

- Adding healthcare fields to the legacy portfolio `UserProfile`: it would
  recreate the scalar-only model that BUI-490 replaced and would not support
  phase transitions or auditable rows.
- Hard-coding ACA/Medicare legal tables in the first module: rules change and
  would be silently stale without versioned source/effective-date data.
- Trusting the Zustand tier or a caller-supplied `userId`: either permits a
  client to self-upgrade or lets one user attribute events to another.
- Writing webhook state with the anonymous Supabase client: unauthenticated
  webhooks require a service-role boundary and RLS must remain user-readable,
  service-role-writable.
- Enabling checkout before persistence is deployed: a successful charge would
  still have no authoritative access record during migration rollout.

## Invariants

- Identical healthcare inputs and annual income produce byte-identical output.
- At most one healthcare phase contributes to each projection month; a row may
  contain multiple prorated phase contributions.
- A shock contributes exactly once and only inside the projection horizon.
- No paid feature is authorized without a current, unexpired `active`/`trialing`
  subscription row for the authenticated user.
- Duplicate Stripe event delivery cannot mutate subscription state twice.
- Existing scenarios without `healthcare` and existing Free users retain their
  current behavior while the subscription rollout flag is off.

## Rollback

Healthcare is optional on `Scenario`; removing the optional field and projector
restores prior projection behavior. Subscription rollout is additive: disable
the server gate flag and leave checkout disabled while retaining the migration
and event records for audit. No existing portfolio rows are rewritten.

## Verification

- Healthcare unit tests cover each phase, mid-year proration and monthly overlap,
  independent inflation, canonical MAGI and income-sensitive ACA subsidy,
  Medicare components, one-time shocks, invalid overlap/horizon, and projection
  integration.
- Subscription tests cover migration contract, event idempotency, status mapping,
  authenticated server gates, and fail-closed missing configuration.
- Full local lint, type, build, security, mutation, and behavioral test gates;
  then exact-head independent review and protected merge.
