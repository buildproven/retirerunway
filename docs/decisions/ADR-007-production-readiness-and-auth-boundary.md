# ADR-007: Make production readiness and optional-auth boundaries explicit

## Status

Accepted and implemented.

## Context

RetireRunway supports local-only analysis, but authenticated API routes still
need a real Supabase configuration. Before this change, a missing server
Supabase URL or anonymous key reached the third-party client constructor and
returned an opaque 500 response. The launch process also had no deterministic
command to distinguish a structurally ready deployment from one that still
needed credentials, migrations, or paid-rollout approval.

## Decision

1. Validate the two public Supabase server settings before constructing the
   server client. Throw a typed internal configuration error when either is
   missing.
2. Make `withAuth` translate that error to a generic 503 response. Keep 401
   for an absent or invalid user when the auth service is configured, and let
   unexpected errors propagate for normal error handling and observability.
3. Add `readiness:check` as a read-only deployment contract. It checks required
   repository files and Supabase settings without printing secret values. Paid
   subscriptions may remain disabled for deployment, staged rollout, or
   rollback. `--require-subscriptions` is the explicit paid go-live mode; it
   checks Stripe key shape, subscription flags, and the configured price
   allowlist. The evaluator uses Next's `.env*` precedence. Local, preview, and
   production modes have different key requirements; preview accepts test
   Stripe keys only, while production accepts live keys only.
4. Add `launch:smoke` as a read-only HTTP acceptance check for public marketing
   routes and the protected subscription boundary. It accepts 401 for a
   configured unauthenticated request and, in its default local mode, 503 for
   an intentionally unconfigured local-only deployment. Preview and production
   modes require 401 and reject 503 and 500.
5. Use `npm ci` for Vercel installs so hosted builds use the committed lockfile.

## Alternatives rejected

- Supplying fake Supabase values: this would create misleading network traffic
  and hide a deployment configuration error.
- Returning 401 for missing configuration: the request is not unauthenticated;
  the service is unavailable, so 503 is the truthful boundary.
- Enabling Stripe during this change: live credentials, price lifecycle,
  webhook delivery, legal approval, and customer acceptance remain external
  launch gates.
- Treating a passing local smoke as production acceptance: the smoke does not
  prove live Supabase, Stripe, Vercel, legal, or customer state.

## Invariants

- No Supabase client is constructed with missing public settings.
- Missing optional auth configuration never produces an opaque 500 at an auth
  boundary.
- Authenticated routes remain protected; no route becomes public.
- Readiness output contains statuses and remediation text, never secret values.
- Paid rollout remains disabled until the existing explicit flags are enabled.

## Rollback

Revert this ADR's implementation commit. No database migration, hosted
configuration, billing mutation, or deployment is required for rollback.

## Verification

- Unit tests cover configured authentication, invalid authentication, missing
  configuration, readiness modes, and smoke failures.
- `npm run quality:check`, coverage, formatting, security audit, and build pass.
- A built local server passes `npm run launch:smoke` for all public routes and
  the protected subscription boundary.
