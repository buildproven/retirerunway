# ADR-010: Retire as early as is safe, through a monthly review loop

Status: accepted, 2026-11-24

## Context

The owner's question is not "is my plan OK?" but "how soon can I stop
working, and what do I pull to make it sooner?". The tools answered the first
(plan_verdict) and tested one retirement age at a time. Paid tools lead with
the earliest retirement age, and a planner's value is in recommending changes
and keeping the plan current, not in a one-off projection.

## Decision

- Add `goals` to the profile, so "safe enough" is the owner's own threshold
  (default: the GO thresholds of plan_verdict).
- Add `earliest_retirement` (full scan of ages) and `rank_levers` (each
  standard or custom lever's effect on the earliest age and on success, then
  the best of each group together).
- Add `review_plan`, the one result the monthly check and the owner read:
  standing, timing, levers, rule changes, actions, stale data, decisions,
  human checks and the next review date.
- Keep the owner in charge: tools never save; the skill records decisions in
  the notes and approved changes in the profile.
- Name the human checks explicitly. The engine covers the analysis; a fee-only
  planner, a CPA, an estate attorney and the agencies cover judgement, tax
  filings, legal documents and official records.

## Consequences

- Levers are fixed sizes (5% and 10% spending, $10,000 savings, $2,000 a
  month for 5 years, half-price home). They show direction and size; custom
  levers cover the owner's real options.
- The lever search uses bisection on the assumption that a later retirement
  never lowers success. Fixed-age events can break it slightly;
  earliest_retirement scans every age and is the reference.
- A review takes up to half a minute; the hosted route allows 60 seconds.
