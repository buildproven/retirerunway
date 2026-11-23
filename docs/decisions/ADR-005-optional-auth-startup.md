# ADR-005: Keep local analysis available when optional auth is unavailable

## Status

Accepted and implemented on the launch-readiness branch.

## Context

RetireRunway's portfolio analysis and retirement-plan calculations are designed
to run locally. Account sync and subscription hydration are optional services.
The root layout currently mounts `AuthListener` on every route. That listener
constructs a Supabase browser client unconditionally, so a build without
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` crashes during
client startup before a visitor can use the local product or read the marketing
pages.

This is a startup-boundary failure, not an authentication failure. A visitor
who has no account must still be able to use local analysis. A visitor who has
an account must still receive normal Supabase auth behavior when the two public
Supabase settings are present.

## Decision

1. Add one shared configuration predicate for the browser auth client.
2. Make `AuthListener` return a no-op when the public Supabase configuration is
   absent. It must reset local auth and subscription state so stale in-memory
   state cannot survive a configuration change.
3. Hide or disable every interactive browser-auth surface when the public
   configuration is absent, including the sign-in card and sync indicator. The
   local-only message must not invite a user to start an auth flow that cannot
   work.
4. Keep server-authenticated routes fail-closed. This decision does not make
   `/api/*` routes public and does not weaken subscription authorization.
5. Keep the configuration state visible through the existing local-only sync
   state (`offline`) rather than throwing from the root layout.
6. Cover both states through behavioral tests: missing configuration renders the
   app without a startup exception or interactive auth controls; configured auth
   still calls the Supabase client and responds to auth state changes.

## Alternatives rejected

- Removing `AuthListener` from the root layout: this would hide auth state from
  the existing account and sync flows and move initialization into multiple
  callers.
- Supplying fake Supabase values in production: this creates misleading network
  traffic and obscures a deployment configuration error.
- Making all local analysis require an account: this contradicts the local-first
  product contract and current free MVP behavior.

## Invariants

- No Supabase client is constructed when either public setting is missing.
- Missing public auth configuration never causes a client-rendered startup
  exception.
- Missing public auth configuration never exposes a sign-in or sign-out action
  that would construct an unavailable client.
- Authenticated server routes continue to require a real Supabase session.
- When configuration is present, sign-in, sign-out, and auth-state hydration
  retain their current behavior.

## Rollback

Revert the browser configuration predicate and the guarded `AuthListener` path.
No database migration or external state change is required.

## Verification

- Unit tests cover configured and unconfigured listener startup behavior.
- Production build succeeds without public Supabase values.
- Browser smoke test loads `/` without public Supabase values and completes the
  local portfolio-analysis flow.
