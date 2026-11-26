# ADR-015: Debt against safe yields, an income annuity, health cover growth

- Status: accepted
- Date: 2026-11-25
- Requirements: REQ-MCP-79, REQ-MCP-80, REQ-MCP-81

## Context

A holistic review (GAP-REVIEW.md) of what planners and planning tools
check found three gaps that move plans like the owner's: paying off
high-rate debt is a guaranteed return the engine never ranked against
investing; at late-2026 rates a lifetime annuity pays about 6.5% joint at
65, and the engine could not test one; and health cover, the largest bridge
cost, was held flat in today's dollars.

## Decision

- Debt is ranked against the saved 10-year Treasury yield (the engine's
  bond mean without one). Pay-first debt leads the review's actions.
- A SPIA is modelled as premium out of an account in its year and a fixed
  nominal payout after, taxed like that account's withdrawals. The test
  uses today's saved quote at Social Security age and reports it as advice:
  the rate at purchase will differ.
- Health cover growth above inflation is a profile rate; without one, the
  review shows a 2-point stress rather than changing the base case, so
  existing results stay comparable.

## Consequences

- The annuity test does not price mortality credits itself; it relies on
  quotes. Joint quotes for a couple are preferred.
- The stress adds one projection to each review.
